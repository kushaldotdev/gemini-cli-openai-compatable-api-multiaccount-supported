import { Hono } from "hono";
import { Env, ChatCompletionRequest, ChatCompletionResponse } from "../types";
import { getAllModelIds, isValidModel, getModelInfo } from "../models";
import { OPENAI_MODEL_OWNER } from "../config";
import { DEFAULT_THINKING_BUDGET } from "../constants";
import { AuthManager } from "../auth";
import { GeminiApiClient } from "../gemini-client";
import { createOpenAIStreamTransformer } from "../stream-transformer";

/**
 * OpenAI-compatible API routes for models and chat completions.
 */
export const OpenAIRoute = new Hono<{ Bindings: Env }>();

// List available models
OpenAIRoute.get("/models", async (c) => {
	const modelData = getAllModelIds().map((modelId) => ({
		id: modelId,
		object: "model",
		created: Math.floor(Date.now() / 1000),
		owned_by: OPENAI_MODEL_OWNER
	}));

	return c.json({
		object: "list",
		data: modelData
	});
});

// Chat completions endpoint
OpenAIRoute.post("/chat/completions", async (c) => {
	try {
		console.log("Chat completions request received");
		const body = await c.req.json<ChatCompletionRequest>();
		const messages = body.messages || [];
		// OpenAI API compatibility: stream defaults to false unless explicitly set to true
		const stream = body.stream === true;

		// Check environment settings for real thinking
		const isRealThinkingEnabled = c.env.ENABLE_REAL_THINKING === "true";
		let includeReasoning = isRealThinkingEnabled; // Automatically enable reasoning when real thinking is enabled
		let thinkingBudget = body.thinking_budget ?? DEFAULT_THINKING_BUDGET; // Default to dynamic allocation

		// Newly added parameters
		const generationOptions = {
			max_tokens: body.max_tokens,
			temperature: body.temperature,
			top_p: body.top_p,
			stop: body.stop,
			presence_penalty: body.presence_penalty,
			frequency_penalty: body.frequency_penalty,
			seed: body.seed,
			response_format: body.response_format
		};

		// Handle effort level mapping to thinking_budget (check multiple locations for client compatibility)
		const reasoning_effort =
			body.reasoning_effort || body.extra_body?.reasoning_effort || body.model_params?.reasoning_effort;
		if (reasoning_effort) {
			includeReasoning = true; // Effort implies reasoning
			const isFlashModel = body.model?.includes("flash"); // Use body.model here as 'model' is not yet validated
			switch (reasoning_effort) {
				case "low":
					thinkingBudget = 1024;
					break;
				case "medium":
					thinkingBudget = isFlashModel ? 12288 : 16384;
					break;
				case "high":
					thinkingBudget = isFlashModel ? 24576 : 32768;
					break;
				case "none":
					thinkingBudget = 0;
					includeReasoning = false;
					break;
			}
		}

		const tools = body.tools;
		const tool_choice = body.tool_choice;

		console.log("Request body parsed:", {
			model: body.model, // Use body.model here as 'model' is not yet validated
			messageCount: messages.length,
			stream,
			includeReasoning,
			thinkingBudget,
			tools,
			tool_choice
		});

		if (!messages.length) {
			return c.json({ error: "messages is a required field" }, 400);
		}

		// Extract and validate model
		const model = body.model?.trim();
		if (!model || !isValidModel(model)) {
			console.warn(`Invalid or missing model requested: '${model}'`);
			return c.json(
				{
					error: `Invalid model '${model}'. Available models: ${getAllModelIds().join(", ")}`
				},
				400
			);
		}

		const modelInfo = getModelInfo(model);
		if (!modelInfo) {
			return c.json({ error: `Could not retrieve info for model '${model}'` }, 500);
		}

		// Deprecation headers
		const extraHeaders: Record<string, string> = {};
		if (modelInfo.deprecated) {
			extraHeaders["X-Model-Deprecated"] = "true";
			if (modelInfo.deprecatedMessage) {
				extraHeaders["X-Model-Deprecated-Message"] = modelInfo.deprecatedMessage;
			}
		}

		// Validate image capabilities
		const hasImages = messages.some(
			(msg) => Array.isArray(msg.content) && msg.content.some((part) => part.type === "image_url")
		);

		if (hasImages && !modelInfo.supportsImages) {
			return c.json(
				{
					error: `Model '${model}' does not support image inputs. Please use a vision-capable model like gemini-3.1-pro-preview or gemini-2.5-pro.`
				},
				400
			);
		}

		// Validate request size and structure
		const MAX_MESSAGES = 200;
		const MAX_CONTENT_CHARS = 1_000_000;

		if (messages.length > MAX_MESSAGES) {
			return c.json({ error: `Too many messages: ${messages.length}. Maximum is ${MAX_MESSAGES}.` }, 400);
		}

		const totalChars = messages.reduce((sum, msg) => {
			const content = typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content);
			return sum + content.length;
		}, 0);

		if (totalChars > MAX_CONTENT_CHARS) {
			return c.json(
				{ error: `Total content length (${totalChars} chars) exceeds maximum (${MAX_CONTENT_CHARS} chars).` },
				400
			);
		}

		if (body.tools) {
			for (const tool of body.tools) {
				if (!tool.type || !tool.function?.name) {
					return c.json({ error: `Invalid tool definition: each tool must have 'type' and 'function.name'.` }, 400);
				}
			}
		}

		// Extract system prompt and user/assistant messages
		const systemParts: string[] = [];
		const otherMessages = messages.filter((msg) => {
			if (msg.role === "system") {
				// Handle system messages with both string and array content
				if (typeof msg.content === "string" && msg.content.trim()) {
					systemParts.push(msg.content.trim());
				} else if (Array.isArray(msg.content)) {
					// For system messages, only extract text content
					const textContent = msg.content
						.filter((part) => part.type === "text")
						.map((part) => part.text || "")
						.join(" ")
						.trim();
					if (textContent) systemParts.push(textContent);
				}
				return false;
			}
			return true;
		});
		const systemPrompt = systemParts.join("\n\n");

		// Initialize services
		const authManager = new AuthManager(c.env);
		const geminiClient = new GeminiApiClient(c.env, authManager);

		if (stream) {
			// Streaming response
			const { readable, writable } = new TransformStream();
			const writer = writable.getWriter();
			const openAITransformer = createOpenAIStreamTransformer(model, c.env);
			const openAIStream = readable.pipeThrough(openAITransformer);

			// Asynchronously pipe data from Gemini to transformer
			(async () => {
				try {
					console.log("Starting stream generation");
					const startTime = Date.now();
					const MAX_STREAM_DURATION_MS = 300_000; // 5 minutes max

					const geminiStream = geminiClient.streamContent(model, systemPrompt, otherMessages, {
						includeReasoning,
						thinkingBudget,
						tools,
						tool_choice,
						...generationOptions
					});

					for await (const chunk of geminiStream) {
						if (Date.now() - startTime > MAX_STREAM_DURATION_MS) {
							console.error(`[Stream] Max duration reached (${MAX_STREAM_DURATION_MS}ms). Forcing closure.`);
							await writer.write({
								type: "error",
								data: `Stream error: Maximum stream duration (${MAX_STREAM_DURATION_MS / 1000}s) exceeded. The response was truncated.`
							});
							break;
						}
						await writer.write(chunk);
					}
					console.log("Stream completed successfully");
					await writer.close();
				} catch (streamError: unknown) {
					const errorMessage = streamError instanceof Error ? streamError.message : String(streamError);
					console.error("Stream error:", errorMessage);
					// Send error to client so they aren't left hanging without explanation
					await writer.write({ type: "error", data: `Stream error: ${errorMessage}` });
					await writer.close();
				}
			})();

			// Return streaming response
			console.log("Returning streaming response");
			return new Response(openAIStream, {
				headers: {
					"Content-Type": "text/event-stream",
					"Cache-Control": "no-cache",
					Connection: "keep-alive",
					"X-Accel-Buffering": "no", // prevents nginx/proxy buffering
					"Access-Control-Allow-Origin": "*",
					"Access-Control-Allow-Methods": "GET, POST, OPTIONS",
					"Access-Control-Allow-Headers": "Content-Type, Authorization",
					...extraHeaders
				}
			});
		} else {
			// Non-streaming response
			try {
				console.log("Starting non-streaming completion");
				const completion = await geminiClient.getCompletion(model, systemPrompt, otherMessages, {
					includeReasoning,
					thinkingBudget,
					tools,
					tool_choice,
					...generationOptions
				});

				const response: ChatCompletionResponse = {
					id: `chatcmpl-${crypto.randomUUID()}`,
					object: "chat.completion",
					created: Math.floor(Date.now() / 1000),
					model: model,
					choices: [
						{
							index: 0,
							message: {
								role: "assistant",
								content: completion.content,
								tool_calls: completion.tool_calls
							},
							finish_reason: completion.tool_calls && completion.tool_calls.length > 0 ? "tool_calls" : "stop"
						}
					]
				};

				// Add usage information if available
				if (completion.usage) {
					response.usage = {
						prompt_tokens: completion.usage.inputTokens,
						completion_tokens: completion.usage.outputTokens,
						total_tokens: completion.usage.inputTokens + completion.usage.outputTokens
					};
				}

				console.log("Returning completion response");
				return c.json(response, 200, extraHeaders);
			} catch (error: unknown) {
				const errorMessage = error instanceof Error ? error.message : String(error);
				console.error("Completion error:", errorMessage);
				return c.json({ error: errorMessage }, 500);
			}
		}
	} catch (e: unknown) {
		const errorMessage = e instanceof Error ? e.message : String(e);
		console.error("Top-level error:", e);
		return c.json({ error: errorMessage }, 500);
	}
});

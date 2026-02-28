import { Env, StreamChunk, ReasoningData, GeminiFunctionCall, UsageData } from "./types";
import { NativeToolResponse } from "./types/native-tools";
import { OPENAI_CHAT_COMPLETION_OBJECT } from "./config";

// OpenAI API interfaces
interface OpenAIToolCall {
	index: number;
	id?: string;
	type?: "function";
	function: {
		name?: string;
		arguments: string;
	};
}

interface OpenAIChoice {
	index: number;
	delta: OpenAIDelta;
	finish_reason: string | null;
	logprobs?: null;
	matched_stop?: null;
}

interface OpenAIDelta {
	role?: string;
	content?: string | null;
	reasoning?: string;
	reasoning_content?: string | null;
	tool_calls?: OpenAIToolCall[];
	native_tool_calls?: NativeToolResponse[];
	grounding?: unknown;
}

interface OpenAIChunk {
	id: string;
	object: string;
	created: number;
	model: string;
	choices: OpenAIChoice[];
	usage?: null;
}

interface OpenAIFinalChoice {
	index: number;
	delta: { content: null };
	finish_reason: string;
}

interface OpenAIUsage {
	prompt_tokens: number;
	completion_tokens: number;
	total_tokens: number;
}

interface OpenAIFinalChunk {
	id: string;
	object: string;
	created: number;
	model: string;
	choices: OpenAIFinalChoice[];
	error?: {
		message: string;
		type: string;
	};
	usage?: OpenAIUsage;
}

// Type guard functions
function isReasoningData(data: unknown): data is ReasoningData {
	return typeof data === "object" && data !== null && ("reasoning" in data || "toolCode" in data);
}

function isGeminiFunctionCall(data: unknown): data is GeminiFunctionCall {
	return typeof data === "object" && data !== null && "name" in data && "args" in data;
}

function isUsageData(data: unknown): data is UsageData {
	return typeof data === "object" && data !== null && "inputTokens" in data && "outputTokens" in data;
}
function isNativeToolResponse(data: unknown): data is NativeToolResponse {
	return typeof data === "object" && data !== null && "type" in data && "data" in data;
}

/**
 * Creates a TransformStream to convert Gemini's output chunks
 * into OpenAI-compatible server-sent events.
 */
export function createOpenAIStreamTransformer(model: string, env?: Env): TransformStream<StreamChunk, Uint8Array> {
	const chatID = `chatcmpl-${crypto.randomUUID()}`;
	const creationTime = Math.floor(Date.now() / 1000);
	const encoder = new TextEncoder();
	let firstChunk = true;
	let toolCallId: string | null = null;
	let toolCallName: string | null = null;
	let usageData: UsageData | undefined;
	let toolCallIndex = 0;

	return new TransformStream({
		async transform(chunk, controller) {
			const delta: OpenAIDelta = {};
			let openAIChunk: OpenAIChunk | null = null;

			switch (chunk.type) {
				case "text":
					if (typeof chunk.data === "string") {
						delta.content = chunk.data;
						if (firstChunk) {
							delta.role = "assistant";
							firstChunk = false;
						}
					}
					break;
				case "thinking_content":
					// Suppress thinking_content from the stream — we cannot mix delta.content
					// with tool_calls in the same stream (Cline/Anthropic SDK rejects it).
					// Thinking is already handled as a `reasoning` field in non-streaming responses.
					return;
				case "real_thinking":
					if (typeof chunk.data === "string") {
						delta.reasoning = chunk.data;
					}
					break;
				case "reasoning":
					if (isReasoningData(chunk.data)) {
						delta.reasoning = chunk.data.reasoning;
					}
					break;
				case "tool_code":
					if (isGeminiFunctionCall(chunk.data)) {
						const toolData = chunk.data;
						toolCallName = toolData.name;
						toolCallId = `call_${crypto.randomUUID()}`;

						console.log(`[Stream] Emitting Tool: ${toolCallName}`, JSON.stringify(toolData.args));

						if (toolData.thoughtSignature) {
							if (env?.GEMINI_CLI_KV) {
								await env.GEMINI_CLI_KV.put(`sig_${toolCallId}`, toolData.thoughtSignature, {
									expirationTtl: 86400
								}).catch((e: unknown) => console.error("KV store error:", e));
							}

							// Encode signature natively into the ID to bypass KV propagation delays
							toolCallId += `_sig_${encodeURIComponent(toolData.thoughtSignature)}`;
						}

						const argsStr = toolData.args
							? typeof toolData.args === "string"
								? toolData.args
								: JSON.stringify(toolData.args)
							: "{}";

						// Send ONE combined chunk with id + type + name + complete arguments.
						// Cline and Kilo Code require that the FIRST chunk for any tool call index
						// always carries both id AND function.name. Since Gemini delivers all args
						// in a single part (not incrementally streamed like OpenAI does), there is
						// no reason to split into an init chunk + a separate args chunk.
						// The previous two-chunk approach sent the args chunk at an already-incremented
						// index with no id/name, causing InvalidResponseDataError in strict parsers.
						delta.tool_calls = [
							{
								index: toolCallIndex++,
								id: toolCallId,
								type: "function",
								function: {
									name: toolCallName,
									arguments: argsStr
								}
							}
						];

						if (firstChunk) {
							delta.role = "assistant";
							delta.content = null;
							firstChunk = false;
						}
					}
					break;
				case "error":
					if (typeof chunk.data === "string") {
						// Emit as a final SSE error chunk in OpenAI format
						const errorChunk: OpenAIFinalChunk = {
							id: chatID,
							object: OPENAI_CHAT_COMPLETION_OBJECT,
							created: creationTime,
							model: model,
							choices: [{ index: 0, delta: { content: null }, finish_reason: "error" }],
							error: { message: chunk.data, type: "stream_error" }
						};
						controller.enqueue(encoder.encode(`data: ${JSON.stringify(errorChunk)}\n\n`));
					}
					return;
				case "native_tool":
					if (isNativeToolResponse(chunk.data)) {
						delta.native_tool_calls = [chunk.data];
					}
					break;
				case "grounding_metadata":
					if (chunk.data) {
						delta.grounding = chunk.data;
					}
					break;
				case "usage":
					if (isUsageData(chunk.data)) {
						usageData = chunk.data;
					}
					return; // Don't send a chunk for usage data
			}

			if (Object.keys(delta).length > 0) {
				openAIChunk = {
					id: chatID,
					object: OPENAI_CHAT_COMPLETION_OBJECT,
					created: creationTime,
					model: model,
					choices: [
						{
							index: 0,
							delta: delta,
							finish_reason: null,
							logprobs: null,
							matched_stop: null
						}
					],
					usage: null
				};
				controller.enqueue(encoder.encode(`data: ${JSON.stringify(openAIChunk)}\n\n`));
			}
		},
		flush(controller) {
			const finishReason = toolCallId ? "tool_calls" : firstChunk ? "content_filter" : "stop";
			const finalChunk: OpenAIFinalChunk = {
				id: chatID,
				object: OPENAI_CHAT_COMPLETION_OBJECT,
				created: creationTime,
				model: model,
				choices: [{ index: 0, delta: { content: null }, finish_reason: finishReason }]
			};

			if (!usageData) {
				console.warn("[Stream] usageMetadata was missing from Gemini stream chunks. Falling back to empty usage.");
				usageData = { inputTokens: 0, outputTokens: 0 } as UsageData;
			}

			finalChunk.usage = {
				prompt_tokens: usageData!.inputTokens || 0,
				completion_tokens: usageData!.outputTokens || 0,
				total_tokens: (usageData!.inputTokens || 0) + (usageData!.outputTokens || 0)
			};

			controller.enqueue(encoder.encode(`data: ${JSON.stringify(finalChunk)}\n\n`));
			controller.enqueue(encoder.encode("data: [DONE]\n\n"));
		}
	});
}

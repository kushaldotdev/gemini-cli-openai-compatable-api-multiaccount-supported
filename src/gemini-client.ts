import {
	Env,
	StreamChunk,
	ReasoningData,
	UsageData,
	ChatMessage,
	MessageContent,
	Tool,
	ToolChoice,
	GeminiFunctionCall
} from "./types";
import { AuthManager } from "./auth";
import { CODE_ASSIST_ENDPOINT, CODE_ASSIST_API_VERSION } from "./config";
import {
	REASONING_MESSAGES,
	REASONING_CHUNK_DELAY,
	THINKING_CONTENT_CHUNK_SIZE,
	MULTI_ACCOUNT_CONFIG,
	REQUEST_TIMEOUT_MS,
	RETRY_STATUS_CODES,
	RETRY_DELAYS_MS,
	MAX_RETRY_ATTEMPTS,
	MAX_SSE_BUFFER_BYTES
} from "./constants";
import { geminiCliModels } from "./models";
import { validateImageUrl } from "./utils/image-utils";
import { GenerationConfigValidator } from "./helpers/generation-config-validator";
import { AutoModelSwitchingHelper, FullStreamOptions } from "./helpers/auto-model-switching";
import { NativeToolsManager } from "./helpers/native-tools-manager";
import { CitationsProcessor } from "./helpers/citations-processor";
import { GeminiUrlContextMetadata, GroundingMetadata, NativeToolsRequestParams } from "./types/native-tools";

// Gemini API response types
interface GeminiCandidate {
	content?: {
		parts?: Array<{ text?: string }>;
	};
	groundingMetadata?: GroundingMetadata;
}

interface GeminiUsageMetadata {
	promptTokenCount?: number;
	candidatesTokenCount?: number;
}

interface GeminiResponse {
	response?: {
		candidates?: GeminiCandidate[];
		usageMetadata?: GeminiUsageMetadata;
	};
}

export interface GeminiPart {
	text?: string;
	thought?: boolean; // For real thinking chunks from Gemini
	functionCall?: {
		name: string;
		args: object;
	};
	thoughtSignature?: string;
	thought_signature?: string;
	functionResponse?: {
		name: string;
		response: {
			result: string;
		};
		thoughtSignature?: string;
	};
	inlineData?: {
		mimeType: string;
		data: string;
	};
	fileData?: {
		mimeType: string;
		fileUri: string;
	};
	url_context_metadata?: GeminiUrlContextMetadata;
}

// Message content types - keeping only the local ones needed
interface TextContent {
	type: "text";
	text: string;
}

interface GeminiFormattedMessage {
	role: string;
	parts: GeminiPart[];
}

interface ProjectDiscoveryResponse {
	cloudaicompanionProject?: string;
}

// Type guard functions
function isTextContent(content: MessageContent): content is TextContent {
	return content.type === "text" && typeof content.text === "string";
}

/**
 * Handles communication with Google's Gemini API through the Code Assist endpoint.
 * Manages project discovery, streaming, and response parsing.
 */

async function retryFetch(fn: () => Promise<Response>, maxAttempts = MAX_RETRY_ATTEMPTS): Promise<Response> {
	let lastResponse: Response | null = null;
	for (let attempt = 0; attempt < maxAttempts; attempt++) {
		const response = await fn();
		if (!(RETRY_STATUS_CODES as readonly number[]).includes(response.status)) {
			return response; // Not a retryable error, return immediately
		}
		lastResponse = response;
		const delay = RETRY_DELAYS_MS[attempt] ?? RETRY_DELAYS_MS[RETRY_DELAYS_MS.length - 1];
		console.warn(`[Retry] Got ${response.status}, attempt ${attempt + 1}/${maxAttempts}. Retrying in ${delay}ms...`);
		await new Promise((r) => setTimeout(r, delay));
	}
	return lastResponse!; // Return last failed response to be handled by caller
}

export class GeminiApiClient {
	private env: Env;
	private authManager: AuthManager;
	private projectId: string | null = null;
	private autoSwitchHelper: AutoModelSwitchingHelper;

	constructor(env: Env, authManager: AuthManager) {
		this.env = env;
		this.authManager = authManager;
		this.autoSwitchHelper = new AutoModelSwitchingHelper(env);
	}

	/**
	 * Discovers the Google Cloud project ID. Uses the environment variable if provided.
	 */
	public async discoverProjectId(): Promise<string> {
		// 1. Try account-specific project ID from AuthManager
		// This should ALWAYS be checked first and not cached locally in GeminiApiClient
		// because the account might rotate.
		const accountProjectId = this.authManager.getCurrentProjectId();
		if (accountProjectId) {
			return accountProjectId;
		}

		// 2. Try environment variable override
		if (this.env.GEMINI_PROJECT_ID) {
			return this.env.GEMINI_PROJECT_ID;
		}

		// 3. Try cached project ID (only if not in multi-account mode or first time)
		if (this.projectId && !this.authManager.isMultiAccount()) {
			return this.projectId;
		}

		try {
			const initialProjectId = "default-project";
			const loadResponse = (await this.authManager.callEndpoint("loadCodeAssist", {
				cloudaicompanionProject: initialProjectId,
				metadata: { duetProject: initialProjectId }
			})) as ProjectDiscoveryResponse;

			if (loadResponse.cloudaicompanionProject) {
				this.projectId = loadResponse.cloudaicompanionProject;
				return loadResponse.cloudaicompanionProject;
			}
			throw new Error("Project ID discovery failed. Please set the GEMINI_PROJECT_ID environment variable.");
		} catch (error: unknown) {
			const errorMessage = error instanceof Error ? error.message : String(error);
			console.error("Failed to discover project ID:", errorMessage);
			throw new Error(
				"Could not discover project ID. Make sure you're authenticated and consider setting GEMINI_PROJECT_ID."
			);
		}
	}

	/**
	 * Parses a server-sent event (SSE) stream from the Gemini API.
	 */
	private async *parseSSEStream(stream: ReadableStream<Uint8Array>): AsyncGenerator<GeminiResponse> {
		const reader = stream.pipeThrough(new TextDecoderStream()).getReader();
		let buffer = "";
		let objectBuffer = "";

		while (true) {
			const { done, value } = await reader.read();
			if (done) {
				if (objectBuffer) {
					try {
						yield JSON.parse(objectBuffer);
					} catch (e) {
						console.error("Error parsing final SSE JSON object:", e);
					}
				}
				break;
			}

			buffer += value;

			if (buffer.length > MAX_SSE_BUFFER_BYTES) {
				console.error(`[SSE] Buffer exceeded ${MAX_SSE_BUFFER_BYTES} bytes, terminating stream`);
				throw new Error(`SSE stream buffer limit exceeded (${MAX_SSE_BUFFER_BYTES} bytes). Response may be too large.`);
			}

			const lines = buffer.split("\n");
			buffer = lines.pop() || ""; // Keep the last, possibly incomplete, line.

			for (const line of lines) {
				if (line.trim() === "") {
					if (objectBuffer) {
						try {
							yield JSON.parse(objectBuffer);
						} catch (e) {
							console.error("Error parsing SSE JSON object:", e);
						}
						objectBuffer = "";
					}
				} else if (line.startsWith("data: ")) {
					objectBuffer += line.substring(6);
				}
			}
		}
	}

	/**
	 * Converts a message to Gemini format, handling both text and image content.
	 */
	private async messageToGeminiFormat(msg: ChatMessage, allMessages?: ChatMessage[]): Promise<GeminiFormattedMessage> {
		switch (msg.role) {
			case "system":
				return {
					role: "user",
					parts: [{ text: `SYSTEM: ${typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content)}` }]
				};

			case "user": {
				// Handle Anthropic-format tool_result messages sent as role:"user" with content array.
				// Kilo Code (and other Anthropic-compatible clients) send tool results this way:
				//   { role: "user", content: [{ type: "tool_result", tool_use_id: "...", content: [...] }] }
				// We detect this and convert each item to a Gemini functionResponse part.
				if (Array.isArray(msg.content)) {
					const toolResultItems = (msg.content as unknown[]).filter(
						(item): item is { type: "tool_result"; tool_use_id: string; content: unknown } =>
							typeof item === "object" && item !== null && (item as Record<string, unknown>).type === "tool_result"
					);

					if (toolResultItems.length > 0) {
						// Build functionResponse parts for each tool_result item
						const parts: GeminiPart[] = await Promise.all(
							toolResultItems.map(async (item) => {
								const toolUseId = item.tool_use_id;

								// Look up function name from the preceding assistant message's tool_use items
								let functionName = "unknown_function";
								if (allMessages) {
									for (const m of allMessages) {
										if (m.role === "assistant") {
											// OpenAI format
											if (m.tool_calls) {
												const match = m.tool_calls.find((tc) => tc.id === toolUseId);
												if (match) {
													functionName = match.function.name;
													break;
												}
											}
											// Anthropic format: content array with tool_use items
											if (Array.isArray(m.content)) {
												const tuMatch = (m.content as unknown[]).find(
													(c): c is { type: "tool_use"; id: string; name: string } =>
														typeof c === "object" &&
														c !== null &&
														(c as Record<string, unknown>).type === "tool_use" &&
														(c as Record<string, unknown>).id === toolUseId
												);
												if (tuMatch) {
													functionName = tuMatch.name;
													break;
												}
											}
										}
									}
								}

								// Flatten the tool result content to a string
								let resultStr: string;
								if (Array.isArray(item.content)) {
									resultStr = (item.content as Array<{ text?: string }>)
										.map((c) => c.text ?? JSON.stringify(c))
										.join("\n");
								} else if (typeof item.content === "string") {
									resultStr = item.content;
								} else {
									resultStr = JSON.stringify(item.content);
								}

								return {
									functionResponse: {
										name: functionName,
										response: { result: resultStr }
									}
								};
							})
						);
						return { role: "user", parts };
					}

					// Regular user message with mixed content (text/images) — no tool_result items
					return {
						role: "user",
						parts: this.parseMultimodalContent(msg.content)
					};
				}
				return {
					role: "user",
					parts: [{ text: msg.content as string }]
				};
			}

			case "assistant": {
				// OpenAI format: msg.tool_calls is an array of ToolCall objects
				const openAIToolCalls = msg.tool_calls;

				// Anthropic format: msg.content is an array containing {type:"tool_use", ...} items
				const anthropicToolUseItems = Array.isArray(msg.content)
					? (msg.content as unknown[]).filter(
							(item): item is { type: "tool_use"; id: string; name: string; input: Record<string, unknown> } =>
								typeof item === "object" && item !== null && (item as Record<string, unknown>).type === "tool_use"
						)
					: [];

				// --- Handle OpenAI-format tool_calls ---
				if (openAIToolCalls && openAIToolCalls.length > 0) {
					const parts = await Promise.all(
						openAIToolCalls.map(async (tc) => {
							let thoughtSignature: string | undefined = undefined;
							try {
								if (this.env.GEMINI_CLI_KV) {
									const baseId = tc.id.split("_sig_")[0];
									const sig = await this.env.GEMINI_CLI_KV.get(`sig_${baseId}`);
									if (sig) thoughtSignature = sig;
								}
							} catch (e) {
								console.error("Error reading signature from KV:", e);
							}
							if (!thoughtSignature && tc.id.includes("_sig_")) {
								let sigMatch = tc.id.split("_sig_")[1];
								if (sigMatch) {
									// Some strict clients (like Kilo Code) sanitize '%' to '_' in tool IDs to make them valid DOM IDs.
									// This turns URL-encoded '%2B' into '_2B', which corrupts the base64 thought_signature.
									// We must safely revert any `_` followed by two hex digits back to `%`.
									sigMatch = sigMatch.replace(/_([0-9A-Fa-f]{2})/g, "%$1");
									try {
										thoughtSignature = decodeURIComponent(sigMatch);
									} catch {
										// ID suffix is not valid URL encoding (e.g. expired/mangled). Skip signature.
										console.warn("[GeminiAPI] Could not decode thought signature from tool call ID (malformed URI). Proceeding without signature.");
									}
								}
							}
							return {
								functionCall: {
									name: tc.function.name,
									args:
										typeof tc.function.arguments === "string"
											? JSON.parse(tc.function.arguments)
											: tc.function.arguments
								},
								...(thoughtSignature ? { thoughtSignature } : {})
							};
						})
					);
					return { role: "model", parts };
				}

				// --- Handle Anthropic-format tool_use items in content array ---
				if (anthropicToolUseItems.length > 0) {
					const parts = await Promise.all(
						anthropicToolUseItems.map(async (item) => {
							let thoughtSignature: string | undefined = undefined;
							try {
								if (this.env.GEMINI_CLI_KV) {
									const baseId = item.id.split("_sig_")[0];
									const sig = await this.env.GEMINI_CLI_KV.get(`sig_${baseId}`);
									if (sig) thoughtSignature = sig;
								}
							} catch (e) {
								console.error("Error reading signature from KV:", e);
							}
							// Fallback: extract signature directly from ID to bypass KV propagation delays
							if (!thoughtSignature && item.id.includes("_sig_")) {
								let sigMatch = item.id.split("_sig_")[1];
								if (sigMatch) {
									// Safely revert client-side '%' to '_' sanitization
									sigMatch = sigMatch.replace(/_([0-9A-Fa-f]{2})/g, "%$1");
									try {
										thoughtSignature = decodeURIComponent(sigMatch);
									} catch {
										// ID suffix is not valid URL encoding. Skip signature.
										console.warn("[GeminiAPI] Could not decode thought signature from tool call ID (malformed URI). Proceeding without signature.");
									}
								}
							}
							return {
								functionCall: {
									name: item.name,
									args: item.input ?? {}
								},
								...(thoughtSignature ? { thoughtSignature } : {})
							};
						})
					);
					return { role: "model", parts };
				}

				// Plain assistant text message
				return {
					role: "model",
					parts: [{ text: (msg.content as string) || "" }]
				};
			}

			case "tool": {
				// OpenAI format: role="tool" with tool_call_id
				let functionName = "unknown_function";

				if (msg.tool_call_id) {
					if (allMessages) {
						for (const m of allMessages) {
							if (m.role === "assistant" && m.tool_calls) {
								const match = m.tool_calls.find((tc) => tc.id === msg.tool_call_id);
								if (match) {
									functionName = match.function.name;
									break;
								}
							}
						}
					}
				}
				return {
					role: "user",
					parts: [
						{
							functionResponse: {
								name: functionName,
								response: {
									result: typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content)
								}
							}
						}
					]
				};
			}

			default:
				return {
					role: "user",
					parts: [{ text: (msg.content as string) || "" }]
				};
		}
	}

	/**
	 * Parses multimodal content (text and/or images) into GeminiPart array.
	 */
	private parseMultimodalContent(content: MessageContent[]): GeminiPart[] {
		const parts: GeminiPart[] = [];
		for (const item of content) {
			if (item.type === "text") {
				parts.push({ text: item.text });
			} else if (item.type === "image_url" && item.image_url) {
				const imageUrl = item.image_url.url;
				const validation = validateImageUrl(imageUrl);
				if (!validation.isValid) {
					throw new Error(`Invalid image: ${validation.error}`);
				}

				if (imageUrl.startsWith("data:")) {
					const [mimeType, base64Data] = imageUrl.split(",");
					const mediaType = mimeType.split(":")[1].split(";")[0];
					parts.push({
						inlineData: {
							mimeType: mediaType,
							data: base64Data
						}
					});
				} else {
					// Note: Keep passing fileData.fileUri directly (fetching+base64 would 4x the size and exhaust memory).
					// If Gemini returns a 400 error, the error text will include the URL — the existing error
					// handler in performStreamRequest already forwards that message to the client.
					parts.push({
						fileData: {
							mimeType: validation.mimeType || "image/jpeg",
							fileUri: imageUrl
						}
					});
				}
			}
		}
		return parts;
	}

	/**
	 * Validates if the model supports images.
	 */
	private validateImageSupport(modelId: string): boolean {
		return geminiCliModels[modelId]?.supportsImages || false;
	}

	/**
	 * Validates image content and format using the shared validation utility.
	 */
	private validateImageContent(imageUrl: string): boolean {
		const validation = validateImageUrl(imageUrl);
		return validation.isValid;
	}

	/**
	 * Stream content from Gemini API.
	 */
	async *streamContent(
		modelId: string,
		systemPrompt: string,
		messages: ChatMessage[],
		options?: {
			includeReasoning?: boolean;
			thinkingBudget?: number;
			tools?: Tool[];
			tool_choice?: ToolChoice;
			max_tokens?: number;
			temperature?: number;
			top_p?: number;
			stop?: string | string[];
			presence_penalty?: number;
			frequency_penalty?: number;
			seed?: number;
			response_format?: {
				type: "text" | "json_object";
			};
		} & NativeToolsRequestParams
	): AsyncGenerator<StreamChunk> {
		await this.authManager.initializeAuth();
		const projectId = await this.discoverProjectId();

		// 1. Format contents into Gemini's format
		const contents = await Promise.all(messages.map((msg) => this.messageToGeminiFormat(msg, messages)));

		// Merge consecutive user messages that consist only of functionResponse parts
		// into a single user message (required by Gemini API for parallel tool calls).
		const mergedContents: GeminiFormattedMessage[] = [];
		for (const content of contents) {
			const prev = mergedContents[mergedContents.length - 1];
			const isFunctionResponse = (c: GeminiFormattedMessage) =>
				c.role === "user" && c.parts.every((p) => p.functionResponse !== undefined);

			if (prev && isFunctionResponse(prev) && isFunctionResponse(content)) {
				// Merge parts into the previous message
				prev.parts.push(...content.parts);
			} else {
				mergedContents.push(content);
			}
		}

		// Check if this is a thinking model and which thinking mode to use
		const isThinkingModel = geminiCliModels[modelId]?.thinking || false;
		const isRealThinkingEnabled = this.env.ENABLE_REAL_THINKING === "true";
		const isFakeThinkingEnabled = this.env.ENABLE_FAKE_THINKING === "true";
		const streamThinkingAsContent = this.env.STREAM_THINKING_AS_CONTENT === "true";
		const includeReasoning = options?.includeReasoning || false;

		const req = {
			thinking_budget: options?.thinkingBudget,
			tools: options?.tools,
			tool_choice: options?.tool_choice,
			max_tokens: options?.max_tokens,
			temperature: options?.temperature,
			top_p: options?.top_p,
			stop: options?.stop,
			presence_penalty: options?.presence_penalty,
			frequency_penalty: options?.frequency_penalty,
			seed: options?.seed,
			response_format: options?.response_format
		};

		// Use the validation helper to create a proper generation config
		const generationConfig = GenerationConfigValidator.createValidatedConfig(
			modelId,
			req,
			isRealThinkingEnabled,
			includeReasoning
		);

		// Native tools integration
		const nativeToolsManager = new NativeToolsManager(this.env);
		const nativeToolsParams = this.extractNativeToolsParams(options as Record<string, unknown>);
		const toolConfig = nativeToolsManager.determineToolConfiguration(options?.tools || [], nativeToolsParams, modelId);

		// Configure request based on tool strategy
		const { tools, toolConfig: finalToolConfig } = GenerationConfigValidator.createFinalToolConfiguration(
			toolConfig,
			options,
			this.env
		);

		// Fake thinking should only stream when:
		// 1. The model IS a thinking model but real thinking is NOT enabled/requested, OR
		// 2. The model is NOT a thinking model (future-proofing for fallback on non-thinking models)
		const shouldUseFakeThinking =
			isFakeThinkingEnabled && !includeReasoning && (!isThinkingModel || !isRealThinkingEnabled);
		let needsThinkingClose = false;
		if (shouldUseFakeThinking) {
			console.log(`[FakeThinking] Streaming synthetic reasoning for model '${modelId}'`);
			yield* this.generateReasoningOutput(messages, streamThinkingAsContent);
			needsThinkingClose = streamThinkingAsContent; // Only need to close if we streamed as content
		}

		const streamRequest: {
			model: string;
			project: string;
			request: {
				systemInstruction?: GeminiFormattedMessage;
				contents: GeminiFormattedMessage[];
				generationConfig: unknown;
				tools?: unknown[];
				toolConfig?: unknown;
				safetySettings?: unknown;
			};
		} = {
			model: modelId,
			project: projectId,
			request: {
				...(systemPrompt
					? {
							systemInstruction: { role: "system", parts: [{ text: systemPrompt }] }
						}
					: {}),
				contents: mergedContents,
				generationConfig,
				tools: tools,
				toolConfig: finalToolConfig
			}
		};

		const safetySettings = GenerationConfigValidator.createSafetySettings(this.env);
		if (safetySettings.length > 0) {
			streamRequest.request.safetySettings = safetySettings;
		}

		yield* this.performStreamRequest(
			modelId,
			streamRequest,
			needsThinkingClose,
			false,
			includeReasoning && streamThinkingAsContent,
			systemPrompt,
			messages,
			nativeToolsManager,
			0
		);
	}

	/**
	 * Generates reasoning output for thinking models.
	 */
	private async *generateReasoningOutput(
		messages: ChatMessage[],
		streamAsContent: boolean = false
	): AsyncGenerator<StreamChunk> {
		// Get the last user message to understand what the model should think about
		const lastUserMessage = messages.filter((msg) => msg.role === "user").pop();
		let userContent = "";

		if (lastUserMessage) {
			if (typeof lastUserMessage.content === "string") {
				userContent = lastUserMessage.content;
			} else if (Array.isArray(lastUserMessage.content)) {
				userContent = lastUserMessage.content
					.filter(isTextContent)
					.map((c) => c.text)
					.join(" ");
			}
		}

		// Generate reasoning text based on the user's question using constants
		const requestPreview = userContent.substring(0, 100) + (userContent.length > 100 ? "..." : "");

		if (streamAsContent) {
			// DeepSeek R1 style: stream thinking as content with <thinking> tags
			yield {
				type: "thinking_content",
				data: "<thinking>\n"
			};

			// Add a small delay after opening tag
			await new Promise((resolve) => setTimeout(resolve, REASONING_CHUNK_DELAY)); // Stream reasoning content in smaller chunks for more realistic streaming
			const reasoningTexts = REASONING_MESSAGES.map((msg) => msg.replace("{requestPreview}", requestPreview));
			const fullReasoningText = reasoningTexts.join("");

			// Split into smaller chunks for more realistic streaming
			// Try to split on word boundaries when possible for better readability
			const chunks: string[] = [];
			let remainingText = fullReasoningText;

			while (remainingText.length > 0) {
				if (remainingText.length <= THINKING_CONTENT_CHUNK_SIZE) {
					chunks.push(remainingText);
					break;
				}

				// Try to find a good break point (space, newline, punctuation)
				let chunkEnd = THINKING_CONTENT_CHUNK_SIZE;
				const searchSpace = remainingText.substring(0, chunkEnd + 10); // Look a bit ahead
				const goodBreaks = [" ", "\n", ".", ",", "!", "?", ";", ":"];

				for (const breakChar of goodBreaks) {
					const lastBreak = searchSpace.lastIndexOf(breakChar);
					if (lastBreak > THINKING_CONTENT_CHUNK_SIZE * 0.7) {
						// Don't make chunks too small
						chunkEnd = lastBreak + 1;
						break;
					}
				}

				chunks.push(remainingText.substring(0, chunkEnd));
				remainingText = remainingText.substring(chunkEnd);
			}

			for (const chunk of chunks) {
				yield {
					type: "thinking_content",
					data: chunk
				};

				// Add small delay between chunks
				await new Promise((resolve) => setTimeout(resolve, 50));
			}

			// Note: We don't close the thinking tag here - it will be closed when real content starts
		} else {
			// Original mode: stream as reasoning field
			const reasoningTexts = REASONING_MESSAGES.map((msg) => msg.replace("{requestPreview}", requestPreview));

			// Stream the reasoning text in chunks
			for (const reasoningText of reasoningTexts) {
				const reasoningData: ReasoningData = { reasoning: reasoningText };
				yield {
					type: "reasoning",
					data: reasoningData
				};

				// Add a small delay to simulate thinking time
				await new Promise((resolve) => setTimeout(resolve, REASONING_CHUNK_DELAY));
			}
		}
	}

	/**
	 * Strips thought signatures, thought parts, and converts tool call history to plain text
	 * for a stateless recovery request. This removes all session-tied state that Google would
	 * reject with 404 when the backend cache has expired.
	 */
	private stripThoughtSignatures(contents: GeminiFormattedMessage[]): GeminiFormattedMessage[] {
		// Deep clone to avoid mutating the original message array
		const stripped = JSON.parse(JSON.stringify(contents)) as GeminiFormattedMessage[];
		const result: GeminiFormattedMessage[] = [];

		for (const message of stripped) {
			if (!message.parts) {
				result.push(message);
				continue;
			}

			// Remove actual thought (thinking) parts — Gemini rejects them when thinkingConfig is absent
			message.parts = message.parts.filter(part => part.thought !== true);

			// Convert functionCall and functionResponse parts to plain text to eliminate all
			// orphaned session references that Google's backend would reject with 404.
			const convertedParts: GeminiPart[] = [];
			for (const part of message.parts) {
				if (part.functionCall) {
					const name = (part.functionCall as any).name ?? 'unknown';
					const args = JSON.stringify((part.functionCall as any).args ?? {});
					convertedParts.push({ text: `[Tool call: ${name}(${args})]` });
				} else if (part.functionResponse) {
					const name = (part.functionResponse as any).name ?? 'unknown';
					const response = JSON.stringify((part.functionResponse as any).response ?? {});
					convertedParts.push({ text: `[Tool result: ${name} → ${response}]` });
				} else {
					if ('thoughtSignature' in part) delete part.thoughtSignature;
					if ('thought_signature' in part) delete part.thought_signature;
					convertedParts.push(part);
				}
			}
			message.parts = convertedParts;

			// After conversion, if parts are empty (was a thinking-only model turn), add placeholder
			if (message.parts.length === 0) {
				if (message.role === 'model') {
					message.parts = [{ text: '...' }];
				} else {
					continue; // Drop empty user turns
				}
			}

			result.push(message);
		}
		return result;
	}

	/**
	 * Performs the actual stream request with retry logic for 401 errors and auto model switching for rate limits.
	 */
	/**
	 * Attempts to remap hallucinated tool args from a model that ignored the schema.
	 * Example: Gemini 3.1 Preview hallucinates {path, line_range} instead of {files:[{path,line_ranges}]}
	 * for the Kilo Code `read_file` tool. This method detects the mismatch and reconstructs the args.
	 * @param toolName - The function call name returned by the model
	 * @param returnedArgs - The args the model returned (may be hallucinated)
	 * @param clientTools - The original tool definitions from the client request
	 * @returns Corrected args, or the originals if no remapping was needed
	 */
	private remapHallucinatedToolArgs(returnedArgs: Record<string, unknown>): Record<string, unknown> {
		return returnedArgs;
	}

	private async *performStreamRequest(
		modelId: string,
		streamRequest: {
			model: string;
			project: string;
			request: {
				systemInstruction?: GeminiFormattedMessage;
				contents: GeminiFormattedMessage[];
				generationConfig: unknown;
				tools?: unknown[];
				toolConfig?: unknown;
				safetySettings?: unknown;
			};
		}, // using unknown for now, typing this is complex
		needsThinkingClose: boolean,
		isRetry: boolean = false,
		realThinkingAsContent: boolean = false,
		systemPrompt?: string,
		messages?: ChatMessage[],
		nativeToolsManager?: NativeToolsManager,
		accountRetryCount: number = 0,
		isStatelessRecovery: boolean = false
	): AsyncGenerator<StreamChunk> {
		const citationsProcessor = new CitationsProcessor(this.env);

		console.log(`[GeminiAPI] Outgoing request payload:\n`, JSON.stringify(streamRequest, null, 2));
		let response: Response;
		try {
			response = await retryFetch(async () => {
				const abortController = new AbortController();
				const timeoutId = setTimeout(() => abortController.abort(), REQUEST_TIMEOUT_MS);
				try {
					return await fetch(`${CODE_ASSIST_ENDPOINT}/${CODE_ASSIST_API_VERSION}:streamGenerateContent?alt=sse`, {
						method: "POST",
						headers: {
							"Content-Type": "application/json",
							Authorization: `Bearer ${this.authManager.getAccessToken()}`
						},
						body: JSON.stringify(streamRequest),
						signal: abortController.signal
					});
				} finally {
					clearTimeout(timeoutId);
				}
			});
		} catch (err: unknown) {
			if (err instanceof Error && err.name === "AbortError") {
				yield {
					type: "error",
					data: `Error: Request timed out after ${REQUEST_TIMEOUT_MS / 1000}s. Please try again.`
				};
				return;
			}
			throw err;
		}

		if (!response.ok) {
			const errorBody = await response.text().catch(() => "<unreadable>");
			console.error(`[Gemini API] ${response.status} ${response.statusText}:`, errorBody.substring(0, 500));

			if (response.status === 401 && !isRetry) {
				console.log("Got 401 error in stream request, clearing token cache and retrying...");
				await this.authManager.clearTokenCache();
				await this.authManager.initializeAuth();
				return yield* this.performStreamRequest(
					modelId,
					streamRequest,
					needsThinkingClose,
					true,
					realThinkingAsContent,
					systemPrompt,
					messages,
					nativeToolsManager,
					0
				); // Retry once
			}

			// Handle rate limiting (429 or 503)
			if (this.autoSwitchHelper.isRateLimitStatus(response.status)) {
				// 1. Try model switching first if applicable
				if (!isRetry) {
					// originalModel is no longer a parameter, so we can't use it here.
					const fallbackModel = this.autoSwitchHelper.getFallbackModel(modelId); // Use modelId as originalModel
					if (fallbackModel && this.autoSwitchHelper.isEnabled()) {
						console.log(
							`Got ${response.status} error for model ${modelId}, switching to fallback model: ${fallbackModel}`
						);

						// NOTE: Not emitting a text chunk here — it would corrupt the stream if this happens during
						// a tool-call response, causing Cline/Kilo to treat it as a text message.

						const fallbackRequest = {
							model: fallbackModel,
							project: streamRequest.project,
							request: {
								...streamRequest.request
							}
						};
						yield* this.performStreamRequest(
							fallbackModel,
							fallbackRequest,
							needsThinkingClose,
							true,
							realThinkingAsContent,
							systemPrompt,
							messages,
							nativeToolsManager,
							accountRetryCount
						);
						return;
					}
				}

				// 2. Try account rotation if multi-account is enabled
				if (this.authManager.isMultiAccount() && accountRetryCount < MULTI_ACCOUNT_CONFIG.MAX_ACCOUNT_RETRY_ATTEMPTS) {
					console.log(
						`Got rate limit error (${response.status}) for account ${this.authManager.getCurrentAccountIndex()}. Rotating accounts...`
					);

					// Mark current account as rate-limited
					await this.authManager.markAccountRateLimited(this.authManager.getCurrentAccountIndex());

					try {
						// This will find and initialize the next available account
						await this.authManager.initializeAuth();

						// Update the request with the new project ID if it changed
						const newProjectId = await this.discoverProjectId();
						const rotatedRequest = {
							model: modelId,
							project: newProjectId,
							request: {
								...streamRequest.request
							}
						};
						const currentEmail = this.authManager.getCurrentAccountEmail();

						console.log(`Retrying request with account ${currentEmail} (retry ${accountRetryCount + 1})`);

						// NOTE: Not emitting a text chunk here — it would corrupt the stream if this happens during
						// a tool-call response, causing Cline/Kilo to treat it as a text message.

						yield* this.performStreamRequest(
							modelId,
							rotatedRequest,
							needsThinkingClose,
							false, // Reset isRetry for the new account's first attempt
							realThinkingAsContent,
							systemPrompt,
							messages,
							nativeToolsManager,
							accountRetryCount + 1
						);
						return;
					} catch (rotationError) {
						console.error("Account rotation failed during stream retry:", rotationError);
					}
				}
			}

			// If we reach here, it means no fallback or rotation was possible or they all failed
			const errorText = errorBody;
			console.error(`[GeminiAPI] Stream request failed: ${response.status}`, errorText);

			// **Google Cache Expiration Recovery**:
			// If Google returns 404 ("Requested entity was not found"), it means the `thought_signature`
			// in the stream expired on their server. We cannot resume the thought process at all.
			// However, we CAN drop the request down to a stateless (non-thinking) query by stripping the signatures
			// and removing the thinkingConfig. This bypasses the 404 and allows the conversation to seamlessly continue.
			if (response.status === 404 && errorText.includes("Requested entity was not found")) {
				if (!isStatelessRecovery) {
					console.warn("[GeminiAPI] 404 Cache Expired! Automatically falling back to a stateless recovery request (thinking temporarily disabled for this turn).");
					
					// Deep clone the generation config
					const newGenerationConfig = JSON.parse(JSON.stringify(streamRequest.request.generationConfig || {})) as Record<string, unknown>;
					
					// Delete thinkingConfig completely to prevent Google from checking signatures or cached states
					delete newGenerationConfig.thinkingConfig;

						// Use the ORIGINAL modelId (not the auto-switched model) for recovery.
					// Also re-discover the project ID to get a completely clean slate.
					const recoveryProjectId = await this.discoverProjectId().catch(() => streamRequest.project);
					const newRequest = {
						model: modelId, // Reset to original model - avoids inheriting the broken auto-switched model
						project: recoveryProjectId,
						request: {
							...streamRequest.request,
							generationConfig: newGenerationConfig,
							contents: this.stripThoughtSignatures(streamRequest.request.contents)
						}
					};

					return yield* this.performStreamRequest(
						modelId, // Original model
						newRequest,
						needsThinkingClose,
						false, // Reset isRetry so it can auto-switch again if needed
						false, // Disable thinking stream wrapper (stateless response)
						systemPrompt,
						messages,
						nativeToolsManager,
						0, // Reset accountRetryCount for the recovery
						true // isStatelessRecovery = true
					);
				}

				// If the stateless recovery STILL 404s, break the loop and force LLM to see the error
				yield {
					type: "text",
					data: "\n\n[SYSTEM ERROR: The backend context cache for the previous thought process has expired. The stateless recovery request also failed. Please rewrite your plan, use targeted operations like grep_search, and avoid reading massive files all at once.]"
				};
				return;
			}

			let errorMessage = `Stream request failed: ${response.status}`;
			try {
				const errorJson = JSON.parse(errorText);
				if (errorJson.error && errorJson.error.message) {
					errorMessage = `${errorJson.error.message}`;
				}
			} catch {
				// Fallback to raw text if not JSON
				if (errorText.length > 0) {
					errorMessage += ` - ${errorText.substring(0, 500)}`;
				}
				// If JSON parsing fails, the errorMessage will already contain the status and potentially raw text.
				// We don't need to yield a separate error for the parsing failure itself,
				// as the main error message will cover the underlying issue.
			}

			yield { type: "error", data: errorMessage };
			return;
		}

		if (!response.body) {
			throw new Error("Response has no body");
		}

		let hasClosedThinking = false;
		let hasStartedThinking = false;

		for await (const jsonData of this.parseSSEStream(response.body)) {
			const candidate = jsonData.response?.candidates?.[0];

			if (candidate?.content?.parts) {
				for (const part of candidate.content.parts as GeminiPart[]) {
					// Handle real thinking content from Gemini
					if (part.thought === true && part.text) {
						const thinkingText = part.text;

						if (realThinkingAsContent) {
							// Stream as content with <thinking> tags (DeepSeek R1 style)
							if (!hasStartedThinking) {
								yield {
									type: "thinking_content",
									data: "<thinking>\n"
								};
								hasStartedThinking = true;
							}

							yield {
								type: "thinking_content",
								data: thinkingText
							};
						} else {
							// Stream as separate reasoning field
							yield {
								type: "real_thinking",
								data: thinkingText
							};
						}
					}
					// Check if text content contains <think> tags (based on your original example)
					else if (part.text && part.text.includes("<think>")) {
						if (realThinkingAsContent) {
							// Extract thinking content and convert to our format
							const thinkingMatch = part.text.match(/<think>(.*?)<\/think>/s);
							if (thinkingMatch) {
								if (!hasStartedThinking) {
									yield {
										type: "thinking_content",
										data: "<thinking>\n"
									};
									hasStartedThinking = true;
								}

								yield {
									type: "thinking_content",
									data: thinkingMatch[1]
								};
							}

							// Extract any non-thinking coRecentent
							const nonThinkingContent = part.text.replace(/<think>.*?<\/think>/gs, "").trim();
							if (nonThinkingContent) {
								if (hasStartedThinking && !hasClosedThinking) {
									yield {
										type: "thinking_content",
										data: "\n</thinking>\n\n"
									};
									hasClosedThinking = true;
								}
								yield { type: "text", data: nonThinkingContent };
							}
						} else {
							// Stream thinking as separate reasoning field
							const thinkingMatch = part.text.match(/<think>(.*?)<\/think>/s);
							if (thinkingMatch) {
								yield {
									type: "real_thinking",
									data: thinkingMatch[1]
								};
							}

							// Stream non-thinking content as regular text
							const nonThinkingContent = part.text.replace(/<think>.*?<\/think>/gs, "").trim();
							if (nonThinkingContent) {
								yield { type: "text", data: nonThinkingContent };
							}
						}
					}
					// Handle regular content - only if it's not a thinking part and doesn't contain <think> tags
					else if (part.text && !part.thought && !part.text.includes("<think>")) {
						// Close thinking tag before first real content if needed
						if ((needsThinkingClose || (realThinkingAsContent && hasStartedThinking)) && !hasClosedThinking) {
							yield {
								type: "thinking_content",
								data: "\n</thinking>\n\n"
							};
							hasClosedThinking = true;
						}

						let processedText = part.text;
						if (nativeToolsManager) {
							processedText = citationsProcessor.processChunk(
								part.text,
								jsonData.response?.candidates?.[0]?.groundingMetadata
							);
						}
						yield { type: "text", data: processedText };
					}
					// Handle function calls from Gemini
					else if (part.functionCall) {
						console.log("RAW_FUNCTION_CALL_PART:", JSON.stringify(part));
						// Close thinking tag before function call if needed
						if ((needsThinkingClose || (realThinkingAsContent && hasStartedThinking)) && !hasClosedThinking) {
							yield {
								type: "thinking_content",
								data: "\n</thinking>\n\n"
							};
							hasClosedThinking = true;
						}

						const correctedArgs = this.remapHallucinatedToolArgs(
							(part.functionCall.args || {}) as Record<string, unknown>
						);
						const functionCallData: GeminiFunctionCall = {
							name: part.functionCall.name,
							args: correctedArgs,
							thoughtSignature: part.thoughtSignature || part.thought_signature
						};

						yield {
							type: "tool_code",
							data: functionCallData
						};
					}
					// Note: Skipping unknown part structures
				}
			}

			if (jsonData.response?.usageMetadata) {
				const usage = jsonData.response.usageMetadata;
				const usageData: UsageData = {
					inputTokens: usage.promptTokenCount || 0,
					outputTokens: usage.candidatesTokenCount || 0
				};
				yield {
					type: "usage",
					data: usageData
				};
			}
		}
	}

	/**
	 * Get a complete response from Gemini API (non-streaming).
	 */
	async getCompletion(
		modelId: string,
		systemPrompt: string,
		messages: ChatMessage[],
		options?: {
			includeReasoning?: boolean;
			thinkingBudget?: number;
			tools?: Tool[];
			tool_choice?: ToolChoice;
			max_tokens?: number;
			temperature?: number;
			top_p?: number;
			stop?: string | string[];
			presence_penalty?: number;
			frequency_penalty?: number;
			seed?: number;
			response_format?: {
				type: "text" | "json_object";
			};
		} & NativeToolsRequestParams
	): Promise<{
		content: string;
		usage?: UsageData;
		tool_calls?: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }>;
	}> {
		try {
			let content = "";
			let usage: UsageData | undefined;
			const tool_calls: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }> = [];

			// Collect all chunks from the stream
			for await (const chunk of this.streamContent(modelId, systemPrompt, messages, options)) {
				if (chunk.type === "text" && typeof chunk.data === "string") {
					content += chunk.data;
				} else if (chunk.type === "usage" && typeof chunk.data === "object") {
					usage = chunk.data as UsageData;
				} else if (chunk.type === "tool_code" && typeof chunk.data === "object") {
					const toolData = chunk.data as GeminiFunctionCall;
					const newCallId = `call_${crypto.randomUUID()}`;

					if (toolData.thoughtSignature && this.env.GEMINI_CLI_KV) {
						this.env.GEMINI_CLI_KV.put(`sig_${newCallId}`, toolData.thoughtSignature, { expirationTtl: 86400 }).catch(
							(e: unknown) => console.error("KV store error:", e)
						);
					}

					tool_calls.push({
						id: newCallId,
						type: "function",
						function: {
							name: toolData.name,
							arguments: JSON.stringify(toolData.args)
						}
					});
				}
				// Skip reasoning chunks for non-streaming responses
			}

			return {
				content,
				usage,
				tool_calls: tool_calls.length > 0 ? tool_calls : undefined
			};
		} catch (error: unknown) {
			// Handle rate limiting for non-streaming requests
			if (this.autoSwitchHelper.isRateLimitError(error)) {
				const fallbackResult = await this.autoSwitchHelper.handleNonStreamingFallback(
					modelId,
					systemPrompt,
					messages,
					options as FullStreamOptions,
					this.streamContent.bind(this)
				);
				if (fallbackResult) {
					return fallbackResult;
				}
			}

			// Re-throw if not a rate limit error or fallback not available
			throw error;
		}
	}

	private extractNativeToolsParams(options?: Record<string, unknown>): NativeToolsRequestParams {
		return {
			enableSearch: this.extractBooleanParam(options, "enable_search"),
			enableUrlContext: this.extractBooleanParam(options, "enable_url_context"),
			enableNativeTools: this.extractBooleanParam(options, "enable_native_tools"),
			nativeToolsPriority: this.extractStringParam(
				options,
				"native_tools_priority",
				(v): v is "native" | "custom" | "mixed" => ["native", "custom", "mixed"].includes(v)
			)
		};
	}

	private extractBooleanParam(options: Record<string, unknown> | undefined, key: string): boolean | undefined {
		const value =
			options?.[key] ??
			(options?.extra_body as Record<string, unknown>)?.[key] ??
			(options?.model_params as Record<string, unknown>)?.[key];
		return typeof value === "boolean" ? value : undefined;
	}

	private extractStringParam<T extends string>(
		options: Record<string, unknown> | undefined,
		key: string,
		guard: (v: string) => v is T
	): T | undefined {
		const value =
			options?.[key] ??
			(options?.extra_body as Record<string, unknown>)?.[key] ??
			(options?.model_params as Record<string, unknown>)?.[key];
		if (typeof value === "string" && guard(value)) {
			return value;
		}
		return undefined;
	}
}

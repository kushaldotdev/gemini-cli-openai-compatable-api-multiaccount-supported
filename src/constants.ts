/**
 * Constants for the Gemini CLI OpenAI Worker
 */

// Static reasoning messages for thinking models
export const REASONING_MESSAGES = [
	'🔍 **Analyzing the request: "{requestPreview}"**\n\n',
	"🤔 Let me think about this step by step... ",
	"💭 I need to consider the context and provide a comprehensive response. ",
	"🎯 Based on my understanding, I should address the key points while being accurate and helpful. ",
	"✨ Let me formulate a clear and structured answer.\n\n"
];

// Default reasoning delay between chunks (in milliseconds)
export const REASONING_CHUNK_DELAY = 100;

// Default chunk size for streaming thinking content (in characters)
/**
 * Controls chunk size when streaming FAKE thinking content (ENABLE_FAKE_THINKING=true).
 * Larger values = fewer SSE events = less overhead. The per-chunk setTimeout(50ms) delays
 * in generateReasoningOutput() are INTENTIONAL — they create realistic progressive streaming.
 * With chunk size 100: ~20 chunks × 50ms = ~1s total fake thinking stream time.
 */
export const THINKING_CONTENT_CHUNK_SIZE = 100;

export const REQUEST_TIMEOUT_MS = 120_000; // 2 minutes
export const TOKEN_REFRESH_TIMEOUT_MS = 30_000; // 30 seconds

export const RETRY_STATUS_CODES = [500, 502, 504] as const;
export const RETRY_DELAYS_MS = [1000, 3000, 8000] as const; // exponential backoff
export const MAX_RETRY_ATTEMPTS = 3;

export const MAX_SSE_BUFFER_BYTES = 10_485_760; // 10 MB
export const RATE_LIMIT_COOLDOWNS_MS = [60_000, 300_000, 900_000]; // 1min, 5min, 15min

// Thinking budget constants
export const DEFAULT_THINKING_BUDGET = -1; // -1 means dynamic allocation by Gemini (recommended)
export const DISABLED_THINKING_BUDGET = 0; // 0 disables thinking entirely

// Generation config defaults
export const DEFAULT_TEMPERATURE = 0.7;

// Auto model switching configuration
export const AUTO_SWITCH_MODEL_MAP = {
	"gemini-3.1-pro-preview": "gemini-3.1-flash-preview",
	"gemini-3.1-flash-preview": "gemini-3-pro-preview",
	"gemini-3-pro-preview": "gemini-3-flash-preview",
	"gemini-3-flash-preview": "gemini-2.5-pro",
	"gemini-2.5-pro": "gemini-2.5-flash",
	"gemini-2.5-flash": "gemini-2.5-flash-lite"
} as const;

// HTTP status codes for rate limiting
export const RATE_LIMIT_STATUS_CODES = [429, 503] as const;

// Reasoning effort mapping to thinking budgets
export const REASONING_EFFORT_BUDGETS = {
	none: 0,
	low: 1024,
	medium: {
		flash: 12288,
		default: 16384
	},
	high: {
		flash: 24576,
		default: 32768
	}
} as const;

// Gemini safety categories
export const GEMINI_SAFETY_CATEGORIES = {
	HARASSMENT: "HARM_CATEGORY_HARASSMENT",
	HATE_SPEECH: "HARM_CATEGORY_HATE_SPEECH",
	SEXUALLY_EXPLICIT: "HARM_CATEGORY_SEXUALLY_EXPLICIT",
	DANGEROUS_CONTENT: "HARM_CATEGORY_DANGEROUS_CONTENT"
} as const;

// Native tools defaults
export const NATIVE_TOOLS_DEFAULTS = {
	ENABLE_GEMINI_NATIVE_TOOLS: false,
	ENABLE_GOOGLE_SEARCH: false,
	ENABLE_URL_CONTEXT: false,
	GEMINI_TOOLS_PRIORITY: "native_first",
	DEFAULT_TO_NATIVE_TOOLS: true,
	ALLOW_REQUEST_TOOL_CONTROL: true,
	ENABLE_INLINE_CITATIONS: false,
	INCLUDE_GROUNDING_METADATA: true,
	INCLUDE_SEARCH_ENTRY_POINT: false
} as const;

// Multi-account configuration
export const MULTI_ACCOUNT_CONFIG = {
	RATE_LIMIT_COOLDOWN_MS: 60000, // 1 minute cooldown for rate-limited accounts
	MAX_ACCOUNT_RETRY_ATTEMPTS: 3 // Maximum number of accounts to try before giving up
} as const;

import { ModelInfo } from "./types";

/**
 * Primary model source — edit `src/models.json` and redeploy to add/remove models.
 * Wrangler bundles the JSON at deploy time; no TypeScript changes needed.
 */
import modelsFromJson from "./models.json";

/**
 * Minimal inline fallback — used only if models.json is absent/corrupt.
 * Prefer editing models.json directly for all model changes.
 */
const fallbackModels: Record<string, ModelInfo> = {
	"gemini-3.1-pro-preview": {
		maxTokens: 65536,
		contextWindow: 1_048_576,
		supportsImages: true,
		supportsPromptCache: false,
		inputPrice: 0,
		outputPrice: 0,
		description: "Google's Gemini 3.1 Pro Preview model via OAuth (free tier)",
		thinking: true
	},
	"gemini-3-flash-preview": {
		maxTokens: 65536,
		contextWindow: 1_048_576,
		supportsImages: true,
		supportsPromptCache: false,
		inputPrice: 0,
		outputPrice: 0,
		description: "Google's Gemini 3 Flash Preview model via OAuth (free tier)",
		thinking: true
	},
	"gemini-2.5-pro": {
		maxTokens: 65536,
		contextWindow: 1_048_576,
		supportsImages: true,
		supportsPromptCache: false,
		inputPrice: 0,
		outputPrice: 0,
		description: "Google's Gemini 2.5 Pro model via OAuth (free tier)",
		thinking: true
	},
	"gemini-2.5-flash": {
		maxTokens: 65536,
		contextWindow: 1_048_576,
		supportsImages: true,
		supportsPromptCache: false,
		inputPrice: 0,
		outputPrice: 0,
		description: "Google's Gemini 2.5 Flash model via OAuth (free tier)",
		thinking: true
	}
};

// Export: use JSON file if valid, otherwise the inline fallback
export const geminiCliModels: Record<string, ModelInfo> =
	modelsFromJson && typeof modelsFromJson === "object" && !Array.isArray(modelsFromJson)
		? (modelsFromJson as Record<string, ModelInfo>)
		: fallbackModels;

// --- Default Model ---
export const DEFAULT_MODEL = "gemini-3.1-pro-preview";

// --- Helper Functions ---
export function getModelInfo(modelId: string): ModelInfo | null {
	return geminiCliModels[modelId] || null;
}

export function getAllModelIds(): string[] {
	return Object.keys(geminiCliModels);
}

export function isValidModel(modelId: string): boolean {
	return modelId in geminiCliModels;
}

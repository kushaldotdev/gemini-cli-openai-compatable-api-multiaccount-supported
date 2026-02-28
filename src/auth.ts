import { Env, OAuth2Credentials } from "./types";
import {
	CODE_ASSIST_ENDPOINT,
	CODE_ASSIST_API_VERSION,
	OAUTH_CLIENT_ID,
	OAUTH_CLIENT_SECRET,
	OAUTH_REFRESH_URL,
	TOKEN_BUFFER_TIME,
	KV_TOKEN_KEY,
	KV_ACCOUNT_ROTATION_KEY,
	KV_ACCOUNT_HEALTH_PREFIX
} from "./config";
import { MULTI_ACCOUNT_CONFIG, RATE_LIMIT_COOLDOWNS_MS, TOKEN_REFRESH_TIMEOUT_MS } from "./constants";

// Auth-related interfaces
interface TokenRefreshResponse {
	access_token: string;
	expires_in: number;
}

interface CachedTokenData {
	access_token: string;
	expiry_date: number;
	cached_at: number;
	account_index?: number; // Track which account this token belongs to
}

interface TokenCacheInfo {
	cached: boolean;
	cached_at?: string;
	expires_at?: string;
	time_until_expiry_seconds?: number;
	is_expired?: boolean;
	message?: string;
	error?: string;
}

interface AccountRotationState {
	current_index: number;
	last_rotation: number;
	total_accounts: number;
}

interface AccountHealthStatus {
	is_rate_limited: boolean;
	rate_limited_at?: number;
	last_success?: number;
	consecutive_rate_limits?: number;
}

/**
 * Handles OAuth2 authentication and Google Code Assist API communication.
 * Manages token caching, refresh, and API calls.
 * Supports multi-account rotation for rate limit avoidance.
 */
export class AuthManager {
	private env: Env;
	private accessToken: string | null = null;
	private accounts: OAuth2Credentials[] = [];
	private currentAccountIndex: number = 0;
	private isMultiAccountMode: boolean = false;
	private accountIds: string[] = [];
	private accountEmails: string[] = []; // Extracted emails for each account
	private _initialized: boolean = false;

	constructor(env: Env) {
		this.env = env;
	}

	/**
	 * Extracts the email from a JWT token.
	 * Handles Base64URL encoding which is standard for JWTs.
	 */
	private getEmailFromToken(token: string | undefined): string {
		if (!token) return "unknown-account";
		try {
			const parts = token.split(".");
			if (parts.length >= 2) {
				// Base64URL to Base64
				let base64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
				// Add padding
				while (base64.length % 4) base64 += "=";

				const payload = JSON.parse(atob(base64));
				return payload.email || payload.unique_name || payload.sub || "unknown-account";
			}
		} catch {
			// Fallback if not a JWT or decoding fails
		}
		return "unknown-account";
	}

	/**
	 * Generates a stable unique ID for an account based on its refresh token.
	 */
	private async getAccountId(account: OAuth2Credentials): Promise<string> {
		const msgUint8 = new TextEncoder().encode(account.refresh_token);
		const hashBuffer = await crypto.subtle.digest("SHA-256", msgUint8);
		const hashArray = Array.from(new Uint8Array(hashBuffer));
		return hashArray
			.map((b) => b.toString(16).padStart(2, "0"))
			.join("")
			.substring(0, 16);
	}

	/**
	 * Checks if multi-account mode is enabled.
	 */
	private isMultiAccountEnabled(): boolean {
		return this.env.ENABLE_MULTI_ACCOUNT === "true";
	}

	/**
	 * Parses and loads accounts from environment variable.
	 * Supports both single account (object) and multiple accounts (array).
	 */
	private async loadAccounts(): Promise<void> {
		if (!this.env.GCP_SERVICE_ACCOUNT) {
			throw new Error("`GCP_SERVICE_ACCOUNT` environment variable not set. Please provide OAuth2 credentials JSON.");
		}

		try {
			const parsed = JSON.parse(this.env.GCP_SERVICE_ACCOUNT);
			let rawAccounts: OAuth2Credentials[] = [];

			// Check if it's an array (multi-account) or single object
			if (Array.isArray(parsed)) {
				if (parsed.length === 0) {
					throw new Error("GCP_SERVICE_ACCOUNT array is empty.");
				}
				rawAccounts = parsed as OAuth2Credentials[];
			} else {
				rawAccounts = [parsed as OAuth2Credentials];
			}

			// Validate and generate IDs
			this.accounts = [];
			this.accountIds = [];
			this.accountEmails = [];
			for (let i = 0; i < rawAccounts.length; i++) {
				const account = rawAccounts[i];
				if (!account.refresh_token || !account.access_token) {
					throw new Error(`Invalid credentials at index ${i}: missing required fields`);
				}
				this.accounts.push(account);
				this.accountIds.push(await this.getAccountId(account));

				// Priority for identification:
				// 1. Manual email field
				// 2. id_token JWT
				// 3. refresh_token JWT
				// 4. project_id
				let id = ((account as unknown as Record<string, unknown>).email as string) || "unknown-account";

				if (id === "unknown-account") {
					id = this.getEmailFromToken(account.id_token);
				}
				if (id === "unknown-account") {
					id = this.getEmailFromToken(account.refresh_token);
				}
				if (id === "unknown-account" && account.project_id) {
					id = `project:${account.project_id}`;
				}
				if (id === "unknown-account") {
					id = `account:${i}`;
				}

				this.accountEmails.push(id);
			}

			this.isMultiAccountMode = this.isMultiAccountEnabled() && this.accounts.length > 1;
			console.log(`Loaded ${this.accounts.length} accounts. Multi-account mode: ${this.isMultiAccountMode}`);
		} catch (e: unknown) {
			if (e instanceof SyntaxError) {
				throw new Error(`Failed to parse GCP_SERVICE_ACCOUNT: Invalid JSON format. ${e.message}`);
			}
			throw e;
		}
	}

	/**
	 * Gets the current account rotation state from KV storage.
	 */
	private async getRotationState(): Promise<AccountRotationState> {
		try {
			const state = await this.env.GEMINI_CLI_KV.get(KV_ACCOUNT_ROTATION_KEY, "json");
			if (state) {
				const parsedState = state as AccountRotationState;
				// Validate that the index is still within bounds of current accounts
				if (parsedState.current_index >= this.accounts.length) {
					parsedState.current_index = 0;
				}
				return parsedState;
			}
		} catch (error) {
			console.log("No rotation state found or error:", error);
		}

		// Default state
		return {
			current_index: 0,
			last_rotation: Date.now(),
			total_accounts: this.accounts.length
		};
	}

	/**
	 * Updates the account rotation state in KV storage.
	 */
	private async updateRotationState(state: AccountRotationState): Promise<void> {
		try {
			await this.env.GEMINI_CLI_KV.put(KV_ACCOUNT_ROTATION_KEY, JSON.stringify(state));
		} catch (error) {
			console.error("Failed to update rotation state:", error);
		}
	}

	/**
	 * Gets the health status for a specific account.
	 */
	private async getAccountHealth(accountIndex: number): Promise<AccountHealthStatus> {
		try {
			const accountId = this.accountIds[accountIndex];
			const health = await this.env.GEMINI_CLI_KV.get(`${KV_ACCOUNT_HEALTH_PREFIX}${accountId}`, "json");
			if (health) {
				return health as AccountHealthStatus;
			}
		} catch (error) {
			console.log(`No health data for account at index ${accountIndex}:`, error);
		}

		return {
			is_rate_limited: false
		};
	}

	/**
	 * Updates the health status for a specific account.
	 */
	private async updateAccountHealth(
		accountIndex: number,
		health: AccountHealthStatus,
		cooldownMs?: number
	): Promise<void> {
		try {
			const accountId = this.accountIds[accountIndex];
			// Store with TTL for auto-expiry of rate limit status
			await this.env.GEMINI_CLI_KV.put(`${KV_ACCOUNT_HEALTH_PREFIX}${accountId}`, JSON.stringify(health), {
				expirationTtl: Math.floor((cooldownMs ?? MULTI_ACCOUNT_CONFIG.RATE_LIMIT_COOLDOWN_MS) / 1000) + 60 // Add buffer
			});
		} catch (error) {
			console.error(`Failed to update health for account at index ${accountIndex}:`, error);
		}
	}

	/**
	 * Marks an account as rate limited in KV storage with progressive cooldown.
	 */
	public async markAccountRateLimited(accountIndex: number): Promise<void> {
		if (!this.isMultiAccountMode) return;

		try {
			const existing = await this.getAccountHealth(accountIndex);
			const consecutive = (existing.consecutive_rate_limits ?? 0) + 1;
			const cooldowns = RATE_LIMIT_COOLDOWNS_MS;
			const cooldownMs = cooldowns[Math.min(consecutive - 1, cooldowns.length - 1)];

			console.log(
				`Marking account ${accountIndex} (${this.accountEmails[accountIndex]}) as rate limited (consecutive: ${consecutive}, cooldown: ${cooldownMs}ms)`
			);

			await this.updateAccountHealth(
				accountIndex,
				{
					is_rate_limited: true,
					rate_limited_at: Date.now(),
					consecutive_rate_limits: consecutive
				},
				cooldownMs
			);
		} catch (error) {
			console.error(`Error marking account ${accountIndex} as rate limited:`, error);
		}
	}

	/**
	 * Marks an account as healthy (not rate limited) in KV storage.
	 */
	public async markAccountHealthy(accountIndex: number): Promise<void> {
		if (!this.isMultiAccountMode) return;

		try {
			// Only call this when transitioning from rate-limited to healthy
			const health = await this.getAccountHealth(accountIndex);
			if (health.is_rate_limited) {
				console.log(`Marking account ${accountIndex} (${this.accountEmails[accountIndex]}) as healthy again`);
				await this.updateAccountHealth(accountIndex, {
					is_rate_limited: false,
					last_success: Date.now(),
					consecutive_rate_limits: 0 // Reset counter on recovery
				});
			}
			// If not rate-limited, do nothing — avoid unnecessary KV writes
		} catch (error) {
			console.error(`Error marking account ${accountIndex} as healthy:`, error);
		}
	}

	/**
	 * Checks if an account is currently rate-limited with cooldown period.
	 */
	private async isAccountRateLimited(accountIndex: number): Promise<boolean> {
		const health = await this.getAccountHealth(accountIndex);

		if (!health.is_rate_limited || !health.rate_limited_at) {
			return false;
		}

		// Check if cooldown period has passed
		const timeSinceRateLimit = Date.now() - health.rate_limited_at;
		if (timeSinceRateLimit > MULTI_ACCOUNT_CONFIG.RATE_LIMIT_COOLDOWN_MS) {
			// Cooldown expired, clear the rate limit status
			await this.markAccountHealthy(accountIndex);
			return false;
		}

		return true;
	}

	/**
	 * Finds the next available (non-rate-limited) account to use.
	 * Returns null if all accounts are rate-limited.
	 */
	private async findAvailableAccount(): Promise<number | null> {
		if (!this.isMultiAccountMode) {
			return 0; // Single account mode
		}

		const state = await this.getRotationState();
		let attempts = 0;
		let currentIndex = state.current_index;

		// Try each account in rotation
		while (attempts < this.accounts.length) {
			const isRateLimited = await this.isAccountRateLimited(currentIndex);

			if (!isRateLimited) {
				console.log(`Found available account at index ${currentIndex}`);
				return currentIndex;
			}

			console.log(`Account ${currentIndex} is rate-limited, trying next`);
			currentIndex = (currentIndex + 1) % this.accounts.length;
			attempts++;
		}

		console.warn("All accounts are rate-limited!");
		return null; // All accounts are rate-limited
	}

	/**
	 * Rotates to the next account in multi-account mode.
	 */
	private async rotateToNextAccount(): Promise<void> {
		if (!this.isMultiAccountMode) {
			return;
		}

		const nextIndex = await this.findAvailableAccount();

		if (nextIndex === null) {
			throw new Error("All accounts are rate-limited. Please try again later.");
		}

		this.currentAccountIndex = nextIndex;

		// Update rotation state
		const state: AccountRotationState = {
			current_index: (nextIndex + 1) % this.accounts.length, // Prepare next rotation
			last_rotation: Date.now(),
			total_accounts: this.accounts.length
		};
		await this.updateRotationState(state);

		console.log(`Rotated to account ${this.currentAccountIndex}`);
	}

	/**
	 * Initializes authentication using OAuth2 credentials with KV storage caching.
	 * Supports multi-account rotation for rate limit avoidance.
	 */
	public async initializeAuth(): Promise<void> {
		if (this._initialized && this.accessToken) {
			return; // Already initialized in this request lifecycle, skip
		}
		// Load accounts on first call
		if (this.accounts.length === 0) {
			await this.loadAccounts();
		}

		// In multi-account mode, find an available account
		if (this.isMultiAccountMode) {
			await this.rotateToNextAccount();
		}

		try {
			// Get cache key for current account using stable account ID
			const accountId = this.accountIds[this.currentAccountIndex];
			const cacheKey = `${KV_TOKEN_KEY}_${accountId}`;

			// First, try to get a cached token from KV storage
			let cachedTokenData: CachedTokenData | null = null;

			try {
				const cachedToken = await this.env.GEMINI_CLI_KV.get(cacheKey, "json");
				if (cachedToken) {
					cachedTokenData = cachedToken as CachedTokenData;
					console.log(`Found cached token for account ${this.currentAccountIndex} (${accountId})`);
				}
			} catch (kvError) {
				console.log("No cached token found in KV storage or KV error:", kvError);
			}

			// Check if cached token is still valid (with buffer)
			if (cachedTokenData) {
				const timeUntilExpiry = cachedTokenData.expiry_date - Date.now();
				if (timeUntilExpiry > TOKEN_BUFFER_TIME) {
					this.accessToken = cachedTokenData.access_token;
					console.log(`Using cached token, valid for ${Math.floor(timeUntilExpiry / 1000)} more seconds`);
					return;
				}
				console.log("Cached token expired or expiring soon");
			}

			// Get current account credentials
			const oauth2Creds = this.accounts[this.currentAccountIndex];

			// Check if the original token is still valid
			const timeUntilExpiry = oauth2Creds.expiry_date - Date.now();
			if (timeUntilExpiry > TOKEN_BUFFER_TIME) {
				// Original token is still valid, cache it and use it
				this.accessToken = oauth2Creds.access_token;
				console.log(
					`Original token for account ${this.currentAccountIndex} is valid for ${Math.floor(timeUntilExpiry / 1000)} more seconds`
				);

				// Cache the token in KV storage
				await this.cacheTokenInKV(oauth2Creds.access_token, oauth2Creds.expiry_date, this.currentAccountIndex);
				return;
			}

			// Both original and cached tokens are expired, refresh the token
			console.log(`Refreshing token for account ${this.currentAccountIndex}...`);
			await this.refreshAndCacheToken(oauth2Creds.refresh_token, this.currentAccountIndex);
		} catch (e: unknown) {
			const errorMessage = e instanceof Error ? e.message : String(e);
			console.error("Failed to initialize authentication:", e);

			// If in multi-account mode and this account failed, try next account
			if (this.isMultiAccountMode) {
				console.log("Marking current account as problematic and trying next account...");
				await this.markAccountRateLimited(this.currentAccountIndex);

				// Try to find another account
				const nextAccount = await this.findAvailableAccount();
				if (nextAccount !== null && nextAccount !== this.currentAccountIndex) {
					this.currentAccountIndex = nextAccount;
					return this.initializeAuth(); // Retry with next account
				}
			}

			throw new Error("Authentication failed: " + errorMessage);
		}
		// Mark as initialized only after successful auth
		this._initialized = true;
	}

	/**
	 * Refresh the OAuth token and cache it in KV storage.
	 */
	private async refreshAndCacheToken(refreshToken: string, accountIndex: number): Promise<void> {
		console.log(`Refreshing OAuth token for account ${accountIndex}...`);

		const ctrl = new AbortController();
		const tid = setTimeout(() => ctrl.abort(), TOKEN_REFRESH_TIMEOUT_MS);
		let refreshResponse: Response;
		try {
			refreshResponse = await fetch(OAUTH_REFRESH_URL, {
				method: "POST",
				headers: {
					"Content-Type": "application/x-www-form-urlencoded"
				},
				body: new URLSearchParams({
					client_id: OAUTH_CLIENT_ID,
					client_secret: OAUTH_CLIENT_SECRET,
					refresh_token: refreshToken,
					grant_type: "refresh_token"
				}),
				signal: ctrl.signal
			});
		} finally {
			clearTimeout(tid);
		}

		if (!refreshResponse.ok) {
			const errorText = await refreshResponse.text();
			console.error("Token refresh failed:", errorText);
			throw new Error(`Token refresh failed: ${errorText}`);
		}

		const refreshData = (await refreshResponse.json()) as TokenRefreshResponse;
		this.accessToken = refreshData.access_token;

		// Calculate expiry time (typically 1 hour from now)
		const expiryTime = Date.now() + refreshData.expires_in * 1000;

		console.log(`Token refreshed successfully for account ${accountIndex}`);
		console.log(`New token expires in ${refreshData.expires_in} seconds`);

		// Cache the new token in KV storage
		await this.cacheTokenInKV(refreshData.access_token, expiryTime, accountIndex);
	}

	/**
	 * Cache the access token in KV storage.
	 */
	private async cacheTokenInKV(accessToken: string, expiryDate: number, accountIndex: number): Promise<void> {
		try {
			const accountId = this.accountIds[accountIndex];
			const cacheKey = `${KV_TOKEN_KEY}_${accountId}`;

			const tokenData: CachedTokenData = {
				access_token: accessToken,
				expiry_date: expiryDate,
				cached_at: Date.now(),
				account_index: accountIndex
			};

			// Cache for slightly less than the token expiry to be safe
			const ttlSeconds = Math.floor((expiryDate - Date.now()) / 1000) - 300; // 5 minutes buffer

			if (ttlSeconds > 0) {
				await this.env.GEMINI_CLI_KV.put(cacheKey, JSON.stringify(tokenData), {
					expirationTtl: ttlSeconds
				});
				console.log(
					`Token cached in KV storage for account ${accountIndex} (${accountId}) with TTL of ${ttlSeconds} seconds`
				);
			} else {
				console.log("Token expires too soon, not caching in KV");
			}
		} catch (kvError) {
			console.error("Failed to cache token in KV storage:", kvError);
			// Don't throw an error here as the token is still valid, just not cached
		}
	}

	/**
	 * Clear cached token from KV storage.
	 * In multi-account mode, clears all account tokens.
	 */
	public async clearTokenCache(): Promise<void> {
		try {
			// Clear tokens for all currently loaded accounts
			for (const accountId of this.accountIds) {
				const cacheKey = `${KV_TOKEN_KEY}_${accountId}`;
				await this.env.GEMINI_CLI_KV.delete(cacheKey);
			}
			console.log(`Cleared cached tokens for all ${this.accountIds.length} accounts from KV storage`);
		} catch (kvError) {
			console.log("Error clearing KV cache:", kvError);
		}
	}

	/**
	 * Get cached token info from KV storage.
	 */
	public async getCachedTokenInfo(): Promise<TokenCacheInfo> {
		try {
			// In multi-account mode, we look for the current account's token
			const accountId = this.accountIds[this.currentAccountIndex];
			const cacheKey = accountId ? `${KV_TOKEN_KEY}_${accountId}` : KV_TOKEN_KEY;

			const cachedToken = await this.env.GEMINI_CLI_KV.get(cacheKey, "json");
			if (cachedToken) {
				const tokenData = cachedToken as CachedTokenData;
				const timeUntilExpiry = tokenData.expiry_date - Date.now();

				return {
					cached: true,
					cached_at: new Date(tokenData.cached_at).toISOString(),
					expires_at: new Date(tokenData.expiry_date).toISOString(),
					time_until_expiry_seconds: Math.floor(timeUntilExpiry / 1000),
					is_expired: timeUntilExpiry < 0
					// Removed token_preview for security
				};
			}
			return { cached: false, message: "No token found in cache" };
		} catch (e: unknown) {
			const errorMessage = e instanceof Error ? e.message : String(e);
			return { cached: false, error: errorMessage };
		}
	}

	/**
	 * A generic method to call a Code Assist API endpoint.
	 * Handles rate limiting with automatic account rotation in multi-account mode.
	 */
	public async callEndpoint(
		method: string,
		body: Record<string, unknown>,
		isRetry: boolean = false,
		retryCount: number = 0
	): Promise<unknown> {
		await this.initializeAuth();

		const ctrl = new AbortController();
		const tid = setTimeout(() => ctrl.abort(), TOKEN_REFRESH_TIMEOUT_MS);
		let response: Response;
		try {
			response = await fetch(`${CODE_ASSIST_ENDPOINT}/${CODE_ASSIST_API_VERSION}:${method}`, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Authorization: `Bearer ${this.accessToken}`
				},
				body: JSON.stringify(body),
				signal: ctrl.signal
			});
		} finally {
			clearTimeout(tid);
		}

		if (!response.ok) {
			// Handle 401 authentication errors
			if (response.status === 401 && !isRetry) {
				console.log("Got 401 error, clearing token cache and retrying...");
				this.accessToken = null; // Clear cached token
				await this.clearTokenCache(); // Clear KV cache
				await this.initializeAuth(); // This will refresh the token
				return this.callEndpoint(method, body, true, retryCount); // Retry once
			}

			// Handle rate limiting (429 or 503) with account rotation
			if ((response.status === 429 || response.status === 503) && this.isMultiAccountMode) {
				console.log(`Got rate limit error (${response.status}) for account ${this.currentAccountIndex}`);

				// Mark current account as rate-limited
				await this.markAccountRateLimited(this.currentAccountIndex);

				// Try to find another account
				if (retryCount < MULTI_ACCOUNT_CONFIG.MAX_ACCOUNT_RETRY_ATTEMPTS) {
					const nextAccount = await this.findAvailableAccount();

					if (nextAccount !== null && nextAccount !== this.currentAccountIndex) {
						console.log(`Switching from account ${this.currentAccountIndex} to account ${nextAccount}`);
						this.currentAccountIndex = nextAccount;
						this.accessToken = null; // Clear current token

						// Retry with the next account
						return this.callEndpoint(method, body, false, retryCount + 1);
					}
				}

				console.warn("All available accounts exhausted or max retries reached");
			}

			const errorText = await response.text();
			throw new Error(`API call failed with status ${response.status}: ${errorText}`);
		}

		// Process successful response
		const data = await response.json();
		return data;
	}

	/**
	 * Get the current access token.
	 */
	public getAccessToken(): string | null {
		return this.accessToken;
	}

	/**
	 * Get the current account index (useful for debugging).
	 */
	public getCurrentAccountIndex(): number {
		return this.currentAccountIndex;
	}

	/**
	 * Get the email for the current account.
	 */
	public getCurrentAccountEmail(): string {
		return this.accountEmails[this.currentAccountIndex] || "unknown-account";
	}

	/**
	 * Get total number of accounts configured.
	 */
	public getTotalAccounts(): number {
		return this.accounts.length;
	}

	/**
	 * Check if multi-account mode is active.
	 */
	public isMultiAccount(): boolean {
		return this.isMultiAccountMode;
	}

	/**
	 * Get the current project ID for the active account.
	 */
	public getCurrentProjectId(): string | null {
		return this.accounts[this.currentAccountIndex]?.project_id || null;
	}
}

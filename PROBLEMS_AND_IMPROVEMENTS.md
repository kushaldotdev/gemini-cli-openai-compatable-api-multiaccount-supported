# Gemini CLI OpenAI Worker - Problems & Improvements Analysis

**Document Updated:** After deep review of ALL source files (`src/gemini-client.ts`, `src/auth.ts`, `src/routes/*.ts`, `src/helpers/*.ts`, `src/middlewares/*.ts`, `src/utils/*.ts`, `src/types/*.ts`, `src/types.ts`, `src/config.ts`, `src/constants.ts`, `src/models.ts`, `src/index.ts`, `src/stream-transformer.ts`)
**Status:** ✅ FULLY IMPLEMENTED & DEPLOYED — See Section 7 for post-implementation findings and architectural additions.

---

## Problem Classification Key

| Severity | Description | Priority | Timeline |
|----------|-------------|----------|----------|
| **CRITICAL** | Causes complete functionality failure | Immediate | This Sprint |
| **HIGH** | Significant reliability issues, frequent failures | Next Release | Next Sprint |
| **MEDIUM** | Occasional issues, degraded experience | Planned | This Quarter |
| **LOW** | Quality of life / nice-to-have | Backlog | As Time Permits |

---

## Section 1: Problems (Verified Against Actual Code)

---

### 1.1 Native Tool Calling Issues

#### Problem 1.1.0: Parallel Tool Call Grouping Bug ✅ CONFIRMED
- **Severity:** HIGH
- **File:** `src/gemini-client.ts` (line 336)
- **Confirmed Code:**
  ```ts
  const contents = messages.map((msg) => this.messageToGeminiFormat(msg)); // 1:1 mapping, no grouping
  ```
- **Description:** When a client sends back multiple `tool` role messages (parallel tool call results), each is converted to a **separate** Gemini `user` message. Gemini requires all parallel `functionResponse` parts to be in a **single** `user` message. This causes a `400 BAD_REQUEST` from the Gemini API.
- **Solution:** After the `messages.map()`, add a post-processing step that merges consecutive Gemini messages of the same `user` role that contain only `functionResponse` parts into one message.

---

#### Problem 1.1.1: Gemini Native Function Calling Incompatibility ✅ CONFIRMED
- **Severity:** CRITICAL
- **File:** `src/helpers/generation-config-validator.ts` (line 217), `src/helpers/native-tools-manager.ts`
- **Description:** Tools sent to Gemini use native `functionDeclarations` format with `functionCallingConfig.mode: "AUTO"`. Clients without native tool call support (e.g., Kilo Code) can't handle Gemini's `functionCall` response parts. There is no environment variable to disable native function calling mode.
- **Solution:** Add a `FORCE_OPENAI_TOOL_FORMAT=true` env var. When set, keep `functionCallingConfig.mode: "NONE"` by default and only activate when the client explicitly provides tools. Pass tool definitions as `functionDeclarations` but route responses back as text, or intercept and reformat `functionCall` parts back to OpenAI format before sending to client.

---

#### Problem 1.1.2: Tool Choice Not Respected for Native Tools ✅ CONFIRMED
- **Severity:** HIGH
- **File:** `src/helpers/generation-config-validator.ts` (line 267)
- **Confirmed Code:**
  ```ts
  // When native tools are used:
  toolConfig: undefined  // ← tool_choice completely ignored
  ```
- **Description:** When `NativeToolsConfiguration.useNativeTools = true`, `toolConfig` is explicitly set to `undefined`, entirely ignoring any `tool_choice` the client sent. No `NONE` mode is applied.
- **Solution:** In `createFinalToolConfiguration()`, honour `tool_choice: "none"` even for native tools by setting `toolConfig: { functionCallingConfig: { mode: "NONE" } }`.

---

#### Problem 1.1.3: `functionResponse.name` Uses Call ID Instead of Function Name ✅ CONFIRMED (Worse Than Described)
- **Severity:** CRITICAL
- **File:** `src/gemini-client.ts` (line 201)
- **Confirmed Code:**
  ```ts
  functionResponse: {
    name: msg.tool_call_id || "unknown_function",  // BUG: call ID, not function name
    response: { result: ... }
  }
  ```
- **Description:** `msg.tool_call_id` (e.g. `call_abc123`) is an opaque identifier. Gemini requires `functionResponse.name` to match the **function declaration name** (e.g. `get_weather`). Gemini has no concept of call IDs — it correlates responses by function name. Using the call ID will cause Gemini to reject or mishandle **every** tool call result, silently breaking all agentic tool use.
- **Solution:** When converting a `tool` role message, look up the **preceding** `assistant` message's `tool_calls` array where `tool_calls[i].id === msg.tool_call_id`, and use `tool_calls[i].function.name` as the `functionResponse.name`.

---

### 1.2 Error Handling & Reliability Issues

#### Problem 1.2.1: Incomplete Error Status Code Handling ✅ CONFIRMED
- **Severity:** HIGH
- **File:** `src/gemini-client.ts` (lines 542-640)
- **Description:** Only `401` and rate-limit codes (429, 503) are specially handled. All other 5xx errors (500, 502, 504) fall through to a plain error text return with no retry. Network-level `fetch` throws are not caught inside `performStreamRequest` at all.
- **Solution:** Add a retryable status codes list `[500, 502, 504]` and wrap the `fetch` in a try/catch. On these codes, apply exponential backoff and retry up to `MAX_RETRY_ATTEMPTS` times before giving up.

---

#### Problem 1.2.2: No Request Timeout on Any Fetch Call ✅ CONFIRMED
- **Severity:** CRITICAL
- **File:** `src/gemini-client.ts` (line 533), `src/auth.ts` (lines 438, 561)
- **Confirmed Code:**
  ```ts
  const response = await fetch(`${CODE_ASSIST_ENDPOINT}/...`, {
    method: "POST", headers: {...}, body: JSON.stringify(streamRequest)
    // ← No signal: AbortController
  });
  ```
- **Description:** All three `fetch` call sites (stream request, token refresh, `callEndpoint`) have no timeout. A slow or hung upstream server will cause the Cloudflare Worker to hang until its wall-clock limit is hit, wasting resources and keeping client connections open indefinitely.
- **Solution:** Create an `AbortController` with `setTimeout(controller.abort, REQUEST_TIMEOUT_MS)` and pass `signal: controller.signal` to every `fetch`. Add `REQUEST_TIMEOUT_MS = 120000` to `src/constants.ts`. Catch `AbortError` and return a clear timeout error to the client.

---

#### Problem 1.2.3: SSE Stream Parsing — Unbounded Buffer ✅ CONFIRMED
- **Severity:** MEDIUM
- **File:** `src/gemini-client.ts` (lines 149-186)
- **Description:** `buffer` and `objectBuffer` grow without any size cap. Parse errors (line 176-178) are swallowed silently — stream continues with no client notification. `await reader.read()` can block indefinitely if the upstream stalls mid-event.
- **Solution:** Add a `MAX_SSE_BUFFER_BYTES = 10_485_760` (10 MB) limit. Throw if exceeded. On parse error, yield an error chunk instead of silently continuing. Add a per-read timeout using `AbortController`.

---

#### Problem 1.2.4: Stream Error Sent as Text, Not as Error Event ⚠️ PARTIALLY-CONFIRMED
- **Severity:** MEDIUM
- **File:** `src/routes/openai.ts` (lines 182-191)
- **Actual Code:**
  ```ts
  await writer.write({ type: "text", data: `Error: ${errorMessage}` });
  await writer.close(); // ← stream IS closed correctly
  ```
- **Description:** The stream **is** properly closed. However, errors are sent as plain `text` chunks — indistinguishable from model output. Clients can't programmatically detect this as an error vs. a normal response.
- **Solution:** Send an SSE `event: error\ndata: {...}\n\n` before the `[DONE]` event, or use a dedicated `StreamChunk.type = "error"` that the transformer converts to an OpenAI error response format.

---

#### Problem 1.2.5: No Retry Logic for Transient Errors ✅ CONFIRMED
- **Severity:** HIGH
- **File:** `src/gemini-client.ts`
- **Description:** Only the single `401` retry exists. No retry for transient `500`/`502`/`504` errors, no exponential backoff, no retry on `fetch` throws (network errors).
- **Solution:** Implement a generic `retryWithBackoff(fn, maxAttempts, delays)` helper. Apply to `performStreamRequest` for retryable status codes. Use delays `[1000, 3000, 5000]` ms.

---

### 1.3 Authentication & Token Management Issues

#### Problem 1.3.0: KV Write on Every Successful Request ✅ CONFIRMED
- **Severity:** CRITICAL
- **File:** `src/auth.ts` (lines 608-611)
- **Confirmed Code:**
  ```ts
  if (this.isMultiAccountMode) {
    await this.markAccountHealthy(this.currentAccountIndex); // KV put every request
  }
  ```
- **Description:** `callEndpoint()` (used for project discovery on every request) calls `markAccountHealthy()` — a KV `put` — on every successful response. Cloudflare KV free tier = 1,000 writes/day. With any meaningful traffic this is exhausted rapidly, causing failures and unexpected billing.
- **Solution:** Remove the automatic `markAccountHealthy()` call from `callEndpoint()`. Health should only be reset when an account recovers from a rate-limited state (i.e., only write to KV when transitioning from `is_rate_limited: true` to `false`). Use a simple TTL expiry on health records instead of explicit healthy writes.

---

#### Problem 1.3.0b: Account Rotation Race Condition ✅ CONFIRMED
- **Severity:** MEDIUM
- **File:** `src/auth.ts` (lines 176-211, 323-344)
- **Description:** `getRotationState()` reads from KV and `updateRotationState()` writes back. No atomic operation. Concurrent requests hitting rate limits simultaneously will cause multiple workers to read the same index and write conflicting state back.
- **Solution:** Implement a KV-based optimistic lock using a `lock_version` field. Retry the rotation update if the written version doesn't match what was read. Alternatively, use Cloudflare Durable Objects for stateful coordination.

---

#### Problem 1.3.1: Token Refresh Race Condition ✅ CONFIRMED
- **Severity:** MEDIUM
- **File:** `src/auth.ts` (lines 362-410)
- **Description:** Multiple concurrent requests can read the same expired token from KV, all conclude they need to refresh, and all fire simultaneous OAuth token refresh requests — wasting quota and risking rate limiting on the OAuth endpoint.
- **Solution:** Use a KV-based lock key (e.g., `token_refresh_lock_{accountId}`). Before refreshing, set the lock with a short TTL. Other concurrent requests should detect the lock and wait/poll for the new token to appear in KV.

---

#### Problem 1.3.2: Rate Limit Cooldown May Be Too Short ✅ CONFIRMED
- **Severity:** MEDIUM
- **File:** `src/constants.ts` (line 79)
- **Confirmed Code:** `RATE_LIMIT_COOLDOWN_MS: 60000` (1 minute)
- **Description:** Google's Code Assist API rate limits (especially for free/OAuth tier) can last longer than 1 minute. Accounts may be retried too soon, generating more 429s.
- **Solution:** Implement progressive cooldowns: increase `RATE_LIMIT_COOLDOWN_MS` exponentially based on consecutive rate limit hits per account (e.g., 1 min → 5 min → 15 min). Store `rate_limit_count` in the account health record.

---

#### Problem 1.3.3: No Tracking of Consecutive Failures ✅ CONFIRMED
- **Severity:** MEDIUM
- **File:** `src/auth.ts` (interface `AccountHealthStatus`, line 44)
- **Confirmed Code:**
  ```ts
  interface AccountHealthStatus {
    is_rate_limited: boolean;
    rate_limited_at?: number;
    last_success?: number;
    // No failure_count, no consecutive_errors
  }
  ```
- **Description:** Non-rate-limit failures (e.g., repeated 500s, auth errors) just mark the account rate-limited for 1 minute without escalating penalties. Problematic accounts keep being retried.
- **Solution:** Add `failure_count: number` and `consecutive_rate_limits: number` to `AccountHealthStatus`. Skip accounts with `failure_count > MAX_ACCOUNT_FAILURES`. Apply progressive cooldowns based on `consecutive_rate_limits`.

---

#### ~~Problem 1.3.4: Token Cache Not Shared Across Worker Instances~~ ❌ OUTDATED/INCORRECT
- **Status:** **REMOVED — This was a documentation error.**
- **Reality:** Cloudflare KV IS globally distributed and shared across all Worker instances. The `this.accessToken` in-memory field is intentionally per-instance (for within-request reuse) and is not a bug. The KV cache correctly handles cross-instance token sharing.

---

### 1.4 Stream Processing Issues

#### Problem 1.4.0: Cloudflare Worker Wall-Clock Timeout ✅ CONFIRMED
- **Severity:** MEDIUM
- **File:** `src/routes/openai.ts`, `src/gemini-client.ts`
- **Description:** Cloudflare Workers have a 30-second CPU time limit (free plan) and a 30-minute wall-clock limit. Very long streaming responses from thinking models could hit these limits, causing the stream to be abruptly terminated.
- **Solution:** Monitor elapsed time within the streaming loop. When approaching the limit, yield a graceful message and close the stream cleanly. Consider Cloudflare Durable Objects for very long-running requests.

---

#### Problem 1.4.1: No Maximum Stream Duration ✅ CONFIRMED
- **Severity:** MEDIUM
- **File:** `src/gemini-client.ts`
- **Description:** Streams can run indefinitely. No maximum token/duration enforcement.
- **Solution:** Add `MAX_STREAM_DURATION_MS = 300000` constant. Start a timer when streaming begins; if exceeded, abort the upstream fetch and close the stream with a timeout error.

---

#### Problem 1.4.2: Thinking Chunk Size Too Small ✅ CONFIRMED
- **Severity:** LOW
- **File:** `src/constants.ts` (line 20)
- **Confirmed Code:** `THINKING_CONTENT_CHUNK_SIZE = 15`
- **Description:** 15 characters per chunk = ~133 SSE events for a typical 2000-char thinking block. Each event is a separate network write. This creates unnecessary overhead and latency.
- **Solution:** Increase to `THINKING_CONTENT_CHUNK_SIZE = 200` or make it configurable via env var `THINKING_CHUNK_SIZE`. The delay between chunks (`50ms`) also adds up; consider reducing or removing it.

---

#### Problem 1.4.3: Usage Data Not Always Included ✅ CONFIRMED
- **Severity:** LOW
- **File:** `src/stream-transformer.ts` (lines 189-194)
- **Description:** Usage is only included in the final SSE chunk if `usageData` was set during streaming. If Gemini doesn't return `usageMetadata` in any chunk, usage is silently absent from the response.
- **Solution:** Add a fallback: if no usage data received from Gemini, include a `usage: null` or estimated usage in the final chunk. Log a warning when usage data is missing.

---

### 1.5 Request Validation Issues

#### Problem 1.5.0: Multiple System Messages — Only Last One Used ✅ CONFIRMED
- **Severity:** MEDIUM
- **File:** `src/routes/openai.ts` (lines 124-142)
- **Confirmed Code:**
  ```ts
  if (typeof msg.content === "string") {
    systemPrompt = msg.content;  // ← overwrites previous
  } else if (Array.isArray(msg.content)) {
    systemPrompt = textContent;  // ← same problem
  }
  ```
- **Description:** If a client sends multiple `system` role messages (valid in OpenAI format), only the **last** one is used. Earlier system messages are silently discarded.
- **Solution:** Change `systemPrompt = msg.content` to `systemPrompt += (systemPrompt ? "\n\n" : "") + msg.content` to concatenate all system messages.

---

#### Problem 1.5.1: No Input Validation ✅ CONFIRMED
- **Severity:** MEDIUM
- **File:** `src/routes/openai.ts`
- **Description:** Beyond `messages.length > 0` and model validation, no validation exists for: max message count, max content length, tool definition structure, or malformed requests. Invalid payloads hit the Gemini API and produce confusing errors.
- **Solution:** Add early validation: max 200 messages, max 1M total characters, validate tool definitions have `name` and `function` fields, validate `tool_choice` is a valid type. Return clear `400` errors.

---

#### Problem 1.5.2: No Model-Specific Capability Validation ⚠️ PARTIALLY-CONFIRMED
- **Severity:** LOW
- **File:** `src/routes/openai.ts`
- **Actual:** Image support IS validated. Thinking budget limits per model are not enforced beyond the `validateThinkingBudget()` helper.
- **Description:** Context window enforcement, per-model capability checks beyond images, and per-model thinking budget max limits are not validated before hitting the API.
- **Solution:** Add `maxThinkingBudget` to `ModelInfo` and validate against it. Check `contextWindow` against estimated input token count.

---

### 1.6 Observability & Debugging Issues

#### Problem 1.6.1: No Request Correlation IDs ✅ CONFIRMED
- **Severity:** MEDIUM
- **File:** All files
- **Description:** No request ID is generated or threaded through log messages. Debugging multi-step request failures in production requires manually correlating timestamps.
- **Solution:** Generate `requestId = crypto.randomUUID().slice(0, 8)` in the logging middleware. Pass it via a closure or context variable. Prefix all log messages with `[${requestId}]`. Return it in a `X-Request-ID` response header.

---

#### Problem 1.6.2: Inconsistent Logging Format ✅ CONFIRMED
- **Severity:** LOW
- **File:** All files
- **Description:** Mix of `console.log` and `console.error` with no structured format, no log levels, no component prefixes. Hard to filter in Cloudflare's log viewer.
- **Solution:** Create a minimal `Logger` class in `src/utils/logger.ts` with `info()`, `warn()`, `error()`, `debug()` methods that emit structured JSON lines. Pass `requestId` via constructor.

---

#### Problem 1.6.3: No Metrics Collection ✅ CONFIRMED
- **Severity:** LOW
- **File:** N/A (new)
- **Description:** No tracking of request counts, latencies, error rates, or account rotation frequency.
- **Solution:** Use Cloudflare Analytics Engine (if available) or emit structured log lines that Cloudflare's log aggregation can parse. At minimum, log request duration, model used, and success/failure on every request.

---

### 1.7 Configuration Issues

#### Problem 1.7.1: Too Many Environment Variables, No Documentation ✅ CONFIRMED
- **Severity:** LOW
- **File:** `src/types.ts` (`Env` interface)
- **Description:** 20+ environment variables in `Env` interface, defaults scattered across `src/constants.ts` and inline. No single reference for what each variable does and its default value.
- **Solution:** Document all env vars in `.dev.vars.example` with comments. Consider creating a `src/config.ts` `getConfig(env)` function that returns a single typed config object with defaults applied.

---

#### Problem 1.7.2: No Startup Configuration Validation ✅ CONFIRMED
- **Severity:** LOW
- **File:** `src/index.ts`
- **Description:** Misconfigured env vars (e.g., invalid JSON in `GCP_SERVICE_ACCOUNT`) are only discovered on the first request, not at startup.
- **Solution:** Add a startup validation function called on `fetch` handler's first invocation. Validate `GCP_SERVICE_ACCOUNT` parses as valid JSON, required fields exist, `GEMINI_CLI_KV` is bound. Return a clear `503` with a setup guide URL if validation fails.

---

### 1.8 Security Issues

#### Problem 1.8.1: Request Body Logging May Expose User Data ⚠️ PARTIALLY-CONFIRMED
- **Severity:** MEDIUM
- **File:** `src/middlewares/logging.ts` (lines 24-30)
- **Confirmed Code:**
  ```ts
  const maskedBody = truncatedBody.replace(
    /"(api_?key|token|authorization)":\s*"[^"]*"/gi, '"$1": "***"'
  );
  ```
- **Description:** The regex only masks JSON keys named `api_key`, `token`, `authorization`. It does NOT mask the actual message content (`messages[].content`), which could contain PII, passwords, or proprietary data. Up to 500 characters of every POST request body is logged.
- **Solution:** For the `/v1/chat/completions` endpoint, log only metadata (message count, model, stream flag) — not content. Add `DISABLE_REQUEST_BODY_LOGGING=true` env var to suppress body logging entirely in production.

---

#### ~~Problem 1.8.2: Stack Traces Exposed in Debug Endpoints~~ ❌ ALREADY FIXED
- **Status:** **REMOVED — Already fixed in current code.**
- **Reality:** `src/routes/debug.ts` already strips stack traces. Comments in the code explicitly state: `// Removed stack trace for security`. This was fixed before this document was written.

---

#### Problem 1.8.3: No Inbound Rate Limiting ✅ CONFIRMED
- **Severity:** MEDIUM
- **File:** `src/index.ts`, `src/routes/openai.ts`
- **Description:** No rate limiting on incoming requests. A single worker/API key can fire unlimited chat completion requests, exhausting Gemini API quotas and causing KV write pressure.
- **Solution:** Add a `src/middlewares/rate-limiter.ts` using KV to track request counts per API key per minute. Return `429 Too Many Requests` with `Retry-After` header when exceeded. Make the limit configurable via `RATE_LIMIT_REQUESTS_PER_MINUTE` env var.

---

### 1.9 Model Management Issues

#### Problem 1.9.1: Hardcoded Model Configuration ✅ CONFIRMED
- **Severity:** LOW
- **File:** `src/models.ts`
- **Description:** All 7 models are hardcoded. Adding a new Gemini model requires a code change and redeployment.
- **Solution:** Consider adding a `CUSTOM_MODELS_JSON` env var that can define additional model entries at runtime. Also maintain the hardcoded list as a baseline.

---

#### Problem 1.9.2: No Model Deprecation Handling ✅ CONFIRMED
- **Severity:** LOW
- **File:** `src/models.ts`, `src/constants.ts`
- **Description:** No `deprecated` flag in `ModelInfo`. `AUTO_SWITCH_MODEL_MAP` in `constants.ts` is static and must be updated manually when models are sunset.
- **Solution:** Add `deprecated?: boolean` and `deprecatedMessage?: string` to `ModelInfo`. Return a warning header `X-Model-Deprecated` when a deprecated model is used. Populate `AUTO_SWITCH_MODEL_MAP` entries for all deprecated models.

---

#### Problem 1.9.3: Non-Streaming Fallback Drops All Options ✅ CONFIRMED
- **Severity:** MEDIUM
- **File:** `src/helpers/auto-model-switching.ts` (lines 70-84)
- **Confirmed Code:**
  ```ts
  // handleNonStreamingFallback only accepts:
  options?: { includeReasoning?: boolean; thinkingBudget?: number; }
  // ALL other options (tools, temperature, max_tokens, stop, etc.) are silently dropped
  ```
- **Description:** When `getCompletion()` falls back to a different model on rate limit, the fallback invocation discards all generation options except `includeReasoning` and `thinkingBudget`.
- **Solution:** Update `handleNonStreamingFallback`'s `options` parameter type to accept the full `NativeToolsRequestParams & { includeReasoning?, thinkingBudget?, max_tokens?, temperature?, tools?, tool_choice?, ... }` and thread it through to the `streamContentFn` call.

---

### 1.10 Citation Processing Issues

#### Problem 1.10.1: Citation Insertion Can Break Text ✅ CONFIRMED
- **Severity:** LOW
- **File:** `src/helpers/citations-processor.ts` (lines 52-93)
- **Description:** `findSafeInsertionPoint` searches forward for whitespace or punctuation but can still insert citations inside URLs if the URL contains `,` or `;`. Citations that fall outside the current chunk's byte range are silently skipped (line 66), potentially causing missing citations.
- **Solution:** Track a global character offset across all chunks. Before inserting, verify the insertion point is not inside a URL (detect via `http://` preceding context). Use a regex to detect and skip URL spans.

---

#### Problem 1.10.2: No Citation Deduplication ✅ CONFIRMED
- **Severity:** LOW
- **File:** `src/helpers/citations-processor.ts`
- **Description:** No global source tracking across chunks. The same URL can appear as `[1]`, `[2]`, `[3]` in different chunks, producing confusing numbered references.
- **Solution:** Maintain a `Map<uri, citationNumber>` in `CitationsProcessor` across `processChunk()` calls. Assign a stable citation number per unique URI. Append a consolidated reference list at the end of the response.

---

### 1.11 Image Handling Issues

#### Problem 1.11.1: External Image URL Errors Are Silent ⬇️ DOWNGRADED to LOW
- **Severity:** LOW (previously listed as MEDIUM — downgraded)
- **File:** `src/gemini-client.ts` (lines 271-279)
- **Confirmed Code:**
  ```ts
  // Note: For better reliability, you might want to fetch the image
  // and convert it to base64, as Gemini API might have limitations with external URLs
  parts.push({ fileData: { mimeType: ..., fileUri: imageUrl } });
  ```
- **Description:** External image URLs are passed directly to Gemini as `fileData.fileUri`. Gemini can handle most public URLs natively, so this works fine for standard cases. The issue is that when Gemini cannot access a URL (private network, auth-gated, non-image URL), the error message from Gemini is cryptic and gives the client no useful guidance.
- **Why NOT to convert to base64:** Base64-encoding a fetched image would: balloon the request body by 4×, consume massive context window tokens, risk hitting the Cloudflare Worker 128 MB memory limit on large images, and add network latency before every image request. This would cause more problems than it solves.
- **Solution:** Keep passing `fileData.fileUri` directly. Add better error handling: catch Gemini 400 errors that mention the image URI and return a clear `400` error explaining that the image URL could not be accessed. Add the URL to the error message so the client can debug it.

---

#### Problem 1.11.2: No Image Size Validation ✅ CONFIRMED
- **Severity:** LOW
- **File:** `src/utils/image-utils.ts`
- **Description:** `validateImageUrl()` validates format and mime type but has no size check on base64 images. A very large base64-encoded image sent by the client can exhaust Cloudflare Worker memory limits (128 MB by default).
- **Solution:** Add size validation in `validateImageUrl()` for the `data:` URL path only (not external URLs): calculate `base64Part.length * 0.75` (approximate bytes) and reject if over `MAX_IMAGE_SIZE_BYTES = 20_971_520` (20 MB). Return a clear `400` error: `"Image too large. Maximum base64 image size is 20MB."`

---

### 1.12 CORS and HTTP Issues

#### Problem 1.12.1: Overly Permissive CORS ✅ CONFIRMED
- **Severity:** LOW
- **File:** `src/index.ts` (line 31)
- **Confirmed Code:** `c.header("Access-Control-Allow-Origin", "*");`
- **Description:** Wildcard CORS allows any origin. For browser-based clients, this means any website can make authenticated requests using the user's credentials.
- **Solution:** Add `ALLOWED_ORIGINS` env var (comma-separated list). In the CORS middleware, validate `request.headers.get("Origin")` against the list. Set specific origin in response header instead of `*` when there's a match.

---

#### Problem 1.12.2: No HTTP Keep-Alive Headers ⚠️ PARTIALLY-CONFIRMED
- **Severity:** LOW
- **File:** `src/routes/openai.ts`
- **Note:** `"Connection": "keep-alive"` header IS already set. HTTP/2 push is not relevant for Cloudflare Workers. Stream interruptions are more likely caused by Worker timeouts than missing headers.
- **Solution:** Ensure `"X-Accel-Buffering": "no"` header is added to prevent any proxy buffering of the SSE stream. Periodically send SSE comment lines (`: keep-alive\n\n`) during long streams to prevent proxy timeouts.

---

### 1.13 NEW — Additional Problems Found in Deep Review

#### Problem 1.13.0: `initializeAuth()` Called Twice per Request ✅ NEW FINDING
- **Severity:** HIGH
- **File:** `src/routes/openai.ts` (line 150) + `src/gemini-client.ts` (line 333)
- **Confirmed Code:**
  ```ts
  // routes/openai.ts:
  await authManager.initializeAuth();  // First call (explicit test)

  // gemini-client.ts:333 (inside streamContent):
  await this.authManager.initializeAuth();  // Second call (always)
  ```
- **Description:** Every request triggers two full `initializeAuth()` calls. Each call: parses `GCP_SERVICE_ACCOUNT` JSON, hashes account tokens with `crypto.subtle.digest`, and makes a KV read. In multi-account mode, `rotateToNextAccount()` also fires twice, causing two KV writes per request.
- **Solution:** Remove the explicit `await authManager.initializeAuth()` from the route handler (or make it a no-op if already initialized). Add an `this.initialized` flag in `AuthManager` so the second call short-circuits when auth is already set up.

---

#### Problem 1.13.1: System Prompt Injected as `user` Role Instead of `systemInstruction` ✅ NEW FINDING
- **Severity:** HIGH
- **File:** `src/gemini-client.ts` (lines 338-340)
- **Confirmed Code:**
  ```ts
  if (systemPrompt) {
    contents.unshift({ role: "user", parts: [{ text: systemPrompt }] });
  }
  ```
- **Description:** The system prompt is prepended as a fake `user` role message. Gemini's API has a dedicated `request.systemInstruction` field (`{ role: "system", parts: [{ text }] }`) designed explicitly for this. Using `user` role wastes context window tokens with a synthetic conversation turn and is semantically incorrect — Gemini may give this different weight than a proper system instruction.
- **Solution:** Move the system prompt to `streamRequest.request.systemInstruction = { role: "system", parts: [{ text: systemPrompt }] }` and remove it from `contents`. Remove the `contents.unshift()` call. Update the `streamRequest` type to include `systemInstruction`.

---

#### Problem 1.13.2: `stream` Field Defaults to `true` — Violates OpenAI API Contract ✅ NEW FINDING
- **Severity:** MEDIUM
- **File:** `src/routes/openai.ts` (line 38)
- **Confirmed Code:**
  ```ts
  const stream = body.stream !== false;  // defaults to true if undefined
  ```
- **Description:** OpenAI API default for `stream` is `false` (non-streaming, returns a complete JSON object). This worker defaults to `true`. Clients that omit the `stream` field expecting a synchronous JSON response receive an SSE stream instead — a breaking API contract violation.
- **Solution:** Change to `const stream = body.stream === true;` (default `false`). This matches OpenAI's API contract and prevents confusion for standard OpenAI SDK clients.

---

#### Problem 1.13.3: `NativeToolsResponseProcessor` Class is Dead Code ✅ NEW FINDING
- **Severity:** LOW
- **File:** `src/helpers/native-tools-response-processor.ts`
- **Description:** The `NativeToolsResponseProcessor` class (`processNativeToolResponse()`, `processGroundingMetadata()`) is defined but never imported or used anywhere in the codebase. `gemini-client.ts` does NOT import this file.
- **Solution:** Either delete the file, or integrate it into `gemini-client.ts`'s SSE parsing loop to properly handle `url_context_metadata` parts and grounding metadata from streaming responses (currently these are not processed in the stream).

---

#### Problem 1.13.4: `ENABLE_FAKE_THINKING` Fires on Thinking Models — Wrong Condition ✅ NEW FINDING
- **Severity:** MEDIUM
- **File:** `src/gemini-client.ts` (line 384), `src/models.ts`
- **Confirmed Code:**
  ```ts
  // gemini-client.ts:384 — triggers if model has thinking:true AND fake thinking is on
  if (isThinkingModel && isFakeThinkingEnabled && !includeReasoning) {
      yield* this.generateReasoningOutput(...);
  }
  ```
  ```ts
  // models.ts — EVERY model has thinking: true
  "gemini-3.1-pro-preview": { ..., thinking: true },
  "gemini-2.5-flash":       { ..., thinking: true },
  // ALL 7 models: thinking: true
  ```
- **Description:** `ENABLE_FAKE_THINKING` was designed to simulate reasoning for models that don't have real thinking support. But every registered model in `models.ts` has `thinking: true`. This means:
  1. If `ENABLE_FAKE_THINKING=true` and `ENABLE_REAL_THINKING=false`: fake thinking fires on **every** request (even pro models that have real thinking). The user gets emoji placeholder reasoning instead of real thinking.
  2. There is no true "non-thinking model" in the model list to apply this feature to as originally intended.
  3. Clients that parse reasoning content programmatically will receive hardcoded emoji text in the reasoning field.
- **The feature itself is intentional** — it's useful for clients that require a `<thinking>` block to function (some Cline-like clients). The **bug** is that the condition doesn't distinguish between "model supports thinking but real thinking is disabled" vs. "model doesn't support thinking at all".
- **Solution:** The condition should be: only fire fake thinking when `!isThinkingModel || !isRealThinkingEnabled`. Better yet, add a separate `supportsRealThinking` flag to `ModelInfo` so that future truly non-thinking models can be added. Add a clear comment explaining why fake thinking exists. Consider adding a warning log when fake thinking fires on a model that supports real thinking.

---

#### Problem 1.13.5: Fake Thinking `setTimeout` Delays — Needs Better Documentation ✅ NEW FINDING
- **Severity:** LOW (documentation issue, not a bug)
- **File:** `src/gemini-client.ts` (lines 458, 498, 514), `src/constants.ts`
- **Confirmed Code:**
  ```ts
  await new Promise((resolve) => setTimeout(resolve, 50)); // per chunk
  await new Promise((resolve) => setTimeout(resolve, REASONING_CHUNK_DELAY)); // 100ms
  ```
- **Description:** For a 2,000-char thinking block with chunk size 15: ~133 × 50ms = ~6.65 seconds of artificial delay. This is **intentional** — it simulates a realistic streaming reasoning experience for clients that expect to see text appear progressively. However, the code has no comments explaining this intent, making it look like accidental latency to future maintainers.
- **Solution:** Add JSDoc comments explaining this is intentional UX delay for realistic streaming simulation. Consider making both `REASONING_CHUNK_DELAY` (100ms) and the per-chunk delay (50ms) configurable via env vars so power users can speed it up. Increasing `THINKING_CONTENT_CHUNK_SIZE` from 15 to ~100 would significantly reduce the number of delay iterations while still looking smooth.

---

## Section 2: Implementation Priority Matrix

| Priority | Problem IDs | Estimated Effort | Business Impact |
|----------|-------------|-----------------|-----------------|
| **CRITICAL** | 1.1.1, 1.1.3, 1.2.2, 1.3.0, 1.13.1 | 6 hours | Fixes all tool calling, prevents hangs, stops KV quota burn |
| **HIGH** | 1.1.0, 1.1.2, 1.2.1, 1.2.5, 1.13.0, 1.13.2 | 10 hours | Major reliability improvements |
| **MEDIUM** | 1.2.3, 1.2.4, 1.3.0b, 1.3.1, 1.3.2, 1.3.3, 1.4.0, 1.4.1, 1.5.0, 1.5.1, 1.6.1, 1.8.1, 1.8.3, 1.9.3, 1.13.4 | 16 hours | Better robustness, security, validation |
| **LOW** | 1.4.2, 1.4.3, 1.5.2, 1.6.2, 1.6.3, 1.7.1, 1.7.2, 1.9.1, 1.9.2, 1.10.1, 1.10.2, 1.11.1, 1.11.2, 1.12.1, 1.12.2, 1.13.3, 1.13.5 | 10 hours | Polished experience, maintainability |

**Total Estimated Time:** ~42 hours

---

## Section 3: Recommended Implementation Order

### Week 1 — Critical Fixes (Core Functionality)

1. **Fix 1.1.3**: `functionResponse.name` must use function name, not call ID
2. **Fix 1.13.1**: Move system prompt to `systemInstruction` field
3. **Fix 1.2.2**: Add `AbortController` timeout to all `fetch` calls
4. **Fix 1.3.0**: Remove `markAccountHealthy()` call from `callEndpoint()`
5. **Fix 1.1.1**: Add `FORCE_OPENAI_TOOL_FORMAT` env var for Kilo Code compatibility
6. **Fix 1.13.6**: Move OAuth secret to Cloudflare Secret env var

### Week 2 — High Priority

7. **Fix 1.1.0**: Group parallel tool responses into single Gemini `user` message
8. **Fix 1.13.0**: Prevent double `initializeAuth()` call per request
9. **Fix 1.13.2**: Change `stream` default from `true` to `false` to match OpenAI spec
10. **Fix 1.2.5**: Add retry with exponential backoff for 500/502/504
11. **Fix 1.1.2**: Honour `tool_choice` for native tools

### Week 3 — Medium Priority

12. **Fix 1.5.0**: Concatenate multiple system messages
13. **Fix 1.3.0b**: KV optimistic locking for rotation state
14. **Fix 1.8.3**: Inbound rate limiter middleware
15. **Fix 1.6.1**: Request correlation IDs
16. **Fix 1.9.3**: Pass full options to non-streaming fallback
17. **Fix 1.11.1**: Optional image fetch + base64 conversion

### Week 4 — Low Priority & Testing

18. **Fix 1.13.4**: Correct `ENABLE_FAKE_THINKING` condition — only fire when `!isThinkingModel || !isRealThinkingEnabled`
19. All remaining LOW items
20. **Remove 1.13.3**: Delete or integrate `NativeToolsResponseProcessor`
21. Write unit tests for tool format conversion, retry logic, auth

---

## Section 4: Environment Variables Reference (Current + Proposed)

### Current Variables
| Variable | Default | Description |
|----------|---------|-------------|
| `GCP_SERVICE_ACCOUNT` | Required | OAuth2 credentials JSON (single object or array) |
| `GEMINI_CLI_KV` | Required | Cloudflare KV namespace binding |
| `OPENAI_API_KEY` | None | Optional bearer token auth for this proxy |
| `GEMINI_PROJECT_ID` | Auto-detected | Override project ID |
| `ENABLE_FAKE_THINKING` | `false` | Stream fake thinking for thinking models |
| `ENABLE_REAL_THINKING` | `false` | Stream real Gemini thinking tokens |
| `STREAM_THINKING_AS_CONTENT` | `false` | Emit thinking inside `<thinking>` tags |
| `ENABLE_AUTO_MODEL_SWITCHING` | `false` | Auto-downgrade model on 429 |
| `ENABLE_MULTI_ACCOUNT` | `false` | Multi-account OAuth rotation |
| `ENABLE_GEMINI_NATIVE_TOOLS` | `false` | Enable Google Search / URL Context tools |
| `ENABLE_GOOGLE_SEARCH` | `false` | Enable Google Search grounding |
| `ENABLE_URL_CONTEXT` | `false` | Enable URL Context tool |
| `ENABLE_INLINE_CITATIONS` | `false` | Inline citation links in responses |

### Proposed New Variables
| Variable | Default | Fixes |
|----------|---------|-------|
| `REQUEST_TIMEOUT_MS` | `120000` | Problem 1.2.2 |
| `FORCE_OPENAI_TOOL_FORMAT` | `false` | Problem 1.1.1 |
| `RATE_LIMIT_REQUESTS_PER_MINUTE` | `60` | Problem 1.8.3 |
| `MAX_ACCOUNT_FAILURES` | `3` | Problem 1.3.3 |
| `MAX_IMAGE_SIZE_MB` | `20` | Problem 1.11.2 |
| `ALLOWED_ORIGINS` | `*` | Problem 1.12.1 |
| `DISABLE_REQUEST_BODY_LOGGING` | `false` | Problem 1.8.1 |
| `THINKING_CHUNK_SIZE` | `100` | Problem 1.4.2, 1.13.5 |

---

## Section 5: Testing Checklist

### Critical Pre-Deploy Tests
- [ ] Tool call round-trip with parallel calls works (Gemini 200, not 400)
- [ ] System prompt sent via `systemInstruction` field, not as user message
- [ ] Request with no `stream` field returns JSON, not SSE
- [ ] Requests to hung upstream return 408/timeout error after `REQUEST_TIMEOUT_MS`
- [ ] KV write count is ≤ 2 per request in multi-account mode (token cache only)

### Regression Tests
- [ ] Single-account mode streaming works
- [ ] Single-account mode non-streaming works
- [ ] Multi-account rotation fires on 429
- [ ] Auto model switching fires on rate limit
- [ ] Auth token refresh works on expiry
- [ ] Image upload (base64) works
- [ ] Kilo Code compatible tool use (with `FORCE_OPENAI_TOOL_FORMAT=true`)

### Security Tests
- [ ] OAuth secret not in source code or logs
- [ ] Request body logger doesn't log message content
- [ ] Debug endpoints reject unauthenticated access (when `OPENAI_API_KEY` is set)
- [ ] CORS whitelist enforced when `ALLOWED_ORIGINS` is set

---

## Section 6: Files Requiring Changes

| File | Changes Required | Priority |
|------|-----------------|----------|
| `src/gemini-client.ts` | Fix `functionResponse.name`, move system prompt to `systemInstruction`, group parallel tool messages, AbortController timeout, `NativeToolsResponseProcessor` integration | Critical |
| `src/config.ts` | Remove hardcoded OAuth secret | Critical |
| `src/types.ts` | Add new env vars to `Env` interface | Critical |
| `src/auth.ts` | Remove `markAccountHealthy()` from `callEndpoint()`, add init flag, KV locking, progressive cooldowns | Critical/High |
| `src/routes/openai.ts` | Fix `stream` default, remove dual `initializeAuth()`, add input validation, concatenate system messages | High |
| `src/helpers/generation-config-validator.ts` | Honour `tool_choice` for native tools, add `FORCE_OPENAI_TOOL_FORMAT` logic | High |
| `src/helpers/auto-model-switching.ts` | Pass full options in non-streaming fallback | Medium |
| `src/constants.ts` | Add timeout/retry/chunk size constants | Critical |
| `src/middlewares/logging.ts` | Stop logging message content, add request ID | Medium |
| `src/middlewares/auth.ts` | No changes needed | — |
| `src/helpers/citations-processor.ts` | Global dedup, cross-chunk offset tracking | Low |
| `src/utils/image-utils.ts` | Add size validation | Low |
| `src/helpers/native-tools-response-processor.ts` | Integrate or delete (currently dead code) | Low |
| **NEW** `src/middlewares/rate-limiter.ts` | Create inbound rate limiter | Medium |
| **NEW** `src/utils/logger.ts` | Structured logger with request ID | Low |

---

## Section 7: Post-Implementation Findings & Architectural Additions

> These items were discovered during the code review pass after initial implementation and subsequently fixed.

---

### 7.1 `_initialized` Flag Never Set in `initializeAuth()` ✅ FIXED
- **Severity:** HIGH — 2A guard was completely non-functional
- **File:** `src/auth.ts`
- **Problem:** Fix 2A added `if (this._initialized && this.accessToken) { return; }` guard to prevent double initialization. However, `this._initialized = true` was never assigned anywhere, so the guard always evaluated to `false` and every request still ran the full auth flow.
- **Fix:** Added `this._initialized = true` after the successful try/catch block at the end of `initializeAuth()`.

---

### 7.2 Unused `RATE_LIMIT_STATUS_CODES` Import in `auth.ts` ✅ FIXED
- **Severity:** LOW
- **File:** `src/auth.ts`
- **Problem:** `RATE_LIMIT_STATUS_CODES` was imported from `constants.ts` but never referenced in `auth.ts`.
- **Fix:** Removed the unused import.

---

### 7.3 Inline `import` Statement Mid-File in `index.ts` ✅ FIXED
- **Severity:** LOW (code quality)
- **File:** `src/index.ts`
- **Problem:** `import { rateLimiterMiddleware }` was placed at line 77 (mid-file, after middleware setup code) instead of at the top with all other imports.
- **Fix:** Moved import to the top imports block.

---

### 7.4 Duplicate `OpenAIFinalChunk` Interface Declaration ✅ FIXED
- **Severity:** LOW (code quality)
- **File:** `src/stream-transformer.ts`
- **Problem:** `OpenAIFinalChunk` was declared twice — once with `error?` field and again with `usage?` field. TypeScript silently merges duplicate interface declarations, but this is confusing and fragile.
- **Fix:** Merged into one interface with both `error?` and `usage?` fields. Also replaced the `as any` cast in the usage fallback with the properly typed `as UsageData`.

---

### 7.5 `CUSTOM_MODELS_JSON` Removed — JSON File Used Instead ✅ IMPLEMENTED
- **Severity:** N/A (architectural improvement)
- **Files:** `src/models.ts`, `src/models.json`, `src/types.ts`, `tsconfig.json`
- **Change:** Removed the `CUSTOM_MODELS_JSON` environment variable approach in favour of a user-editable `src/models.json` file bundled at deploy time by Wrangler. This is more user-friendly — edit the JSON file and redeploy, no TypeScript changes required.
- **Fallback:** `src/models.ts` retains a minimal 2-model inline fallback (`gemini-3.1-pro-preview`, `gemini-2.5-pro`) used only if `models.json` is missing or corrupt.
- **`tsconfig.json`:** Added `"resolveJsonModule": true` to enable the JSON import.
- **Helper functions** (`getModelInfo`, `getAllModelIds`, `isValidModel`) simplified — `env` parameter removed since models are static at bundle time.

---

### 7.6 `ENABLE_FAKE_THINKING` Default Changed to `false` ✅ UPDATED
- **Severity:** LOW (UX improvement)
- **Files:** `.dev.vars.example`, `.dev.vars`
- **Change:** Default example value changed from `true` to `false`. With all Gemini models supporting real thinking, fake thinking should be opt-in, not opt-in-by-default.

---

### 7.7 `ROTATION_STRATEGY` Removed from Config ✅ CLEANED
- **Severity:** LOW
- **Files:** `.dev.vars`
- **Problem:** `ROTATION_STRATEGY=ACCOUNT_FIRST` was present in `.dev.vars` but this variable is not read anywhere in the codebase.
- **Fix:** Removed from both config files.
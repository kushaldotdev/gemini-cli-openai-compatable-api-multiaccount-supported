import { Context, Next } from "hono";
import { Env } from "../types";

/**
 * Logging middleware for request/response tracking
 *
 * Logs:
 * - Request start with method, path, and body (for POST/PUT/PATCH)
 * - Request completion with status code and duration
 * - Masks sensitive data in request bodies
 */
export const loggingMiddleware = async (c: Context<{ Bindings: Env }>, next: Next) => {
	const requestId = crypto.randomUUID().slice(0, 8);
	const method = c.req.method;
	const path = c.req.path;
	const startTime = Date.now();

	// Attach requestId to response header so it's traceable
	c.header("X-Request-ID", requestId);

	// Log request body for POST/PUT/PATCH requests
	let bodyLog = "";
	if (["POST", "PUT", "PATCH"].includes(method)) {
		try {
			// Clone the request to read the body without consuming it
			const clonedReq = c.req.raw.clone();
			const body = await clonedReq.text();

			// Log metadata only, never message content
			try {
				const parsed = JSON.parse(body);
				bodyLog = ` model=${parsed.model ?? "?"} msgs=${parsed.messages?.length ?? "?"} stream=${parsed.stream ?? "?"}`;
			} catch {
				bodyLog = " [non-JSON body]";
			}
		} catch {
			bodyLog = " [unreadable body]";
		}
	}

	console.log(`[${requestId}] ${method} ${path}${bodyLog}`);

	await next();

	const duration = Date.now() - startTime;
	console.log(`[${requestId}] ${method} ${path} → ${c.res.status} (${duration}ms)`);
};

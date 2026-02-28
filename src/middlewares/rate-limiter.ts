import { MiddlewareHandler } from "hono";
import { Env } from "../types";

export const rateLimiterMiddleware: MiddlewareHandler<{ Bindings: Env }> = async (c, next) => {
	const limitPerMinute = parseInt(c.env.RATE_LIMIT_REQUESTS_PER_MINUTE || "0", 10);
	if (!limitPerMinute || !c.env.GEMINI_CLI_KV) {
		await next();
		return;
	}

	// Use the API key or fallback to IP for the rate limit key
	const authHeader = c.req.header("Authorization") || "";
	const keyId = authHeader.replace("Bearer ", "").substring(0, 32) || "anonymous";
	const windowKey = `ratelimit_${keyId}_${Math.floor(Date.now() / 60000)}`; // 1-minute window

	const current = await c.env.GEMINI_CLI_KV.get(windowKey);
	const count = parseInt(current || "0", 10);

	if (count >= limitPerMinute) {
		return c.json(
			{
				error: {
					message: "Rate limit exceeded. Too many requests.",
					type: "rate_limit_error",
					code: "rate_limit_exceeded"
				}
			},
			429,
			{
				"Retry-After": "60"
			}
		);
	}

	// Increment counter with 70-second TTL (covers the full minute window with buffer)
	await c.env.GEMINI_CLI_KV.put(windowKey, String(count + 1), { expirationTtl: 70 });
	await next();
};

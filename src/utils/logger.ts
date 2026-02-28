/**
 * Structured logger utility with standard levels.
 */

export type LogLevel = "DEBUG" | "INFO" | "WARN" | "ERROR";

export class Logger {
	private requestId: string;

	constructor(requestId: string) {
		this.requestId = requestId;
	}

	private log(level: LogLevel, message: string, meta?: Record<string, unknown>) {
		const entry = {
			timestamp: new Date().toISOString(),
			requestId: this.requestId,
			level,
			message,
			...meta
		};
		// stringify securely
		let output = "";
		try {
			output = JSON.stringify(entry);
		} catch {
			output = `[${entry.timestamp}] [${this.requestId}] [${level}] ${message} (meta could not be serialized)`;
		}
		
		if (level === "ERROR") {
			console.error(output);
		} else if (level === "WARN") {
			console.warn(output);
		} else if (level === "INFO") {
			console.info(output);
		} else {
			console.log(output);
		}
	}

	public debug(message: string, meta?: Record<string, unknown>) {
		this.log("DEBUG", message, meta);
	}

	public info(message: string, meta?: Record<string, unknown>) {
		this.log("INFO", message, meta);
	}

	public warn(message: string, meta?: Record<string, unknown>) {
		this.log("WARN", message, meta);
	}

	public error(message: string, meta?: Record<string, unknown>) {
		this.log("ERROR", message, meta);
	}
}

/** Centralizes console output so every diagnostic is easy to filter. */

const LOG_PREFIX = "[CleanForward]";

/** Logging surface used by the application modules. */
export interface Logger {
  /** Writes low-level diagnostics useful while researching Telegram DOM changes. */
  debug(message: string, details?: unknown): void;
  /** Writes lifecycle and successful-action messages. */
  info(message: string, details?: unknown): void;
  /** Writes recoverable integration problems. */
  warn(message: string, details?: unknown): void;
  /** Writes unexpected failures. */
  error(message: string, details?: unknown): void;
}

function write(
  method: "debug" | "info" | "warn" | "error",
  message: string,
  details?: unknown,
): void {
  const output = details === undefined ? [LOG_PREFIX, message] : [LOG_PREFIX, message, details];
  console[method](...output);
}

/** Default application logger with the required userscript prefix. */
export const logger: Logger = {
  debug: (message, details) => write("debug", message, details),
  info: (message, details) => write("info", message, details),
  warn: (message, details) => write("warn", message, details),
  error: (message, details) => write("error", message, details),
};

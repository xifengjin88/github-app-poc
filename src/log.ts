import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Opt-in review tracing. Set REVIEW_DEBUG=1 to log how each review was produced
 * (the diff sent, Archera tool calls/results, token usage, final review object)
 * to the console and a JSON file under REVIEW_LOG_DIR (default ./logs).
 */
export function reviewDebugEnabled(): boolean {
  const v = process.env.REVIEW_DEBUG;
  return Boolean(v) && v !== "0" && v !== "false";
}

const LOG_DIR = process.env.REVIEW_LOG_DIR ?? "logs";

/** Write a full review trace to a JSON file (no-op unless REVIEW_DEBUG is set). */
export function writeReviewLog(name: string, data: unknown): string | null {
  if (!reviewDebugEnabled()) return null;
  try {
    mkdirSync(LOG_DIR, { recursive: true });
    const file = join(LOG_DIR, `${name}.json`);
    writeFileSync(file, JSON.stringify(data, null, 2));
    console.log(`[review-debug] full trace → ${file}`);
    return file;
  } catch (error) {
    console.error("[review-debug] failed to write trace", error);
    return null;
  }
}

/** Truncate a string for compact logging. */
export function trunc(value: string, max = 1200): string {
  return value.length > max ? `${value.slice(0, max)}…[truncated]` : value;
}

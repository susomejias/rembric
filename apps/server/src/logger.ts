import { LOG_LEVELS, type LogLevel } from './config.js';

/**
 * Minimal leveled logger honoring the `LOG_LEVEL` config knob. Always
 * writes to stderr (never stdout — stdout is reserved for the MCP stdio
 * transport's JSON-RPC stream), matching the existing bootstrap logging
 * convention. `setLevel` is called once at boot from the loaded `Config`;
 * everything logged before that call uses the default ('info').
 */

const LEVEL_RANK: Record<LogLevel, number> = Object.fromEntries(
  LOG_LEVELS.map((level, index) => [level, index]),
) as Record<LogLevel, number>;

let currentLevel: LogLevel = 'info';

export function setLogLevel(level: LogLevel): void {
  currentLevel = level;
}

function shouldLog(level: LogLevel): boolean {
  return LEVEL_RANK[level] >= LEVEL_RANK[currentLevel];
}

function write(level: LogLevel, message: string, meta?: Record<string, unknown>): void {
  if (!shouldLog(level)) return;
  const suffix = meta ? ` ${JSON.stringify(meta)}` : '';
  console.error(`[${level}] ${message}${suffix}`);
}

export const logger = {
  debug: (message: string, meta?: Record<string, unknown>) => write('debug', message, meta),
  info: (message: string, meta?: Record<string, unknown>) => write('info', message, meta),
  warn: (message: string, meta?: Record<string, unknown>) => write('warn', message, meta),
  error: (message: string, meta?: Record<string, unknown>) => write('error', message, meta),
};

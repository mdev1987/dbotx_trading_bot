import { CONFIG } from "../config";

const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 } as const;
type Level = keyof typeof LEVELS;

const currentLevel: Level = (CONFIG.logLevel.toLowerCase() as Level) ?? "info";

function shouldLog(level: Level): boolean {
  return LEVELS[level] >= LEVELS[currentLevel];
}

function prefix(level: Level): string {
  switch (level) {
    case "debug": return "[DEBUG]";
    case "info":  return "[INFO]";
    case "warn":  return "[WARN]";
    case "error": return "[ERROR]";
  }
}

export const logger = {
  debug: (...args: unknown[]) => {
    if (shouldLog("debug")) console.log(prefix("debug"), ...args);
  },
  info: (...args: unknown[]) => {
    if (shouldLog("info")) console.log(prefix("info"), ...args);
  },
  warn: (...args: unknown[]) => {
    if (shouldLog("warn")) console.warn(prefix("warn"), ...args);
  },
  error: (...args: unknown[]) => {
    if (shouldLog("error")) console.error(prefix("error"), ...args);
  },
};

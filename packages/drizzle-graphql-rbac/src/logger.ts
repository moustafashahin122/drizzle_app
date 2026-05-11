/**
 * @module drizzle-graphql-rbac/logger
 *
 * Shared pino root logger for the framework. Consumers may either import
 * `logger` and call `logger.child({ component: "..." })`, or construct
 * their own pino instance — there is no custom wrapper.
 *
 * Configuration precedence (highest first):
 *  - CLI flag `--log-level=<level>` (or `--log-level <level>`).
 *  - `LOG_LEVEL` env var.
 *  - Default `info`.
 *
 * Pretty output (via `pino-pretty`) is used when stdout is a TTY and
 * `NO_COLOR` is unset. Otherwise pino emits newline-delimited JSON.
 */
import { pino } from "pino";

const VALID_LEVELS = ["trace", "debug", "info", "warn", "error", "fatal", "silent"] as const;

function parseLogLevelFlag(argv: string[]): string | undefined {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg.startsWith("--log-level=")) return arg.slice("--log-level=".length);
    if (arg === "--log-level") return argv[i + 1];
  }
  return undefined;
}

const rawLevel = parseLogLevelFlag(process.argv.slice(2)) ?? process.env.LOG_LEVEL ?? "info";
const level = (VALID_LEVELS as readonly string[]).includes(rawLevel) ? rawLevel : "info";
const usePretty =
  Boolean(process.stdout.isTTY) &&
  (process.env.NO_COLOR == null || process.env.NO_COLOR === "");

export const logger = pino({
  level,
  timestamp: pino.stdTimeFunctions.isoTime,
  base: undefined,
  ...(usePretty
    ? {
        transport: {
          target: "pino-pretty",
          options: {
            colorize: true,
            translateTime: "SYS:isoDateTime",
            ignore: "pid,hostname",
            messageFormat: "{component} {msg}",
          },
        },
      }
    : {}),
});

export type { Logger } from "pino";

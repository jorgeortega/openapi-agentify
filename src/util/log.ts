/**
 * A small structured logger: one JSON line per event, secrets redacted before
 * they reach the sink (secrets, tokens and cookies redacted). Pass your own
 * `logger` in the config to send events to pino, winston or console.
 */

export interface Logger {
  debug(event: string, fields?: Record<string, unknown>): void;
  info(event: string, fields?: Record<string, unknown>): void;
  warn(event: string, fields?: Record<string, unknown>): void;
  error(event: string, fields?: Record<string, unknown>): void;
}

export type LogLevel = "debug" | "info" | "warn" | "error" | "silent";
const LEVELS: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40, silent: 99 };

const SECRET_KEY = /(authorization|api[_-]?key|secret|password|token|cookie|signature|payment|pepper)$/i;
const SECRET_VALUE = /\b(sk-[A-Za-z0-9_-]{8,}|[a-z]{2,8}_(live|test)_[A-Za-z0-9]{6,}_[A-Za-z0-9]{16,}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+)/g;
const MAX_STRING = 4_000;

export function redact(value: unknown, depth = 0, seen = new WeakSet<object>()): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === "string") {
    const s = value.replace(SECRET_VALUE, "[REDACTED]");
    return s.length > MAX_STRING ? `${s.slice(0, MAX_STRING)}…` : s;
  }
  if (typeof value === "bigint") return value.toString();
  if (typeof value !== "object") return value;
  if (value instanceof Error) return { name: value.name, message: redact(value.message, depth + 1, seen) };
  if (value instanceof Date) return value.toISOString();
  if (seen.has(value)) return "[Circular]";
  if (depth >= 6) return "[MaxDepth]";
  seen.add(value);
  if (Array.isArray(value)) return value.slice(0, 100).map((v) => redact(v, depth + 1, seen));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) out[k] = SECRET_KEY.test(k) ? "[REDACTED]" : redact(v, depth + 1, seen);
  return out;
}

export function createLogger(level: LogLevel = "info", sink: (line: string) => void = (l) => process.stderr.write(`${l}\n`)): Logger {
  const min = LEVELS[level];
  const emit = (lvl: Exclude<LogLevel, "silent">, event: string, fields?: Record<string, unknown>) => {
    if (LEVELS[lvl] < min) return;
    const record = { ts: new Date().toISOString(), level: lvl, event, component: "agentify", ...(fields ? (redact(fields) as Record<string, unknown>) : {}) };
    try {
      sink(JSON.stringify(record));
    } catch {
      sink(JSON.stringify({ ts: record.ts, level: lvl, event }));
    }
  };
  return {
    debug: (e, f) => emit("debug", e, f),
    info: (e, f) => emit("info", e, f),
    warn: (e, f) => emit("warn", e, f),
    error: (e, f) => emit("error", e, f),
  };
}

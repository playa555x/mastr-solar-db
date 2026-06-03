// P2-22: Strukturiertes JSON-Logging mit Trace-ID-Korrelation.
// In Produktion landet das in journalctl, von dort einfach mit jq filterbar.

import { randomBytes } from "crypto";

export type LogLevel = "debug" | "info" | "warn" | "error";

export function newTraceId(): string {
  return randomBytes(8).toString("hex");
}

function emit(level: LogLevel, msg: string, fields: Record<string, any> = {}) {
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    level,
    msg,
    ...fields,
  });
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

export const log = {
  debug: (msg: string, fields?: Record<string, any>) => emit("debug", msg, fields),
  info:  (msg: string, fields?: Record<string, any>) => emit("info", msg, fields),
  warn:  (msg: string, fields?: Record<string, any>) => emit("warn", msg, fields),
  error: (msg: string, fields?: Record<string, any>) => emit("error", msg, fields),
};

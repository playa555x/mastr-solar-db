// Opaque Cursor-Pagination Helper.
// Cursor = base64url-encoded JSON { id, ts }.
// - id: letzte gesehene Datensatz-ID (numeric)
// - ts: letzter gesehener created_at-Timestamp (ISO-String oder null)
//
// Vorteil gegenüber offset/limit: stabil bei wachsenden Datensätzen, kein O(N) skip.
// Use-Case: feed-artige Endpoints mit ORDER BY created_at DESC, id DESC.

export interface CursorPayload {
  id: number;
  ts: string | null;
}

function b64urlEncode(s: string): string {
  return Buffer.from(s, "utf-8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function b64urlDecode(s: string): string {
  try {
    const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
    return Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/") + pad, "base64").toString("utf-8");
  } catch { return ""; }
}

export function encodeCursor(payload: CursorPayload): string {
  return b64urlEncode(JSON.stringify(payload));
}

export function decodeCursor(c: string | null | undefined): CursorPayload | null {
  if (!c) return null;
  const raw = b64urlDecode(c);
  if (!raw) return null;
  try {
    const obj = JSON.parse(raw);
    if (typeof obj?.id !== "number") return null;
    return { id: obj.id, ts: typeof obj.ts === "string" ? obj.ts : null };
  } catch {
    return null;
  }
}

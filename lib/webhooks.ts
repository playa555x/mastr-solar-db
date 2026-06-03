// Outgoing Webhooks: subscribe externe Systeme auf Events (lead.created,
// anlage.status_changed, mention.created, anfrage.received).
//
// DB-Tabellen werden bei ensureWebhookTables() angelegt (idempotent).
// Delivery: HMAC-SHA256 in Header X-Webhook-Signature: sha256=<hex>
// Retry: 3 Versuche mit exponential backoff (15s, 60s, 300s) via setTimeout
//        (Best-Effort; bei Process-Restart geht offene Retry-Queue verloren).
// Logged in webhook_deliveries (id, webhook_id, event, payload, status_code, response_body, attempts, delivered_at).

import { createHmac, randomBytes } from "node:crypto";
import type { Database } from "bun:sqlite";

export type WebhookEvent =
  | "lead.created"               // /api/public/leads POST
  | "anfrage.received"            // /api/public/check POST (alias zu lead.created mit type=check)
  | "anlage.status_changed"
  | "anlage.owner_changed"
  | "mention.created"
  | "termin.created"
  | "reminder.due";

export const ALL_EVENTS: WebhookEvent[] = [
  "lead.created", "anfrage.received",
  "anlage.status_changed", "anlage.owner_changed",
  "mention.created", "termin.created", "reminder.due",
];

export interface Webhook {
  id: number;
  url: string;
  events: string;     // JSON-Array
  secret: string;
  enabled: number;
  description: string | null;
  created_by: number;
  created_at: string;
  last_status: number | null;
  last_delivery_at: string | null;
  last_error: string | null;
}

export function ensureWebhookTables(db: Database): void {
  db.run(`
    CREATE TABLE IF NOT EXISTS webhooks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      url TEXT NOT NULL,
      events TEXT NOT NULL,
      secret TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      description TEXT,
      created_by INTEGER NOT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      last_status INTEGER,
      last_delivery_at TEXT,
      last_error TEXT,
      FOREIGN KEY (created_by) REFERENCES users(id)
    )
  `);
  db.run("CREATE INDEX IF NOT EXISTS idx_webhooks_enabled ON webhooks(enabled)");
  db.run(`
    CREATE TABLE IF NOT EXISTS webhook_deliveries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      webhook_id INTEGER NOT NULL,
      event TEXT NOT NULL,
      payload TEXT NOT NULL,
      status_code INTEGER,
      response_body TEXT,
      attempts INTEGER NOT NULL DEFAULT 0,
      next_retry_at TEXT,
      delivered_at TEXT,
      error TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (webhook_id) REFERENCES webhooks(id)
    )
  `);
  db.run("CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_webhook ON webhook_deliveries(webhook_id, created_at DESC)");
}

export function generateWebhookSecret(): string {
  return "whsec_" + randomBytes(24).toString("base64url");
}

export function signPayload(secret: string, payload: string): string {
  return "sha256=" + createHmac("sha256", secret).update(payload).digest("hex");
}

export function createWebhook(db: Database, input: {
  url: string;
  events: WebhookEvent[];
  description?: string | null;
  created_by: number;
}): Webhook {
  if (!input.url || !/^https?:\/\//i.test(input.url)) throw new Error("URL muss mit http:// oder https:// beginnen");
  if (!Array.isArray(input.events) || input.events.length === 0) throw new Error("Mindestens ein Event auswaehlen");
  for (const e of input.events) {
    if (!ALL_EVENTS.includes(e)) throw new Error("Unbekanntes Event: " + e);
  }
  const secret = generateWebhookSecret();
  const r = db.prepare(`
    INSERT INTO webhooks (url, events, secret, description, created_by)
    VALUES (?, ?, ?, ?, ?)
  `).run(input.url, JSON.stringify(input.events), secret, input.description || null, input.created_by);
  return getWebhookById(db, Number(r.lastInsertRowid))!;
}

export function getWebhookById(db: Database, id: number): Webhook | null {
  return (db.prepare("SELECT * FROM webhooks WHERE id = ?").get(id) as Webhook | undefined) || null;
}

export function listWebhooks(db: Database): Webhook[] {
  return db.prepare("SELECT * FROM webhooks ORDER BY created_at DESC").all() as Webhook[];
}

export function updateWebhook(db: Database, id: number, patch: { url?: string; events?: WebhookEvent[]; enabled?: 0 | 1; description?: string | null }): void {
  const sets: string[] = []; const vals: any[] = [];
  if (patch.url !== undefined) {
    if (!/^https?:\/\//i.test(patch.url)) throw new Error("URL muss mit http:// oder https:// beginnen");
    sets.push("url = ?"); vals.push(patch.url);
  }
  if (patch.events !== undefined) {
    if (!Array.isArray(patch.events) || patch.events.length === 0) throw new Error("Mindestens ein Event auswaehlen");
    for (const e of patch.events) if (!ALL_EVENTS.includes(e)) throw new Error("Unbekanntes Event: " + e);
    sets.push("events = ?"); vals.push(JSON.stringify(patch.events));
  }
  if (patch.enabled !== undefined) { sets.push("enabled = ?"); vals.push(patch.enabled ? 1 : 0); }
  if (patch.description !== undefined) { sets.push("description = ?"); vals.push(patch.description); }
  if (sets.length === 0) return;
  vals.push(id);
  db.prepare(`UPDATE webhooks SET ${sets.join(", ")} WHERE id = ?`).run(...vals);
}

export function deleteWebhook(db: Database, id: number): void {
  db.prepare("DELETE FROM webhooks WHERE id = ?").run(id);
}

export function listDeliveries(db: Database, webhookId?: number, limit = 50): any[] {
  if (webhookId) {
    return db.prepare(`
      SELECT id, webhook_id, event, status_code, attempts, delivered_at, error, created_at
      FROM webhook_deliveries
      WHERE webhook_id = ?
      ORDER BY created_at DESC
      LIMIT ?
    `).all(webhookId, limit) as any[];
  }
  return db.prepare(`
    SELECT id, webhook_id, event, status_code, attempts, delivered_at, error, created_at
    FROM webhook_deliveries
    ORDER BY created_at DESC
    LIMIT ?
  `).all(limit) as any[];
}

// Per-event delivery. Skips disabled webhooks und nicht-subscribierte.
// Asynchron, blockt den Caller nicht.
export function fireEvent(db: Database, event: WebhookEvent, data: any): void {
  // 1) Webhook-Subscriber (externe Systeme)
  const targets = db.prepare("SELECT * FROM webhooks WHERE enabled = 1").all() as Webhook[];
  for (const w of targets) {
    let evs: string[] = [];
    try { evs = JSON.parse(w.events); } catch { continue; }
    if (!evs.includes(event)) continue;
    const payload = JSON.stringify({
      event,
      timestamp: new Date().toISOString(),
      delivery_id: randomBytes(8).toString("hex"),
      data,
    });
    const insert = db.prepare(`
      INSERT INTO webhook_deliveries (webhook_id, event, payload, attempts)
      VALUES (?, ?, ?, 0)
    `).run(w.id, event, payload);
    void deliverWithRetry(db, w, event, payload, Number(insert.lastInsertRowid), 0);
  }
  // 2) Admin-Telegram-Benachrichtigung über globalen Bot (fire-and-forget).
  //    Dynamic-Import vermeidet Zyklen lib/webhooks <-> lib/telegram-commands.
  void (async () => {
    try {
      const { notifyAdminsViaBot, formatEventSummary } = await import("./telegram-commands");
      const summary = formatEventSummary(event, data);
      await notifyAdminsViaBot(db, event, summary);
    } catch (e) { console.error("[webhooks] admin-bot notify failed:", e); }
  })();
}

async function deliverWithRetry(db: Database, w: Webhook, event: string, payload: string, deliveryId: number, attempt: number): Promise<void> {
  const signature = signPayload(w.secret, payload);
  let statusCode = 0;
  let responseBody = "";
  let errorMsg: string | null = null;
  try {
    const ac = new AbortController();
    const to = setTimeout(() => ac.abort(), 10_000); // 10s timeout
    const r = await fetch(w.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": "mastr-solar-webhook/1.0",
        "X-Webhook-Event": event,
        "X-Webhook-Signature": signature,
        "X-Webhook-Delivery": String(deliveryId),
      },
      body: payload,
      signal: ac.signal,
    });
    clearTimeout(to);
    statusCode = r.status;
    try { responseBody = (await r.text()).substring(0, 2000); } catch {}
  } catch (e: any) {
    errorMsg = e?.message || String(e);
  }
  const newAttempts = attempt + 1;
  const isSuccess = statusCode >= 200 && statusCode < 300;
  if (isSuccess) {
    db.prepare(`
      UPDATE webhook_deliveries
      SET status_code = ?, response_body = ?, attempts = ?, delivered_at = CURRENT_TIMESTAMP, error = NULL, next_retry_at = NULL
      WHERE id = ?
    `).run(statusCode, responseBody, newAttempts, deliveryId);
    db.prepare(`
      UPDATE webhooks SET last_status = ?, last_delivery_at = CURRENT_TIMESTAMP, last_error = NULL WHERE id = ?
    `).run(statusCode, w.id);
    try {
      const { publish } = await import("./sse-bus");
      publish("webhook.delivery", { delivery_id: deliveryId, webhook_id: w.id, event, status_code: statusCode, ok: true, attempts: newAttempts });
    } catch {}
    return;
  }
  // Retry-Logik: 3 Versuche insgesamt (initial + 2 retries) mit 15s/60s exponential backoff
  const maxAttempts = 3;
  const backoffMs = [15_000, 60_000][attempt] || 0;
  const nextRetry = backoffMs > 0 && newAttempts < maxAttempts ? new Date(Date.now() + backoffMs).toISOString() : null;
  db.prepare(`
    UPDATE webhook_deliveries
    SET status_code = ?, response_body = ?, attempts = ?, error = ?, next_retry_at = ?
    WHERE id = ?
  `).run(statusCode || null, responseBody || null, newAttempts, errorMsg, nextRetry, deliveryId);
  db.prepare(`
    UPDATE webhooks SET last_status = ?, last_delivery_at = CURRENT_TIMESTAMP, last_error = ? WHERE id = ?
  `).run(statusCode || null, errorMsg || `HTTP ${statusCode}`, w.id);
  try {
    const { publish } = await import("./sse-bus");
    publish("webhook.delivery", { delivery_id: deliveryId, webhook_id: w.id, event, status_code: statusCode || 0, ok: false, attempts: newAttempts, error: errorMsg, will_retry: !!nextRetry });
  } catch {}
  if (nextRetry) {
    setTimeout(() => { void deliverWithRetry(db, w, event, payload, deliveryId, newAttempts); }, backoffMs);
  }
}

// Manueller Test-Trigger (Admin UI): liefert sofort den Status zurueck.
export async function testWebhook(db: Database, id: number): Promise<{ status: number; ok: boolean; body: string; error: string | null }> {
  const w = getWebhookById(db, id);
  if (!w) throw new Error("Webhook nicht gefunden");
  const payload = JSON.stringify({
    event: "webhook.test",
    timestamp: new Date().toISOString(),
    delivery_id: "test_" + randomBytes(4).toString("hex"),
    data: { message: "Dies ist ein Test-Ping von mastr-solar." },
  });
  const signature = signPayload(w.secret, payload);
  try {
    const ac = new AbortController();
    const to = setTimeout(() => ac.abort(), 10_000);
    const r = await fetch(w.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Webhook-Event": "webhook.test",
        "X-Webhook-Signature": signature,
      },
      body: payload,
      signal: ac.signal,
    });
    clearTimeout(to);
    const body = (await r.text()).substring(0, 2000);
    return { status: r.status, ok: r.ok, body, error: null };
  } catch (e: any) {
    return { status: 0, ok: false, body: "", error: e?.message || String(e) };
  }
}

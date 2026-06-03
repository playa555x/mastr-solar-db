/*
  Claude-CLI-Integration: nutzt den `claude` Subprocess statt direkter API-Key-Calls.
  Vorteil: Single-Tenant Setup ohne API-Key, OAuth-basiert.
  Auth-Repair: erkennt Broken-Auth, schreibt Status, benachrichtigt Admin via Telegram/Email.
*/
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { Database } from "bun:sqlite";

const CLAUDE_BIN = process.env.CLAUDE_BIN || "/usr/local/bin/claude";
const STATUS_FILE = process.env.CLAUDE_AUTH_STATUS_FILE || "/opt/mastr-solar/data/.claude-auth-status.json";
// Default-Modell — kann ueber Env ueberschrieben werden.
const DEFAULT_MODEL = process.env.CLAUDE_CLI_MODEL || "claude-haiku-4-5-20251001";

export interface ClaudeAuthStatus {
  ok: boolean;
  last_check_iso: string;
  last_ok_iso: string | null;
  last_error: string | null;
  notified_at: string | null;   // wann wurde admin zuletzt benachrichtigt
  consecutive_failures: number;
}

function readStatus(): ClaudeAuthStatus {
  try {
    if (existsSync(STATUS_FILE)) {
      return JSON.parse(readFileSync(STATUS_FILE, "utf8"));
    }
  } catch {}
  return {
    ok: false,
    last_check_iso: new Date(0).toISOString(),
    last_ok_iso: null,
    last_error: null,
    notified_at: null,
    consecutive_failures: 0,
  };
}

function writeStatus(s: ClaudeAuthStatus): void {
  try {
    mkdirSync(dirname(STATUS_FILE), { recursive: true });
    writeFileSync(STATUS_FILE, JSON.stringify(s, null, 2));
  } catch (e) {
    console.error("claude-cli: status write failed", e);
  }
}

export function getClaudeAuthStatus(): ClaudeAuthStatus {
  return readStatus();
}

/**
 * Run claude CLI in print-mode with prompt on stdin.
 * Returns { stdout, stderr, code, duration_ms }.
 */
async function runClaude(prompt: string, opts: { systemPrompt?: string; model?: string; timeoutMs?: number } = {}): Promise<{
  stdout: string; stderr: string; code: number | null; duration_ms: number;
}> {
  const args = ["-p", "--model", opts.model || DEFAULT_MODEL];
  if (opts.systemPrompt) args.push("--append-system-prompt", opts.systemPrompt);
  return new Promise((resolve) => {
    const start = Date.now();
    const child = spawn(CLAUDE_BIN, args, {
      stdio: ["pipe", "pipe", "pipe"],
      // Wichtig: --bare nicht setzen, damit OAuth/Keychain genutzt wird
      env: { ...process.env },
    });
    let stdout = "", stderr = "";
    child.stdout.on("data", (d) => { stdout += d.toString(); });
    child.stderr.on("data", (d) => { stderr += d.toString(); });
    const timer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch {}
    }, opts.timeoutMs || 120_000);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, code, duration_ms: Date.now() - start });
    });
    child.stdin.write(prompt);
    child.stdin.end();
  });
}

/**
 * Health-Check: ruft Claude mit einem trivialen Prompt auf.
 * Aktualisiert STATUS_FILE und triggert Notification wenn Auth broken.
 */
export async function checkClaudeAuth(db?: Database, opts: { silent?: boolean } = {}): Promise<ClaudeAuthStatus> {
  const before = readStatus();
  const result = await runClaude("Antworte mit genau diesem Wort: OK", { timeoutMs: 30_000 });
  const now = new Date().toISOString();

  const looksOk = result.code === 0 && /\bOK\b/i.test(result.stdout) && !result.stderr.includes("authentication_error");
  if (looksOk) {
    const status: ClaudeAuthStatus = {
      ok: true,
      last_check_iso: now,
      last_ok_iso: now,
      last_error: null,
      notified_at: before.notified_at,    // notification-state nicht zuruecksetzen — admin sieht das
      consecutive_failures: 0,
    };
    writeStatus(status);
    return status;
  }

  // Fail
  const errMsg = result.stderr || result.stdout || `exit code ${result.code}`;
  const status: ClaudeAuthStatus = {
    ok: false,
    last_check_iso: now,
    last_ok_iso: before.last_ok_iso,
    last_error: errMsg.substring(0, 1000),
    notified_at: before.notified_at,
    consecutive_failures: before.consecutive_failures + 1,
  };

  // Notification: nur wenn frischer Fehler (1. consecutive_failure) oder lange her seit letzter
  if (db && !opts.silent) {
    const lastNotif = status.notified_at ? new Date(status.notified_at).getTime() : 0;
    const sinceNotif = Date.now() - lastNotif;
    const shouldNotify = (before.consecutive_failures === 0) || (sinceNotif > 6 * 3600_000);
    if (shouldNotify) {
      try {
        const { notify } = await import("./notifications");
        const admins = db.prepare(`SELECT id FROM users WHERE active = 1 AND (is_admin = 1 OR username = 'admin')`).all() as any[];
        for (const a of admins) {
          await notify(db, {
            userId: a.id,
            type: "assignment",
            titleKey: "notif.claude_auth_title",
            bodyKey: "notif.claude_auth_body",
            bodyArgs: { error: errMsg.substring(0, 400) },
            url: "/?#settings",
          });
        }
        status.notified_at = now;
      } catch (e) {
        console.error("claude-cli: notify failed", e);
      }
    }
  }
  writeStatus(status);
  return status;
}

/**
 * Antwort von Claude erzeugen — fuer KI-Calls aus der App.
 * Auto-Repair: bei Auth-Fehler wird Status gesetzt, Admin benachrichtigt,
 * und der Caller bekommt einen klaren Error.
 */
export async function callClaude(prompt: string, opts: { systemPrompt?: string; model?: string; db?: Database } = {}): Promise<string> {
  // Wenn STATUS sagt: nicht OK und letzter Check < 5min her → fail-fast
  const status = readStatus();
  const since = Date.now() - new Date(status.last_check_iso).getTime();
  if (!status.ok && since < 5 * 60_000) {
    throw new Error("Claude-CLI nicht authentifiziert — bitte 'claude /login' auf dem VPS ausfuehren. Letzter Fehler: " + (status.last_error || "unbekannt"));
  }

  const result = await runClaude(prompt, { systemPrompt: opts.systemPrompt, model: opts.model, timeoutMs: 180_000 });

  if (result.code !== 0 || result.stderr.includes("authentication_error") || /Invalid authentication/i.test(result.stdout)) {
    // Auth ist kaputt — Status updaten + Admin benachrichtigen
    void checkClaudeAuth(opts.db, { silent: false }).catch(() => {});
    throw new Error("Claude-CLI Aufruf fehlgeschlagen: " + (result.stderr || result.stdout || "exit " + result.code).substring(0, 300));
  }

  return result.stdout.trim();
}

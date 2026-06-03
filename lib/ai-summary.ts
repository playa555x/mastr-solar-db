import { decrypt } from "./crypto";

export interface CallContext {
  anlagenname: string;
  ort: string;
  bundesland: string;
  leistung: number | null;
  betreiber: string;
  current_status: string;
  duration_seconds: number | null;
  outcome: string | null;
  notes: string;
}

export interface AiResult {
  summary: string;
  next_steps: string[];
  sentiment: "positive" | "neutral" | "negative";
  status_suggest: string | null;
}

const SYSTEM_PROMPT = `Du bist ein Vertriebs-Assistent fuer einen Solar-Akquise-Workflow in Deutschland.
Aus den Notizen eines Akquise-Anrufs extrahierst du eine kompakte Zusammenfassung, naechste Schritte und eine Sentiment-Bewertung.
Antworte ausschliesslich mit JSON in folgendem Schema:
{
  "summary": "string (max 280 Zeichen, deutsch, sachlich)",
  "next_steps": ["string", ...] (1-4 konkrete naechste Aktionen, deutsch),
  "sentiment": "positive" | "neutral" | "negative",
  "status_suggest": "neu" | "kontaktiert" | "interessiert" | "nicht_interessiert" | "abgeschlossen" | null
}`;

function buildUserPrompt(c: CallContext): string {
  return [
    `Anruf-Kontext:`,
    `- Anlage: ${c.anlagenname}`,
    `- Ort: ${c.ort}${c.bundesland ? `, ${c.bundesland}` : ""}`,
    `- Leistung: ${c.leistung ? `${Math.round(c.leistung)} kWp` : "unbekannt"}`,
    `- Betreiber: ${c.betreiber}`,
    `- Status vor Anruf: ${c.current_status || "unbekannt"}`,
    `- Anruf-Dauer: ${c.duration_seconds ? `${Math.round(c.duration_seconds / 60)} Min ${c.duration_seconds % 60}s` : "unbekannt"}`,
    `- Outcome: ${c.outcome || "unbekannt"}`,
    ``,
    `Notiz vom Anruf:`,
    `"""${c.notes}"""`,
    ``,
    `Liefere JSON wie spezifiziert.`,
  ].join("\n");
}

export async function generateCallSummary(
  user: { ai_provider: string | null; anthropic_key_enc: string | null; ollama_url: string | null },
  ctx: CallContext,
): Promise<AiResult> {
  const provider = user.ai_provider || "anthropic";
  if (provider === "none") throw new Error("AI deaktiviert");
  if (provider === "ollama") return generateViaOllama(user.ollama_url || "http://localhost:11434", ctx);
  return generateViaAnthropic(user.anthropic_key_enc, ctx);
}

async function generateViaAnthropic(keyEnc: string | null, ctx: CallContext): Promise<AiResult> {
  if (!keyEnc) throw new Error("Anthropic-API-Key fehlt — bitte in Settings → AI eintragen");
  const apiKey = decrypt(keyEnc);
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 600,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: buildUserPrompt(ctx) }],
    }),
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`Anthropic ${res.status}: ${t.substring(0, 300)}`);
  }
  const j = await res.json() as any;
  const text = j.content?.[0]?.text || "";
  return parseJsonStrict(text);
}

async function generateViaOllama(url: string, ctx: CallContext): Promise<AiResult> {
  const res = await fetch(`${url.replace(/\/$/, "")}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: process.env.OLLAMA_MODEL || "llama3.1:8b",
      stream: false,
      format: "json",
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: buildUserPrompt(ctx) },
      ],
    }),
  });
  if (!res.ok) throw new Error(`Ollama ${res.status}: ${await res.text()}`);
  const j = await res.json() as any;
  return parseJsonStrict(j.message?.content || "");
}

function parseJsonStrict(text: string): AiResult {
  // JSON aus moeglicherweise umschliessenden Markern extrahieren
  let cleaned = text.trim();
  const fence = cleaned.match(/```(?:json)?\s*([\s\S]+?)\s*```/);
  if (fence) cleaned = fence[1];
  const startBrace = cleaned.indexOf("{");
  const endBrace = cleaned.lastIndexOf("}");
  if (startBrace === -1 || endBrace === -1) throw new Error("KI lieferte kein JSON");
  cleaned = cleaned.substring(startBrace, endBrace + 1);
  let parsed: any;
  try { parsed = JSON.parse(cleaned); } catch (e) { throw new Error("JSON-Parse-Fehler: " + (e as any).message); }
  return {
    summary: String(parsed.summary || "").substring(0, 500),
    next_steps: Array.isArray(parsed.next_steps) ? parsed.next_steps.slice(0, 6).map((s: any) => String(s)) : [],
    sentiment: ["positive", "neutral", "negative"].includes(parsed.sentiment) ? parsed.sentiment : "neutral",
    status_suggest: parsed.status_suggest && ["neu", "kontaktiert", "interessiert", "nicht_interessiert", "abgeschlossen"].includes(parsed.status_suggest)
      ? parsed.status_suggest : null,
  };
}

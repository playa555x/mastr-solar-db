// Helper: Mail-Signatur pro Empfänger-Locale wählen.
// Spalten in users: signature_html (DE-Default, alt), signature_html_en, signature_html_fr.
// Reihenfolge: angeforderte Locale → DE-Fallback → leerer String.

import type { Database } from "bun:sqlite";

export function ensureSignatureColumns(db: Database): void {
  try {
    const cols = db.prepare("PRAGMA table_info(users)").all() as any[];
    const names = new Set(cols.map(c => c.name));
    if (!names.has("signature_html_en")) {
      db.run("ALTER TABLE users ADD COLUMN signature_html_en TEXT");
    }
    if (!names.has("signature_html_fr")) {
      db.run("ALTER TABLE users ADD COLUMN signature_html_fr TEXT");
    }
  } catch (e) {
    console.error("[signatures] ALTER users failed:", e);
  }
}

/**
 * Wählt die Signatur für eine Locale.
 * `locale` kann sein: "de", "de-DE", "en", "en-US", "fr", "fr-FR".
 * Leere/whitespace-only Signaturen werden ignoriert — fallback auf DE.
 */
export function pickSignature(
  user: { signature_html?: string | null; signature_html_en?: string | null; signature_html_fr?: string | null } | null | undefined,
  locale: string | null | undefined,
): string {
  if (!user) return "";
  const loc = (locale || "de").toLowerCase().slice(0, 2);
  const nonEmpty = (s: string | null | undefined): string | null => {
    if (!s) return null;
    const stripped = s.replace(/<[^>]*>/g, "").trim();
    return stripped.length > 0 ? s : null;
  };
  if (loc === "en") {
    const en = nonEmpty(user.signature_html_en);
    if (en) return en;
  }
  if (loc === "fr") {
    const fr = nonEmpty(user.signature_html_fr);
    if (fr) return fr;
  }
  return nonEmpty(user.signature_html) || "";
}

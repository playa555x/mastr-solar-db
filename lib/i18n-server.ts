/**
 * Server-side i18n: Loads all 3 locale files at startup and provides
 * a t(locale, key, args) helper that does {var}-substitution.
 *
 * Used by notify(), stale-notify cron, reminders, and any server-generated
 * user-facing text. Locale is taken from users.pref_locale.
 */
import { readFileSync } from "fs";
import { join } from "path";

type Locale = "de" | "en" | "fr";
type Dict = Record<string, string>;

const STATIC_DIR = process.env.STATIC_DIR || join(import.meta.dir, "..", "static");

const dicts: Record<Locale, Dict> = { de: {}, en: {}, fr: {} };

function loadLocale(loc: Locale): void {
  try {
    const p = join(STATIC_DIR, "locales", `${loc}.json`);
    dicts[loc] = JSON.parse(readFileSync(p, "utf8"));
  } catch (e) {
    console.error(`i18n-server: konnte ${loc}.json nicht laden`, e);
    dicts[loc] = {};
  }
}

loadLocale("de");
loadLocale("en");
loadLocale("fr");

/** Akzeptiert "de", "de-DE", "en-US", "fr", "fr-FR" usw. → enum-Locale. */
export function normalizeLocale(input: string | null | undefined): Locale {
  if (!input) return "de";
  const lc = input.toLowerCase();
  if (lc.startsWith("en")) return "en";
  if (lc.startsWith("fr")) return "fr";
  return "de";
}

/**
 * t("en", "notif.mention_title", { from: "Leila", anlage: "PVA Kottenheim" })
 *   → "Leila mentioned you in a note: PVA Kottenheim"
 */
export function t(locale: string | null | undefined, key: string, args?: Record<string, string | number>): string {
  const loc = normalizeLocale(locale);
  let s = dicts[loc][key];
  if (s == null) s = dicts.de[key]; // Fallback DE
  if (s == null) s = key;            // Letzter Fallback: Key
  if (args) {
    for (const [k, v] of Object.entries(args)) {
      s = s.replace(new RegExp(`\\{${k}\\}`, "g"), String(v));
    }
  }
  return s;
}

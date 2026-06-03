/**
 * Anrede-Heuristik: aus betreiber_name die passende Anrede ableiten.
 * MaStR liefert keine Geschlechts-Info, daher zwei Heuristiken:
 *   1. Firma-Kennzeichen (GmbH, AG, etc.) -> "Sehr geehrte Damen und Herren"
 *   2. Vorname -> Lookup in DE-Vornamen-Liste (top ~250 m/f)
 *   3. Sonst -> Fallback "Sehr geehrte/r Frau/Herr {Nachname}"
 *
 * Ergebnis enthält alle Felder die in Templates als {{anrede}}, {{anrede_kurz}},
 * {{nachname}}, {{vorname}}, {{gender}} verwendet werden können.
 */

const FEMALE = new Set([
  "anna","maria","sophia","emma","mia","hannah","emilia","lina","clara","mila",
  "ella","leonie","lea","lara","amelie","helena","ida","frieda","luisa","sofia",
  "marie","charlotte","laura","julia","sarah","sara","hanna","lena","nina","lisa",
  "katharina","katrin","christina","kristina","stefanie","stephanie","silke","sandra","susanne","silvia",
  "petra","monika","brigitte","gisela","ursula","ute","ulrike","heike","helga","ingrid",
  "ingeborg","irmgard","inge","christel","gerda","erika","elke","eva","edith","elisabeth",
  "renate","ruth","ricarda","rita","gabriele","gabi","claudia","cordula","cornelia","conny",
  "doris","dagmar","daniela","diana","ellen","beate","barbara","bettina","birgit","britta",
  "andrea","angelika","anke","anja","annette","anne","annika","astrid","alexandra","aileen",
  "aische","aysel","aylin","ayla","ayse","fatma","fatima","hatice","leyla","leila",
  "yasmin","yasemin","emine","esra","ela","derya","dilara","ceyda","cigdem","ceren",
  "tamara","tina","tanja","theresa","therese","ulla","verena","vera","viola","viktoria",
  "ramona","regina","rebecca","rebekka","kerstin","karin","karina","kim","kirsten","kathrin",
  "michaela","manuela","melanie","melissa","martina","mareike","margarete","margarethe","margit","margot",
  "miriam","mona","nadja","nadine","natalie","nathalie","nora","olivia","olga","paula",
  "pauline","ramona","romina","romy","rosa","rose","rosemarie","sabine","sabrina","saskia",
  "selina","selena","sina","simone","sonja","stella","tabea","talea","theresia","valerie",
  "vanessa","veronika","wanda","wiebke","wilma","yvonne","zara","zoe","jana","janina",
  "janine","jasmin","jessica","jessika","johanna","jolanthe","josefa","josefine","judith","julia",
  "elena","elif","heidi","heidemarie","heidrun","hella","hildegard","hilke","hilde","horst",
]);

const MALE = new Set([
  "michael","thomas","andreas","wolfgang","peter","klaus","stefan","stephan","christian","frank",
  "jürgen","juergen","martin","uwe","manfred","helmut","werner","rainer","reiner","hans",
  "joachim","gerhard","günter","guenter","günther","guenther","horst","heinz","dieter","walter",
  "rolf","ralf","kurt","karl","jens","jörg","joerg","jan","ingo","holger",
  "harald","hartmut","heinrich","heiko","helmuth","herbert","hermann","hubert","kai","karsten",
  "kevin","lars","lothar","ludwig","markus","marcus","matthias","mathias","max","maximilian",
  "norbert","oliver","otto","patrick","paul","philipp","philip","ralph","reinhard","richard",
  "robert","roland","roman","sebastian","siegfried","sven","tim","tobias","udo","ulrich",
  "uli","volker","wilhelm","willi","willy","achim","adam","adrian","alexander","alex",
  "alfred","alois","anton","arne","arnold","artur","arthur","august","axel","benedikt",
  "benjamin","bernd","bernhard","björn","bjoern","boris","bruno","carsten","christof","christoph",
  "claus","cornelius","dennis","detlef","dirk","domenico","dominik","eberhard","edgar","eduard",
  "edwin","egon","elmar","emil","enrico","erhard","erich","erik","ernst","eugen",
  "fabian","felix","ferdinand","florian","franz","fred","friedhelm","friedrich","fritz","gabriel",
  "georg","gerald","gerd","gerrit","gert","gilbert","gottfried","gregor","günther","gustav",
  "harry","henning","henrik","hinrich","hubertus","ilja","ivan","jakob","julian","justus",
  "kilian","konrad","konstantin","laurenz","leo","leon","leopold","linus","lorenz","louis",
  "luca","luis","lukas","manuel","marc","marco","mario","mark","martin","mateo",
  "mehmet","ahmet","ali","ayhan","baris","burak","cem","deniz","emin","emir",
  "emre","ercan","erkan","ferhat","hakan","halil","hasan","huseyin","ibrahim","ismail",
  "kemal","mahmut","mert","murat","mustafa","nuri","ömer","oezcan","ozan","rasit",
  "harold","benjamin","ulli","achill","alban","aldo","aleksander","alfons","amir",
]);

// Firma-Pattern: GmbH, AG, UG, KG, OHG, eG, eV, eK, Kommune, etc.
const COMPANY_RE = /\b(GmbH|AG|UG|GbR|KG|OHG|e\.?K\.?|e\.?V\.?|Co\.?|& Co|mbH|SE|Limited|Ltd\.?|Holding|Verwaltung|Stiftung|Verein|Genossenschaft|eG|Kommune|Gemeinde|Stadt|Landkreis|Bezirk|Schule|Kirche|Pfarrei|Klinikum|Krankenhaus|Bundesland|Bayern|Sachsen|Thüringen|Hessen|Hamburg|Berlin|Bremen)\b/i;

export type Gender = "m" | "f" | "company" | "unknown";

export interface AnredeResult {
  anrede: string;       // "Sehr geehrter Herr Müller," / "Sehr geehrte Frau Schmidt," / "Sehr geehrte Damen und Herren,"
  anrede_kurz: string;  // "Herr Müller" / "Frau Schmidt" / "Damen und Herren"
  gender: Gender;
  vorname: string;
  nachname: string;
}

export function detectAnrede(betreiberName: string | null | undefined): AnredeResult {
  return detectAnredeLocalized(betreiberName, "de-DE");
}

/**
 * Locale-aware Anrede.
 * Locales (Stand 2026-06): de, en, fr — alle anderen fallen auf de zurück.
 *
 * Beispiel-Output pro Locale für "Hans Müller":
 *   de  → "Sehr geehrter Herr Müller,"
 *   en  → "Dear Mr. Müller,"
 *   fr  → "Cher Monsieur Müller,"
 *
 * Für Firma/unbekannt:
 *   de  → "Sehr geehrte Damen und Herren,"
 *   en  → "Dear Sir or Madam,"
 *   fr  → "Madame, Monsieur,"
 */
export function detectAnredeLocalized(betreiberName: string | null | undefined, locale: string | null | undefined): AnredeResult {
  const loc = (locale || "de").toLowerCase().slice(0, 2);
  const tpl = ANREDE_TPL[loc] || ANREDE_TPL.de;
  const bn = (betreiberName || "").trim();
  if (!bn) {
    return { anrede: tpl.sirMadam, anrede_kurz: tpl.sirMadamKurz, gender: "unknown", vorname: "", nachname: "" };
  }
  if (COMPANY_RE.test(bn)) {
    return { anrede: tpl.sirMadam, anrede_kurz: tpl.sirMadamKurz, gender: "company", vorname: "", nachname: "" };
  }
  const parts = bn.split(/\s+/).filter(p => p && !/^[A-Z]\.$/.test(p));
  if (parts.length < 2 || parts.length > 4) {
    return { anrede: tpl.sirMadam, anrede_kurz: tpl.sirMadamKurz, gender: "unknown", vorname: "", nachname: bn };
  }
  const vorname = parts[0];
  const nachname = parts[parts.length - 1];
  const vl = vorname.toLowerCase();
  const vlFirst = vl.split(/[-\s]/)[0];
  if (FEMALE.has(vl) || FEMALE.has(vlFirst)) {
    return { anrede: tpl.f(nachname), anrede_kurz: tpl.fKurz(nachname), gender: "f", vorname, nachname };
  }
  if (MALE.has(vl) || MALE.has(vlFirst)) {
    return { anrede: tpl.m(nachname), anrede_kurz: tpl.mKurz(nachname), gender: "m", vorname, nachname };
  }
  return { anrede: tpl.neutral(nachname), anrede_kurz: tpl.neutralKurz(nachname), gender: "unknown", vorname, nachname };
}

interface AnredeTpl {
  sirMadam: string;
  sirMadamKurz: string;
  m: (n: string) => string;
  f: (n: string) => string;
  neutral: (n: string) => string;
  mKurz: (n: string) => string;
  fKurz: (n: string) => string;
  neutralKurz: (n: string) => string;
}
const ANREDE_TPL: Record<string, AnredeTpl> = {
  de: {
    sirMadam:     "Sehr geehrte Damen und Herren,",
    sirMadamKurz: "Damen und Herren",
    m:            n => `Sehr geehrter Herr ${n},`,
    f:            n => `Sehr geehrte Frau ${n},`,
    neutral:      n => `Sehr geehrte/r Frau/Herr ${n},`,
    mKurz:        n => `Herr ${n}`,
    fKurz:        n => `Frau ${n}`,
    neutralKurz:  n => `Frau/Herr ${n}`,
  },
  en: {
    sirMadam:     "Dear Sir or Madam,",
    sirMadamKurz: "Sir or Madam",
    m:            n => `Dear Mr. ${n},`,
    f:            n => `Dear Ms. ${n},`,
    neutral:      n => `Dear Mx. ${n},`,
    mKurz:        n => `Mr. ${n}`,
    fKurz:        n => `Ms. ${n}`,
    neutralKurz:  n => `Mx. ${n}`,
  },
  fr: {
    sirMadam:     "Madame, Monsieur,",
    sirMadamKurz: "Madame, Monsieur",
    m:            n => `Cher Monsieur ${n},`,
    f:            n => `Chère Madame ${n},`,
    neutral:      n => `Madame, Monsieur ${n},`,
    mKurz:        n => `M. ${n}`,
    fKurz:        n => `Mme ${n}`,
    neutralKurz:  n => `Mme/M. ${n}`,
  },
};

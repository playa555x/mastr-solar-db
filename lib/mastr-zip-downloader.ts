import { createWriteStream, existsSync, statSync, unlinkSync, mkdirSync, statfsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const MASTR_DATENDOWNLOAD_PAGE = "https://www.marktstammdatenregister.de/MaStR/Datendownload";

// Hard floor: MaStR-ZIP ist aktuell ~2.8 GB. Wir verlangen mind. 4 GB frei im destDir,
// um nicht in "curl exit 23" (write error) zu laufen. tmpfs in /tmp ist auf Standard-
// Servern 4-6 GB gross und oft schon teilweise belegt → daily-update.ts setzt destDir
// explizit auf eine Disk-Partition.
const MIN_FREE_BYTES = 4 * 1024 * 1024 * 1024;

export interface DownloadResult {
  path: string;
  sizeBytes: number;
  url: string;
}

const BROWSER_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36";

export async function resolveLatestZipUrl(): Promise<string> {
  const res = await fetch(MASTR_DATENDOWNLOAD_PAGE, {
    headers: { "User-Agent": BROWSER_UA, "Accept": "text/html,*/*" },
    redirect: "follow",
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} beim Holen der Datendownload-Seite`);
  const html = await res.text();

  const matches = html.match(/https:\/\/download\.marktstammdatenregister\.de\/Gesamtdatenexport_[0-9]{8}_[0-9.]+\.zip/g);
  if (!matches || matches.length === 0) {
    throw new Error("Keine aktuelle Gesamtdatenexport-URL auf der Seite gefunden");
  }
  return matches[0];
}

export async function downloadMastrZip(opts: {
  url?: string;
  destDir?: string;
  onProgress?: (bytesReceived: number, bytesTotal: number) => void;
} = {}): Promise<DownloadResult> {
  const url = opts.url || (await resolveLatestZipUrl());
  const destDir = opts.destDir || tmpdir();

  // destDir sicher anlegen (idempotent) und Pre-Flight: gibt es genug freien Speicher?
  if (!existsSync(destDir)) mkdirSync(destDir, { recursive: true });
  try {
    const s = statfsSync(destDir);
    const freeBytes = Number(s.bavail) * Number(s.bsize);
    if (freeBytes < MIN_FREE_BYTES) {
      const freeGB = (freeBytes / 1024 / 1024 / 1024).toFixed(2);
      const needGB = (MIN_FREE_BYTES / 1024 / 1024 / 1024).toFixed(0);
      throw new Error(
        `Zu wenig freier Speicher in ${destDir}: ${freeGB} GB frei, brauche mind. ${needGB} GB. ` +
        `Aufraeumen oder $IMPORT_TMP_DIR auf eine andere Partition setzen.`,
      );
    }
  } catch (e: any) {
    // Wenn der Disk-Check selbst scheitert (statfs nicht supported o.ä.), nicht blockieren
    if (e?.message?.startsWith("Zu wenig")) throw e;
  }

  const dest = join(destDir, `mastr-${Date.now()}.zip`);

  // curl: robust, mit Resume bei Verbindungsabbruch, Timeout bei Stillstand
  // --connect-timeout 30: max 30s fuer Verbindungsaufbau
  // --speed-time 120 --speed-limit 10240: abbruch wenn <10 KB/s ueber 120s
  // --retry 5 --retry-delay 10 --retry-all-errors: bis zu 5 Versuche
  // -C -: Resume bei Abbruch
  // -L: follow redirects, -s: silent, -S: show errors
  const args = [
    "--retry", "5",
    "--retry-delay", "10",
    "--retry-all-errors",
    "--connect-timeout", "30",
    "--speed-time", "120",
    "--speed-limit", "10240",
    "-L",
    "-A", BROWSER_UA,
    "-H", "Accept: */*",
    "-o", dest,
    "-w", "%{http_code}\n",
    url,
  ];

  // Progress via stderr-Polling auf Datei-Groesse
  const proc = Bun.spawn(["curl", ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });

  let progressTimer: ReturnType<typeof setInterval> | null = null;
  if (opts.onProgress) {
    progressTimer = setInterval(() => {
      try {
        const sz = statSync(dest).size;
        opts.onProgress!(sz, 0);
      } catch {}
    }, 5000);
  }

  const exitCode = await proc.exited;
  if (progressTimer) clearInterval(progressTimer);

  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();

  if (exitCode !== 0) {
    try { unlinkSync(dest); } catch {}
    throw new Error(`curl exit ${exitCode}: ${stderr.substring(0, 300)}`);
  }

  // Validate file
  let received = 0;
  try { received = statSync(dest).size; } catch {}

  if (received < 100_000_000) {
    let preview = "";
    try {
      const buf = await Bun.file(dest).arrayBuffer();
      preview = Buffer.from(buf.slice(0, Math.min(200, buf.byteLength))).toString("utf8");
    } catch {}
    try { unlinkSync(dest); } catch {}
    throw new Error(`ZIP zu klein (${received} bytes, http=${stdout.trim()}). Anfang: ${preview.substring(0, 100)}`);
  }

  // Magic-Byte check
  try {
    const head = new Uint8Array(await Bun.file(dest).slice(0, 4).arrayBuffer());
    const magic = Array.from(head).map((b) => b.toString(16).padStart(2, "0")).join("");
    if (magic !== "504b0304") {
      try { unlinkSync(dest); } catch {}
      throw new Error(`Datei keine ZIP (Magic=${magic})`);
    }
  } catch (e: any) {
    if (e.message?.startsWith("Datei keine ZIP")) throw e;
    // ignore other errors here
  }

  if (opts.onProgress) opts.onProgress(received, received);

  return { path: dest, sizeBytes: received, url };
}

export function cleanupZip(path: string): void {
  try {
    if (existsSync(path)) unlinkSync(path);
  } catch (e) {
    console.error("ZIP cleanup fehlgeschlagen:", path, e);
  }
}

export function getZipSize(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

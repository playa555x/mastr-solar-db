import { randomBytes, createCipheriv, createDecipheriv } from "crypto";
import { existsSync, readFileSync, writeFileSync, chmodSync } from "fs";
import { dirname } from "path";
import { mkdirSync } from "fs";

let masterKey: Buffer | null = null;

export function initMasterKey(keyPath: string): void {
  const dir = dirname(keyPath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  if (!existsSync(keyPath)) {
    const key = randomBytes(32);
    writeFileSync(keyPath, key.toString("hex"), { mode: 0o600 });
    try {
      chmodSync(keyPath, 0o600);
    } catch {}
    masterKey = key;
    console.log(`Master-Key generiert: ${keyPath}`);
  } else {
    const hex = readFileSync(keyPath, "utf8").trim();
    masterKey = Buffer.from(hex, "hex");
    if (masterKey.length !== 32) {
      throw new Error(`Master-Key ungueltig in ${keyPath} (erwartet 32 Bytes hex)`);
    }
  }
}

export function encrypt(plaintext: string): string {
  if (!masterKey) throw new Error("Master-Key nicht initialisiert");
  if (!plaintext) return "";
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", masterKey, iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString("base64")}:${tag.toString("base64")}:${ct.toString("base64")}`;
}

export function decrypt(blob: string): string {
  if (!masterKey) throw new Error("Master-Key nicht initialisiert");
  if (!blob) return "";
  const [ivB64, tagB64, ctB64] = blob.split(":");
  if (!ivB64 || !tagB64 || !ctB64) return "";
  const iv = Buffer.from(ivB64, "base64");
  const tag = Buffer.from(tagB64, "base64");
  const ct = Buffer.from(ctB64, "base64");
  const decipher = createDecipheriv("aes-256-gcm", masterKey, iv);
  decipher.setAuthTag(tag);
  const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
  return pt.toString("utf8");
}

import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions";
import { Api } from "telegram";
import { decrypt } from "./crypto";

const API_ID = parseInt(process.env.TELEGRAM_API_ID || "37228472", 10);
const API_HASH = process.env.TELEGRAM_API_HASH || "46ec5332ff838683dd7d09264dabcd33";

// In-memory cache fuer pending logins (phoneCodeHash + StringSession)
interface PendingLogin {
  client: TelegramClient;
  phoneCodeHash: string;
  phone: string;
  createdAt: number;
}
const pendingLogins = new Map<string, PendingLogin>();

// Auto-cleanup nach 10 Min
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of pendingLogins.entries()) {
    if (now - v.createdAt > 10 * 60 * 1000) {
      try { v.client.disconnect(); } catch {}
      pendingLogins.delete(k);
    }
  }
}, 60_000);

function makeClient(sessionString = ""): TelegramClient {
  const session = new StringSession(sessionString);
  return new TelegramClient(session, API_ID, API_HASH, {
    connectionRetries: 3,
    useWSS: true,
    deviceModel: "Solar DB",
    appVersion: "2.1",
    systemVersion: "Server",
  });
}

/**
 * Schritt 1: Telefonnummer einreichen, SMS wird versendet.
 * Returns ein opakes Token das der Client beim 2. Schritt mitschicken muss.
 */
export async function startLogin(phone: string): Promise<{ loginToken: string }> {
  if (!phone || !/^\+?[0-9]{6,20}$/.test(phone.replace(/\s/g, ""))) {
    throw new Error("Telefonnummer ungueltig (Format: +491701234567)");
  }
  const client = makeClient();
  await client.connect();
  const result = await client.sendCode(
    { apiId: API_ID, apiHash: API_HASH },
    phone,
  );
  const loginToken = `tg_${Date.now()}_${Math.random().toString(36).substring(2, 10)}`;
  pendingLogins.set(loginToken, {
    client,
    phoneCodeHash: result.phoneCodeHash,
    phone,
    createdAt: Date.now(),
  });
  return { loginToken };
}

/**
 * Schritt 2: SMS-Code bestaetigen. Returns Session-String + User-Info.
 * Falls 2FA: braucht password Param.
 */
export async function finishLogin(loginToken: string, code: string, password?: string): Promise<{
  sessionString: string;
  userId: number;
  username: string | null;
  firstName: string | null;
  phone: string;
}> {
  const pending = pendingLogins.get(loginToken);
  if (!pending) throw new Error("Login-Token abgelaufen, bitte Telefonnummer neu eingeben");
  const { client, phoneCodeHash, phone } = pending;

  try {
    let me: any;
    try {
      const result = await client.invoke(
        new Api.auth.SignIn({
          phoneNumber: phone,
          phoneCodeHash,
          phoneCode: code.trim(),
        }),
      );
      me = (result as any).user;
    } catch (e: any) {
      if (e.message?.includes("SESSION_PASSWORD_NEEDED")) {
        if (!password) throw new Error("2FA-Passwort erforderlich");
        // 2FA-Flow: signInWithPassword
        await client.signInWithPassword(
          { apiId: API_ID, apiHash: API_HASH },
          {
            password: async () => password,
            onError: (err: any) => { throw err; },
          } as any,
        );
        const meRes = await client.getMe();
        me = meRes;
      } else {
        throw e;
      }
    }

    const sessionString = (client.session as StringSession).save() as unknown as string;
    pendingLogins.delete(loginToken);
    try { client.disconnect(); } catch {}
    return {
      sessionString,
      userId: Number((me?.id as any)?.value ?? me?.id ?? 0),
      username: me?.username || null,
      firstName: me?.firstName || null,
      phone,
    };
  } catch (e) {
    // Bei Fehler nicht aufraeumen, User kann erneut versuchen
    throw e;
  }
}

export async function logoutSession(sessionStringPlain: string): Promise<void> {
  if (!sessionStringPlain) return;
  try {
    const client = makeClient(sessionStringPlain);
    await client.connect();
    await client.invoke(new Api.auth.LogOut());
    client.disconnect();
  } catch (e) {
    console.error("Telegram-Logout-Fehler:", e);
  }
}

/**
 * Schickt Nachricht an "Saved Messages" (= an den eingeloggten User selbst).
 */
export async function sendToSelf(sessionStringEncrypted: string, text: string): Promise<void> {
  const sessionString = decrypt(sessionStringEncrypted);
  if (!sessionString) throw new Error("Telegram-Session fehlt");
  const client = makeClient(sessionString);
  try {
    await client.connect();
    await client.sendMessage("me", { message: text, parseMode: "markdown" });
  } finally {
    try { client.disconnect(); } catch {}
  }
}

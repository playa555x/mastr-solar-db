import { randomBytes } from "crypto";

export function generateTrackingToken(): string {
  return randomBytes(16).toString("hex");
}

/**
 * Erweitert HTML-Body mit:
 * - Open-Pixel am Ende (1x1 GIF)
 * - Click-Wrapper auf alle <a href="https/http://...">
 */
export function injectTracking(html: string, token: string, baseUrl: string): string {
  if (!token || !html) return html;
  const trackBase = baseUrl.replace(/\/$/, "");
  // Click-Wrapper: <a href="https://..."> -> <a href="{base}/t/c/{token}?u=...">
  let out = html.replace(/<a\s+([^>]*?)href=["'](https?:\/\/[^"']+)["']([^>]*)>/gi, (m, pre, url, post) => {
    // Ignore mailto/tel/anchors
    if (/^(mailto:|tel:|#)/i.test(url)) return m;
    const wrapped = `${trackBase}/t/c/${token}?u=${encodeURIComponent(url)}`;
    return `<a ${pre}href="${wrapped}"${post}>`;
  });
  // Open-Pixel
  const pixel = `<img src="${trackBase}/t/o/${token}.png" width="1" height="1" alt="" style="display:block;width:1px;height:1px;border:0;" />`;
  if (/<\/body>/i.test(out)) {
    out = out.replace(/<\/body>/i, `${pixel}</body>`);
  } else {
    out += pixel;
  }
  return out;
}

import { createHash } from "crypto";
export function hashShort(s: string | null | undefined): string {
  if (!s) return "";
  return createHash("sha256").update(s).digest("hex").substring(0, 16);
}

// 1x1 transparent GIF
export const TRANSPARENT_GIF = Buffer.from([
  0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x01, 0x00, 0x01, 0x00, 0x80, 0x00,
  0x00, 0x00, 0x00, 0x00, 0xff, 0xff, 0xff, 0x21, 0xf9, 0x04, 0x01, 0x00,
  0x00, 0x00, 0x00, 0x2c, 0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00,
  0x00, 0x02, 0x02, 0x44, 0x01, 0x00, 0x3b,
]);

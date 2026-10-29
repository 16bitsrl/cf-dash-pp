// Cifratura dei token OAuth salvati in D1 (AES-GCM, chiave nel secret SESSION_KEY).

const enc = new TextEncoder();
const dec = new TextDecoder();

const b64 = (buf: ArrayBuffer | Uint8Array) => btoa(String.fromCharCode(...new Uint8Array(buf)));
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
export const b64url = (buf: ArrayBuffer | Uint8Array) => b64(buf).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

let keyCache: { raw: string; key: CryptoKey } | null = null;

async function key(secret: string) {
  if (keyCache?.raw === secret) return keyCache.key;
  const digest = await crypto.subtle.digest("SHA-256", enc.encode(secret));
  const k = await crypto.subtle.importKey("raw", digest, "AES-GCM", false, ["encrypt", "decrypt"]);
  keyCache = { raw: secret, key: k };
  return k;
}

export async function seal(secret: string, text: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await key(secret), enc.encode(text));
  return `${b64(iv)}.${b64(ct)}`;
}

export async function open(secret: string, sealed: string): Promise<string> {
  const [iv, ct] = sealed.split(".");
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(iv) }, await key(secret), unb64(ct));
  return dec.decode(pt);
}

export const randomToken = (bytes = 32) => b64url(crypto.getRandomValues(new Uint8Array(bytes)));

export async function sha256(text: string) {
  return b64url(await crypto.subtle.digest("SHA-256", enc.encode(text)));
}

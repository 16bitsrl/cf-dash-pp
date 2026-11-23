// Emails from Dash++: who asks to enable an account, and the answer. They go out only where
// sending is set up (EMAIL and EMAIL_FROM, see cloudflare.config.ts), in the language the
// recipient last used in the panel, English otherwise.

import type { Env } from "./auth";
import { now } from "./lib/db";

type Lang = "en" | "it";
const LANGS: Lang[] = ["en", "it"];

const TEXTS = {
  en: {
    requestSubject: (account: string) => `Dash++: ${account} asks to be enabled`,
    requestText: (account: string, by: string, url: string) => `${by} asks to use Dash++ with the Cloudflare account ${account}.\n\nYou can enable it or decline it here:\n${url}`,
    approvedSubject: (account: string) => `Dash++: ${account} is enabled`,
    approvedText: (account: string, url: string) => `The Cloudflare account ${account} is now enabled on Dash++. Everyone in the account can use it with their own permissions.\n\nOpen it:\n${url}`,
  },
  it: {
    requestSubject: (account: string) => `Dash++: richiesta per ${account}`,
    requestText: (account: string, by: string, url: string) => `${by} chiede di abilitare l'account Cloudflare ${account} su Dash++.\n\nPuoi abilitarlo o rifiutare la richiesta qui:\n${url}`,
    approvedSubject: (account: string) => `Dash++: ${account} è abilitato`,
    approvedText: (account: string, url: string) => `L'account Cloudflare ${account} ora è abilitato su Dash++. Chi fa parte dell'account può usarlo con i suoi permessi.\n\nAprilo qui:\n${url}`,
  },
} satisfies Record<Lang, unknown>;

/** Remembers the language of someone's panel, if the request says it. */
export async function rememberLang(env: Env, email: string, lang: string | undefined) {
  if (!lang || !LANGS.includes(lang as Lang)) return;
  await env.DB.prepare("INSERT INTO people (email, lang, seen_at) VALUES (?, ?, ?) ON CONFLICT(email) DO UPDATE SET lang = excluded.lang, seen_at = excluded.seen_at").bind(email.toLowerCase(), lang, now()).run();
}

async function langOf(env: Env, email: string): Promise<Lang> {
  const row = await env.DB.prepare("SELECT lang FROM people WHERE email = ?").bind(email.toLowerCase()).first<{ lang: Lang }>();
  return row && LANGS.includes(row.lang) ? row.lang : "en";
}

/** Sends one email; never fails the action that caused it. */
async function send(env: Env, to: string, subject: string, text: string) {
  if (!env.EMAIL || !env.EMAIL_FROM) return;
  try {
    await env.EMAIL.send({ from: { name: "Dash++", email: env.EMAIL_FROM }, to, subject, text });
  } catch (e) {
    console.error("email not sent", e);
  }
}

export async function notifyRequest(env: Env, admins: string[], account: string, by: string, setupUrl: string) {
  for (const to of admins) {
    const t = TEXTS[await langOf(env, to)];
    await send(env, to, t.requestSubject(account), t.requestText(account, by, setupUrl));
  }
}

export async function notifyApproved(env: Env, to: string, account: string, url: string) {
  const t = TEXTS[await langOf(env, to)];
  await send(env, to, t.approvedSubject(account), t.approvedText(account, url));
}

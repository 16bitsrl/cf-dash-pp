import { useSyncExternalStore } from "react";
import type { Check } from "../../worker/lib/mail";
import { en, type Dict } from "./en";
import { it } from "./it";

export type Lang = "en" | "it";
export const LANGS: Record<Lang, { dict: Dict; label: string }> = { en: { dict: en, label: "English" }, it: { dict: it, label: "Italiano" } };

const KEY = "dpp:lang";
// The language chosen from the account menu; otherwise the browser's, if we have it; otherwise English.
const fromBrowser = (): Lang => ((navigator.languages ?? [navigator.language]).map((l) => l.slice(0, 2).toLowerCase()).find((l) => l in LANGS) as Lang) ?? "en";
let lang: Lang = (localStorage.getItem(KEY) as Lang) in LANGS ? (localStorage.getItem(KEY) as Lang) : fromBrowser();
const listeners = new Set<() => void>();

export function setLang(l: Lang) {
  lang = l;
  localStorage.setItem(KEY, l);
  document.documentElement.lang = l;
  listeners.forEach((f) => f());
}
document.documentElement.lang = lang;

export const useLang = () =>
  useSyncExternalStore(
    (f) => (listeners.add(f), () => listeners.delete(f)),
    () => lang,
  );

export const useT = () => LANGS[useLang()].dict;
export const currentDict = () => LANGS[lang].dict;

type P = Record<string, string | number>;
const call = (v: string | ((p: P) => string) | undefined, p: P = {}) => (typeof v === "function" ? v(p) : (v ?? ""));

export function checkText(t: Dict, c: Pick<Check, "id" | "params">) {
  const m = t.checks[c.id];
  return { title: m ? call(m.title, c.params) : c.id, detail: m ? call(m.detail, c.params) : "" };
}

export function errorText(t: Dict, code: string, params?: P) {
  return call(t.errors[code] ?? t.errors.unexpected, params);
}

export function doneText(t: Dict, d: { op: string } & P) {
  const f = t.done[d.op];
  return f ? f(d) : d.op;
}

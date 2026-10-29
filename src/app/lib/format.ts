import { useLang } from "../i18n";

const cache = new Map<string, { rtf: Intl.RelativeTimeFormat; dtf: Intl.DateTimeFormat }>();
const fmt = (lang: string) => {
  let f = cache.get(lang);
  if (!f) cache.set(lang, (f = { rtf: new Intl.RelativeTimeFormat(lang, { numeric: "auto" }), dtf: new Intl.DateTimeFormat(lang, { dateStyle: "medium", timeStyle: "short" }) }));
  return f;
};

function ago(lang: string, ts: number | null | undefined, never: string) {
  if (!ts) return never;
  const { rtf, dtf } = fmt(lang);
  const s = Math.round((ts - Date.now()) / 1000);
  const abs = Math.abs(s);
  if (abs < 45) return rtf.format(0, "second");
  if (abs < 3600) return rtf.format(Math.round(s / 60), "minute");
  if (abs < 86400) return rtf.format(Math.round(s / 3600), "hour");
  if (abs < 86400 * 30) return rtf.format(Math.round(s / 86400), "day");
  return dtf.format(ts);
}

/** Date helpers in the current language. */
export function useFormat() {
  const lang = useLang();
  return {
    ago: (ts: number | null | undefined, never = "—") => ago(lang, ts, never),
    dateTime: (ts: number) => fmt(lang).dtf.format(ts),
  };
}

/** Name relative to the zone, as the dashboard shows it: "@" for the apex. */
export function shortName(name: string, zone: string) {
  const n = name.toLowerCase();
  const z = zone.toLowerCase();
  if (n === z) return "@";
  return n.endsWith(`.${z}`) ? n.slice(0, -z.length - 1) : n;
}

/** Links to the matching pages of the Cloudflare dashboard. */
export const dash = {
  account: (acc: string, path = "") => `https://dash.cloudflare.com/${acc}${path}`,
  zone: (acc: string, zone: string, path = "") => `https://dash.cloudflare.com/${acc}/${zone}${path}`,
};

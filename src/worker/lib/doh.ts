import type { Resolver } from "./mail";

const TYPES = { A: 1, AAAA: 28, MX: 15, TXT: 16 } as const;

/** Risolutore DNS su HTTPS (1.1.1.1), con cache per la durata della richiesta. */
export function dohResolver(): Resolver {
  const cache = new Map<string, Promise<string[]>>();
  return {
    lookup(name, type) {
      const key = `${type} ${name}`;
      let hit = cache.get(key);
      if (!hit) {
        hit = fetch(`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(name)}&type=${type}`, {
          headers: { accept: "application/dns-json" },
        })
          .then((r) => r.json() as Promise<{ Answer?: { type: number; data: string }[] }>)
          .then((j) => (j.Answer ?? []).filter((a) => a.type === TYPES[type]).map((a) => a.data))
          .catch(() => []);
        cache.set(key, hit);
      }
      return hit;
    },
  };
}

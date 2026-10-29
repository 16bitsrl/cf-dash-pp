// The parking page. It is a single static file: Cloudflare serves it from its asset storage
// without running any code, so parked domains cost nothing and are cached everywhere.
// The browser fills in the domain name and picks English or Italian.

export type ParkBrand = {
  name: string;
  site: string | null;
  accent: string;
  leadEn: string | null;
  leadIt: string | null;
  logo: string | null; // path under /.park/
  logoHeight: string | null;
  icon: string | null;
};

export type ParkConfig = {
  // brand null: anonymous page; noneEn/noneIt null: the standard "No website yet."
  pages: Record<string, { brand: ParkBrand | null; noneEn: string | null; noneIt: string | null }>;
  defaultPage: string;
  assign: Record<string, string>; // domain → page, when not the default
};

/** The standard line under the domain, when a page does not set its own. */
export const NO_SITE = { en: "No website yet.", it: "Nessun sito, per ora." };

const css = `
:root { --ink: #1d1d22; --muted: #5d5f6b; --line: rgba(29, 29, 34, .09); --glow: color-mix(in srgb, var(--accent) 22%, transparent); }
* { box-sizing: border-box; margin: 0; }
html { background: #f7f7f4; }
body {
  font-family: ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
  color: var(--ink);
  background: radial-gradient(60rem 40rem at 85% -10%, var(--glow), transparent 60%), radial-gradient(50rem 35rem at -10% 110%, var(--glow), transparent 60%), #f7f7f4;
  -webkit-font-smoothing: antialiased; display: flex; flex-direction: column; min-height: 100vh; min-height: 100dvh;
}
body::before {
  content: ""; position: fixed; inset: 0; pointer-events: none;
  background-image: radial-gradient(var(--line) 1px, transparent 1px); background-size: 22px 22px;
  mask-image: radial-gradient(ellipse at center, #000 30%, transparent 75%);
}
header, main, footer { position: relative; width: 100%; max-width: 64rem; margin: 0 auto; padding: 0 1.5rem; }
header { padding-top: 2rem; min-height: 5.25rem; }
header img { height: var(--logo-h, 3.25rem); width: auto; display: block; }
main { flex: 1; display: flex; flex-direction: column; justify-content: center; padding-top: 3rem; padding-bottom: 3rem; }
.tag {
  display: inline-flex; align-items: center; gap: .5rem; align-self: flex-start; font-size: .8125rem; font-weight: 600;
  letter-spacing: .02em; color: var(--muted); padding: .375rem .75rem .375rem .625rem; border: 1px solid var(--line);
  border-radius: 999px; background: rgba(255, 255, 255, .7); backdrop-filter: blur(6px);
}
.tag::before { content: ""; width: .5rem; height: .5rem; border-radius: 50%; background: var(--accent); box-shadow: 0 0 0 4px var(--glow); }
h1 {
  margin-top: 1.25rem; line-height: 1.02; letter-spacing: -.035em; font-weight: 750; overflow-wrap: anywhere; text-wrap: balance;
  font-size: max(1.5rem, min(clamp(2.25rem, 7.5vw, 5.25rem), calc((100vw - 3rem) / (var(--len) * .57))));
}
p { margin-top: 1.25rem; font-size: clamp(1rem, 1.6vw, 1.25rem); line-height: 1.55; color: var(--muted); }
p span { display: block; text-wrap: balance; }
a.cta {
  margin-top: 2.25rem; align-self: flex-start; display: inline-flex; align-items: center; gap: .625rem; padding: .875rem 1.375rem;
  border-radius: .75rem; background: var(--accent); color: #fff; font-weight: 600; font-size: 1rem; text-decoration: none;
  box-shadow: 0 1px 0 rgba(255, 255, 255, .25) inset, 0 8px 24px -8px var(--accent); transition: transform .15s ease, box-shadow .15s ease;
}
a.cta:hover { transform: translateY(-1px); box-shadow: 0 1px 0 rgba(255, 255, 255, .25) inset, 0 12px 28px -8px var(--accent); }
a.cta:focus-visible { outline: 3px solid var(--glow); outline-offset: 3px; }
a.cta svg { transition: transform .15s ease; }
a.cta:hover svg { transform: translateX(3px); }
[hidden] { display: none !important; }
footer { padding-bottom: 2rem; font-size: .8125rem; color: var(--muted); }
footer a { color: inherit; }
@media (prefers-reduced-motion: reduce) { a.cta, a.cta svg { transition: none; } }
`;

// Runs in the visitor's browser. Kept dependency-free and small.
const script = `
(function () {
  var c = window.PARK, d = document;
  var host = (window.PARK_HOST || location.hostname).toLowerCase().replace(/^www\\./, "");
  var lang = window.PARK_LANG || (/^it\\b/i.test(navigator.language || "") ? "it" : "en");
  var T = {
    en: { tag: "Domain registered", none: ${JSON.stringify(NO_SITE.en)}, visit: "Visit " },
    it: { tag: "Dominio registrato", none: ${JSON.stringify(NO_SITE.it)}, visit: "Visita " }
  }[lang];
  var id = c.assign[host] || c.defaultPage;
  var pg = c.pages[id] || c.pages[c.defaultPage];
  var b = pg.brand;
  var root = d.documentElement;
  root.lang = lang;
  root.style.setProperty("--accent", b ? b.accent : "#3a3b44");
  if (b && b.logoHeight) root.style.setProperty("--logo-h", b.logoHeight);
  d.title = host;
  d.getElementById("tag").textContent = T.tag;
  var h1 = d.getElementById("d");
  h1.style.setProperty("--len", host.length);
  var dot = host.lastIndexOf(".");
  h1.textContent = dot > 0 ? host.slice(0, dot) : host;
  if (dot > 0) { h1.appendChild(d.createElement("wbr")); h1.appendChild(d.createTextNode(host.slice(dot))); }
  var p = d.getElementById("p");
  var lead = b && (lang === "it" ? b.leadIt || b.leadEn : b.leadEn || b.leadIt);
  [lead, (lang === "it" ? pg.noneIt : pg.noneEn) || T.none].forEach(function (t) { if (t) { var s = d.createElement("span"); s.textContent = t; p.appendChild(s); } });
  if (b && b.site) {
    var label = b.site.replace(/^https?:\\/\\//, "").replace(/\\/$/, "");
    if (b.logo) {
      var a = d.createElement("a"), img = d.createElement("img");
      a.href = b.site; a.setAttribute("aria-label", b.name); img.src = b.logo; img.alt = b.name;
      a.appendChild(img); d.getElementById("h").appendChild(a);
    }
    var cta = d.getElementById("cta");
    cta.href = b.site; cta.hidden = false;
    cta.insertBefore(d.createTextNode(T.visit + label), cta.firstChild);
    var f = d.getElementById("f"), fa = d.createElement("a");
    fa.href = b.site; fa.textContent = b.name;
    f.appendChild(d.createTextNode("\\u00a9 " + new Date().getFullYear() + " ")); f.appendChild(fa);
  }
  if (b && b.icon) { var l = d.createElement("link"); l.rel = "icon"; l.href = b.icon; d.head.appendChild(l); }
})();
`;

const arrow = `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M3 8h10m-4-4 4 4-4 4" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

/** JSON safe inside a <script> block. */
const inline = (v: unknown) => JSON.stringify(v).replace(/</g, "\\u003c");

export function parkPage(config: ParkConfig, preview?: { host: string; lang: "en" | "it" }) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<meta name="color-scheme" content="light">
<title>Domain registered</title>
<style>${css}</style>
<script>window.PARK=${inline(config)};${preview ? `window.PARK_HOST=${inline(preview.host)};window.PARK_LANG=${inline(preview.lang)};` : ""}</script>
</head>
<body>
<header id="h"></header>
<main>
  <span class="tag" id="tag">Domain registered</span>
  <h1 id="d"></h1>
  <p id="p"></p>
  <a class="cta" id="cta" hidden>${arrow}</a>
</main>
<footer id="f"></footer>
<script>${script}</script>
</body>
</html>`;
}

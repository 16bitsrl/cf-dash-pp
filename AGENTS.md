# Dash++

Pannello integrato con Cloudflare per ciò che la dashboard non gestisce: parcheggio
domini, redirect, posta (MX, SPF, DKIM, DMARC), gruppi di domini e cronologia delle
modifiche. Pubblicato su https://cf-dash.16bit.cloud (account Cloudflare 16bit).

## Documentazione

La documentazione di progetto è in `docs/`:

- `docs/setup.md`: risorse create, configurazione, client OAuth, token, deploy;
- `docs/architettura.md`: componenti, accesso, decisioni;
- `docs/sviluppo.md`: sviluppo in locale e test.

`docs/` non va committata per ora (Mattia, 2026-10-28): è esclusa in
`.git/info/exclude`. Il resto del progetto si committa.

## Regole

- Usa `cf` per deploy e risorse (`cloudflare.config.ts`), non Wrangler.
- Interfaccia in inglese di base, con traduzione italiana: ogni testo visibile sta in
  `src/app/i18n/en.ts` e `it.ts`. Il Worker restituisce codici e parametri, mai testi.
- Testi per chi usa il prodotto, niente dettagli tecnici.
- Componenti e token Kumo (`npx @cloudflare/kumo doc <Componente>`), niente colori
  Tailwind grezzi.
- Non sovrascrivere mai record DNS esistenti senza dirlo all'utente.
- Prove con scritture reali: solo su `quadraconti.com` (autorizzato da Mattia il
  2026-10-28), riportandolo poi allo stato di partenza.
- Il parcheggio è nativo (Worker `dash-plus-plus-park` pubblicato da Dash++ in ogni
  account). I vecchi Worker `park-*` vanno pensionati.
- Il deploy dell'istanza di 16bit prende account, dominio e amministratori da `.env`
  (non committato, vedi `docs/setup.md`): senza, andrebbe su workers.dev.

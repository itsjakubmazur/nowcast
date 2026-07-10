# nowcast-narrate — Cloudflare Worker

AI verdikt (Gemini) pro libovolné místo + Web Push upozornění pro oblíbená místa.

## Routy

- `GET /verdict?lat=..&lon=..&label=..` — AI verdikt, edge-cachovaný ~10 min.
- `GET /vapid-public-key` — veřejný VAPID klíč (frontend ho použije pro `pushManager.subscribe`).
- `POST /subscribe` — `{ subscription, favorites: [{lat,lon,label}, ...] }` → uloží do KV.
- `POST /unsubscribe` — `{ endpoint }` → smaže z KV.
- `scheduled()` (cron `*/10 * * * *`) — projde všechny subscriptions, zkontroluje
  jejich oblíbená místa proti `forecast_grid.json` a pošle prázdný Web Push,
  když hrozí déšť (do ~45 min) nebo je aktivní výstraha ČHMÚ.

## Jednorázový setup (nutno provést ručně — vyžaduje Cloudflare účet)

1. **KV namespace pro push subscriptions:**
   ```
   wrangler kv namespace create SUBSCRIPTIONS
   wrangler kv namespace create SUBSCRIPTIONS --preview
   ```
   Zkopíruj vrácená `id` / `preview_id` do `wrangler.toml` (nahraď placeholdery
   `REPLACE_WITH_REAL_KV_NAMESPACE_ID` / `REPLACE_WITH_REAL_KV_PREVIEW_NAMESPACE_ID`).

2. **VAPID klíčový pár pro Web Push.** Veřejný klíč je už v `wrangler.toml`
   (`VAPID_PUBLIC_KEY`). Soukromou polovinu (vygenerovanou offline, nikdy
   neopustila session, do repa se NESMÍ dostat) nastav jako secret:
   ```
   wrangler secret put VAPID_PRIVATE_KEY
   ```
   Hodnotu private key dostaneš od toho, kdo tuto session spustil (byla
   vypsaná v chatu, ne v souboru). Pokud jsi ji ztratil/a, vygeneruj nový pár
   a aktualizuj i `VAPID_PUBLIC_KEY` v `wrangler.toml` — oba klíče patří k sobě.

   Nový pár (kdyby bylo potřeba rotovat) lze vygenerovat offline přes OpenSSL:
   ```
   openssl ecparam -genkey -name prime256v1 -noout -out priv.pem
   openssl ec -in priv.pem -text -noout   # vypíše priv/pub raw bytes
   ```
   a raw bytes zakódovat jako base64url (`kty:EC, crv:P-256`, uncompressed
   point `04||X||Y` pro veřejný klíč, `d` pro soukromý).

3. **Gemini API klíč** (pokud ještě není nastavený):
   ```
   wrangler secret put GEMINI_API_KEY
   ```

4. **Deploy:**
   ```
   wrangler deploy
   ```
   (nebo přes `.github/workflows/deploy-worker.yml`, který se spouští
   automaticky při push do `workers/narrate/**` — potřebuje `CF_API_TOKEN`
   secret v GitHub repu).

## Poznámky k designu

- Push notifikace nemají payload (RFC 8292 VAPID bez šifrovaného těla) —
  jednodušší a spolehlivější než plná ECE šifrace (RFC 8291), za cenu obecné
  zprávy. Service worker po kliknutí otevře appku, která si sama dotáhne
  aktuální stav pro dané místo.
- `/subscribe` je idempotentní a levné volat opakovaně — frontend ho volá i
  při refreshi stránky, pokud je push povolený, aby se obnovilo TTL (60 dní)
  a aktuální seznam oblíbených míst.
- `/verdict` je GET (ne POST jako dřív), aby šel cachovat přes Cloudflare
  Cache API i běžný `fetch` cache — souřadnice se zaokrouhlují na ~1 km, ať
  víc uživatelů ze stejné obce sdílí cache hit a šetří Gemini kvótu.

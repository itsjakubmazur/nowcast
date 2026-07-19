# Brand font — Alcyone (atipo foundry)

Sem patří soubory fontu Alcyone:

- `Alcyone-Medium.woff2` (povinný — základní řez, atipo ho nabízí zdarma)
- `Alcyone-Bold.woff2` (volitelný — bez něj prohlížeč bold syntetizuje z Medium)

## Jak je získat

1. Otevři https://www.atipofoundry.com/fonts/alcyone
2. Stáhni free balíček (Medium, „pay what you want") — přijde e-mailem
3. Z balíčku vezmi webfont `.woff2` soubory, přejmenuj podle názvů výše
   a nakopíruj do tohoto adresáře

Licence: atipo free balíček zahrnuje web licenci pro vlastní projekty —
soubory fontu se commitují sem (self-hosting), do žádné CDN se neposílají.

Dokud soubory chybí, `@font-face` v `css/app.css` se tiše neuplatní
a web jede na systémovém font stacku — nic se nerozbije.

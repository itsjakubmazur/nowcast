// Sloučení lišt ve středních šířkách (769–1080 px).
//
// Na desktopu má appka dvě fixní lišty: vlevo #left-card (nowcast, předpověď),
// vpravo #right-panel (týden, modely, data). Mezi 769 a 1080 px se ale obě
// nevejdou tak, aby mezi nimi zbyla použitelná mapa — z ní je proužek.
//
// Původní řešení bylo `display: none` na pravém panelu. Tím ale zmizely
// expertní panely a s nimi význam tlačítek TÝDEN a DATA v liště sekcí:
// zůstala klikatelná a nedělala nic. Klikneš, nestane se nic, a nemáš jak
// zjistit proč — mrtvé ovládání je horší než chybějící.
//
// Obsah se proto nezahazuje, ale stěhuje. V tomhle pásmu se pravý panel
// vsune na konec levé karty, takže vznikne JEDEN svitek se vším a mapa má
// celou zbylou šířku. Navigace sekcí funguje beze změny: scrollerOf() si
// najde skutečný rolující kontejner, a ten je pak jen jeden.
//
// Stěhuje se uzel v DOMu, ne kopie. Canvasy grafů si při přepojení nechají
// obsah i posluchače, takže se nemusí nic překreslovat ani přepojovat.

const BAND = "(min-width: 769px) and (max-width: 1080px)";

export function initRail() {
  const left = document.getElementById("left-card");
  const right = document.getElementById("right-panel");
  const mq = window.matchMedia?.(BAND);
  if (!left || !right || !mq) return;

  // Kam ho vrátit, až se okno zase roztáhne. Držím si rodiče i následníka,
  // protože appka mezi ně nic nepřidává — kdyby se to změnilo, fallback
  // níž ho prostě přilepí na konec, což je pořád správné pořadí.
  const home = right.parentElement;
  const after = right.nextElementSibling;

  const apply = () => {
    if (mq.matches) {
      if (right.parentElement !== left) left.appendChild(right);
    } else if (right.parentElement !== home) {
      if (after && after.parentElement === home) home.insertBefore(right, after);
      else home.appendChild(right);
    }
  };

  apply();
  mq.addEventListener?.("change", apply);
}

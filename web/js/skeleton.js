// Skeleton placeholdery pro karty pravého panelu (a pár v levé kartě), které
// se plní asynchronně po výběru místa. Bez nich byly tyto karty buď prázdné,
// nebo úplně schované (display:none) — při scrollu dolů byl vidět "uťatý",
// prázdný prostor a obsah pak najednou "naskočil". Skeletony mají STEJNÉ CSS
// třídy jako finální obsah (fc7-day, aq-item, astro-row, act…),
// takže mají od začátku správnou výšku — žádný layout jump při načtení.

const shimmer = (w, h, extra = "") =>
  `<span class="skel" style="width:${w};height:${h}${extra ? ";" + extra : ""}"></span>`;

function skelFc7(n = 7) {
  let html = "";
  for (let i = 0; i < n; i++) {
    html += `<div class="fc7-day">
      <div>${shimmer("34px", "12px")}</div>
      <div>${shimmer("24px", "10px", "margin-top:.2rem")}</div>
      <div>${shimmer("30px", "30px", "margin:.3rem 0;border-radius:50%")}</div>
      <div>${shimmer("46px", "13px")}</div>
      <div>${shimmer("58px", "10px", "margin-top:.2rem")}</div>
    </div>`;
  }
  return html;
}

function skelAq() {
  const item = `<div class="aq-item"><div>${shimmer("40%", "9px")}</div><div style="margin-top:.3rem">${shimmer("60%", "16px")}</div></div>`;
  return `<div class="aq-title">${shimmer("120px", "11px")}</div>
    <div class="aq-grid">${item}${item}${item}${item}</div>`;
}

function skelAstro(n = 4) {
  let html = "";
  for (let i = 0; i < n; i++) {
    html += `<div class="astro-row">
      ${shimmer("4.4rem", "9px")}${shimmer("70px", "12px")}${shimmer("50px", "9px", "margin-left:auto")}
    </div>`;
  }
  return html;
}

function skelActivities(n = 6) {
  let html = "";
  for (let i = 0; i < n; i++) {
    html += `<div class="act">
      <div>${shimmer("18px", "16px", "margin:0 auto")}</div>
      <div>${shimmer("70%", "8px", "margin:.3rem auto 0")}</div>
      <div>${shimmer("50%", "12px", "margin:.25rem auto 0")}</div>
    </div>`;
  }
  return html;
}

export function showLoadingSkeletons() {
  const set = (id, html) => { const el = document.getElementById(id); if (el) el.innerHTML = html; };

  set("fc7-grid", skelFc7());
  const fc7 = document.getElementById("fc7");
  if (fc7) fc7.style.display = "block";

  set("aq-panel", skelAq());
  document.getElementById("aq-panel")?.classList.add("show");

  set("astro-body", skelAstro());
  document.getElementById("astro-panel")?.classList.add("show");

  set("act-grid", skelActivities());
  document.getElementById("activities-panel")?.classList.add("show");

  const minBars = document.getElementById("minutely-bars");
  if (minBars) minBars.innerHTML = `<span class="skel" style="width:100%;height:100%;border-radius:8px"></span>`;
  document.getElementById("precip-panel")?.classList.add("show");
}

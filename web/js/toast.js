// Nenásilné oznámení místo alert() — vizuálně sdílí #notif-bar s dešťovými
// upozorněními, ale s vlastní krátkou dobou zobrazení pro informační hlášky.

let hideTimer = null;

export function showToast(text, { kind = "info", timeoutMs = 4000 } = {}) {
  const bar = document.getElementById("notif-bar");
  const textEl = document.getElementById("notif-text");
  if (!bar || !textEl) return;
  textEl.textContent = text;
  bar.classList.remove("info");
  if (kind === "info") bar.classList.add("info");
  bar.classList.add("show");
  clearTimeout(hideTimer);
  if (timeoutMs) {
    hideTimer = setTimeout(() => bar.classList.remove("show"), timeoutMs);
  }
}

export function initToastClose() {
  document.getElementById("notif-close")?.addEventListener("click", () => {
    document.getElementById("notif-bar").classList.remove("show");
    clearTimeout(hideTimer);
  });
}

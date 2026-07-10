import { showToast } from "./toast.js";

export async function shareCurrentView(label) {
  const url = window.location.href;
  const title = "nowcast" + (label ? ` — ${label}` : "");
  if (navigator.share) {
    try {
      await navigator.share({ title, url });
      return;
    } catch (e) {
      if (e?.name === "AbortError") return; // uživatel zavřel share sheet
    }
  }
  try {
    await navigator.clipboard.writeText(url);
    showToast("Odkaz zkopírován do schránky.");
  } catch {
    showToast(url, { timeoutMs: 8000 });
  }
}

export function embedUrl() {
  const u = new URL(window.location);
  u.searchParams.set("embed", "1");
  return u.toString();
}

export async function copyEmbedLink() {
  try {
    await navigator.clipboard.writeText(embedUrl());
    showToast("Odkaz pro vložení (embed) zkopírován.");
  } catch {
    showToast(embedUrl(), { timeoutMs: 8000 });
  }
}

export function initEmbedMode() {
  const u = new URL(window.location);
  if (u.searchParams.get("embed") === "1") {
    document.body.classList.add("embed");
  }
}

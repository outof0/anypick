import { mount } from "nimbus-docs/client";
import { getTranslator, type Locale } from "@/i18n";

function initPageActions(root: HTMLElement): () => void {
  const copyBtn = root.querySelector<HTMLButtonElement>("[data-nb-page-actions-copy]");
  const copyIcon = root.querySelector<SVGElement>("[data-nb-page-actions-copy-icon]");
  const checkIcon = root.querySelector<SVGElement>("[data-nb-page-actions-check-icon]");
  const label = root.querySelector<HTMLSpanElement>("[data-nb-page-actions-label]");
  const mdUrl = root.dataset.mdUrl;
  const locale = (root.dataset.locale ?? "en") as Locale;
  const translator = getTranslator(locale);

  if (!copyBtn || !mdUrl) return () => {};

  let resetTimer: number | undefined;

  async function showState(state: "copied" | "error") {
    if (!copyIcon || !checkIcon || !label) return;
    const t = await translator;
    if (state === "copied") {
      copyIcon.classList.add("hidden");
      checkIcon.classList.remove("hidden");
      label.textContent = t("pageActions.copied");
    } else {
      label.textContent = t("pageActions.copyFailed");
    }
    if (resetTimer) window.clearTimeout(resetTimer);
    resetTimer = window.setTimeout(() => {
      copyIcon.classList.remove("hidden");
      checkIcon.classList.add("hidden");
      label.textContent = t("pageActions.copyPage");
    }, 1500);
  }

  async function handleCopyPage() {
    try {
      const res = await fetch(mdUrl!);
      if (!res.ok) {
        await showState("error");
        return;
      }
      const text = await res.text();
      await navigator.clipboard.writeText(text);
      await showState("copied");
    } catch {
      await showState("error");
    }
  }

  copyBtn.addEventListener("click", handleCopyPage);

  return () => {
    if (resetTimer) window.clearTimeout(resetTimer);
    copyBtn.removeEventListener("click", handleCopyPage);
  };
}

mount("[data-nb-page-actions]", initPageActions);

/**
 * Sync key `ui-pm-tab` (sessionStorage) is shared with the
 * `<nb-pm-restore>` early-paint element to avoid flash across navigations.
 */

import { mount, initTabs } from "nimbus-docs/client";
import { getTranslator, type Locale } from "@/i18n";

function cloneIcon(tpl: HTMLTemplateElement | null): Node {
  return tpl ? tpl.content.cloneNode(true) : document.createTextNode("");
}

function initPackageManager(container: HTMLElement): () => void {
  const locale = (container.dataset.locale ?? "en") as Locale;
  const translator = getTranslator(locale);
  const copyTpl = container.querySelector<HTMLTemplateElement>("[data-nb-pm-icon-copy]");
  const checkTpl = container.querySelector<HTMLTemplateElement>("[data-nb-pm-icon-check]");

  const tabs = initTabs({
    container,
    tabSelector: "[data-nb-pm-tab]",
    panelSelector: "[data-nb-pm-panel]",
    rovingTabindex: true,
    sync: { key: "ui-pm-tab", storage: "session" },
  });

  const copyHandlers: Array<{ btn: HTMLButtonElement; handler: () => void; timer?: number }> = [];

  container.querySelectorAll<HTMLButtonElement>("[data-nb-pm-copy]").forEach((btn) => {
    const copyLabel = btn.getAttribute("aria-label") ?? "";
    const handlerInfo: { btn: HTMLButtonElement; handler: () => void; timer?: number } = {
      btn,
      handler: async () => {
        try {
          await navigator.clipboard.writeText(btn.dataset.nbCommand ?? "");
        } catch {
          return;
        }
        const t = await translator;
        btn.setAttribute("aria-label", t("packageManager.copied"));
        btn.replaceChildren(cloneIcon(checkTpl));
        if (handlerInfo.timer) window.clearTimeout(handlerInfo.timer);
        handlerInfo.timer = window.setTimeout(() => {
          btn.replaceChildren(cloneIcon(copyTpl));
          btn.setAttribute("aria-label", copyLabel);
        }, 1500);
      },
    };
    btn.addEventListener("click", handlerInfo.handler);
    copyHandlers.push(handlerInfo);
  });

  return () => {
    tabs.destroy();
    copyHandlers.forEach(({ btn, handler, timer }) => {
      btn.removeEventListener("click", handler);
      if (timer) window.clearTimeout(timer);
    });
  };
}

mount("[data-nb-pm]", initPackageManager);

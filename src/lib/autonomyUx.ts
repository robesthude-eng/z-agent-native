import { useStore } from "../store/useStore";
import { markStopRequested } from "./stopUx";

function compactText(value: string | null | undefined): string {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function localizeWorkspace(root: ParentNode) {
  for (const span of root.querySelectorAll<HTMLSpanElement>("aside header span")) {
    if (compactText(span.textContent) === "Files") span.textContent = "Файлы";
  }
}

/**
 * Presentation-only Stop acknowledgement. React/store/runtime still own the
 * cancellation itself; this bridge only makes the tap visible before a slow
 * abort request returns. Unlike the old compatibility layer, it does not watch
 * or rewrite every DOM mutation in the application.
 */
function installStopFeedback() {
  document.addEventListener("click", (event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const button = target.closest<HTMLButtonElement>(
      'button[aria-label="Остановить генерацию"]',
    );
    if (!button || button.dataset.zStopping === "true") return;

    const state = useStore.getState();
    const sid = state.currentID;
    if (sid && !sid.startsWith("tmp_")) {
      const list = state.messages[sid] ?? [];
      let assistantId: string | undefined;
      for (let i = list.length - 1; i >= 0; i--) {
        if (list[i]?.role === "assistant") {
          assistantId = list[i]?.id;
          break;
        }
      }
      markStopRequested(sid, assistantId);
    }

    button.dataset.zStopping = "true";
    button.setAttribute("aria-label", "Останавливаю ответ");
    button.title = "Останавливаю…";
    button.disabled = true;

    window.setTimeout(() => {
      if (!button.isConnected) return;
      delete button.dataset.zStopping;
      button.disabled = false;
      button.setAttribute("aria-label", "Остановить генерацию");
      button.title = "Остановить генерацию";
    }, 6000);
  });
}

function installWorkspaceLabel() {
  localizeWorkspace(document);
  document.addEventListener("click", (event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    if (!target.closest('[data-testid="workspace-toggle"]')) return;
    // Workspace is rendered by React after the click handler returns.
    window.setTimeout(() => localizeWorkspace(document), 0);
  });
}

/**
 * Tiny compatibility entrypoint retained for existing bootstrap imports.
 * No MutationObserver is installed: presentation work is bound only to the two
 * explicit user actions that still need legacy bridging.
 */
export function initAutonomyUx() {
  if (typeof window === "undefined" || typeof document === "undefined") return;
  installStopFeedback();
  installWorkspaceLabel();
}

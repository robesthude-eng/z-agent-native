import { useStore } from "../store/useStore";
import { markStopRequested } from "./stopUx";

const RESET_DELAY_MS = 6000;

// Listeners and timers are tracked so a second bootstrap (HMR, a remount, a
// test) cannot stack duplicate handlers: two live click listeners would report
// the same Stop twice and then fight over the same button.
let dispose: (() => void) | null = null;
const pendingTimers = new Set<number>();

function compactText(value: string | null | undefined): string {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function later(run: () => void, delayMs: number) {
  const id = window.setTimeout(() => {
    pendingTimers.delete(id);
    run();
  }, delayMs);
  pendingTimers.add(id);
}

// TODO: the English label comes from src/components/Workspace.tsx. Translating
// it there removes the need for this DOM pass and for installWorkspaceLabel.
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
function installStopFeedback(): () => void {
  const onClick = (event: MouseEvent) => {
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

    later(() => {
      // React may have replaced the node or already restored it, so only undo
      // the exact element this handler marked.
      if (!button.isConnected || button.dataset.zStopping !== "true") return;
      delete button.dataset.zStopping;
      button.disabled = false;
      button.setAttribute("aria-label", "Остановить генерацию");
      button.title = "Остановить генерацию";
    }, RESET_DELAY_MS);
  };

  document.addEventListener("click", onClick);
  return () => document.removeEventListener("click", onClick);
}

function installWorkspaceLabel(): () => void {
  localizeWorkspace(document);
  const onClick = (event: MouseEvent) => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    if (!target.closest('[data-testid="workspace-toggle"]')) return;
    // Workspace is rendered by React after the click handler returns.
    later(() => localizeWorkspace(document), 0);
  };
  document.addEventListener("click", onClick);
  return () => document.removeEventListener("click", onClick);
}

/**
 * Tiny compatibility entrypoint retained for existing bootstrap imports.
 * No MutationObserver is installed: presentation work is bound only to the two
 * explicit user actions that still need legacy bridging. Calling it twice is a
 * no-op, and the returned disposer removes everything it installed.
 */
export function initAutonomyUx(): () => void {
  if (typeof window === "undefined" || typeof document === "undefined") {
    return () => {};
  }
  if (dispose) return dispose;
  const cleanups = [installStopFeedback(), installWorkspaceLabel()];
  dispose = () => {
    for (const cleanup of cleanups) cleanup();
    for (const id of pendingTimers) window.clearTimeout(id);
    pendingTimers.clear();
    dispose = null;
  };
  return dispose;
}

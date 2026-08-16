const RESPONSE_ACTIONS = new Map<string, string>([
  ["Спросить ещё раз", "↻ Ещё раз"],
  ["Изменить последний запрос", "✎ Изменить"],
]);

function compactText(value: string | null | undefined): string {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function polishComposer(root: ParentNode) {
  const section = root.querySelector<HTMLElement>(
    'section[aria-label="Поле ввода сообщения"]',
  );
  section?.parentElement?.classList.add("z-agent-composer-shell");
}

function polishResponseActions(root: ParentNode) {
  for (const button of root.querySelectorAll<HTMLButtonElement>("button")) {
    const text = compactText(button.textContent);
    const replacement = RESPONSE_ACTIONS.get(text);
    if (!replacement) continue;
    button.textContent = replacement;
    button.classList.add("z-agent-response-action");
    if (text === "Спросить ещё раз") {
      button.title = "Повторить последний запрос";
      button.setAttribute("aria-label", "Повторить последний запрос");
    } else {
      button.title = "Изменить последний запрос";
      button.setAttribute("aria-label", "Изменить последний запрос");
    }
  }
}

function polishTopBar(root: ParentNode) {
  for (const button of root.querySelectorAll<HTMLButtonElement>("header button")) {
    if (button.title) continue;
    const aria = button.getAttribute("aria-label");
    if (aria) button.title = aria;
  }
}

function localizeWorkspace(root: ParentNode) {
  for (const span of root.querySelectorAll<HTMLSpanElement>("aside header span")) {
    if (compactText(span.textContent) === "Files") span.textContent = "Файлы";
  }
}

function hideLegacyPermissionUi(root: ParentNode) {
  // New native turns never request tool permission, but a stale browser tab may
  // still contain a card emitted by an older runtime. Do not let that legacy
  // card block an otherwise autonomous session after a hot deploy.
  for (const node of root.querySelectorAll<HTMLElement>("div, section, aside")) {
    const text = compactText(node.textContent);
    if (
      text.startsWith("ЗАПРОС РАЗРЕШЕНИЯ") &&
      text.includes("Разрешить") &&
      text.includes("Отклонить")
    ) {
      node.style.display = "none";
      node.setAttribute("aria-hidden", "true");
      break;
    }
  }
}

function polish(root: ParentNode) {
  polishComposer(root);
  polishResponseActions(root);
  polishTopBar(root);
  localizeWorkspace(root);
  hideLegacyPermissionUi(root);
}

/**
 * Small DOM-level compatibility layer for presentation-only details that span
 * several independently rendered surfaces. Business logic stays in React/the
 * store; this only adds classes, labels and stale-runtime cleanup.
 */
export function initAutonomyUx() {
  if (typeof window === "undefined" || typeof document === "undefined") return;

  let queued = false;
  const run = () => {
    queued = false;
    polish(document);
  };
  const schedule = () => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(run);
  };

  schedule();
  const observer = new MutationObserver(schedule);
  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
    characterData: true,
  });

  window.addEventListener(
    "pagehide",
    () => {
      observer.disconnect();
    },
    { once: true },
  );
}

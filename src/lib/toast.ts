import { create } from "zustand";

export type ToastKind = "success" | "error" | "info";

export type ToastItem = {
  id: number;
  kind: ToastKind;
  text: string;
};

type ToastState = {
  toasts: ToastItem[];
  push: (kind: ToastKind, text: string) => void;
  dismiss: (id: number) => void;
};

const TOAST_TTL_MS = 4000;
const MAX_VISIBLE = 3;

let nextId = 1;
// Dismissal timers used to be fire-and-forget: a toast closed by hand still had
// a timer waiting to run, and a burst of toasts left one pending timer each.
const timers = new Map<number, ReturnType<typeof setTimeout>>();

function cancel(id: number) {
  const timer = timers.get(id);
  if (timer === undefined) return;
  clearTimeout(timer);
  timers.delete(id);
}

export const useToasts = create<ToastState>((set, get) => ({
  toasts: [],
  push: (kind, text) => {
    const id = nextId++;
    const next = [...get().toasts, { id, kind, text }];
    // Toasts pushed out of the visible window are gone, so their timers go too.
    for (const item of next.slice(0, Math.max(0, next.length - MAX_VISIBLE))) {
      cancel(item.id);
    }
    set({ toasts: next.slice(-MAX_VISIBLE) });
    timers.set(
      id,
      setTimeout(() => get().dismiss(id), TOAST_TTL_MS),
    );
  },
  dismiss: (id) => {
    cancel(id);
    set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
  },
}));

export function toast(kind: ToastKind, text: string) {
  useToasts.getState().push(kind, text);
}

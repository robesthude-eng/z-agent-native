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

export const useToasts = create<ToastState>((set, get) => ({
  toasts: [],
  push: (kind, text) => {
    const id = nextId++;
    set((s) => ({
      toasts: [...s.toasts.slice(1 - MAX_VISIBLE), { id, kind, text }],
    }));
    setTimeout(() => get().dismiss(id), TOAST_TTL_MS);
  },
  dismiss: (id) => {
    set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
  },
}));

export function toast(kind: ToastKind, text: string) {
  useToasts.getState().push(kind, text);
}

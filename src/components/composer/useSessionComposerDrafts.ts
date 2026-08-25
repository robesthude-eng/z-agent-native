import { useEffect, useRef } from "react";
import type { ProcessedFile } from "@/api/files";

const sessionDrafts = new Map<string, string>();
const sessionAttachments = new Map<string, ProcessedFile[]>();

export function clearSessionComposerCache(sessionId: string): void {
  sessionDrafts.delete(sessionId);
  sessionAttachments.delete(sessionId);
}

export function storeSessionAttachment(
  sessionId: string,
  attachment: ProcessedFile,
): void {
  const saved = sessionAttachments.get(sessionId) ?? [];
  sessionAttachments.set(sessionId, [
    ...saved.filter((item) => item.name !== attachment.name),
    attachment,
  ]);
}

interface UseSessionComposerDraftsOptions {
  sessionId: string | null;
  text: string;
  attachments: ProcessedFile[];
  setText: (value: string) => void;
  addAttachments: (attachments: ProcessedFile[]) => void;
  clearAttachments: () => void;
}

export function useSessionComposerDrafts({
  sessionId,
  text,
  attachments,
  setText,
  addAttachments,
  clearAttachments,
}: UseSessionComposerDraftsOptions): void {
  const textRef = useRef(text);
  textRef.current = text;
  const attachmentsRef = useRef(attachments);
  attachmentsRef.current = attachments;
  const previousSessionRef = useRef<string | null>(null);

  useEffect(() => {
    const previous = previousSessionRef.current;
    if (previous !== null && previous !== sessionId) {
      if (textRef.current) sessionDrafts.set(previous, textRef.current);
      else sessionDrafts.delete(previous);
      setText(sessionDrafts.get(sessionId ?? "") ?? "");

      if (attachmentsRef.current.length > 0) {
        sessionAttachments.set(previous, attachmentsRef.current);
      } else {
        sessionAttachments.delete(previous);
      }
      clearAttachments();
      const restored = sessionId
        ? sessionAttachments.get(sessionId)
        : undefined;
      if (restored?.length) addAttachments(restored);
    }
    previousSessionRef.current = sessionId;
  }, [sessionId, addAttachments, clearAttachments, setText]);
}

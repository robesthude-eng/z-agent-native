import { api } from "../../api/client";

/**
 * Несохранённые черновики редактора, переживающие смену чата и файла.
 *
 * Раньше переключение чата или открытие другого файла (например, по ссылке
 * из ответа) безусловно сбрасывало черновик: проверка несохранённых правок
 * стояла только на закрытии редактора. Теперь черновик откладывается по ключу
 * «сессия + путь» и возвращается, когда этот файл снова открывают.
 */
export interface EditorFileState {
  path: string;
  content: string;
  version?: string | undefined;
}

export interface StashedDraft {
  draft: string;
  base: string;
  version?: string | undefined;
}

const drafts = new Map<string, StashedDraft>();
const MAX_DRAFTS = 50;

const keyOf = (sessionId: string, path: string) => `${sessionId}\u0000${path}`;

/** Remember the editor's unsaved draft; a clean editor stores nothing. */
export function stashDraft(
  sessionId: string | null | undefined,
  file: EditorFileState | null,
  draft: string,
): void {
  if (!sessionId || !file || draft === file.content) return;
  const key = keyOf(sessionId, file.path);
  drafts.delete(key);
  drafts.set(key, { draft, base: file.content, version: file.version });
  while (drafts.size > MAX_DRAFTS) {
    const oldest = drafts.keys().next().value;
    if (oldest === undefined) break;
    drafts.delete(oldest);
  }
}

/** Return and forget the stashed draft for this file, if any. */
export function takeDraft(
  sessionId: string | null | undefined,
  path: string,
): StashedDraft | null {
  if (!sessionId) return null;
  const key = keyOf(sessionId, path);
  const found = drafts.get(key) ?? null;
  drafts.delete(key);
  return found;
}

export function dropDraft(
  sessionId: string | null | undefined,
  path: string | null | undefined,
): void {
  if (sessionId && path) drafts.delete(keyOf(sessionId, path));
}

/** The server refused a save because the file changed after it was opened. */
export function isVersionConflict(error: unknown): boolean {
  const e = error as { status?: number; data?: { code?: unknown } | null };
  return e?.status === 409 && e?.data?.code === "WORKSPACE_FILE_CONFLICT";
}

export type SaveOutcome =
  | { kind: "saved"; file: EditorFileState }
  | { kind: "kept"; file: EditorFileState };

/**
 * Conditional save: the draft is written only over the version it was based
 * on. When the file changed meanwhile (agent, another tab), the user decides:
 * overwrite with the draft, or keep editing against the newer version, which
 * becomes the comparison base so the diff view shows what differs from it.
 */
export async function saveEditorFile(
  file: EditorFileState,
  draft: string,
  sessionId: string,
  confirmOverwrite: () => Promise<boolean>,
): Promise<SaveOutcome> {
  try {
    const saved = await api.writeFile(file.path, draft, sessionId, {
      baseVersion: file.version,
    });
    return {
      kind: "saved",
      file: { path: file.path, content: draft, version: saved?.version },
    };
  } catch (e: unknown) {
    if (!isVersionConflict(e)) throw e;
  }
  if (!(await confirmOverwrite())) {
    const latest = await api.readFile(file.path, sessionId);
    return {
      kind: "kept",
      file: {
        path: file.path,
        content: latest.content ?? latest.text ?? "",
        version: latest.version,
      },
    };
  }
  const saved = await api.writeFile(file.path, draft, sessionId, {
    force: true,
  });
  return {
    kind: "saved",
    file: { path: file.path, content: draft, version: saved?.version },
  };
}

import { useEffect } from "react";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { t } from "@/i18n";
import { cn } from "@/lib/utils";
import DiffView from "../DiffView";
import FilePreview from "../FilePreview";
import {
  ArchiveFileIcon,
  CloseIcon,
  FileIcon,
  ImageFileIcon,
  SaveIcon,
} from "../icons";
import CodeView from "./CodeView";
import type { PreviewKind, ViewMode } from "./fileDecisions";
import { fileVisual } from "./fileVisual";
import { toRelPath } from "./workspaceTreeHelpers";

/**
 * Окно просмотра и правки файла воркспейса.
 *
 * Этап 3.1, четвёртая часть: разметка редактора и диффов вынесена из
 * `Workspace.tsx` дословно. Всё, что бралось из замыкания, стало явным
 * свойством — список длинный намеренно, и прятать его за контекстом не
 * следует: он и есть та связность, которую разделение делает видимой.
 *
 * Решений здесь нет ни одного, и это не совпадение. Что показывать вкладками
 * (`viewModesFor`), какой режим годен после смены файла (`keepViewMode`),
 * правится ли файл и куда ведёт превью — всё в `fileDecisions.ts`, где
 * проверяется перебором. Компонент остаётся разметкой и вызовами.
 *
 * Визуальный проход добавил к этому ровно две вещи, обе — про окно, а не про
 * файл: закрытие по Escape (у всех прочих окон проекта оно есть, здесь
 * единственным способом уйти была мышь) и роль `dialog` для чтения с экрана.
 *
 * **Проверен только чтением.** `.tsx` офлайн-харнесс не запускает: нужен
 * JSX-транспайлер и настоящий DOM. Первым делом после `npm ci` —
 * `npm run typecheck`.
 */
const VIEW_MODE_LABEL: Record<ViewMode, string> = {
  code: t("file_editor.kod"),
  preview: t("file_editor.prevyu"),
  diff: t("file_editor.izmeneniya"),
};

export interface FileEditorProps {
  file: { path: string; content: string };
  draft: string;
  dirty: boolean;
  editable: boolean;
  saving: boolean;
  modes: ViewMode[];
  mode: ViewMode;
  previewKind: PreviewKind | null;
  /** Готовый URL превью или `null`, если превью не показывается. */
  previewUrl: string | null;
  sessionId: string | null;
  /** Почему файл только для чтения. Показывается вместо редактора. */
  readonlyNote: string;
  onModeChange: (mode: ViewMode) => void;
  onDraftChange: (value: string) => void;
  onSave: () => void;
  onClose: () => void;
}

export default function FileEditor({
  file,
  draft,
  dirty,
  editable,
  saving,
  modes,
  mode,
  previewKind,
  previewUrl,
  sessionId,
  readonlyNote,
  onModeChange,
  onDraftChange,
  onSave,
  onClose,
}: FileEditorProps) {
  // Escape закрывает окно. Дальше решает `onClose`: у несохранённого файла он
  // сначала спросит подтверждение — то же, что и у крестика.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const rel = toRelPath(file.path);
  const slash = rel.lastIndexOf("/");
  const dirPart = slash === -1 ? "" : `${rel.slice(0, slash)}/`;
  const namePart = slash === -1 ? rel : rel.slice(slash + 1);
  const visual = fileVisual(namePart);
  const TitleIcon =
    visual.glyph === "image"
      ? ImageFileIcon
      : visual.glyph === "archive"
        ? ArchiveFileIcon
        : FileIcon;

  return (
    <>
      {/* Фон — кнопка-сосед, как в PanelModal: закрытие кликом мимо
          остаётся доступным и с клавиатуры, а окну не нужен
          stopPropagation, чтобы клики внутри не закрывали его. */}
      <button
        type="button"
        className="fixed inset-0 z-[60] bg-black/55 backdrop-blur-[3px] animate-in fade-in"
        onClick={onClose}
        aria-label={t("file_editor.zakryt_fayl")}
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={rel}
        className="fixed left-1/2 top-1/2 z-[65] flex h-[min(660px,88dvh)] w-[min(880px,94vw)] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-2xl border border-border bg-card shadow-e3 animate-in fade-in zoom-in-95"
      >
        <div className="flex shrink-0 items-center gap-2.5 border-b border-border px-4 py-3">
          <span className="shrink-0" style={{ color: visual.color }}>
            <TitleIcon size={16} />
          </span>
          {/* Путь и имя разной яркости: в списке из десяти открытых файлов
              глаз ищет имя, а путь нужен только чтобы не спутать одноимённые. */}
          <span className="flex min-w-0 flex-1 items-baseline gap-0 truncate font-mono text-[13px]">
            {dirPart && (
              <span className="truncate text-muted-foreground">{dirPart}</span>
            )}
            <span className="truncate font-medium text-foreground">
              {namePart}
            </span>
          </span>
          {dirty && (
            <span
              className="shrink-0 rounded-full bg-warning/15 px-2 py-0.5 text-[10.5px] font-medium text-warning"
              title={t("file_editor.est_nesohranennye_pravki")}
            >
              {t("file_editor.ne_sohraneno")}
            </span>
          )}
          {editable && (
            <Button
              size="sm"
              className="h-8 shrink-0 gap-1.5 text-xs"
              disabled={!dirty || saving}
              onClick={() => {
                onSave();
              }}
              title={t("file_editor.sohranit_ctrl_s")}
            >
              <SaveIcon size={14} />
              {saving
                ? t("account_tab_content.sohranenie")
                : t("file_editor.sohranit")}
            </Button>
          )}
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8 shrink-0 rounded-lg"
            onClick={onClose}
            title={t("panel_modal.zakryt")}
            aria-label={t("panel_modal.zakryt")}
          >
            <CloseIcon size={16} />
          </Button>
        </div>

        {/* Вкладки: код / превью / несохранённые изменения. Вкладка есть
            только когда ей есть что показать — пустая «Превью» для .ts
            только путала бы.

            Набор считает `viewModesFor`, а не разметка. До этого правило
            было выписано здесь заново, а вынесенная функция вместе с
            `keepViewMode` не звалась ниоткуда: написана, покрыта тестами и
            мертва — тот же случай, что с полем `cancelsTurn`. */}
        {modes.length > 1 && (
          <div className="flex shrink-0 items-center border-b border-border px-3 py-2">
            <div className="inline-flex items-center gap-0.5 rounded-lg bg-muted/60 p-0.5">
              {modes.map((m) => (
                <button
                  key={m}
                  type="button"
                  aria-pressed={mode === m}
                  className={cn(
                    "rounded-[7px] px-3 py-1 text-[11.5px] transition-all",
                    mode === m
                      ? "bg-card text-foreground shadow-e1"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                  onClick={() => onModeChange(m)}
                >
                  {VIEW_MODE_LABEL[m]}
                </button>
              ))}
            </div>
          </div>
        )}

        {mode === "diff" && dirty ? (
          <ScrollArea className="flex-1 min-h-0 w-full">
            <div className="p-3">
              <DiffView
                oldText={file.content}
                newText={draft}
                emptyLabel={t(
                  "file_editor.chernovik_sovpadaet_s_sohranennym_faylom",
                )}
              />
            </div>
          </ScrollArea>
        ) : mode === "preview" && previewKind && sessionId && previewUrl ? (
          <FilePreview
            kind={previewKind}
            path={file.path}
            content={file.content}
            sessionId={sessionId}
            url={previewUrl}
          />
        ) : (
          // Подсветка синтаксиса — в `CodeView`; оба состояния, правка и
          // только чтение, живут там же, потому что метрика текста у них
          // обязана совпадать до пикселя (см. шапку того файла).
          <CodeView
            path={file.path}
            value={editable ? draft : file.content}
            editable={editable}
            onChange={onDraftChange}
            readonlyNote={readonlyNote}
          />
        )}
      </div>
    </>
  );
}

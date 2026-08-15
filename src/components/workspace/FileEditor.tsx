import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
import DiffView from "../DiffView";
import FilePreview from "../FilePreview";
import { CloseIcon, SaveIcon } from "../icons";
import CodeView from "./CodeView";
import type { PreviewKind, ViewMode } from "./fileDecisions";
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
 * **Проверен только чтением.** `.tsx` офлайн-харнесс не запускает: нужен
 * JSX-транспайлер и настоящий DOM. Первым делом после `npm ci` —
 * `npm run typecheck`.
 */
const VIEW_MODE_LABEL: Record<ViewMode, string> = {
  code: "Код",
  preview: "Превью",
  diff: "Изменения",
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
  return (
    <>
      {/* Фон — кнопка-сосед, как в PanelModal: закрытие кликом мимо
          остаётся доступным и с клавиатуры, а окну не нужен
          stopPropagation, чтобы клики внутри не закрывали его. */}
      <button
        type="button"
        className="fixed inset-0 z-[60] bg-black/50 backdrop-blur-sm"
        onClick={onClose}
        aria-label="Закрыть файл"
      />
      <div className="fixed left-1/2 top-1/2 z-[65] flex h-[min(560px,85dvh)] w-[min(720px,94vw)] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-xl border border-border bg-card shadow-e3">
        <div className="flex shrink-0 items-center gap-2 border-b border-border px-4 py-3">
          <span className="min-w-0 flex-1 truncate font-mono text-sm">
            {toRelPath(file.path)}
            {dirty && (
              <span
                className="ml-2 text-amber-400"
                title="Есть несохранённые правки"
              >
                •
              </span>
            )}
          </span>
          {editable && (
            <Button
              size="sm"
              className="h-8 shrink-0 gap-1.5 text-xs"
              disabled={!dirty || saving}
              onClick={() => {
                onSave();
              }}
              title="Сохранить (Ctrl+S)"
            >
              <SaveIcon size={14} />
              {saving ? "Сохранение…" : "Сохранить"}
            </Button>
          )}
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8 shrink-0"
            onClick={onClose}
            title="Закрыть"
            aria-label="Закрыть"
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
          <div className="flex shrink-0 items-center gap-1 border-b border-border px-3 py-1.5">
            {modes.map((m) => (
              <button
                key={m}
                type="button"
                className={cn(
                  "rounded-md px-2.5 py-1 text-[11.5px] transition",
                  mode === m
                    ? "bg-accent text-foreground"
                    : "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
                )}
                onClick={() => onModeChange(m)}
              >
                {VIEW_MODE_LABEL[m]}
              </button>
            ))}
          </div>
        )}

        {mode === "diff" && dirty ? (
          <ScrollArea className="flex-1 min-h-0 w-full">
            <div className="p-3">
              <DiffView
                oldText={file.content}
                newText={draft}
                emptyLabel="Черновик совпадает с сохранённым файлом"
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

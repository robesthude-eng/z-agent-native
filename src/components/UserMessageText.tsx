import { useMemo, useState } from "react";
import { t, tf } from "@/i18n";
import { cn } from "@/lib/utils";
import CopyButton from "./CopyButton";

/**
 * Классический рендер текста пользовательского сообщения.
 *
 * Короткий текст — обычный пузырь (текст всегда выровнен влево, сам пузырь
 * прижат вправо родителем). Длинная вставка (много строк / символов) —
 * отдельная карточка «Вставленный текст / Фрагмент кода» со счётчиком строк,
 * кнопкой копирования и сворачиванием: свёрнута показывает начало с фейдом,
 * развёрнута — прокручивается внутри ограниченной высоты, не раздувая ленту.
 */

const LONG_LINES = 12;
const LONG_CHARS = 700;

/** Эвристика «похоже на код»: fenced-блок или заметная доля кодо-строк. */
const CODE_HINT_RE =
  /[{}[\]();=<>]|=>|<\/|\/>|^\s{2,}\S|\b(function|const|let|var|import|export|return|def|class|public|private|interface|SELECT|INSERT|UPDATE|FROM|WHERE)\b/;

function looksLikeCode(text: string, lines: string[]): boolean {
  if (text.includes("```")) return true;
  const nonEmpty = lines.filter((l) => l.trim().length > 0);
  if (nonEmpty.length < 4) return false;
  const hits = nonEmpty.filter((l) => CODE_HINT_RE.test(l)).length;
  return hits / nonEmpty.length >= 0.4;
}

export default function UserMessageText({ text }: { text: string }) {
  const [expanded, setExpanded] = useState(false);

  const { lineCount, isLong, codeLike } = useMemo(() => {
    const lines = text.split("\n");
    return {
      lineCount: lines.length,
      isLong: lines.length > LONG_LINES || text.length > LONG_CHARS,
      codeLike: looksLikeCode(text, lines),
    };
  }, [text]);

  // Короткое сообщение — классический пузырь.
  //
  // Потолок ширины стоит здесь, а не на обёртке, намеренно: длинная вставка
  // ниже — это код, и сужать её значило бы ломать строки там, где их ломать
  // нельзя. Ограничение нужно только разговорной реплике.
  //
  // `min(82%, 560px)`: доля — чтобы на телефоне пузырь не расползался во всю
  // ширину и было видно, что реплика прижата вправо; абсолютный потолок —
  // чтобы на широком экране строка не становилась длиннее удобной для чтения.
  if (!isLong) {
    return (
      <div className="w-fit min-w-[4.5rem] max-w-[min(82%,560px)] self-end rounded-3xl bg-muted px-4 py-2.5 text-left">
        <div className="whitespace-pre-wrap break-normal text-[14.5px] leading-relaxed text-foreground/95">
          {text}
        </div>
      </div>
    );
  }

  // Длинная вставка — карточка со шапкой, фейдом и сворачиванием.
  return (
    <div className="w-full max-w-full self-end overflow-hidden rounded-xl border border-border bg-card text-left shadow-sm">
      <div className="flex items-center gap-2 border-b border-border bg-muted/50 px-3 py-1.5">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          {codeLike
            ? t("user_message_text.fragment_koda")
            : t("user_message_text.vstavlennyy_tekst")}
        </span>
        <span className="text-[11px] tabular-nums text-muted-foreground/70">
          {lineCount} строк
        </span>
        <div className="ml-auto flex items-center">
          <CopyButton
            text={text}
            title={t("user_message_text.kopirovat_vstavlennyy_tekst")}
            className="h-6 w-6"
          />
        </div>
      </div>

      <div
        className={cn(
          "whitespace-pre-wrap break-words px-3 py-2 leading-relaxed text-foreground/95",
          codeLike ? "font-mono text-[12.5px]" : "text-[13.5px]",
          expanded
            ? "max-h-[420px] overflow-y-auto"
            : "max-h-[180px] overflow-hidden [mask-image:linear-gradient(to_bottom,black_55%,transparent)]",
        )}
      >
        {text}
      </div>

      <button
        type="button"
        aria-expanded={expanded}
        className="block w-full border-t border-border px-3 py-1.5 text-center text-[11px] text-muted-foreground transition hover:bg-accent hover:text-foreground"
        onClick={() => setExpanded((v) => !v)}
      >
        {expanded
          ? t("sidebar.svernut")
          : tf("user_message_text.razvernut_0_strok", [lineCount])}
      </button>
    </div>
  );
}

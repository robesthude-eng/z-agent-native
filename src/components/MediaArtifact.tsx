import { useState } from "react";
import { usePreviewUrl } from "@/api/previewUrl";
import { t, tf } from "@/i18n";
import { cn } from "@/lib/utils";
import { useStore } from "../store/useStore";
import { DownloadIcon, PreviewIcon } from "./icons";

/**
 * Сведения о сгенерированном файле — то, что кладёт в `metadata.media`
 * `server/native/media.mjs`. Кроме `kind` и `path` всё необязательно: набор зависит
 * от инструмента, и падать из-за отсутствующего поля было бы хуже, чем
 * показать карточку без него.
 */
export interface MediaArtifactInfo {
  kind: string;
  path: string;
  mimeType?: string;
  bytes?: number;
  engine?: string;
  /** Документ собран запасным генератором, без Chromium. */
  degraded?: boolean;
  variants?: string[];
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

/**
 * Разбор `state.metadata.media` из сырого пайлоада.
 *
 * Метаданные приходят по сети и типом не гарантированы, поэтому проверяется
 * каждое поле, а не приводится объект целиком: один чужой `path: {…}` уронил бы
 * всю ленту сообщений (React error #31).
 */
export function readMediaArtifact(metadata: unknown): MediaArtifactInfo | null {
  if (!metadata || typeof metadata !== "object") return null;
  const raw = (metadata as { media?: unknown }).media;
  if (!raw || typeof raw !== "object") return null;
  const media = raw as Record<string, unknown>;
  const path = str(media.path);
  if (!path) return null;
  const variants = Array.isArray(media.variants)
    ? media.variants.filter((item): item is string => typeof item === "string")
    : undefined;
  return {
    kind: str(media.kind) ?? "file",
    path,
    mimeType: str(media.mimeType),
    bytes: typeof media.bytes === "number" ? media.bytes : undefined,
    engine: str(media.engine),
    degraded: media.degraded === true,
    variants: variants && variants.length > 1 ? variants : undefined,
  };
}

/** Размер файла словами. Пустая строка — размер не пришёл. */
export function humanBytes(bytes?: number): string {
  if (typeof bytes !== "number" || !Number.isFinite(bytes) || bytes < 0)
    return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Результат медиа-инструмента прямо в ленте.
 *
 * Сгенерированный файл — это ровно тот результат, ради которого вызывался
 * инструмент. Показывать его строкой «wrote 41 KB to out/poster.png» значит
 * заставлять человека искать файл руками в дереве — при том что всё нужное
 * для показа уже лежит в метаданных вызова.
 *
 * Адрес берётся тем же `usePreviewUrl`, что и в панели файлов: одна точка
 * правды про токен превью и про запасной путь по cookie.
 */
export default function MediaArtifact({
  media,
  className,
}: {
  media: MediaArtifactInfo;
  className?: string;
}) {
  const sessionId = useStore((s) => s.currentID) || "";
  const requestOpenFile = useStore((s) => s.requestOpenFile);
  const url = usePreviewUrl(sessionId, media.path);
  const [failed, setFailed] = useState(false);

  const size = humanBytes(media.bytes);
  const kind = media.kind;
  const showable = url && !failed;

  return (
    <div
      className={cn(
        "overflow-hidden rounded-lg border border-border bg-card/60",
        className,
      )}
    >
      {showable && kind === "image" && (
        <div className="flex max-h-80 items-center justify-center bg-[repeating-conic-gradient(#0000_0%_25%,#8883_0%_50%)] bg-[length:16px_16px] p-2">
          <img
            src={url}
            alt={media.path}
            className="max-h-72 max-w-full rounded object-contain"
            onError={() => setFailed(true)}
          />
        </div>
      )}

      {showable && kind === "video" && (
        // biome-ignore lint/a11y/useMediaCaption: субтитров к только что собранному файлу не существует — это просмотр артефакта, а не публикация видео
        <video
          src={url}
          controls
          preload="metadata"
          className="max-h-72 w-full bg-black"
          onError={() => setFailed(true)}
        />
      )}

      {showable && kind === "audio" && (
        <div className="p-2.5">
          {/* biome-ignore lint/a11y/useMediaCaption: сгенерированная озвучка без дорожки субтитров */}
          <audio
            src={url}
            controls
            preload="metadata"
            className="w-full"
            onError={() => setFailed(true)}
          />
        </div>
      )}

      {failed && (
        <div className="px-2.5 py-2 text-[12px] text-muted-foreground">
          {t("media_artifact.ne_udalos_pokazat_fayl")}
        </div>
      )}

      {media.variants && (
        <div className="flex flex-wrap gap-1.5 px-2.5 pb-2">
          {media.variants.map((variant) => (
            <button
              key={variant}
              type="button"
              className="rounded border border-border px-1.5 py-0.5 font-mono text-[10.5px] text-muted-foreground transition hover:bg-accent hover:text-foreground"
              onClick={() => requestOpenFile(variant)}
            >
              {variant.split("/").pop()}
            </button>
          ))}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 border-t border-border/70 px-2.5 py-1.5 text-[11px] text-muted-foreground">
        <button
          type="button"
          className="flex items-center gap-1 rounded px-1 py-0.5 font-mono text-[11px] transition hover:bg-accent hover:text-foreground"
          onClick={() => requestOpenFile(media.path)}
          title={t("media_artifact.otkryt_v_paneli_faylov")}
        >
          <PreviewIcon size={12} />
          {media.path}
        </button>
        {size && <span className="tabular-nums">{size}</span>}
        {media.mimeType && <span className="truncate">{media.mimeType}</span>}
        {media.engine && (
          <span className="truncate">
            {tf("media_artifact.dvizhok_0", [media.engine])}
          </span>
        )}
        {media.degraded && (
          <span className="text-amber-500">
            {t("media_artifact.uproschennyy_render_bez_chromium")}
          </span>
        )}
        <span className="flex-1" />
        {url && (
          <a
            href={url}
            download={media.path.split("/").pop()}
            className="flex items-center gap-1 rounded px-1 py-0.5 transition hover:bg-accent hover:text-foreground"
          >
            <DownloadIcon size={12} />
            {t("media_artifact.skachat")}
          </a>
        )}
      </div>
    </div>
  );
}

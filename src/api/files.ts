// File attachment utilities — convert browser File objects to API parts.

export interface ProcessedFile {
  name: string;
  size: number;
  mime: string;
  ext: string;
  kind: "image" | "pdf" | "text" | "zip" | "binary";
  // For the API message:
  part?: { type: "file"; mime: string; url: string; filename?: string };
  // For text files: inline content as text part:
  textPart?: { type: "text"; text: string };
  // Raw data URL for preview:
  dataUrl?: string;
  // Каноническое имя, назначенное сервером (может отличаться от исходного
  // при коллизии). Именно оно показывается и уходит в манифест.
  serverName?: string;
  // Путь относительно корня workspace сессии: uploads/<имя>.
  workspacePath?: string;
  // Полный путь в томе (sessions/<sid>/workspace/uploads/<имя>) — для скачивания.
  uploadedPath?: string;
  // Runtime path/reference for the file inside this session workspace.
  agentPath?: string;
  // For zip archives: number of entries inside (set by api.uploadFile):
  entryCount?: number;
}

const TEXT_EXTS = new Set([
  "txt",
  "md",
  "markdown",
  "json",
  "js",
  "jsx",
  "ts",
  "tsx",
  "css",
  "scss",
  "html",
  "htm",
  "xml",
  "yaml",
  "yml",
  "toml",
  "ini",
  "cfg",
  "conf",
  "py",
  "rb",
  "go",
  "rs",
  "java",
  "kt",
  "c",
  "cpp",
  "h",
  "hpp",
  "cs",
  "php",
  "swift",
  "sh",
  "bash",
  "zsh",
  "sql",
  "graphql",
  "gql",
  "vue",
  "svelte",
  "astro",
  "env",
  "gitignore",
  "dockerfile",
  "csv",
  "tsv",
  "log",
]);

const IMAGE_EXTS = new Set(["jpg", "jpeg", "png", "gif", "webp", "bmp", "svg"]);

const MIME_MAP: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  gif: "image/gif",
  webp: "image/webp",
  bmp: "image/bmp",
  svg: "image/svg+xml",
  pdf: "application/pdf",
  zip: "application/zip",
  txt: "text/plain",
  md: "text/markdown",
  json: "application/json",
  js: "text/javascript",
  ts: "text/typescript",
  tsx: "text/typescript",
  jsx: "text/javascript",
  html: "text/html",
  css: "text/css",
  py: "text/x-python",
  sh: "text/x-shellscript",
  yaml: "text/yaml",
  yml: "text/yaml",
  xml: "text/xml",
  csv: "text/csv",
};

function mimeFromExt(ext: string): string {
  return MIME_MAP[ext] ?? "application/octet-stream";
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024)
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

export function fileKind(name: string): ProcessedFile["kind"] {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  if (IMAGE_EXTS.has(ext)) return "image";
  if (ext === "pdf") return "pdf";
  if (ext === "zip") return "zip";
  if (TEXT_EXTS.has(ext)) return "text";
  return "binary";
}

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      // result is "data:<mime>;base64,<data>" — extract just the data URL
      resolve(result);
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

export async function processFile(file: File): Promise<ProcessedFile> {
  const ext = file.name.split(".").pop()?.toLowerCase() ?? "";
  const kind = fileKind(file.name);
  const mime = file.type || mimeFromExt(ext);

  // base64 читаем ТОЛЬКО для картинок и PDF: их data-URL реально нужен —
  // как превью в чипе и как vision-часть промпта. Для zip/бинарников/текста
  // он не используется никем, а стоил 1.37× размера файла в строке, которая
  // жила в сторе до конца сессии (архив на 50 МБ → ~68 МБ в памяти вкладки,
  // плюс столько же на копию при каждом set()). Такие файлы агент читает из
  // workspace по пути, куда их кладёт аплоад.
  const needsDataUrl = kind === "image" || kind === "pdf";
  const dataUrl = needsDataUrl ? await fileToBase64(file) : undefined;

  const result: ProcessedFile = {
    name: file.name,
    size: file.size,
    mime,
    ext,
    kind,
    ...(dataUrl
      ? {
          dataUrl,
          part: {
            type: "file" as const,
            mime,
            url: dataUrl,
            filename: file.name,
          },
        }
      : {}),
  };

  return result;
}

/**
 * Потолок размера ОДНОЙ загрузки. Должен совпадать с MAX_BODY_BYTES в
 * server/middleware.mjs: сервер обрывает тело запроса и отвечает 413, но
 * без этой проверки клиент узнаёт об отказе, только докачав файл до конца.
 * Суммарный объём вложений чата ограничивает сервер отдельно (квота сессии).
 */
export const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;

export const ACCEPTED_EXTENSIONS =
  ".jpg,.jpeg,.png,.gif,.webp,.bmp,.svg,.pdf,.zip,.txt,.md,.json,.js,.jsx,.ts,.tsx,.css,.scss,.html,.xml,.yaml,.yml,.toml,.py,.rb,.go,.rs,.java,.c,.cpp,.h,.cs,.php,.sh,.sql,.csv,.log,.env";

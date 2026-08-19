// File attachment utilities. File bytes live in the session workspace; the
// browser keeps metadata only, so a 50 MB image does not become a ~67 MB
// base64 string copied through Zustand state.

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

export function processFile(file: File): ProcessedFile {
  const ext = file.name.split(".").pop()?.toLowerCase() ?? "";
  const kind = fileKind(file.name);
  const mime = file.type || mimeFromExt(ext);

  const result: ProcessedFile = {
    name: file.name,
    size: file.size,
    mime,
    ext,
    kind,
  };

  return result;
}

/**
 * Потолок размера ОДНОЙ загрузки. Совпадает с дефолтным MAX_UPLOAD_BYTES в
 * server/native/config.mjs: streaming multipart parser отвечает 413, но
 * без этой проверки клиент узнаёт об отказе, только докачав файл до конца.
 * Суммарный объём вложений чата ограничивает сервер отдельно (квота сессии).
 */
export const MAX_UPLOAD_BYTES = 250 * 1024 * 1024;

export const ACCEPTED_EXTENSIONS =
  ".jpg,.jpeg,.png,.gif,.webp,.bmp,.svg,.pdf,.zip,.txt,.md,.json,.js,.jsx,.ts,.tsx,.css,.scss,.html,.xml,.yaml,.yml,.toml,.py,.rb,.go,.rs,.java,.c,.cpp,.h,.cs,.php,.sh,.sql,.csv,.log,.env";

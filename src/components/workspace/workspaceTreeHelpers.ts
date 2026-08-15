import { isSessionId } from "../../lib/ids";

export interface TreeNode {
  name: string;
  path: string;
  isDir: boolean;
  children?: TreeNode[] | undefined;
  loaded?: boolean | undefined;
}

export const STATUS_COLORS: Record<string, string> = {
  modified: "#fbbf24",
  added: "#4ade80",
  untracked: "#60a5fa",
  deleted: "#f87171",
  renamed: "#60a5fa",
};

const HIDDEN_SEGMENTS = new Set([
  "node_modules",
  ".git",
  "dist",
  "dist-ssr",
  "coverage",
  ".vite",
  ".cache",
  ".turbo",
  ".next",
  ".arena",
  "__pycache__",
  ".local",
  ".config",
  ".users.json",
  ".sessions.json",
  ".session_owners.json",
  ".admin_password",
  "package-lock.json",
  "backups",
]);

export const DEEP_RELOAD_MAX_DEPTH = 8;

export function toRelPath(p: string): string {
  if (!p) return p;
  const m = p.match(/^\/app\/workspace\/sessions\/[^/]+\/workspace(\/.*)?$/);
  if (m) return m[1] ? m[1].replace(/^\//, "") : ".";
  if (p.startsWith("/app/workspace/")) return p.slice("/app/workspace/".length);
  return p;
}

export function toTree(
  files: { path: string; type?: string; isDirectory?: boolean }[],
): TreeNode[] {
  const root: TreeNode = { name: "", path: "", isDir: true, children: [] };
  for (const f of files) {
    const raw = toRelPath(f.path || "");
    const parts = raw.split("/").filter(Boolean);
    if (!parts.length) continue;
    let cur = root;
    for (let i = 0; i < parts.length; i++) {
      const seg = parts[i] || "";
      const isDir =
        i < parts.length - 1 ||
        f.type === "directory" ||
        f.isDirectory === true;
      const acc = parts.slice(0, i + 1).join("/");
      if (!cur.children) cur.children = [];
      let child = cur.children.find((c) => c.name === seg);
      if (!child) {
        child = {
          name: seg,
          path: acc,
          isDir,
          children: isDir ? [] : undefined,
          loaded: false,
        };
        cur.children.push(child);
      }
      if (isDir && child) cur = child;
    }
  }
  const sort = (nodes: TreeNode[]): TreeNode[] => {
    nodes.sort((a, b) =>
      a.isDir === b.isDir ? a.name.localeCompare(b.name) : a.isDir ? -1 : 1,
    );
    for (const n of nodes) if (n.children) sort(n.children);
    return nodes;
  };
  return sort(root.children ?? []);
}

export function filterNodes<
  T extends { path: string; type?: string; isDirectory?: boolean },
>(
  nodes: T[],
  options: {
    mySessionIds: Set<string>;
  },
): T[] {
  if (!Array.isArray(nodes)) return [];
  return nodes.filter((n) => {
    const raw = (n.path || "").replace(/\\/g, "/");
    const parts = raw.split("/").filter(Boolean);
    const p = parts[0] || "";

    if (parts.some((seg: string) => HIDDEN_SEGMENTS.has(seg))) return false;
    if (raw.endsWith(".tsbuildinfo") || raw.endsWith(".map")) return false;

    if (
      (p === "sessions" || p === "uploads" || p === "temp") &&
      parts.length > 1
    ) {
      const sid = parts[1];
      if (isSessionId(sid) && !options.mySessionIds.has(sid)) return false;
    }
    return true;
  });
}

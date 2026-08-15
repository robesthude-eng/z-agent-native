import path from "node:path";
import babel from "@rolldown/plugin-babel";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const NATIVE_TARGET = process.env.Z_AGENT_API_TARGET ?? "http://localhost:3000";

function packageOf(id: string): string | null {
  const at = id.lastIndexOf("node_modules/");
  if (at === -1) return null;
  const parts = id.slice(at + "node_modules/".length).split("/");
  const first = parts[0] ?? "";
  return first.startsWith("@") ? `${first}/${parts[1] ?? ""}` : first;
}

const MARKDOWN_PKGS =
  /^(highlight\.js|lowlight|react-markdown|rehype-|remark-|micromark|mdast-util-|hast-util-|unist-util-|unified$|vfile|property-information$|character-entities|decode-named-character-reference$|comma-separated-tokens$|space-separated-tokens$|stringify-entities$|html-void-elements$|html-url-attributes$|web-namespaces$|zwitch$|longest-streak$|markdown-table$|ccount$|trim-lines$|devlop$|bail$|trough$|is-plain-obj$|extend$|escape-string-regexp$|style-to-js$|style-to-object$|inline-style-parser$|@ungap\/structured-clone$)/;

function manualChunks(id: string): string | undefined {
  const pkg = packageOf(id);
  if (!pkg) return undefined;
  if (pkg === "react" || pkg === "react-dom" || pkg === "scheduler") return "vendor-react";
  if (pkg.startsWith("@tanstack/")) return "vendor-router";
  if (MARKDOWN_PKGS.test(pkg)) return "vendor-markdown";
  return undefined;
}

export default defineConfig({
  plugins: [
    babel({ plugins: [["babel-plugin-react-compiler", {}]] }),
    react(),
    tailwindcss(),
  ],
  resolve: { alias: { "@": path.resolve(__dirname, "./src") } },
  build: { rollupOptions: { output: { manualChunks } } },
  server: {
    port: 5173,
    proxy: {
      "/api": { target: NATIVE_TARGET, changeOrigin: true },
      "/socket.io": { target: NATIVE_TARGET, changeOrigin: true, ws: true },
      "/health": { target: NATIVE_TARGET, changeOrigin: true },
    },
  },
});

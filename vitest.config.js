import path from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";
export default defineConfig({
    plugins: [react(), tailwindcss()],
    resolve: {
        alias: {
            "@": path.resolve(__dirname, "./src"),
        },
    },
    test: {
        globals: true,
        environment: "jsdom",
        setupFiles: ["./src/__tests__/setup.ts"],
        include: ["src/**/*.test.{ts,tsx}"],
        pool: "threads",
        coverage: {
            provider: "v8",
            reporter: ["text", "html", "json-summary", "lcov"],
            reportsDirectory: "coverage",
            exclude: ["**/node_modules/**", "**/dist/**", "**/coverage/**"],
        },
    },
});

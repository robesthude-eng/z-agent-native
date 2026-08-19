import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, devices } from "@playwright/test";

const HOST = "127.0.0.1";
const PORT = Number(process.env.E2E_PORT ?? 3210);
const BASE_URL = `http://${HOST}:${PORT}`;

const root = path.dirname(fileURLToPath(import.meta.url));
const tmp = path.join(root, ".e2e-tmp");

export default defineConfig({
	testDir: "./e2e",
	outputDir: "./.e2e-tmp/artifacts",
	// The server keeps one sqlite file and one workspace tree per instance, so
	// parallel workers would fight over the same rows and the same git state.
	fullyParallel: false,
	workers: 1,
	forbidOnly: Boolean(process.env.CI),
	retries: process.env.CI ? 1 : 0,
	timeout: 30_000,
	expect: { timeout: 10_000 },
	reporter: process.env.CI
		? [["github"], ["html", { outputFolder: "playwright-report", open: "never" }]]
		: [["list"], ["html", { outputFolder: "playwright-report", open: "never" }]],
	use: {
		baseURL: BASE_URL,
		trace: "retain-on-failure",
		screenshot: "only-on-failure",
		video: "retain-on-failure",
	},
	projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
	webServer: {
		// The server serves the built bundle, so a stale dist/ would make the
		// suite pass against code that is no longer in the tree.
		command: "npm run build && node server/index.mjs",
		url: `${BASE_URL}/health`,
		reuseExistingServer: !process.env.CI,
		timeout: 180_000,
		stdout: "pipe",
		stderr: "pipe",
		env: {
			PORT: String(PORT),
			HOST,
			// Isolated from the developer's real data: the suite must never be able
			// to read or delete actual sessions, sqlite state or master.key.
			Z_AGENT_DATA_DIR: path.join(tmp, "data"),
			Z_AGENT_WORKSPACES_DIR: path.join(tmp, "workspaces"),
			Z_AGENT_ALLOW_OPEN_REGISTRATION: "1",
			Z_AGENT_SECURE_COOKIES: "0",
			NODE_ENV: "production",
		},
	},
});

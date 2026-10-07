import fs from "node:fs";
import { subagentCapabilityRows } from "../server/native/subagents.mjs";

const START = "<!-- BEGIN GENERATED SUBAGENT CAPABILITIES -->";
const END = "<!-- END GENERATED SUBAGENT CAPABILITIES -->";

export function capabilityBlock() {
  const rows = subagentCapabilityRows();
  return [
    START,
    "| Profile | Writes workspace | Max steps | Tools |",
    "| --- | --- | ---: | --- |",
    ...rows.map(
      (row) =>
        `| \`${row.kind}\` | ${row.writes ? "yes" : "no"} | ${row.maxSteps} | ${row.tools.map((tool) => `\`${tool}\``).join(", ")} |`,
    ),
    END,
  ].join("\n");
}

function replaceBlock(text, block) {
  const start = text.indexOf(START);
  const end = text.indexOf(END);
  if (start < 0 || end < start) return null;
  return text.slice(0, start) + block + text.slice(end + END.length);
}

const root = new URL("../", import.meta.url);
const read = (file) => fs.readFileSync(new URL(file, root), "utf8");
const problems = [];

function walk(dir, ext, out = []) {
  for (const entry of fs.readdirSync(new URL(dir, root), { withFileTypes: true })) {
    const rel = `${dir}${entry.name}`;
    if (entry.isDirectory()) walk(`${rel}/`, ext, out);
    else if (ext.some((e) => entry.name.endsWith(e))) out.push(rel);
  }
  return out;
}

// --- 1. Generated subagent capability tables -------------------------------
function checkCapabilityBlocks() {
  const expected = capabilityBlock();
  for (const file of ["README.md", "ARCHITECTURE.md"]) {
    const text = read(file);
    const replaced = replaceBlock(text, expected);
    if (replaced == null) {
      problems.push(`${file}: generated subagent capability block is missing`);
    } else if (replaced !== text) {
      problems.push(
        `${file}: subagent capability docs drifted from server/native/subagents.mjs`,
      );
    }
  }
}

// --- 2. Environment variables ----------------------------------------------
// Variables read by the runtime or tooling that are not operator configuration.
const SYSTEM_ENV = new Set([
  "HOME",
  "LANG",
  "LC_ALL",
  "PATH",
  "PORT",
  "NODE_ENV",
  "PLAYWRIGHT_BROWSERS_PATH",
  "GIT_CONFIG_NOSYSTEM",
  "GIT_OPTIONAL_LOCKS",
  "GIT_TERMINAL_PROMPT",
]);

function codeEnvVars() {
  const names = new Set();
  const files = [...walk("server/", [".mjs"]), ...walk("scripts/", [".mjs"])];
  for (const file of files) {
    const text = read(file);
    for (const m of text.matchAll(/\bZ_AGENT_[A-Z0-9_]*[A-Z0-9]\b/g)) {
      names.add(m[0]);
    }
    for (const m of text.matchAll(/process\.env\.([A-Z][A-Z0-9_]*)\b/g)) {
      names.add(m[1]);
    }
  }
  return names;
}

function checkEnvironment() {
  const docs = [
    ...fs.readdirSync(root).filter((f) => f.endsWith(".md")),
    ...walk("docs/", [".md"]),
    ...walk("deploy/", [".md"]),
    ...walk("azure/", [".md"]),
    ...walk("cloudflare/", [".md"]),
  ];
  const documentedText = [...docs, ".env.example"].map(read).join("\n");
  const documented = new Set(
    documentedText.match(/\b[A-Z][A-Z0-9_]*[A-Z0-9]\b/g) || [],
  );
  const used = codeEnvVars();
  for (const name of [...used].sort()) {
    if (SYSTEM_ENV.has(name) || documented.has(name)) continue;
    problems.push(
      `env ${name} is read by the code but is not documented (README.md "Advanced" table or .env.example)`,
    );
  }

  // Every variable a user is told to set must still exist somewhere real.
  const realText = [
    ...walk("server/", [".mjs"]),
    ...walk("scripts/", [".mjs"]),
    ...walk("deploy/", [".sh", ".yml", ".service", ".timer", ""]).filter((f) =>
      fs.statSync(new URL(f, root)).isFile(),
    ),
    "docker-compose.yml",
    "docker-compose.override.yml",
    "docker-compose.trusted.yml",
    "docker-compose.unrestricted.yml",
    "Dockerfile",
    "Dockerfile.browser",
    "Caddyfile",
  ]
    .filter((f) => fs.existsSync(new URL(f, root)))
    .map(read)
    .join("\n");
  const example = read(".env.example");
  for (const m of example.matchAll(/^#?\s*([A-Z][A-Z0-9_]*[A-Z0-9])=/gm)) {
    if (!new RegExp(`\\b${m[1]}\\b`).test(realText)) {
      problems.push(
        `.env.example sets ${m[1]}, which nothing in the code, scripts or Compose files reads`,
      );
    }
  }
}

// --- 3. Documented numeric defaults ----------------------------------------
function checkDefaults() {
  const code = [...walk("server/", [".mjs"]), ...walk("scripts/", [".mjs"])]
    .map(read)
    .join("\n");
  const lines = code.split("\n");
  const rows = [
    ...read("README.md").matchAll(/^\| `([A-Z][A-Z0-9_]+)` \| `([0-9_]+)` \|/gm),
  ];
  const evalProduct = (expr) => {
    try {
      return String(
        expr
          .split("*")
          .map((n) => Number(n.replace(/_/g, "")))
          .reduce((a, b) => a * b, 1),
      );
    } catch {
      return "";
    }
  };
  const literalsOf = (line) => {
    const out = new Set();
    for (const m of line.matchAll(/\b\d[\d_]*\b/g)) out.add(m[0].replace(/_/g, ""));
    for (const m of line.matchAll(/(\d[\d_]*(?:\s*\*\s*\d[\d_]*)+)/g)) {
      out.add(evalProduct(m[1]));
    }
    return out;
  };
  for (const [, name, raw] of rows) {
    const value = raw.replace(/_/g, "");
    if (value === "0" || value === "1") continue; // boolean flags
    const usage = lines.filter((l) => new RegExp(`\\b${name}\\b`).test(l));
    if (!usage.length) continue; // set only by Compose/Docker or documented elsewhere
    let ok = usage.some((l) => literalsOf(l).has(value));
    if (!ok) {
      for (const l of usage) {
        for (const c of l.match(/\b[A-Z0-9_]*DEFAULT[A-Z0-9_]*\b/g) || []) {
          const def = lines.find((d) => new RegExp(`\\b${c}\\s*=`).test(d));
          if (def && literalsOf(def).has(value)) ok = true;
        }
      }
    }
    if (!ok) {
      problems.push(
        `README documents ${name} default ${raw}, but no matching default was found in the code`,
      );
    }
  }
}

// --- 4. Documented HTTP endpoints exist in the server ------------------------
function checkEndpoints() {
  const serverCode = walk("server/", [".mjs"]).map(read).join("\n");
  // Historical documents legitimately mention removed endpoints.
  const files = ["README.md", "ARCHITECTURE.md", "SECURITY.md", "OPERATIONS.md"];
  for (const file of files) {
    const text = read(file);
    for (const m of text.matchAll(
      /`(?:(?:GET|POST|PUT|PATCH|DELETE|HEAD) )?(\/(?:api\/[A-Za-z0-9_\-/:{}.]*|health[A-Za-z0-9_\-/]*|metrics))`/g,
    )) {
      const endpoint = m[1]
        .split("/")
        .filter((seg) => !seg.startsWith(":") && !seg.startsWith("{"))
        .join("/")
        .replace(/\/+$/, "");
      if (endpoint && !serverCode.includes(endpoint)) {
        problems.push(`${file}: documented endpoint ${m[1]} is not present in server/`);
      }
    }
  }
}

// --- 5. Evaluation case count ------------------------------------------------
function checkEvalCount() {
  const manifest = JSON.parse(read("evals/coding-agent.json"));
  const count = (manifest.cases ?? manifest).length;
  const text = read("README.md");
  for (const m of text.matchAll(/\*\*(\d+) executable regression cases\*\*/g)) {
    if (Number(m[1]) !== count) {
      problems.push(
        `README says ${m[1]} eval cases but evals/coding-agent.json has ${count}`,
      );
    }
  }
}

checkCapabilityBlocks();
checkEnvironment();
checkDefaults();
checkEndpoints();
checkEvalCount();

if (problems.length) {
  for (const problem of problems) console.error(problem);
  console.error(`${problems.length} documentation drift problem(s) found`);
  process.exitCode = 1;
} else {
  console.log(
    "docs match runtime: subagent registry, env vars, defaults, endpoints, eval count",
  );
}

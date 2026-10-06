#!/usr/bin/env node
// Compare two benchmark reports (for example default toolset vs --bash-first).
//   node scripts/compare-benchmark-reports.mjs default.json bash-first.json
import fs from "node:fs";

const [leftPath, rightPath] = process.argv.slice(2);
if (!leftPath || !rightPath) {
  console.error(
    "usage: compare-benchmark-reports.mjs <report-a.json> <report-b.json>",
  );
  process.exit(2);
}
const read = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
const a = read(leftPath);
const b = read(rightPath);
const label = (r, fallback) =>
  `${fallback}${r.bashFirst ? " (bash-first)" : " (default)"}`;
const byId = (r) => new Map((r.cases || []).map((c) => [c.id, c]));
const ca = byId(a);
const cb = byId(b);
const mean = (cases, key) =>
  cases.length
    ? cases.reduce((s, c) => s + Number(c[key] || 0), 0) / cases.length
    : 0;
const pct = (from, to) =>
  from ? `${(((to - from) / from) * 100).toFixed(0)}%` : "n/a";
const num = (v) => (Number.isInteger(v) ? String(v) : v.toFixed(2));

const ids = [...ca.keys()].filter((id) => cb.has(id));
if (!ids.length) {
  console.error("The reports have no cases in common.");
  process.exit(1);
}
const shared = (m) => ids.map((id) => m.get(id));
const rows = [
  ["pass rate", (cs) => mean(cs, "passRate")],
  ["tool calls / run", (cs) => mean(cs, "meanToolCalls")],
  ["model calls / run", (cs) => mean(cs, "meanModelCalls")],
  ["input tokens / run", (cs) => mean(cs, "meanInputTokens")],
  ["output tokens / run", (cs) => mean(cs, "meanOutputTokens")],
  ["duration ms / run", (cs) => mean(cs, "meanDurationMs")],
];
console.log(`Cases compared: ${ids.length}`);
console.log(
  `${"metric".padEnd(22)}${label(a, "A").padEnd(24)}${label(b, "B").padEnd(24)}change`,
);
for (const [name, fn] of rows) {
  const x = fn(shared(ca));
  const y = fn(shared(cb));
  console.log(
    `${name.padEnd(22)}${num(x).padEnd(24)}${num(y).padEnd(24)}${pct(x, y)}`,
  );
}
console.log("\nPer case (pass rate A -> B, tokens A -> B):");
for (const id of ids) {
  const x = ca.get(id);
  const y = cb.get(id);
  console.log(
    `${id.padEnd(40)} ${num(x.passRate)} -> ${num(y.passRate)}   in:${x.meanInputTokens ?? "?"} -> ${y.meanInputTokens ?? "?"}`,
  );
}

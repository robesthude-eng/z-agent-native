import fs from "node:fs";

const budgets = new Map([
  ["src/components/Workspace.tsx", 850],
  ["src/components/Composer.tsx", 700],
  ["src/components/settings/ProviderChannelManager.tsx", 700],
]);

const violations = [];
for (const [file, limit] of budgets) {
  const lines = fs.readFileSync(file, "utf8").split(/\r?\n/).length;
  if (lines > limit)
    violations.push(`${file}: ${lines} lines (budget ${limit})`);
}

if (violations.length > 0) {
  throw new Error(`UI boundary budget exceeded:\n${violations.join("\n")}`);
}

console.log("UI controller boundaries stay within their line budgets.");

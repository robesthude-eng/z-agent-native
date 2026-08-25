import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "z-agent-dr-drill-"));
const snapshot = path.join(root, "snapshot.sqlite");
function run(args) {
  const child = spawnSync(process.execPath, args, {
    encoding: "utf8",
    env: process.env,
    timeout: 120_000,
  });
  if (child.status !== 0)
    throw new Error(
      `${args.join(" ")} failed: ${child.stderr || child.stdout}`,
    );
  return String(child.stdout || "").trim();
}
try {
  const backup = JSON.parse(
    run(["server/backup.mjs", snapshot]).split(/\r?\n/).filter(Boolean).at(-1),
  );
  const restore = JSON.parse(
    run(["server/restore-verify.mjs", snapshot])
      .split(/\r?\n/)
      .filter(Boolean)
      .at(-1),
  );
  console.log(
    JSON.stringify({ ok: true, backup: { bytes: backup.bytes }, restore }),
  );
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

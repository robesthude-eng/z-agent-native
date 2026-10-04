import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const templatePath = path.join(repoRoot, ".env.example");
const args = process.argv.slice(2);
const profileArg = args.find((arg) => arg.startsWith("--profile="));
const profile = profileArg?.slice("--profile=".length) || "hardened";
const targets = args.filter((arg) => !arg.startsWith("--profile="));
if (
  !["hardened", "trusted", "unrestricted"].includes(profile) ||
  targets.length > 1 ||
  targets.some((arg) => arg.startsWith("-"))
) {
  throw new Error(
    "Usage: prod:env:init -- [path] [--profile=hardened|trusted|unrestricted]",
  );
}
const targetPath = path.resolve(targets[0] || path.join(repoRoot, ".env"));
if (fs.existsSync(targetPath))
  throw new Error(
    `Refusing to overwrite existing environment file: ${targetPath}`,
  );
let text = fs.readFileSync(templatePath, "utf8");
const values = {
  SEARXNG_SECRET: crypto.randomBytes(32).toString("hex"),
  Z_AGENT_SECRET_KEY: crypto.randomBytes(32).toString("hex"),
  Z_AGENT_AUDIT_KEY: crypto.randomBytes(32).toString("hex"),
  Z_AGENT_METRICS_TOKEN: crypto.randomBytes(32).toString("base64url"),
  Z_AGENT_INVITE_CODE: crypto.randomBytes(24).toString("base64url"),
};
if (profile !== "hardened")
  Object.assign(values, {
    COMPOSE_FILE:
      "docker-compose.yml:docker-compose.override.yml:docker-compose.trusted.yml" +
      (profile === "unrestricted" ? ":docker-compose.unrestricted.yml" : ""),
    Z_AGENT_SHELL_NETWORK_POLICY: "open",
    Z_AGENT_NETWORK_POLICY: "public",
    Z_AGENT_ALLOW_PUBLIC_WEB: "1",
    Z_AGENT_SSH_POLICY: "any",
    Z_AGENT_ALLOW_NETWORKED_INSTALLERS: "1",
    Z_AGENT_TERMINAL_ENABLED: "1",
    Z_AGENT_ALLOW_PRODUCTION_TERMINAL: "1",
  });
if (profile === "unrestricted")
  Object.assign(values, {
    Z_AGENT_ALLOW_SUDO: "1",
    Z_AGENT_SENSITIVE_FILE_POLICY: "allow",
  });
for (const [key, value] of Object.entries(values)) {
  const re = new RegExp(`^${key}=.*$`, "m");
  if (!re.test(text)) throw new Error(`Template is missing ${key}`);
  text = text.replace(re, `${key}=${value}`);
}
fs.mkdirSync(path.dirname(targetPath), { recursive: true });
fs.writeFileSync(targetPath, text, { flag: "wx", mode: 0o600 });
fs.chmodSync(targetPath, 0o600);
console.log(
  JSON.stringify({
    ok: true,
    path: targetPath,
    mode: "0600",
    profile,
    generated: Object.keys(values),
  }),
);

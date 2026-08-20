import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const templatePath = path.join(repoRoot, '.env.example');
const targetPath = path.resolve(process.argv[2] || path.join(repoRoot, '.env'));
if (fs.existsSync(targetPath)) throw new Error(`Refusing to overwrite existing environment file: ${targetPath}`);
let text = fs.readFileSync(templatePath, 'utf8');
const values = {
  Z_AGENT_SECRET_KEY: crypto.randomBytes(32).toString('hex'),
  Z_AGENT_AUDIT_KEY: crypto.randomBytes(32).toString('hex'),
  Z_AGENT_METRICS_TOKEN: crypto.randomBytes(32).toString('base64url'),
};
for (const [key, value] of Object.entries(values)) {
  const re = new RegExp(`^${key}=.*$`, 'm');
  if (!re.test(text)) throw new Error(`Template is missing ${key}`);
  text = text.replace(re, `${key}=${value}`);
}
fs.mkdirSync(path.dirname(targetPath), { recursive: true });
fs.writeFileSync(targetPath, text, { flag: 'wx', mode: 0o600 });
fs.chmodSync(targetPath, 0o600);
console.log(JSON.stringify({ ok: true, path: targetPath, mode: '0600', generated: Object.keys(values) }));

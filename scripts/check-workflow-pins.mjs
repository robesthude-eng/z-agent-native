import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve('.github/workflows');
const failures = [];
for (const name of fs.readdirSync(root).filter((name) => /\.ya?ml$/i.test(name)).sort()) {
  const file = path.join(root, name);
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index].match(/^\s*-?\s*uses:\s*([^\s#]+)/);
    if (!match) continue;
    const uses = match[1];
    // Local actions are part of the checked-out tree. Remote actions must be
    // pinned to an immutable full commit SHA; release tags are mutable refs.
    if (uses.startsWith('./')) continue;
    const at = uses.lastIndexOf('@');
    const ref = at >= 0 ? uses.slice(at + 1) : '';
    if (!/^[0-9a-f]{40}$/i.test(ref)) failures.push(`${name}:${index + 1}: ${uses}`);
  }
}
if (failures.length) {
  console.error(`Unpinned GitHub Actions:\n${failures.join('\n')}`);
  process.exit(1);
}
console.log('GitHub Actions are pinned to immutable commit SHAs.');

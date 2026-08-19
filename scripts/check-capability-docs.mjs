import fs from 'node:fs';
import { subagentCapabilityRows } from '../server/native/subagents.mjs';

const START = '<!-- BEGIN GENERATED SUBAGENT CAPABILITIES -->';
const END = '<!-- END GENERATED SUBAGENT CAPABILITIES -->';

export function capabilityBlock() {
  const rows = subagentCapabilityRows();
  return [
    START,
    '| Profile | Writes workspace | Max steps | Tools |',
    '| --- | --- | ---: | --- |',
    ...rows.map((row) => `| \`${row.kind}\` | ${row.writes ? 'yes' : 'no'} | ${row.maxSteps} | ${row.tools.map((tool) => `\`${tool}\``).join(', ')} |`),
    END,
  ].join('\n');
}

function replaceBlock(text, block) {
  const start = text.indexOf(START);
  const end = text.indexOf(END);
  if (start < 0 || end < start) return null;
  return text.slice(0, start) + block + text.slice(end + END.length);
}

const expected = capabilityBlock();
let failed = false;
for (const file of ['README.md', 'ARCHITECTURE.md']) {
  const text = fs.readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
  const replaced = replaceBlock(text, expected);
  if (replaced == null) {
    console.error(`${file}: generated subagent capability block is missing`);
    failed = true;
    continue;
  }
  if (replaced !== text) {
    console.error(`${file}: subagent capability docs drifted from server/native/subagents.mjs`);
    failed = true;
  }
}
if (failed) process.exitCode = 1;
else console.log('subagent capability docs match runtime registry');

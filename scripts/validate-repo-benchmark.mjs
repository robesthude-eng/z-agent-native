import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateBenchmarkManifest } from './repo-benchmark-manifest.mjs';

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const manifestPath = path.resolve(process.argv[2] || process.env.Z_AGENT_BENCHMARK_MANIFEST || path.join(repoRoot, 'evals/production-benchmark.example.json'));
const manifest = validateBenchmarkManifest(JSON.parse(fs.readFileSync(manifestPath, 'utf8')));
const local = manifest.cases.filter((item) => item.source?.type === 'local').length;
const git = manifest.cases.filter((item) => item.source?.type === 'git').length;
console.log(`Production benchmark manifest valid: ${manifest.cases.length} case(s) (local=${local}, git=${git})`);

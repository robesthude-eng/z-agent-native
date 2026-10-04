// Ревьюер перед финальным ответом: вторая «пара глаз» смотрит на изменённые
// файлы, цель задачи, доказательства проверки и черновик ответа. Если
// находит реальные проблемы, агент получает их списком и исправляет до того,
// как сказать «готово».
import fs from 'node:fs';
import { callModelAutopilot } from '../autopilot.mjs';
import { safeWorkspacePath } from '../security.mjs';

const MAX_FILE_CHARS = 14_000;
const MAX_TOTAL_CHARS = 70_000;
const SKIP_PATH = /(^|\/)(\.screenshots|\.agent-home|\.agent-skills|node_modules|dist|build|\.git)(\/|$)|\.(png|jpe?g|gif|webp|ico|pdf|zip|gz|mp[34]|wav|woff2?|ttf|lock)$/i;

export function reviewablePaths(strategy) {
  const paths = Array.isArray(strategy?.changedPaths) ? strategy.changedPaths : [];
  return [...new Set(paths.map((p) => String(p || '').trim()).filter((p) => p && p !== '.' && !SKIP_PATH.test(p)))].slice(-20);
}

export function shouldReview(strategy, { enabled = true, reviewsDone = 0, waitingForUser = false } = {}) {
  if (!enabled || waitingForUser || reviewsDone >= 1) return false;
  return Boolean(strategy?.changed) && reviewablePaths(strategy).length > 0;
}

function readChanged(workspace, paths) {
  const out = [];
  let used = 0;
  for (const rel of paths) {
    let text;
    try {
      // Без symlink-ов: ревьюер читает файлы от имени сервера.
      const full = safeWorkspacePath(workspace, rel, { allowMissing: false });
      const st = fs.statSync(full);
      if (!st.isFile()) continue;
      if (st.size > 2_000_000) { out.push(`=== ${rel} (${st.size} bytes, too large to show) ===`); continue; }
      text = fs.readFileSync(full, 'utf8');
    } catch {
      out.push(`=== ${rel} (deleted or unreadable) ===`);
      continue;
    }
    if (text.includes('\u0000')) continue;
    const budget = Math.min(MAX_FILE_CHARS, MAX_TOTAL_CHARS - used);
    if (budget <= 500) { out.push(`=== ${rel} (omitted: review budget exhausted) ===`); continue; }
    const clipped = text.length > budget ? `${text.slice(0, Math.floor(budget * 0.7))}\n…[${text.length - budget} chars omitted]…\n${text.slice(-Math.floor(budget * 0.3))}` : text;
    used += clipped.length;
    const numbered = clipped.split('\n').map((line, i) => `${String(i + 1).padStart(4)}| ${line}`).join('\n');
    out.push(`=== ${rel} ===\n${numbered}`);
  }
  return out.join('\n\n');
}

const REVIEW_SYSTEM = [
  'You are a strict senior code reviewer checking another AI agent\'s work right before it reports "done" to the user.',
  'You see the user\'s goal, the final content of the files it changed, its verification evidence and its draft final answer.',
  'Find only REAL problems that matter to the user: bugs, broken or missing parts of what was asked, syntax errors, wrong file paths, security issues (secrets in code, injection, dangerous commands), obvious UI breakage, unverified claims in the draft answer, or work the draft claims but the files do not show.',
  'Ignore style nits, naming preferences and optional improvements. If the work is fine, say so — do not invent issues.',
  'Reply with ONLY a JSON object, no prose, no code fences:',
  '{"verdict":"pass"|"fix","summary":"one sentence in Russian","issues":[{"severity":"blocker"|"major","file":"path or empty","line":0,"problem":"Russian","fix":"Russian, concrete"}]}',
  'Use "fix" only when there is at least one blocker or major issue. Max 6 issues.',
].join('\n');

export function parseReview(text) {
  const raw = String(text || '').trim();
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    const obj = JSON.parse(raw.slice(start, end + 1));
    const issues = (Array.isArray(obj.issues) ? obj.issues : [])
      .filter((i) => i && typeof i === 'object' && ['blocker', 'major'].includes(String(i.severity)) && String(i.problem || '').trim())
      .slice(0, 6)
      .map((i) => ({
        severity: String(i.severity),
        file: String(i.file || '').slice(0, 200),
        line: Number(i.line) || 0,
        problem: String(i.problem).slice(0, 600),
        fix: String(i.fix || '').slice(0, 600),
      }));
    const verdict = obj.verdict === 'fix' && issues.length ? 'fix' : 'pass';
    return { verdict, summary: String(obj.summary || '').slice(0, 300), issues: verdict === 'fix' ? issues : [] };
  } catch {
    return null;
  }
}

export function formatIssues(review) {
  return review.issues.map((i, n) => `${n + 1}. [${i.severity}] ${i.file ? `${i.file}${i.line ? `:${i.line}` : ''} — ` : ''}${i.problem}${i.fix ? `\n   Как исправить: ${i.fix}` : ''}`).join('\n');
}

export async function reviewTurn({ ownerId, modelPlan, goal, strategy, workspace, draft, signal }) {
  const paths = reviewablePaths(strategy);
  const files = readChanged(workspace, paths);
  if (!files.trim()) return null;
  const evidence = strategy?.lastVerificationEvidence
    ? `${strategy.lastVerificationEvidence.ok ? 'OK' : 'FAILED'} via ${strategy.lastVerificationEvidence.tool}: ${strategy.lastVerificationEvidence.detail}`
    : strategy?.needsVerification ? 'No successful verification after the latest change.' : 'none recorded';
  const plan = (strategy?.plan || []).map((t) => `- [${t.status}] ${t.content}`).join('\n');
  const content = [
    `# User goal\n${String(goal || '').slice(0, 6000)}`,
    plan ? `# Agent plan\n${plan}` : '',
    `# Verification evidence\n${evidence}`,
    `# Changed files (final content)\n${files}`,
    `# Draft final answer\n${String(draft || '(empty)').slice(0, 6000)}`,
  ].filter(Boolean).join('\n\n');
  const response = await callModelAutopilot(ownerId, modelPlan, {
    system: REVIEW_SYSTEM,
    frames: [{ role: 'user', content }],
    tools: [],
    signal,
  });
  return parseReview(response?.text);
}

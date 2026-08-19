# Z Agent Native hardening report

This source bundle contains the continuation/hardening pass performed after the original handoff and `FIXES.patch` work.

## What changed

- Executable coding-agent eval harness with 30 repository/fixture cases, deterministic CI smoke, per-case scoring, external verification, JSON reports, and optional baseline/regression comparison.
- Deterministic fixture provider plus Playwright flow covering browser submission -> native turn -> workspace writes -> regression test -> completion gate -> persisted UI/API evidence.
- Per-session crash/recovery chaos tests using real `SIGKILL`, including recovery after a durable tool checkpoint without replaying the completed write and repair after final-message persistence.
- Subagent runtime refactor: nested execution moved out of the parent orchestrator; one capability registry now drives runtime, tests, eval validation, and generated documentation.
- Writer subagent completion semantics: delegated mutations propagate to the parent turn and require verification.
- Stronger completion evidence: mutation/verification epochs, changed paths, verification evidence, and stale-verification invalidation after subsequent edits.
- Turn telemetry: provider/model/tool timing and counts, fallbacks, retries, tokens, verification/gate activity, outcome, optional operator-supplied cost estimates, bounded JSONL persistence, and an operator summary CLI.
- Security hardening for autonomous execution: sensitive workspace-file policy, guarded/tool-only shell egress modes, model-network allowlist/off policy, DNS-pinned static fetch/search transport, browser request revalidation, service-worker/WebSocket blocking, and explicit prompt-injection instruction precedence for parent/subagents.
- CI hardening: native eval/docs/test gates, blocking correctness lint/typecheck/unit/build/E2E, blocking high/critical runtime dependency audit, formatting kept report-only.
- Capability documentation drift check and updated README/ARCHITECTURE/SECURITY/.env guidance.

## Verification performed in this bundle

- `node --check` across `server/`, `scripts/`, and `tests/` `.mjs` files: passed.
- `node scripts/check-capability-docs.mjs`: passed.
- `node scripts/validate-agent-evals.mjs`: passed; 30 cases (explore=7, debug=7, review=7, implement=8, smoke=1).
- `npm run eval:smoke`: 100/100, 1/1 passed through the real native `runTurn` and workspace verification path.
- Baseline regression mode was exercised against two deterministic smoke runs with 0-point tolerance: 0 regressions.
- `npm run test:native`: 192 tests, 190 passed, 0 failed, 2 skipped.

## Local environment limitation

The source declares Node.js 24+; the packaging environment available for this pass is Node.js 22.16.0 and did not contain a complete frontend dependency installation. Therefore local `biome`, Vitest, TypeScript frontend build, and Playwright E2E execution could not be completed here. CI is explicitly configured for Node.js 24 and installs dependencies before running those gates. The native runtime/eval/chaos suites above do not depend on the missing frontend toolchain and were executed successfully.

## Security boundary that still requires deployment controls

Application-level filtering is intentionally not described as a firewall. `Z_AGENT_NETWORK_POLICY=public` is a compatibility mode, not a hard anti-exfiltration mode; arbitrary interpreters/build/test processes can also be network-capable. A sensitive multi-user deployment should use model-network allowlisting or `off`, `Z_AGENT_SHELL_NETWORK_POLICY=tool-only`, the sensitive-file policy, and container/namespace/host egress enforcement. Chromium request validation cannot provide the native DNS-pinned socket transport, so strict browser deployments also need lower-level egress rules or browser networking disabled.

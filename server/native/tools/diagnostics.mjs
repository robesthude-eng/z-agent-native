import { DEFAULT_TOOL_TIMEOUT_MS } from '../config.mjs';
import { buildTestCommand, formatTestReport } from '../test-runner.mjs';
import { formatDiagnosticsReport, planDiagnostics } from '../diagnostics.mjs';

export async function executeRunTests(root, input, ctx = {}, execBash) {
  const plan = buildTestCommand(root, input || {});
  const result = await execBash(root, plan.command, Number(input?.timeoutMs) || 900_000, ctx.signal, ctx);
  const report = formatTestReport({
    command: plan.command,
    framework: plan.framework,
    source: plan.source,
    exitCode: result.code,
    output: [result.stdout, result.stderr].filter(Boolean).join('\n'),
  });
  return {
    output: report.text,
    title: plan.command,
    mutatedPaths: ['.'],
    metadata: {
      tests: {
        command: plan.command,
        framework: plan.framework,
        exit: result.code,
        totals: report.totals,
        failures: report.failures.slice(0, 40),
      },
    },
  };
}

export async function executeDiagnostics(root, input, ctx = {}, execBash) {
  const plans = planDiagnostics(root, input || {});
  const runs = [];
  for (const plan of plans) {
    const result = await execBash(root, plan.command, Number(input?.timeoutMs) || DEFAULT_TOOL_TIMEOUT_MS, ctx.signal, ctx);
    runs.push({
      ...plan,
      exitCode: result.code,
      output: [result.stdout, result.stderr].filter(Boolean).join('\n'),
    });
  }
  const report = formatDiagnosticsReport(runs);
  return {
    output: report.text,
    title: plans.map((plan) => plan.kind).join(' + '),
    metadata: {
      diagnostics: {
        ok: report.ok,
        errorCount: report.errorCount,
        warningCount: report.warningCount,
        commands: plans.map((plan) => plan.command),
      },
    },
  };
}

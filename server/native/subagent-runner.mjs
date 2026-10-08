import { callModelAutopilot, modelKey, promoteModelPlan, subagentStepBudget } from './autopilot.mjs';
import { previewTitle } from './agent/tool-stream.mjs';
import { compactFrames } from './context.mjs';
import { getSubagentProfile, subagentToolNames, subagentWrites } from './subagents.mjs';
import { availableToolDefinitions, executeTool, toolOutputText } from './tools.mjs';

function toolsFor(profile) {
  const allowed = new Set(subagentToolNames(profile?.name));
  return availableToolDefinitions().filter((tool) => allowed.has(tool.name));
}

/**
 * Run one specialized nested model loop. This module intentionally owns the
 * child loop so the parent turn state machine does not also own capability
 * policy, child context compaction and child tool execution.
 */
export async function runSubagent({ ownerId, modelPlan, input, workspace, signal, projectContext = '', sessionId = '', progress = null }) {
  const prompt = String(input?.prompt || '').trim();
  if (!prompt) throw new Error('Subagent prompt must not be empty');
  const profile = getSubagentProfile(input?.agent);
  const tools = toolsFor(profile);
  // Тот же ownerId, что и у родительского хода: без него generate_image и
  // generate_speech не найдут ключ провайдера в подзадаче.
  const toolContext = subagentWrites(profile.name) ? { workspace, sessionId, ownerId, signal } : { workspace, ownerId, signal };
  const mutatedPaths = new Set();
  let repositorySnapshot = '';

  if (!projectContext) {
    const mapDone = progress?.ticker('Собираю карту репозитория');
    try {
      const map = await executeTool('repo_map', { maxFiles: 1800, maxSymbolsPerFile: 4 }, { workspace, signal });
      repositorySnapshot = toolOutputText(map).slice(0, 60_000);
    } catch {
      /* repository map is an accelerator, not a hard dependency */
    }
    mapDone?.('Карта репозитория готова');
  }

  const frames = [
    {
      role: 'user',
      content: [prompt, repositorySnapshot && `[Automatic repository snapshot]\n${repositorySnapshot}`].filter(Boolean).join('\n\n'),
    },
  ];
  const maxSteps = subagentStepBudget(profile, prompt);
  let plan = modelPlan;
  let selectedModel = plan?.candidates?.[0] || null;
  let continuations = 0;
  progress?.step(`Подагент «${profile.name}» запущен (до ${maxSteps} шагов)`);

  for (let step = 0; step < maxSteps; step++) {
    if (signal?.aborted) throw Object.assign(new Error('Turn cancelled'), { name: 'AbortError' });
    const modelDone = progress?.ticker(`Шаг ${step + 1}: жду ответ модели`);
    let response;
    try {
      response = await callModelAutopilot(ownerId, plan, {
        system: [profile.system, projectContext].filter(Boolean).join('\n\n'),
        frames: compactFrames(frames, { maxChars: 180_000, maxObservationChars: 24_000 }),
        tools,
        signal,
      });
    } finally {
      modelDone?.();
    }
    selectedModel = response.model || selectedModel;
    plan = promoteModelPlan(plan, selectedModel);
    const calls = response.toolCalls || [];
    // Обрыв стрима или лимит токенов — не готовый отчёт: просим продолжить.
    const cutOff =
      Boolean(response.interrupted) || /^(length|max_tokens|max_output_tokens|MAX_TOKENS)$/i.test(String(response.finish || ''));
    if (calls.length === 0 && cutOff && continuations < 2) {
      continuations += 1;
      frames.push({ role: 'assistant', content: response.text || '', toolCalls: [] });
      frames.push({
        role: 'user',
        content: '[Runtime] Your previous response was cut off. Continue exactly from where you stopped without repeating earlier text.',
      });
      continue;
    }
    if (response.text && calls.length > 0) progress?.step(`Модель: ${response.text}`);
    if (calls.length === 0) {
      progress?.step('Подагент закончил, пишет отчёт родительскому агенту');
      return {
        report: response.text || `${profile.name} subagent completed without a written report.`,
        kind: profile.name,
        steps: step + 1,
        repositorySnapshot: Boolean(repositorySnapshot || projectContext),
        model: selectedModel ? modelKey(selectedModel) : '',
        mutatedPaths: [...mutatedPaths],
      };
    }

    frames.push({ role: 'assistant', content: response.text || '', toolCalls: calls });
    for (const call of calls) {
      if (!tools.some((tool) => tool.name === call.name)) {
        frames.push({
          role: 'tool',
          callId: call.id,
          name: call.name,
          content: `Tool ${call.name} is not available to the ${profile.name} subagent.`,
          isError: true,
        });
        continue;
      }
      const toolDone = progress?.ticker(`→ ${call.name}: ${previewTitle(call.name, call.arguments || {})}`);
      try {
        const result = await executeTool(call.name, call.arguments || {}, toolContext);
        for (const mutated of result?.mutatedPaths || []) mutatedPaths.add(mutated);
        const content = toolOutputText(result);
        frames.push({ role: 'tool', callId: call.id, name: call.name, content, isError: false });
        toolDone?.(`→ ${call.name}: ${previewTitle(call.name, call.arguments || {})} ✓ ${content.length} симв.`);
      } catch (err) {
        frames.push({ role: 'tool', callId: call.id, name: call.name, content: `Error: ${err?.message || String(err)}`, isError: true });
        toolDone?.(`→ ${call.name}: ${previewTitle(call.name, call.arguments || {})} ✗ ${String(err?.message || err).split('\n')[0]}`);
      }
    }
  }

  // Лимит шагов исчерпан. Без итогового отчёта родительский ход терял всё,
  // что субагент успел выяснить, и повторял работу заново.
  let finalReport = '';
  const limitDone = progress?.ticker(`Лимит в ${maxSteps} шагов исчерпан, пишу итоговый отчёт`);
  try {
    if (!signal?.aborted) {
      frames.push({
        role: 'user',
        content:
          '[Runtime] Step limit reached. Do not call tools. Write your report now: what you found or changed (with file paths), what is verified, and what remains unfinished.',
      });
      const summary = await callModelAutopilot(ownerId, plan, {
        system: [profile.system, projectContext].filter(Boolean).join('\n\n'),
        frames: compactFrames(frames, { maxChars: 180_000, maxObservationChars: 24_000 }),
        tools: [],
        signal,
      });
      finalReport = String(summary?.text || '').trim();
    }
  } catch (err) {
    if (err?.name === 'AbortError' || signal?.aborted) throw err;
  } finally {
    limitDone?.();
  }

  return {
    report: finalReport
      ? `${finalReport}\n\n(${profile.name} subagent reached its ${maxSteps}-step limit; the report may be incomplete.)`
      : `${profile.name} subagent reached its ${maxSteps}-step investigation limit.`,
    kind: profile.name,
    steps: maxSteps,
    repositorySnapshot: Boolean(repositorySnapshot || projectContext),
    model: selectedModel ? modelKey(selectedModel) : '',
    mutatedPaths: [...mutatedPaths],
  };
}

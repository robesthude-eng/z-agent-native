import path from "node:path";

export function isPinnedCommit(value) {
  return /^(?:[a-fA-F0-9]{40}|[a-fA-F0-9]{64})$/.test(String(value || ""));
}

export function resolveLocalBenchmarkSource(sourceRoot, sourcePath) {
  const root = path.resolve(String(sourceRoot || "."));
  const target = path.resolve(root, String(sourcePath || ""));
  if (target !== root && !target.startsWith(`${root}${path.sep}`))
    throw new Error(
      `Local benchmark source escapes Z_AGENT_BENCHMARK_SOURCE_ROOT: ${sourcePath}`,
    );
  return target;
}

function finiteInRange(value, min, max, label, id) {
  if (value === undefined) return;
  const number = Number(value);
  if (!Number.isFinite(number) || number < min || number > max)
    throw new Error(`Benchmark ${id} ${label} must be ${min}..${max}`);
}

export function validateBenchmarkManifest(manifest) {
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest))
    throw new Error("Benchmark manifest must be an object");
  if (!Array.isArray(manifest.cases) || !manifest.cases.length)
    throw new Error("Benchmark manifest has no cases");
  const ids = new Set();
  for (const item of manifest.cases) {
    const id = String(item?.id || "").trim();
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{1,99}$/.test(id))
      throw new Error(`Invalid benchmark case id: ${id || "(empty)"}`);
    if (ids.has(id)) throw new Error(`Duplicate benchmark case id: ${id}`);
    ids.add(id);
    if (String(item.prompt || "").trim().length < 10)
      throw new Error(`Benchmark ${id} requires a concrete prompt`);
    if (!String(item.verifyCommand || "").trim())
      throw new Error(`Benchmark ${id} requires verifyCommand`);
    if (
      item.regressionCommands !== undefined &&
      (!Array.isArray(item.regressionCommands) ||
        item.regressionCommands.some(
          (command) => !String(command || "").trim(),
        ))
    ) {
      throw new Error(
        `Benchmark ${id} regressionCommands must be non-empty command strings`,
      );
    }
    const source = item.source;
    if (!source || !["local", "git"].includes(source.type))
      throw new Error(`Benchmark ${id} source.type must be local or git`);
    if (source.type === "local" && !String(source.path || "").trim())
      throw new Error(`Benchmark ${id} local source.path is required`);
    if (source.type === "git") {
      let url;
      try {
        url = new URL(String(source.url || ""));
      } catch {
        throw new Error(`Benchmark ${id} git source URL is invalid`);
      }
      if (url.protocol !== "https:" || url.username || url.password)
        throw new Error(
          `Benchmark ${id} git source must be credential-free HTTPS`,
        );
      if (!isPinnedCommit(source.ref))
        throw new Error(
          `Benchmark ${id} git source.ref must be a full 40/64-character commit hash`,
        );
    }
    finiteInRange(item.maxToolCalls, 1, 256, "maxToolCalls", id);
    finiteInRange(item.maxDurationMs, 1_000, 3_600_000, "maxDurationMs", id);
    finiteInRange(item.setupTimeoutMs, 1_000, 1_800_000, "setupTimeoutMs", id);
    finiteInRange(
      item.verifyTimeoutMs,
      1_000,
      1_800_000,
      "verifyTimeoutMs",
      id,
    );
  }
  return manifest;
}

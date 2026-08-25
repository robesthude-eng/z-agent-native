export type RuntimeCapabilityState =
  | "ready"
  | "disabled"
  | "failed"
  | "local-fallback";

export interface RuntimeCapability {
  state: RuntimeCapabilityState;
  mode?: string;
  required?: boolean;
  isolated?: boolean;
  allowlistCount?: number;
}

export interface RuntimeCapabilitySnapshot {
  runtime: string;
  version: string;
  capabilities: Record<string, RuntimeCapability>;
  policies: Record<string, string>;
  tools: string[];
}

const STATES: readonly string[] = [
  "ready",
  "disabled",
  "failed",
  "local-fallback",
];

export function parseRuntimeCapabilities(
  input: unknown,
): RuntimeCapabilitySnapshot | null {
  if (!input || typeof input !== "object") return null;
  const raw = input as Record<string, unknown>;
  if (
    typeof raw.runtime !== "string" ||
    typeof raw.version !== "string" ||
    !raw.capabilities ||
    typeof raw.capabilities !== "object" ||
    !raw.policies ||
    typeof raw.policies !== "object" ||
    !Array.isArray(raw.tools)
  ) {
    return null;
  }

  const capabilities: Record<string, RuntimeCapability> = {};
  for (const [name, value] of Object.entries(raw.capabilities)) {
    if (!value || typeof value !== "object") continue;
    const capability = value as Record<string, unknown>;
    if (
      typeof capability.state !== "string" ||
      !STATES.includes(capability.state)
    )
      continue;
    capabilities[name] = {
      state: capability.state as RuntimeCapabilityState,
      ...(typeof capability.mode === "string" ? { mode: capability.mode } : {}),
      ...(typeof capability.required === "boolean"
        ? { required: capability.required }
        : {}),
      ...(typeof capability.isolated === "boolean"
        ? { isolated: capability.isolated }
        : {}),
      ...(typeof capability.allowlistCount === "number"
        ? { allowlistCount: capability.allowlistCount }
        : {}),
    };
  }

  const policies = Object.fromEntries(
    Object.entries(raw.policies).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
  const tools = raw.tools.filter(
    (tool): tool is string => typeof tool === "string",
  );
  return {
    runtime: raw.runtime,
    version: raw.version,
    capabilities,
    policies,
    tools,
  };
}

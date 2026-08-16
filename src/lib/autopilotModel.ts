export const AUTO_MODEL = {
  providerID: "__auto__",
  modelID: "__auto__",
} as const;

export function isAutoModel(
  model: { providerID?: string; modelID?: string } | null | undefined,
): boolean {
  return (
    model?.providerID === AUTO_MODEL.providerID &&
    model?.modelID === AUTO_MODEL.modelID
  );
}

export const AUTO_MODEL = {
  providerID: "",
  modelID: "",
} as const;

export function isAutoModel(
  model: { providerID?: string; modelID?: string } | null | undefined,
): boolean {
  return (
    model != null &&
    model.providerID === AUTO_MODEL.providerID &&
    model.modelID === AUTO_MODEL.modelID
  );
}

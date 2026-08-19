export function envFlag(value, fallback = false) {
  if (value == null || value === '') return fallback;
  return Boolean(value);
}

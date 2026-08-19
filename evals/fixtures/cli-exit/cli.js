export function exitCode({ errors = 0, warnings = 0 }) {
  return warnings > 0 ? 1 : 0;
}

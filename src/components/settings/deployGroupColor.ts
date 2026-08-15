/**
 * Groups deploy-like artifact names (DB backups, dist snapshots) by proximity
 * in time so related items get a shared accent color in the UI. Pure helper
 * — no state, safe to share between DbBackupCard and InstantRollbackCard.
 */
export function getDeployGroupColor(name: string): string {
  const m = name.match(/(\d{4}-\d{2}-\d{2})[T-](\d{2})[-:](\d{2})[-:](\d{2})/);
  if (!m) return "";
  const dateStr = m[1];
  const timeStr = `${m[2]}:${m[3]}:${m[4]}`;
  const cleanTime = new Date(`${dateStr}T${timeStr}`).getTime();
  if (Number.isNaN(cleanTime)) return "";
  const group = Math.floor(cleanTime / (3 * 60 * 1000)); // group by 3 minutes proximity
  const colors = [
    "border-foreground/25 bg-foreground/[0.02]",
    "border-sky-400/30 bg-sky-400/[0.02]",
    "border-cyan-500/30 bg-cyan-500/[0.02]",
    "border-amber-500/30 bg-amber-500/[0.02]",
    "border-sky-500/30 bg-sky-500/[0.02]",
  ];
  return colors[group % colors.length] ?? "";
}

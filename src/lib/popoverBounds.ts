/** Horizontal shift so a centered popover stays inside the viewport. */
export function clampPopoverShift(
  left: number,
  right: number,
  viewport: number,
  pad = 8,
): number {
  if (!(viewport > 0)) return 0;
  let shift = 0;
  if (left < pad) shift += pad - left;
  if (right + shift > viewport - pad) {
    shift -= right + shift - (viewport - pad);
  }
  return shift;
}

import { describe, expect, test } from "vitest";
import { clampPopoverShift } from "./popoverBounds";

describe("clampPopoverShift", () => {
  test("does not move a panel that already fits", () => {
    expect(clampPopoverShift(40, 360, 400)).toBe(0);
  });

  test("pushes a left-clipped panel back into the viewport", () => {
    expect(clampPopoverShift(-40, 280, 360)).toBe(48);
  });

  test("pulls a right-clipped panel back into the viewport", () => {
    expect(clampPopoverShift(80, 400, 360)).toBe(-48);
  });
});

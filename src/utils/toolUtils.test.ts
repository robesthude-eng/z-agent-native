import { TOOL_LABEL_KEYS } from "@/lib/toolLabels";
import { TOOL_ICONS } from "./toolUtils";

describe("таблицы инструментов", () => {
  it("у каждого инструмента с подписью есть свой значок", () => {
    const missing = Object.keys(TOOL_LABEL_KEYS).filter(
      (tool) => !(tool in TOOL_ICONS),
    );
    expect(missing).toEqual([]);
  });

  it("у каждого значка есть человеческая подпись", () => {
    const missing = Object.keys(TOOL_ICONS).filter(
      (tool) => !(tool in TOOL_LABEL_KEYS),
    );
    expect(missing).toEqual([]);
  });
});

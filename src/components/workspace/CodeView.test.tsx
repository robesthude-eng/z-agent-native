/**
 * Тесты для src/components/workspace/CodeView.tsx
 *
 * Проверять здесь можно не всё: jsdom не считает раскладку, поэтому «слои
 * совпали до пикселя» тестом не берётся — это меряется в браузере. Зато
 * берётся причина расхождения, а она структурная.
 *
 * Textarea держит место под строку после последнего перевода строки, а
 * `<pre>` её схлопывает. Пока файл влезает в окно, разницы не видно; в самом низу
 * длинного файла нижний слой упирается в свой предел на строку раньше, и
 * подсветка съезжает. Поэтому нижний слой всегда получает текст с переводом
 * строки на конце — и ровно это здесь и утверждается.
 *
 * Второе утверждение важнее первого: добавленный перевод строки не должен
 * протекать в textarea. Протёк бы — каждое открытие файла считалось бы
 * правкой, а каждое сохранение дописывало бы пустую строку.
 */

import { fireEvent, render } from "@testing-library/react";
import { describe, expect, test, vi } from "vitest";
import CodeView from "./CodeView";

describe("CodeView", () => {
  const json = '{\n  "name": "demo"\n}';

  test("нижний слой заканчивается переводом строки — иначе слои разъезжаются", () => {
    const { container } = render(
      <CodeView
        path="package.json"
        value={json}
        editable
        onChange={() => {}}
      />,
    );
    const pre = container.querySelector("pre");
    expect(pre?.textContent?.endsWith("\n")).toBe(true);
  });

  test("перевод строки не протекает в textarea", () => {
    const { container } = render(
      <CodeView
        path="package.json"
        value={json}
        editable
        onChange={() => {}}
      />,
    );
    const ta = container.querySelector("textarea");
    expect(ta?.value).toBe(json);
  });

  test("то же и без подсветки: у незнакомого расширения слои тоже совпадают", () => {
    const { container } = render(
      <CodeView
        path="notes.unknown"
        value={json}
        editable
        onChange={() => {}}
      />,
    );
    expect(container.querySelector("pre")?.textContent).toBe(`${json}\n`);
    expect(container.querySelector("textarea")?.value).toBe(json);
  });

  test("правка уходит наверх нетронутой", () => {
    const onChange = vi.fn();
    const { container } = render(
      <CodeView
        path="package.json"
        value={json}
        editable
        onChange={onChange}
      />,
    );
    const ta = container.querySelector("textarea");
    if (!ta) throw new Error("textarea не отрисована");
    // Настоящее событие ввода, а не вызов пропа: так проверяется и то, что
    // прозрачная textarea осталась настоящим полем ввода.
    fireEvent.change(ta, { target: { value: `${json}\nx` } });
    expect(onChange).toHaveBeenCalledWith(`${json}\nx`);
  });

  test("только для чтения: textarea нет, подсветка есть", () => {
    const { container } = render(
      <CodeView path="package.json" value={json} editable={false} />,
    );
    expect(container.querySelector("textarea")).toBeNull();
    expect(
      container.querySelectorAll('[class^="hljs-"]').length,
    ).toBeGreaterThan(0);
  });

  test("подсветка размечает JSON, а не отдаёт его строкой", () => {
    const { container } = render(
      <CodeView
        path="package.json"
        value={json}
        editable
        onChange={() => {}}
      />,
    );
    expect(container.querySelector(".hljs-attr")).not.toBeNull();
  });

  test("файл сверх потолка показывается без подсветки", () => {
    const huge = "a".repeat(500_001);
    const { container } = render(
      <CodeView path="huge.json" value={huge} editable={false} />,
    );
    expect(container.querySelectorAll('[class^="hljs-"]').length).toBe(0);
  });
});

import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import { Terminal as XTerm } from "@xterm/xterm";
import { useEffect, useRef } from "react";
import io, { type Socket } from "socket.io-client";
import { log } from "../lib/log";
import "@xterm/xterm/css/xterm.css";

interface TerminalProps {
  workdir: string;
}

/**
 * Внутренности xterm. Публичного признака «рендерер уже создан» терминал не
 * отдаёт, а fitAddon.fit() до этого момента падает на обращении к
 * _renderService. Описываем ровно то приватное поле, которое читаем, — это
 * честнее, чем каст всего терминала в any.
 */
interface XTermInternals {
  _core?: { _renderService?: unknown };
}

export function Terminal({ workdir }: TerminalProps) {
  const terminalRef = useRef<HTMLDivElement>(null);
  const xtermRef = useRef<XTerm | null>(null);
  const socketRef = useRef<Socket | null>(null);

  useEffect(() => {
    if (!terminalRef.current) return;

    // Инициализация Xterm
    const term = new XTerm({
      theme: {
        background: "#111214",
        foreground: "#f2f3f4",
        cursor: "#63e2b7",
      },
      fontFamily: "monospace",
      fontSize: 13,
      cursorBlink: true,
    });
    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);

    term.open(terminalRef.current);
    xtermRef.current = term;

    // WebGL-рендерер: заметно быстрее при болтливом выводе агента.
    // Грузится строго после open(); при недоступности WebGL или потере
    // контекста молча откатываемся на DOM-рендерер xterm.
    let webgl: WebglAddon | null = null;
    try {
      webgl = new WebglAddon();
      webgl.onContextLoss(() => {
        webgl?.dispose();
        webgl = null;
      });
      term.loadAddon(webgl);
    } catch {
      // WebGL недоступен — остаёмся на дефолтном рендерере
      webgl = null;
    }

    // Инициализация Socket.IO
    const socket = io({
      path: "/socket.io",
      query: { workdir },
    });
    socketRef.current = socket;

    socket.on("connect", () => {
      term.writeln("\x1b[32m*** Подключено к терминалу ***\x1b[0m");
      // Первичный размер для pty на сервере (создаётся 80x24, тут же подгоняем).
      socket.emit("resize", { cols: term.cols, rows: term.rows });
    });

    socket.on("data", (data: string) => {
      term.write(data);
    });

    socket.on("disconnect", () => {
      term.writeln("\r\n\x1b[31m*** Отключено от терминала ***\x1b[0m");
    });

    term.onData((data) => {
      socket.emit("data", data);
    });

    // FitAddon меняет cols/rows у xterm → пробрасываем в pty на сервере,
    // иначе для программ окно навсегда 80x24. До connect socket.io сам
    // буферизует emit'ы.
    term.onResize(({ cols, rows }) => {
      socket.emit("resize", { cols, rows });
    });

    let isDisposed = false;
    const safeFit = () => {
      if (isDisposed) return;
      try {
        if (
          term.element &&
          term.element.clientWidth > 0 &&
          term.element.clientHeight > 0
        ) {
          if ((term as XTermInternals)._core?._renderService) {
            fitAddon.fit();
          }
        }
      } catch (e) {
        log.warn("fitAddon.fit error:", e);
      }
    };

    const resizeObserver = new ResizeObserver(() => {
      safeFit();
    });
    resizeObserver.observe(terminalRef.current);

    // Initial fit with slight delay to ensure layout
    const timeoutId = setTimeout(safeFit, 50);

    return () => {
      isDisposed = true;
      clearTimeout(timeoutId);
      resizeObserver.disconnect();
      // Релиз 3: гарантированная очистка при размонтировании: снимаем
      // обработчики сокета, явно освобождаем все аддоны и зануляем refs,
      // чтобы повторные открытия терминала не копили память.
      socket.removeAllListeners();
      socket.disconnect();
      try {
        webgl?.dispose();
      } catch {
        // уже освобождён при потере контекста
      }
      webgl = null;
      try {
        fitAddon.dispose();
      } catch {
        // аддон мог быть уже освобождён вместе с терминалом
      }
      term.dispose();
      xtermRef.current = null;
      socketRef.current = null;
    };
  }, [workdir]);

  return <div ref={terminalRef} className="h-full w-full overflow-hidden" />;
}

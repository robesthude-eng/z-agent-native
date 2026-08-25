import type { RefObject } from "react";
import { useEffect, useMemo, useState } from "react";
import { api } from "@/api/client";
import type { FileNode } from "@/api/types";
import { t } from "@/i18n";
import type { ComposerCommand } from "./ComposerSuggestions";

const COMMANDS: ComposerCommand[] = [
  {
    cmd: t("composer.rezyume"),
    hint: t("composer.kratkoe_rezyume_dialoga"),
    insert: t("composer.sdelay_kratkoe_rezyume_nashego_dialoga_klyuc"),
  },
  {
    cmd: t("composer.testy"),
    hint: t("composer.zapustit_testy"),
    insert: t("composer.zapusti_testy_i_pokazhi_rezultat_esli"),
  },
  {
    cmd: t("composer.fiks"),
    hint: t("composer.pochinit_poslednyuyu_oshibku"),
    insert: t("composer.naydi_prichinu_posledney_oshibki_i_predlozhi"),
  },
  {
    cmd: t("composer.revyu"),
    hint: t("composer.kod_revyu_izmeneniy"),
    insert: t("composer.sdelay_kod_revyu_poslednih_izmeneniy_oshibki"),
  },
  {
    cmd: t("composer.kommit"),
    hint: t("composer.soobschenie_kommita"),
    insert: t("composer.sformuliruy_soobschenie_kommita_dlya_tekusch"),
  },
];

interface UseComposerSuggestionsOptions {
  sessionId: string | null;
  text: string;
  caret: number;
  setText: (value: string) => void;
  setCaret: (value: number) => void;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
}

export function useComposerSuggestions({
  sessionId,
  text,
  caret,
  setText,
  setCaret,
  textareaRef,
}: UseComposerSuggestionsOptions) {
  const [commandIndex, setCommandIndex] = useState(0);
  const [fileIndex, setFileIndex] = useState(0);
  const [fileCache, setFileCache] = useState<{
    sessionId: string;
    files: FileNode[];
  } | null>(null);

  const commandQuery = /^\/[^\s\n]*$/.test(text) ? text.toLowerCase() : null;
  const commands = commandQuery
    ? COMMANDS.filter((command) => command.cmd.startsWith(commandQuery))
    : [];

  const mentionMatch = /(^|\s)@([\w./-]*)$/.exec(text.slice(0, caret));
  const mentionQuery = mentionMatch
    ? (mentionMatch[2] ?? "").toLowerCase()
    : null;
  const cachedFiles =
    fileCache?.sessionId === sessionId ? fileCache.files : null;
  const files = useMemo(
    () =>
      mentionQuery !== null && cachedFiles
        ? cachedFiles
            .filter((file) => file.path.toLowerCase().includes(mentionQuery))
            .slice(0, 8)
        : [],
    [cachedFiles, mentionQuery],
  );

  useEffect(() => {
    if (mentionQuery === null || cachedFiles !== null || !sessionId) return;
    let cancelled = false;
    api
      .listTree(sessionId)
      .then((nodes) => {
        if (cancelled) return;
        setFileCache({
          sessionId,
          files: nodes
            .filter((node) => node.type !== "directory" && !node.isDirectory)
            .slice(0, 2000),
        });
      })
      .catch(() => {
        if (!cancelled) setFileCache({ sessionId, files: [] });
      });
    return () => {
      cancelled = true;
    };
  }, [cachedFiles, mentionQuery, sessionId]);

  const chooseCommand = (command: ComposerCommand) => {
    setText(command.insert);
    setCommandIndex(0);
    textareaRef.current?.focus();
  };

  const chooseFile = (file: FileNode) => {
    if (!mentionMatch) return;
    const start = caret - (mentionMatch[2] ?? "").length;
    setText(`${text.slice(0, start)}${file.path} ${text.slice(caret)}`);
    setFileIndex(0);
    setCaret(start + file.path.length + 1);
    textareaRef.current?.focus();
  };

  return {
    commands,
    files,
    commandIndex,
    fileIndex,
    chooseCommand,
    chooseFile,
    moveCommand(delta: number) {
      if (commands.length === 0) return;
      setCommandIndex(
        (index) => (index + delta + commands.length) % commands.length,
      );
    },
    moveFile(delta: number) {
      if (files.length === 0) return;
      setFileIndex((index) => (index + delta + files.length) % files.length);
    },
    activeCommand: commands[commandIndex % commands.length],
    activeFile: files[fileIndex % files.length],
  };
}

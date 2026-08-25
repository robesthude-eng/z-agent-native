import { useEffect, useRef, useState } from "react";

export function useWindowFileDrop(
  onFiles: (files: FileList | null) => void,
  onDropStateReset: () => void,
): boolean {
  const [active, setActive] = useState(false);
  const depthRef = useRef(0);
  const onFilesRef = useRef(onFiles);
  onFilesRef.current = onFiles;
  const onDropStateResetRef = useRef(onDropStateReset);
  onDropStateResetRef.current = onDropStateReset;

  useEffect(() => {
    const hasFiles = (event: DragEvent) =>
      Array.from(event.dataTransfer?.types ?? []).includes("Files");
    const onEnter = (event: DragEvent) => {
      if (!hasFiles(event)) return;
      depthRef.current += 1;
      setActive(true);
    };
    const onOver = (event: DragEvent) => {
      if (hasFiles(event)) event.preventDefault();
    };
    const onLeave = (event: DragEvent) => {
      if (!hasFiles(event)) return;
      depthRef.current = Math.max(0, depthRef.current - 1);
      if (depthRef.current === 0) setActive(false);
    };
    const onDrop = (event: DragEvent) => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      depthRef.current = 0;
      setActive(false);
      onDropStateResetRef.current();
      onFilesRef.current(event.dataTransfer?.files ?? null);
    };

    window.addEventListener("dragenter", onEnter);
    window.addEventListener("dragover", onOver);
    window.addEventListener("dragleave", onLeave);
    window.addEventListener("drop", onDrop);
    return () => {
      window.removeEventListener("dragenter", onEnter);
      window.removeEventListener("dragover", onOver);
      window.removeEventListener("dragleave", onLeave);
      window.removeEventListener("drop", onDrop);
    };
  }, []);

  return active;
}

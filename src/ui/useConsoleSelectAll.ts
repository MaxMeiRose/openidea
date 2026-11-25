import { useEffect, useLayoutEffect, useRef, type ClipboardEvent, type KeyboardEvent, type RefObject } from "react";
import { registerKeyClaim } from "@/platform/keymap";

const EDITABLE = "input, textarea, [contenteditable=''], [contenteditable='true'], [contenteditable='plaintext-only']";
const isSelectAll = (event: { key: string; ctrlKey: boolean; metaKey: boolean; altKey: boolean; shiftKey: boolean }) =>
  (event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === "a";
const isEditable = (target: EventTarget | null) => target instanceof Element && !!target.closest(EDITABLE);

/** Highlight the virtualized container; copy the complete output, including unmounted rows. */
export function useConsoleSelectAll(
  host: RefObject<HTMLDivElement | null>,
  inner: RefObject<HTMLDivElement | null>,
  text: () => string,
  pauseFollow: () => void,
) {
  const fullSelection = useRef(false);
  useEffect(
    () =>
      registerKeyClaim(
        (event) =>
          isSelectAll(event) &&
          !isEditable(event.target) &&
          event.target instanceof Node &&
          !!host.current?.contains(event.target),
      ),
    [host],
  );

  useEffect(() => {
    const down = (event: globalThis.MouseEvent) => {
      if (event.button !== 0 || !(event.target instanceof Node)) return;
      if (inner.current?.contains(event.target) || !host.current?.contains(event.target)) fullSelection.current = false;
    };
    const selectionChanged = () => {
      if (!fullSelection.current) return;
      const selection = window.getSelection();
      if (
        (selection?.anchorNode && !host.current?.contains(selection.anchorNode)) ||
        (selection?.focusNode && !host.current?.contains(selection.focusNode)) ||
        (selection &&
          !selection.isCollapsed &&
          (selection.anchorNode !== inner.current || selection.focusNode !== inner.current))
      )
        fullSelection.current = false;
    };
    const focusChanged = (event: FocusEvent) => {
      if (isEditable(event.target)) fullSelection.current = false;
    };
    document.addEventListener("mousedown", down);
    document.addEventListener("selectionchange", selectionChanged);
    document.addEventListener("focusin", focusChanged);
    return () => {
      document.removeEventListener("mousedown", down);
      document.removeEventListener("selectionchange", selectionChanged);
      document.removeEventListener("focusin", focusChanged);
    };
  }, [host, inner]);

  // Recycling virtual rows can collapse or shorten the native range. Keep the
  // logical full-buffer selection, and repaint only the currently mounted rows.
  useLayoutEffect(() => {
    if (fullSelection.current && inner.current) window.getSelection()?.selectAllChildren(inner.current);
  });

  const selectAll = () => {
    if (!inner.current) return;
    host.current?.focus();
    pauseFollow();
    fullSelection.current = true;
    window.getSelection()?.selectAllChildren(inner.current);
  };

  return {
    selectAll,
    selectedOutput: () => (fullSelection.current ? text() : (window.getSelection()?.toString() ?? "")),
    onSelectAllKeyDown: (event: KeyboardEvent<HTMLDivElement>) => {
      if (event.defaultPrevented || event.nativeEvent.isComposing || isEditable(event.target)) return false;
      if (!isSelectAll(event)) {
        const copy =
          !event.altKey &&
          !event.shiftKey &&
          ((event.key.toLowerCase() === "c" && (event.ctrlKey || event.metaKey)) ||
            (event.key === "Insert" && event.ctrlKey));
        if (copy && fullSelection.current && inner.current) window.getSelection()?.selectAllChildren(inner.current);
        else if (
          [
            "Escape",
            "ArrowLeft",
            "ArrowRight",
            "ArrowUp",
            "ArrowDown",
            "Home",
            "End",
            "Enter",
            "Backspace",
            "Delete",
          ].includes(event.key) ||
          (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey)
        )
          fullSelection.current = false;
        return false;
      }
      event.preventDefault();
      event.stopPropagation();
      selectAll();
      return true;
    },
    onCopy: (event: ClipboardEvent<HTMLDivElement>) => {
      if (!fullSelection.current) return;
      event.preventDefault();
      event.clipboardData.setData("text/plain", text());
    },
  };
}

/** "Send to Agent": the editor selection or Project view files as `@` references. */
import { activeEditor } from "@/editor/api";
import { isVirtualUri } from "@/platform/virtualDocs";
import { addReferences } from "./store";

/** The active editor's file, with the selected lines when there is a selection. */
export function sendSelection(target?: string): boolean {
  const handle = activeEditor();
  if (!handle || isVirtualUri(handle.ctx.path)) return false;
  const { state } = handle.view;
  const sel = state.selection.main;
  // A selection ending at a line start does not include that line.
  const end = sel.to > sel.from && state.doc.lineAt(sel.to).from === sel.to ? sel.to - 1 : sel.to;
  const lines = sel.empty ? undefined : { from: state.doc.lineAt(sel.from).number, to: state.doc.lineAt(end).number };
  addReferences([{ path: handle.ctx.path, lines }], target);
  return true;
}

/** Files and folders from the Project view. */
export function sendPaths(paths: readonly string[], target?: string): boolean {
  const refs = paths.filter((path) => path && !isVirtualUri(path)).map((path) => ({ path }));
  if (refs.length) addReferences(refs, target);
  return refs.length > 0;
}

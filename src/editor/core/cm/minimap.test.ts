import { afterEach, expect, it, vi } from "vitest";
import { Compartment, EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import type { EditorSettings } from "@/platform/ipc";
import { HEAVY_LIMIT, heavyExtension } from "./setup";

const settings = (showMinimap: boolean) => ({ appearance: { showMinimap } }) as EditorSettings;

afterEach(() => {
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

it("shows the minimap by default, and lets the user turn it off", () => {
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
  const make = (prefs?: EditorSettings, length = 10) =>
    new EditorView({
      state: EditorState.create({ doc: "one\ntwo\n", extensions: heavyExtension(length, prefs) }),
      parent: document.body,
    });
  const view = make();
  expect(view.dom.querySelector('.cm-openidea-minimap[aria-label="Code minimap"]')).not.toBeNull();
  view.destroy();
  const hidden = make(settings(false));
  expect(hidden.dom.querySelector(".cm-openidea-minimap")).toBeNull();
  hidden.destroy();
  const large = make(settings(true), HEAVY_LIMIT + 1);
  expect(large.dom.querySelector(".cm-openidea-minimap")).toBeNull();
  large.destroy();
});

it("scrolls on a minimap click and removes its window listeners on close", () => {
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
  const add = vi.spyOn(window, "addEventListener");
  const remove = vi.spyOn(window, "removeEventListener");
  const view = new EditorView({
    state: EditorState.create({ doc: "line\n".repeat(100), extensions: heavyExtension(500, settings(true)) }),
    parent: document.body,
  });
  Object.defineProperties(view.scrollDOM, { clientHeight: { value: 100 }, scrollHeight: { value: 1000 } });
  const overlay = view.dom.querySelector<HTMLElement>(".cm-minimap-overlay-container")!;
  overlay.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, clientY: 75, button: 0 }));
  expect(view.scrollDOM.scrollTop).toBeGreaterThan(0);
  const handlers = add.mock.calls.filter(([type]) => type === "mouseup" || type === "mousemove");
  expect(handlers.some(([type]) => type === "mouseup")).toBe(true);
  expect(handlers.some(([type]) => type === "mousemove")).toBe(true);
  view.destroy();
  for (const [type, handler] of handlers) expect(remove).toHaveBeenCalledWith(type, handler);
});

it("prevents a primary minimap press from starting an editor selection", () => {
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
  const view = new EditorView({
    state: EditorState.create({ doc: "line\n".repeat(100), extensions: heavyExtension(500, settings(true)) }),
    parent: document.body,
  });
  const editorMouseDown = vi.fn();
  view.dom.addEventListener("mousedown", editorMouseDown);
  const overlay = view.dom.querySelector<HTMLElement>(".cm-minimap-overlay-container")!;
  const primary = new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 });
  overlay.dispatchEvent(primary);
  expect(primary.defaultPrevented).toBe(true);
  expect(editorMouseDown).not.toHaveBeenCalled();

  const secondary = new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 2 });
  overlay.dispatchEvent(secondary);
  expect(secondary.defaultPrevented).toBe(false);
  expect(editorMouseDown).toHaveBeenCalledOnce();
  view.destroy();
});

it("applies the minimap setting to an already open editor", () => {
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
  const compartment = new Compartment();
  const view = new EditorView({
    state: EditorState.create({ doc: "line\n", extensions: compartment.of(heavyExtension(5, settings(true))) }),
    parent: document.body,
  });
  expect(view.dom.querySelector(".cm-openidea-minimap")).not.toBeNull();
  view.dispatch({ effects: compartment.reconfigure(heavyExtension(5, settings(false))) });
  expect(view.dom.querySelector(".cm-openidea-minimap")).toBeNull();
  view.dispatch({ effects: compartment.reconfigure(heavyExtension(5, settings(true))) });
  expect(view.dom.querySelector(".cm-openidea-minimap")).not.toBeNull();
  view.destroy();
});

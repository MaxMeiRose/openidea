import { MapMode, RangeSet, StateEffect, StateField, type Extension } from "@codemirror/state";
import { EditorView, GutterMarker, ViewPlugin, gutter, type ViewUpdate } from "@codemirror/view";
import type { EditorDocContext } from "@/editor/api";
import { executeAction } from "@/platform/actions";
import { gutterIconMarkup } from "@/ui";
import { javaMethods, methodKey, methodLabel, type MethodTarget } from "./model";
import styles from "./MethodTest.module.css";

const setMethods = StateEffect.define<MethodTarget[]>();
const methods = StateField.define<MethodTarget[]>({
  create: () => [],
  update(value, transaction) {
    for (const effect of transaction.effects) if (effect.is(setMethods)) return effect.value;
    if (!transaction.docChanged) return value;
    return value.flatMap((method) => {
      const from = transaction.changes.mapPos(method.from, 1, MapMode.TrackDel);
      return from === null ? [] : [{ ...method, from, to: transaction.changes.mapPos(method.to, -1) }];
    });
  },
});
class MethodMarker extends GutterMarker {
  constructor(readonly target: MethodTarget) {
    super();
  }
  eq(other: GutterMarker) {
    return (
      other instanceof MethodMarker &&
      methodKey(other.target) === methodKey(this.target) &&
      other.target.from === this.target.from
    );
  }
  toDOM(view: EditorView) {
    const button = document.createElement("button");
    button.type = "button";
    button.tabIndex = -1;
    button.className = styles.marker ?? "";
    button.title = `Test Method · ${methodLabel(this.target)}`;
    button.setAttribute("aria-label", button.title);
    button.innerHTML = gutterIconMarkup("toolwindow-method-test") ?? "";
    button.addEventListener("mousedown", (event) => {
      event.preventDefault();
      event.stopPropagation();
    });
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      const current = view.state
        .field(methods)
        .find((target) => methodKey(target) === methodKey(this.target) && target.from === this.target.from);
      if (current) void executeAction("methodTest.open", current);
    });
    return button;
  }
}
export function methodTestExtension(ctx: EditorDocContext): Extension {
  if (ctx.language !== "java" || ctx.virtual || ctx.readOnly) return [];
  return [
    methods,
    ViewPlugin.fromClass(
      class {
        timer: ReturnType<typeof setTimeout> | undefined;
        constructor(readonly view: EditorView) {
          this.schedule(0);
        }
        update(update: ViewUpdate) {
          if (update.docChanged) this.schedule(350);
        }
        schedule(delay: number) {
          clearTimeout(this.timer);
          this.timer = setTimeout(() => {
            const targets = javaMethods(ctx.path, this.view.state.doc.toString()).filter((target) => target.service);
            this.view.dispatch({ effects: setMethods.of(targets) });
          }, delay);
        }
        destroy() {
          clearTimeout(this.timer);
        }
      },
    ),
    gutter({
      class: "cm-openidea-gutter-method-test",
      markers: (view) =>
        RangeSet.of(
          view.state
            .field(methods)
            .map((target) => new MethodMarker(target).range(view.state.doc.lineAt(target.from).from)),
          true,
        ),
    }),
  ];
}

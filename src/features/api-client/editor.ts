/** Clickable request hints above Spring controller methods, using the current editor buffer. */
import { MapMode, StateEffect, StateField, type EditorState, type Extension } from "@codemirror/state";
import { ViewPlugin, type EditorView, type ViewUpdate } from "@codemirror/view";
import { codeLenses, type CodeLens, type EditorDocContext } from "@/editor/api";
import { executeAction } from "@/platform/actions";
import { tx } from "@/platform/i18n";
import { useProject } from "@/platform/project";
import { isVirtualUri } from "@/platform/virtualDocs";
import { showContextMenu } from "@/ui";
import { springControllers, type Endpoint } from "@/features/http-client/spring/endpoints";
import type { ApiEndpointTarget } from "./model";

interface Target {
  pos: number;
  from: number;
  endpoint: Endpoint;
}
const setTargets = StateEffect.define<Target[]>();
const targets = StateField.define<Target[]>({
  create: () => [],
  update(value, tr) {
    for (const effect of tr.effects) if (effect.is(setTargets)) return effect.value;
    if (!tr.docChanged) return value;
    return value.flatMap((target) => {
      const pos = tr.changes.mapPos(target.pos, 1, MapMode.TrackDel);
      // Removed declarations must not leave clickable hints at the end of their replacement.
      return pos === null ? [] : [{ ...target, pos, from: tr.changes.mapPos(target.from, -1) }];
    });
  },
});

const detect = (state: EditorState) =>
  springControllers(state.doc.toString()).flatMap((controller) =>
    controller.endpoints.map((endpoint) => ({ pos: endpoint.offset, from: endpoint.range.from, endpoint })),
  );

function openRequest(view: EditorView, path: string, target: Target, event: MouseEvent) {
  // Resolve again on click: edits may still be inside the detector's debounce window.
  const line = view.state.doc.lineAt(target.pos).number;
  const candidates = detect(view.state).filter((entry) => view.state.doc.lineAt(entry.pos).number === line);
  const current = candidates.find((entry) => entry.endpoint.methodName === target.endpoint.methodName) ?? candidates[0];
  if (!current) return;
  const endpoint = current.endpoint;
  const text = view.state.doc.toString();
  const at = view.state.doc.lineAt(endpoint.offset);
  const root = useProject.getState().project?.root;
  const open = (url: string) => {
    const arg: ApiEndpointTarget = {
      endpoint: {
        method: endpoint.httpMethod,
        url,
        controller: endpoint.className,
        methodName: endpoint.methodName,
        path,
        rel: root && path.startsWith(root + "/") ? path.slice(root.length + 1) : path,
        line: at.number - 1,
        col: endpoint.offset - at.from,
      },
      source: text,
    };
    void executeAction("apiClient.openEndpoint", arg);
  };
  if (endpoint.paths.length === 1) open(endpoint.paths[0]!);
  else
    showContextMenu(
      event,
      endpoint.paths.map((url) => ({
        label: `${endpoint.httpMethod} ${url}`,
        verbatim: true,
        icon: "toolwindow-api",
        run: () => open(url),
      })),
    );
}

export function apiRequestLenses(ctx: EditorDocContext): Extension {
  if (!["java", "kotlin"].includes(ctx.language) || ctx.virtual || isVirtualUri(ctx.path)) return [];
  return [
    targets,
    codeLenses.compute([targets], (state): CodeLens[] =>
      state.field(targets).map((target) => ({
        pos: target.from,
        title: tx("API Call"),
        tooltip: `${target.endpoint.httpMethod} ${target.endpoint.paths.join(", ")}`,
        order: 30,
        run: (view, event) => openRequest(view, ctx.path, target, event),
      })),
    ),
    ViewPlugin.fromClass(
      class {
        timer: ReturnType<typeof setTimeout> | undefined;
        constructor(readonly view: EditorView) {
          this.schedule(0);
        }
        update(update: ViewUpdate) {
          if (update.docChanged) this.schedule(400);
        }
        schedule(delay: number) {
          clearTimeout(this.timer);
          this.timer = setTimeout(() => this.view.dispatch({ effects: setTargets.of(detect(this.view.state)) }), delay);
        }
        destroy() {
          clearTimeout(this.timer);
        }
      },
    ),
  ];
}

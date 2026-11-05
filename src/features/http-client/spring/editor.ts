/**
 * Spring Web in Java / Kotlin editors: a gutter icon on every request mapping
 * and controller. Method icons open the visual API client; context actions
 * can still generate requests into the `generated-requests.http` scratch.
 */
import { MapMode, RangeSet, StateEffect, StateField, type EditorState, type Extension } from "@codemirror/state";
import { EditorView, GutterMarker, ViewPlugin, gutter, type ViewUpdate } from "@codemirror/view";
import {
  activeEditor,
  editorsFor,
  intentionProviders,
  useEditorRegistry,
  type ContributedIntention,
  type EditorDocContext,
  type TextEditorHandle,
} from "@/editor/api";
import { tx } from "@/platform/i18n";
import { executeAction } from "@/platform/actions";
import { call, commands, emitLocalIdeEvent, IpcError } from "@/platform/ipc";
import { ipcPath } from "@/platform/paths";
import { useProject } from "@/platform/project";
import { isVirtualUri } from "@/platform/virtualDocs";
import { gutterIconMarkup, showContextMenu, type MenuItem } from "@/ui";
import { editorService, notifications, type MenuGroupContext } from "@/workbench/contributions";
import { springAt, springControllers, type Controller, type Endpoint } from "./endpoints";
import { appendRequests, bodyLookup, findHost, renderRequest, skeleton, type SourceReader } from "./request";
import { parseSource } from "./source";
import type { ApiEndpointTarget } from "@/features/api-client/model";
import styles from "../HttpClient.module.css";

export const SPRING_LANGUAGES = new Set(["java", "kotlin"]);
export const GENERATED_REQUESTS = "generated-requests.http";
export const GENERATE_REQUEST = "http.generateSpringRequest";
export const GENERATE_CONTROLLER_REQUESTS = "http.generateSpringControllerRequests";

const reader: SourceReader = {
  read: async (path) => {
    try {
      return await call(commands.fsReadText(path));
    } catch {
      return null;
    }
  },
};

/** One request per endpoint (`paths[i]` picks another path of the mapping). */
export interface Target {
  endpoint: Endpoint;
  path?: string;
}

async function scratchFile(): Promise<{ path: string; created: boolean }> {
  const { appDataDir } = await import("@tauri-apps/api/path");
  // `appDataDir()` is native (`C:\…`): the editor is found by its `/` path.
  const dir = `${ipcPath(await appDataDir()).replace(/\/+$/, "")}/scratches`;
  const ignoreExisting = (e: unknown) => {
    if (!(e instanceof IpcError && e.kind === "alreadyExists")) throw e;
  };
  await call(commands.fsCreateDir(dir)).catch(ignoreExisting);
  const path = `${dir}/${GENERATED_REQUESTS}`;
  let created = true;
  await call(commands.fsCreateFile(path)).catch((e) => {
    ignoreExisting(e);
    created = false;
  });
  return { path, created };
}

/** The text editor of `path`, once the just opened tab has created it. */
function editorFor(path: string, timeoutMs = 5000): Promise<TextEditorHandle | null> {
  const find = () => editorsFor(path).find((x) => x === activeEditor()) ?? editorsFor(path)[0] ?? null;
  const now = find();
  if (now) return Promise.resolve(now);
  return new Promise((resolve) => {
    const done = (e: TextEditorHandle | null) => {
      clearTimeout(timer);
      unsubscribe();
      resolve(e);
    };
    const timer = setTimeout(() => done(null), timeoutMs);
    const unsubscribe = useEditorRegistry.subscribe(() => {
      const e = find();
      if (e) done(e);
    });
  });
}

/** Renders `targets` of the source at `sourcePath`, appends them to the scratch and opens it at the first one. */
export async function generateRequests(sourcePath: string, text: string, targets: Target[]): Promise<void> {
  if (!targets.length) return;
  try {
    const root = useProject.getState().project?.root ?? null;
    const [host, lookup] = await Promise.all([
      findHost(sourcePath, root, reader),
      bodyLookup(
        sourcePath,
        parseSource(text),
        targets.map((t) => t.endpoint),
        reader,
      ),
    ]);
    const blocks = targets.map(({ endpoint, path }) =>
      renderRequest(endpoint, {
        host,
        path,
        body: endpoint.bodyType ? skeleton(endpoint.bodyType, lookup) : undefined,
      }),
    );
    const file = await scratchFile();
    if (file.created) emitLocalIdeEvent({ type: "fsChanged", created: [file.path], modified: [], removed: [] });
    await editorService().openFile(file.path, { focus: true });
    const e = await editorFor(file.path);
    if (!e) throw new Error(`${tx("Cannot open file")}: ${file.path}`);
    const { insert, from, caret } = appendRequests(e.view.state.doc.toString(), blocks);
    e.view.dispatch({
      changes: { from, insert },
      selection: { anchor: caret },
      effects: EditorView.scrollIntoView(caret, { y: "center" }),
      userEvent: "input",
    });
  } catch (err) {
    notifications().notify({
      level: "error",
      title: "Cannot generate the HTTP request",
      body: err instanceof Error ? err.message : String(err),
      key: "http-generate",
    });
  }
}

function endpointItems(sourcePath: string, text: string, e: Endpoint): MenuItem[] {
  const generate = (path?: string) => void generateRequests(sourcePath, text, [{ endpoint: e, path }]);
  return [
    e.paths.length > 1
      ? {
          label: "Generate Request in HTTP Client",
          icon: "file-http",
          submenu: e.paths.map((p) => ({ label: `${e.httpMethod} ${p}`, verbatim: true, run: () => generate(p) })),
        }
      : { label: "Generate Request in HTTP Client", icon: "file-http", run: () => generate() },
  ];
}

function controllerItems(sourcePath: string, text: string, c: Controller): MenuItem[] {
  return c.endpoints.length
    ? [
        {
          label: "Generate Requests for Controller",
          icon: "file-http",
          run: () =>
            void generateRequests(
              sourcePath,
              text,
              c.endpoints.map((endpoint) => ({ endpoint })),
            ),
        },
      ]
    : [];
}

/** Editor context menu items for the caret at `offset`: the generate actions (a path choice for several paths). */
export function springMenuItems(sourcePath: string, text: string, offset: number): MenuItem[] {
  const { controller, endpoint } = springAt(springControllers(text), offset);
  const items: MenuItem[] = [];
  if (endpoint)
    items.push(
      endpoint.paths.length > 1
        ? endpointItems(sourcePath, text, endpoint)[0]!
        : { kind: "action", action: GENERATE_REQUEST, icon: "file-http" },
    );
  if (controller?.endpoints.length)
    items.push({ kind: "action", action: GENERATE_CONTROLLER_REQUESTS, icon: "file-http" });
  return items;
}

export function menuGroupItems(ctx: MenuGroupContext): MenuItem[] {
  const path = ctx.paths[0];
  if (!path || ctx.text === undefined || ctx.line === undefined || !/\.(java|kt)$/.test(path)) return [];
  // The actions work at the caret: only the active editor's menu offers them.
  const e = activeEditor();
  if (!e || e.ctx.path !== path || !SPRING_LANGUAGES.has(e.ctx.language)) return [];
  return springMenuItems(path, ctx.text, e.view.state.selection.main.head);
}

/** The generate actions at the caret of the active editor. */
export async function generateAtCaret(scope: "endpoint" | "controller"): Promise<void> {
  const e = activeEditor();
  if (!e || !SPRING_LANGUAGES.has(e.ctx.language)) return;
  const text = e.view.state.doc.toString();
  const { controller, endpoint } = springAt(springControllers(text), e.view.state.selection.main.head);
  const endpoints = scope === "endpoint" ? (endpoint ? [endpoint] : []) : (controller?.endpoints ?? []);
  if (!endpoints.length) {
    notifications().notify({
      level: "info",
      title: scope === "endpoint" ? "No Spring request mapping at the caret" : "No Spring controller at the caret",
      key: "http-generate",
    });
    return;
  }
  await generateRequests(
    e.ctx.path,
    text,
    endpoints.map((x) => ({ endpoint: x })),
  );
}

// --- gutter ----------------------------------------------------------------------

interface Mark {
  pos: number;
  offset: number;
  /** Endpoint key or the controller's name. */
  key: string;
  title: string;
  methodName?: string;
  items: (path: string, text: string) => MenuItem[];
}

const setMarks = StateEffect.define<Mark[]>();

const marksField = StateField.define<Mark[]>({
  create: () => [],
  update(value, tr) {
    for (const e of tr.effects) if (e.is(setMarks)) return e.value;
    if (!tr.docChanged || !value.length) return value;
    return value.flatMap((m) => {
      const offset = tr.changes.mapPos(m.offset, 1, MapMode.TrackDel);
      return offset === null ? [] : [{ ...m, offset, pos: tr.state.doc.lineAt(offset).from }];
    });
  },
});

function computeMarks(state: EditorState): Mark[] {
  const doc = state.doc;
  const marks: Mark[] = [];
  const lineStart = (offset: number) => doc.lineAt(Math.min(offset, doc.length)).from;
  for (const c of springControllers(doc.toString())) {
    if (c.endpoints.length)
      marks.push({
        pos: lineStart(c.offset),
        offset: c.offset,
        key: `class:${c.name}`,
        title: "Generate Requests for Controller",
        items: (path, text) => controllerItems(path, text, c),
      });
    for (const e of c.endpoints)
      marks.push({
        pos: lineStart(e.offset),
        offset: e.offset,
        key: `${e.className}.${e.methodName}: ${e.httpMethod} ${e.paths.join(",")}`,
        title: `${tx("API Call")} · ${e.httpMethod} ${e.paths.join(", ")}`,
        methodName: e.methodName,
        items: (path, text) => endpointItems(path, text, e),
      });
  }
  // One icon per line (the first wins).
  return marks.filter((m, i) => marks.findIndex((x) => x.pos === m.pos) === i);
}

function openApiRequest(view: EditorView, sourcePath: string, mark: Mark, event: MouseEvent) {
  const text = view.state.doc.toString();
  // Source edits may still be inside the detector's debounce window.
  const candidates = springControllers(text)
    .flatMap((controller) => controller.endpoints)
    .filter((endpoint) => view.state.doc.lineAt(endpoint.offset).from === mark.pos);
  const endpoint = candidates.find((entry) => entry.methodName === mark.methodName) ?? candidates[0];
  if (!endpoint) return;
  const at = view.state.doc.lineAt(endpoint.offset);
  const root = useProject.getState().project?.root;
  const open = (url: string) => {
    const arg: ApiEndpointTarget = {
      endpoint: {
        method: endpoint.httpMethod,
        url,
        controller: endpoint.className,
        methodName: endpoint.methodName,
        path: sourcePath,
        rel: root && sourcePath.startsWith(root + "/") ? sourcePath.slice(root.length + 1) : sourcePath,
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

class SpringMarker extends GutterMarker {
  constructor(
    readonly mark: Mark,
    readonly path: string,
  ) {
    super();
  }
  override eq(other: GutterMarker): boolean {
    return (
      other instanceof SpringMarker &&
      other.mark.key === this.mark.key &&
      other.mark.title === this.mark.title &&
      other.mark.offset === this.mark.offset &&
      other.path === this.path
    );
  }
  override toDOM(view: EditorView): Node {
    const el = document.createElement("button");
    el.type = "button";
    el.tabIndex = -1;
    el.className = styles.runMarker ?? "";
    el.title = this.mark.title;
    el.setAttribute("aria-label", this.mark.title);
    el.innerHTML = gutterIconMarkup(this.mark.methodName ? "gutter-api-request" : "file-http") ?? "";
    el.addEventListener("mousedown", (event) => {
      event.preventDefault();
      event.stopPropagation();
    });
    el.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      const mark = view.state
        .field(marksField)
        .find((entry) => entry.key === this.mark.key && entry.pos === this.mark.pos);
      if (!mark) return;
      if (mark.methodName) openApiRequest(view, this.path, mark, event);
      else showContextMenu(event, mark.items(this.path, view.state.doc.toString()));
    });
    el.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      event.stopPropagation();
      const mark = view.state
        .field(marksField)
        .find((entry) => entry.key === this.mark.key && entry.pos === this.mark.pos);
      if (mark) showContextMenu(event, mark.items(this.path, view.state.doc.toString()));
    });
    return el;
  }
}

const DEBOUNCE = 400;

export function springEditorExtension(ctx: EditorDocContext): Extension {
  if (!SPRING_LANGUAGES.has(ctx.language) || ctx.virtual || isVirtualUri(ctx.path)) return [];
  const path = ctx.path;
  const detector = ViewPlugin.fromClass(
    class {
      timer: ReturnType<typeof setTimeout> | undefined;
      constructor(readonly view: EditorView) {
        this.schedule(0);
      }
      update(u: ViewUpdate) {
        if (u.docChanged) this.schedule(DEBOUNCE);
      }
      schedule(delay: number) {
        clearTimeout(this.timer);
        this.timer = setTimeout(() => {
          const found = computeMarks(this.view.state);
          this.view.dispatch({ effects: setMarks.of(found) });
        }, delay);
      }
      destroy() {
        clearTimeout(this.timer);
      }
    },
  );
  const intentions = (view: EditorView): ContributedIntention[] => {
    // Only files that have mappings (the gutter found some) are parsed again here.
    if (!view.state.field(marksField, false)?.length) return [];
    const text = view.state.doc.toString();
    const { controller, endpoint } = springAt(springControllers(text), view.state.selection.main.head);
    const out: ContributedIntention[] = [];
    if (endpoint)
      out.push({
        id: GENERATE_REQUEST,
        label: "Generate Request in HTTP Client",
        icon: "file-http",
        run: () => generateRequests(path, text, [{ endpoint }]),
      });
    if (controller?.endpoints.length)
      out.push({
        id: GENERATE_CONTROLLER_REQUESTS,
        label: "Generate Requests for Controller",
        icon: "file-http",
        run: () =>
          generateRequests(
            path,
            text,
            controller.endpoints.map((e) => ({ endpoint: e })),
          ),
      });
    return out;
  };
  return [
    marksField,
    detector,
    intentionProviders.of(intentions),
    gutter({
      class: `${styles.runGutter} cm-openidea-gutter-spring`,
      markers: (view) =>
        RangeSet.of(
          view.state.field(marksField).map((m) => new SpringMarker(m, path).range(m.pos)),
          true,
        ),
    }),
  ];
}

import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { waitFor } from "@testing-library/react";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { codeLenses } from "@/editor/api";
import { codeLensExtension } from "@/editor/core/cm/codeLens";
import { registerActions } from "@/platform/actions";
import { useProject } from "@/platform/project";
import { showContextMenu, type MenuItem } from "@/ui";
import { apiRequestLenses } from "./editor";
import type { ApiEndpointTarget } from "./model";

vi.mock("@/ui", async (original) => ({
  ...(await original<typeof import("@/ui")>()),
  showContextMenu: vi.fn(),
}));

const SOURCE = `@RestController
@RequestMapping("/api/orders")
class OrderController {
  @GetMapping(
    path = "/{id}"
  )
  public Order find(@PathVariable String id) { return null; }
  @PostMapping
  public Order save(@RequestBody CreateOrder body) { return null; }
  public void helper() {}
}`;
const views: EditorView[] = [];
const opened: ApiEndpointTarget[] = [];
let dispose: () => void;

beforeEach(() => {
  opened.length = 0;
  vi.clearAllMocks();
  useProject.setState({ project: { root: "/project" } as never });
  dispose = registerActions([
    {
      id: "apiClient.openEndpoint",
      title: "API Call",
      run: ({ arg }) => {
        opened.push(arg as ApiEndpointTarget);
      },
    },
  ]);
});
afterEach(() => {
  views.splice(0).forEach((view) => view.destroy());
  dispose();
  useProject.setState({ project: null });
});

function editor(source = SOURCE, language = "java") {
  const view = new EditorView({
    state: EditorState.create({
      doc: source,
      extensions: [
        codeLensExtension,
        apiRequestLenses({
          doc: 1,
          path: `/project/OrderController.${language === "kotlin" ? "kt" : "java"}`,
          language,
          uiMode: null,
          readOnly: false,
        }),
      ],
    }),
    parent: document.body,
  });
  views.push(view);
  return view;
}

it("renders text buttons above mapped Java methods, including multiline annotations, and opens their request", async () => {
  const view = editor();
  await waitFor(() => expect(view.state.facet(codeLenses)).toHaveLength(2));
  const lenses = view.state.facet(codeLenses);
  expect(lenses[0]!.pos).toBe(SOURCE.indexOf("@GetMapping"));
  expect(lenses.map((lens) => lens.title)).toEqual(["API Call", "API Call"]);
  const button = view.dom.querySelector<HTMLButtonElement>(".cm-openidea-lensAction")!;
  button.click();
  await waitFor(() => expect(opened).toHaveLength(1));
  expect(opened[0]).toMatchObject({
    endpoint: {
      method: "GET",
      url: "/api/orders/{id}",
      controller: "OrderController",
      methodName: "find",
      rel: "OrderController.java",
      line: 6,
    },
    source: SOURCE,
  });
});

it("uses fresh unsaved mapping content even when clicked before the edit debounce completes", async () => {
  const view = editor();
  await waitFor(() => expect(view.state.facet(codeLenses)).toHaveLength(2));
  const from = SOURCE.indexOf("/api/orders");
  view.dispatch({ changes: { from, to: from + "/api/orders".length, insert: "/api/current-orders" } });
  view.state.facet(codeLenses)[0]!.run!(view, new MouseEvent("click"));
  await waitFor(() => expect(opened).toHaveLength(1));
  expect(opened[0]!.endpoint.url).toBe("/api/current-orders/{id}");
  expect(opened[0]!.source).toContain('@RequestMapping("/api/current-orders")');
});

it("offers each mapped Kotlin URL before opening the chosen request", async () => {
  const source = `@RestController
@RequestMapping("/api")
class HealthController {
  @GetMapping(value = ["/health", "/ready"])
  fun health(): String = "ok"
}`;
  const view = editor(source, "kotlin");
  await waitFor(() => expect(view.state.facet(codeLenses)).toHaveLength(1));
  view.state.facet(codeLenses)[0]!.run!(view, new MouseEvent("click"));
  expect(opened).toEqual([]);
  const items = vi.mocked(showContextMenu).mock.calls[0]![1] as MenuItem[];
  expect(items.map((item) => "label" in item && item.label)).toEqual(["GET /api/health", "GET /api/ready"]);
  const selected = items[1]!;
  if ("run" in selected) selected.run?.();
  await waitFor(() => expect(opened).toHaveLength(1));
  expect(opened[0]!.endpoint).toMatchObject({ method: "GET", url: "/api/ready", methodName: "health" });
});

it("removes stale hints on source replacement before detecting the new declarations", async () => {
  const view = editor();
  await waitFor(() => expect(view.state.facet(codeLenses)).toHaveLength(2));
  const replacement = SOURCE.replace("OrderController", "NewController");
  view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: replacement } });
  expect(view.state.facet(codeLenses)).toHaveLength(0);
  await waitFor(() => expect(view.state.facet(codeLenses)).toHaveLength(2));
  view.state.facet(codeLenses)[0]!.run!(view, new MouseEvent("click"));
  await waitFor(() => expect(opened).toHaveLength(1));
  expect(opened[0]!.endpoint.controller).toBe("NewController");
});

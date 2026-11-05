import { beforeEach, describe, expect, it, vi } from "vitest";
import type { HttpExchange, HttpHistoryEntry } from "@/bindings";
import { commands } from "@/platform/ipc";
import { registerEndpointProvider } from "@/workbench/contributions";
import { pair } from "./model";
import {
  WORKSPACE_KEY,
  cancelRequest,
  closeTab,
  newRequest,
  openEndpoint,
  openProject,
  refreshEndpoints,
  refreshHistory,
  removeEnvironment,
  restoreHistory,
  saveEnvironment,
  selectTab,
  sendRequest,
  updateDraft,
  useApiClient,
} from "./store";

vi.mock("@/platform/ipc", async (original) => {
  const actual = await original<typeof import("@/platform/ipc")>();
  return {
    ...actual,
    commands: {
      ...actual.commands,
      httpExecuteRaw: vi.fn(),
      httpHistory: vi.fn(),
      httpHistoryGet: vi.fn(),
      cancelRequest: vi.fn(async () => {}),
      fsReadText: vi.fn(),
    },
  };
});

it("prepares controller requests from unsaved source and preserves an existing edited request on reopening", async () => {
  const source = `@RestController
@RequestMapping("/api/unsaved")
class OrderController {
  @PostMapping(produces = "application/json")
  public Order save(@RequestParam(defaultValue = "25") int limit, @RequestBody CreateOrder body) { return null; }
}
class CreateOrder { private String name; private int count; }
`;
  vi.mocked(commands.fsReadText).mockImplementation(async (path) =>
    ok(path.endsWith("application.properties") ? "server.port=9191" : ""),
  );
  const endpoint = {
    method: "POST",
    url: "/api/unsaved",
    controller: "OrderController",
    methodName: "save",
    path: "/project-a/OrderController.java",
    rel: "OrderController.java",
    line: 4,
    col: 15,
  };
  await openEndpoint(endpoint, source);
  const draft = useApiClient.getState().tabs[0]!;
  expect(draft).toMatchObject({ method: "POST", url: "/api/unsaved", baseUrl: "http://localhost:9191" });
  expect(draft.query).toMatchObject([{ key: "limit", value: "25" }]);
  expect(draft.headers).toMatchObject([
    { key: "Accept", value: "application/json" },
    { key: "Content-Type", value: "application/json" },
  ]);
  expect(JSON.parse(draft.body)).toEqual({ name: "", count: 0 });
  expect(commands.httpExecuteRaw).not.toHaveBeenCalled();
  updateDraft(draft.id, { body: '{"name":"keep"}' });
  await openEndpoint(endpoint, source);
  expect(useApiClient.getState().tabs).toHaveLength(1);
  expect(useApiClient.getState().tabs[0]!.body).toBe('{"name":"keep"}');
});
const ok = <T>(data: T) => ({ status: "ok" as const, data });
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function exchange(id: string, url = "https://api.test/orders"): HttpExchange {
  return {
    entry: { id, timeMs: 1, name: id, method: "GET", url, status: 200, totalMs: 10, file: null, error: null },
    request: { name: id, method: "GET", url, headers: [], body: null },
    response: {
      status: 200,
      statusText: "OK",
      version: "HTTP/1.1",
      headers: [],
      contentType: "application/json",
      body: `{"request":"${id}"}`,
      size: 10,
      truncated: false,
      ttfbMs: 1,
      totalMs: 10,
    },
  };
}
beforeEach(() => {
  openProject(null);
  localStorage.clear();
  vi.clearAllMocks();
  openProject("/project-a");
});

describe("API Client request isolation", () => {
  it("keeps each tab's environment when switching tabs or removing another environment", async () => {
    const first = newRequest();
    updateDraft(first, { body: "first draft" });
    saveEnvironment({ id: "dev", name: "Dev", baseUrl: "https://dev.test", headers: [] });
    const second = newRequest();
    saveEnvironment({ id: "test", name: "Test", baseUrl: "https://test.test", headers: [] });
    selectTab(first);
    vi.mocked(commands.httpExecuteRaw).mockResolvedValueOnce(ok(exchange("first")));
    await sendRequest(first);
    expect(commands.httpExecuteRaw).toHaveBeenLastCalledWith(
      expect.any(Number),
      expect.objectContaining({ url: "https://dev.test/" }),
    );
    removeEnvironment("dev");
    expect(useApiClient.getState().tabs.find((draft) => draft.id === first)?.body).toBe("first draft");
    expect(useApiClient.getState().tabs.find((draft) => draft.id === first)?.environmentId).toBeNull();
    expect(useApiClient.getState().tabs.find((draft) => draft.id === second)?.environmentId).toBe("test");
  });
  it("captures the selected environment and attaches a late response only to its original tab", async () => {
    const first = newRequest();
    updateDraft(first, { url: "/orders", headers: [pair("Accept", "application/json")] });
    saveEnvironment({ id: "dev", name: "Dev", baseUrl: "https://dev.test", headers: [] });
    const pending = deferred<ReturnType<typeof ok<HttpExchange>>>();
    vi.mocked(commands.httpExecuteRaw).mockReturnValueOnce(pending.promise);
    const send = sendRequest(first);
    const second = newRequest();
    saveEnvironment({ id: "test", name: "Test", baseUrl: "https://test.test", headers: [] });
    pending.resolve(ok(exchange("first", "https://dev.test/orders")));
    await send;
    expect(commands.httpExecuteRaw).toHaveBeenCalledWith(
      expect.any(Number),
      expect.objectContaining({
        method: "GET",
        url: "https://dev.test/orders",
        headers: [["Accept", "application/json"]],
      }),
    );
    expect(useApiClient.getState().active).toBe(second);
    expect(useApiClient.getState().responses[first]?.entry.id).toBe("first");
    expect(useApiClient.getState().responses[second]).toBeUndefined();
    expect(useApiClient.getState().running).toEqual({});
  });
  it("ignores replies after cancellation, closing a tab, or changing project", async () => {
    for (const action of ["cancel", "close", "project"]) {
      openProject(`/project-${action}`);
      const id = newRequest();
      const pending = deferred<ReturnType<typeof ok<HttpExchange>>>();
      vi.mocked(commands.httpExecuteRaw).mockReturnValueOnce(pending.promise);
      const send = sendRequest(id);
      if (action === "cancel") cancelRequest(id);
      if (action === "close") closeTab(id);
      if (action === "project") openProject("/different-project");
      pending.resolve(ok(exchange("late")));
      await send;
      expect(useApiClient.getState().responses[id]).toBeUndefined();
      expect(useApiClient.getState().running).toEqual({});
    }
    expect(commands.cancelRequest).toHaveBeenCalledTimes(3);
  });
  it("prevents duplicate sends and reports request construction errors without calling the network", async () => {
    const id = newRequest();
    updateDraft(id, { url: "/orders/{id}" });
    await sendRequest(id);
    expect(commands.httpExecuteRaw).not.toHaveBeenCalled();
    expect(useApiClient.getState().errors[id]).toContain("path parameter");
    updateDraft(id, { url: "/orders" });
    const pending = deferred<ReturnType<typeof ok<HttpExchange>>>();
    vi.mocked(commands.httpExecuteRaw).mockReturnValueOnce(pending.promise);
    const sending = sendRequest(id);
    await sendRequest(id);
    expect(commands.httpExecuteRaw).toHaveBeenCalledTimes(1);
    pending.resolve(ok(exchange("first")));
    await sending;
  });
  it("restores history into a new tab without replacing an existing draft", async () => {
    const id = newRequest();
    updateDraft(id, { body: "keep this draft" });
    saveEnvironment({ id: "test", name: "Test", baseUrl: "https://test.test", headers: [] });
    vi.mocked(commands.httpHistoryGet).mockResolvedValue(ok(exchange("saved", "https://original.test/path")));
    await restoreHistory("saved");
    const state = useApiClient.getState();
    expect(state.tabs.find((tab) => tab.id === id)?.body).toBe("keep this draft");
    expect(state.tabs.find((tab) => tab.id === state.active)?.baseUrl).toBe("https://original.test");
    expect(state.selectedEnvironment).toBe("test");
    expect(state.tabs.find((tab) => tab.id === state.active)?.environmentId).toBeNull();
    expect(state.tabs.find((tab) => tab.id === id)?.environmentId).toBe("test");
    expect(state.responses[state.active!]?.entry.id).toBe("saved");
  });
  it("does not erase a newly completed request when an older history snapshot arrives", async () => {
    const pending = deferred<ReturnType<typeof ok<HttpHistoryEntry[]>>>();
    vi.mocked(commands.httpHistory).mockReturnValueOnce(pending.promise);
    const loading = refreshHistory();
    const id = newRequest();
    vi.mocked(commands.httpExecuteRaw).mockResolvedValueOnce(ok(exchange("new")));
    await sendRequest(id);
    pending.resolve(ok([]));
    await loading;
    expect(useApiClient.getState().history.map((entry) => entry.id)).toEqual(["new"]);
    expect(useApiClient.getState().historyLoading).toBe(false);
  });
});

describe("API Client workspace", () => {
  it("preserves drafts and environments independently for each project", () => {
    const id = newRequest();
    updateDraft(id, { body: "project a body" });
    saveEnvironment({ id: "a", name: "A", baseUrl: "https://a.test", headers: [] });
    openProject("/project-b");
    expect(useApiClient.getState().tabs).toEqual([]);
    const other = newRequest();
    updateDraft(other, { body: "project b body" });
    openProject("/project-a");
    expect(useApiClient.getState().tabs[0]?.body).toBe("project a body");
    expect(useApiClient.getState().selectedEnvironment).toBe("a");
    openProject("/project-b");
    expect(useApiClient.getState().tabs[0]?.body).toBe("project b body");
  });
  it("isolates identical root paths on different SSH hosts and locally", async () => {
    const root = "/shared/project";
    openProject(root, "ssh:a:/shared/project");
    const first = newRequest();
    updateDraft(first, { body: "host a draft" });
    saveEnvironment({ id: "a", name: "A", baseUrl: "https://a.test", headers: [pair("Authorization", "secret-a")] });
    const pending = deferred<ReturnType<typeof ok<HttpExchange>>>();
    vi.mocked(commands.httpExecuteRaw).mockReturnValueOnce(pending.promise);
    const sending = sendRequest(first);
    openProject(root, "ssh:b:/shared/project");
    expect(useApiClient.getState().tabs).toEqual([]);
    expect(useApiClient.getState().environments).toEqual([]);
    pending.resolve(ok(exchange("host-a")));
    await sending;
    expect(useApiClient.getState().responses).toEqual({});
    openProject(root, root);
    expect(useApiClient.getState().tabs).toEqual([]);
    openProject(root, "ssh:a:/shared/project");
    expect(useApiClient.getState().tabs[0]?.body).toBe("host a draft");
    expect(useApiClient.getState().environments[0]?.headers[0]?.value).toBe("secret-a");
  });
  it("ignores a route scan that finishes after changing projects", async () => {
    const pending = deferred<[]>();
    const dispose = registerEndpointProvider({ id: "api-client-test", endpoints: () => pending.promise });
    try {
      const scan = refreshEndpoints();
      openProject("/project-b");
      pending.resolve([]);
      await scan;
      expect(useApiClient.getState().root).toBe("/project-b");
      expect(useApiClient.getState().loading).toBe(false);
    } finally {
      dispose();
    }
  });
  it("shows persistence failures and does not claim a failed environment save", () => {
    const storage = vi.spyOn(Storage.prototype, "setItem").mockImplementationOnce(() => {
      throw new Error("storage full");
    });
    expect(() => saveEnvironment({ id: "a", name: "A", baseUrl: "https://a.test", headers: [] })).toThrow(
      "storage full",
    );
    expect(useApiClient.getState().environments).toEqual([]);
    storage.mockRestore();
    expect(localStorage.getItem(WORKSPACE_KEY + "/project-a")).toBeNull();
  });
});

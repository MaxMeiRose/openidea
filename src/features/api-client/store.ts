import { create } from "zustand";
import {
  call,
  commands,
  isCancelled,
  nextRequestId,
  type HttpExchange,
  type HttpHistoryEntry,
  type RequestId,
} from "@/platform/ipc";
import { searchEndpoints, type EndpointEntry } from "@/workbench/contributions";
import { springControllers } from "@/features/http-client/spring/endpoints";
import { clearRouteIndex } from "@/features/http-client/spring/routeIndex";
import { bodyLookup, findHost, skeleton, type SourceReader } from "@/features/http-client/spring/request";
import { parseSource } from "@/features/http-client/spring/source";
import {
  draftFromExchange,
  endpointDraft,
  endpointKey,
  environmentOf,
  newDraft,
  pair,
  pathParameters,
  prepareRequest,
  savedWorkspace,
  type ApiEnvironment,
  type RequestDraft,
  type SavedWorkspace,
} from "./model";

export const API_CLIENT_WINDOW = "apiClient";
export const WORKSPACE_KEY = "openidea.apiClient.workspace:";
const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
interface State extends SavedWorkspace {
  root: string | null;
  location: string | null;
  endpoints: EndpointEntry[];
  loading: boolean;
  indexError: string | null;
  storageError: string | null;
  historyError: string | null;
  history: HttpHistoryEntry[];
  historyLoading: boolean;
  running: Record<string, RequestId>;
  responses: Record<string, HttpExchange>;
  errors: Record<string, string>;
}
const empty = savedWorkspace(null);
export const useApiClient = create<State>(() => ({
  ...empty,
  root: null,
  location: null,
  endpoints: [],
  loading: false,
  indexError: null,
  storageError: null,
  historyError: null,
  history: [],
  historyLoading: false,
  running: {},
  responses: {},
  errors: {},
}));
let indexGeneration = 0;
let workspaceGeneration = 0;
let historyGeneration = 0;

function persist() {
  const { location, environments, selectedEnvironment, tabs, active } = useApiClient.getState();
  if (!location) return;
  try {
    localStorage.setItem(
      WORKSPACE_KEY + location,
      JSON.stringify({ environments, selectedEnvironment, tabs, active } satisfies SavedWorkspace),
    );
    useApiClient.setState({ storageError: null });
  } catch (error) {
    useApiClient.setState({ storageError: message(error) });
  }
}

export function openProject(root: string | null, location: string | null = root) {
  if (useApiClient.getState().root === root && useApiClient.getState().location === location) return;
  for (const request of Object.values(useApiClient.getState().running))
    void commands.cancelRequest(request).catch(() => {});
  workspaceGeneration++;
  indexGeneration++;
  historyGeneration++;
  let saved = empty;
  let storageError: string | null = null;
  try {
    saved = savedWorkspace(location ? localStorage.getItem(WORKSPACE_KEY + location) : null);
  } catch (error) {
    storageError = message(error);
  }
  useApiClient.setState({
    ...saved,
    root,
    location,
    endpoints: [],
    loading: false,
    indexError: null,
    storageError,
    historyError: null,
    history: [],
    historyLoading: false,
    running: {},
    responses: {},
    errors: {},
  });
}

export async function refreshEndpoints() {
  const { root } = useApiClient.getState();
  if (!root) return;
  const generation = ++indexGeneration;
  useApiClient.setState({ loading: true, indexError: null });
  clearRouteIndex();
  try {
    const endpoints = await searchEndpoints(root);
    if (generation !== indexGeneration || useApiClient.getState().root !== root) return;
    useApiClient.setState({
      endpoints: endpoints.sort(
        (a, b) =>
          a.controller.localeCompare(b.controller) || a.url.localeCompare(b.url) || a.method.localeCompare(b.method),
      ),
    });
  } catch (error) {
    if (generation === indexGeneration) useApiClient.setState({ indexError: message(error) });
  } finally {
    if (generation === indexGeneration) useApiClient.setState({ loading: false });
  }
}

function addTab(draft: RequestDraft, response?: HttpExchange) {
  useApiClient.setState((state) => ({
    tabs: [
      ...state.tabs,
      { ...draft, environmentId: draft.environmentId === undefined ? state.selectedEnvironment : draft.environmentId },
    ],
    active: draft.id,
    ...(response ? { responses: { ...state.responses, [draft.id]: response } } : {}),
  }));
  persist();
}
export function newRequest() {
  const draft = newDraft();
  addTab(draft);
  return draft.id;
}
export function selectTab(active: string) {
  if (useApiClient.getState().tabs.some((draft) => draft.id === active)) {
    useApiClient.setState({ active });
    persist();
  }
}
export function updateDraft(id: string, patch: Partial<RequestDraft>) {
  useApiClient.setState((state) => ({
    tabs: state.tabs.map((draft) =>
      draft.id === id
        ? { ...draft, ...patch, ...(patch.url !== undefined ? { path: pathParameters(patch.url, draft.path) } : {}) }
        : draft,
    ),
  }));
  persist();
}
export function closeTab(id: string) {
  cancelRequest(id);
  useApiClient.setState((state) => {
    const at = state.tabs.findIndex((draft) => draft.id === id);
    const tabs = state.tabs.filter((draft) => draft.id !== id);
    const responses = { ...state.responses };
    delete responses[id];
    const errors = { ...state.errors };
    delete errors[id];
    return {
      tabs,
      responses,
      errors,
      active: state.active === id ? (tabs[Math.min(at, tabs.length - 1)]?.id ?? null) : state.active,
    };
  });
  persist();
}

const reader: SourceReader = {
  read: async (path) => {
    try {
      return await call(commands.fsReadText(path));
    } catch {
      return null;
    }
  },
};
export async function openEndpoint(endpoint: EndpointEntry) {
  const state = useApiClient.getState();
  const existing = state.tabs.find((draft) => draft.endpointKey === endpointKey(endpoint));
  if (existing) {
    selectTab(existing.id);
    return;
  }
  const draft = endpointDraft(endpoint);
  addTab(draft);
  const generation = workspaceGeneration;
  try {
    const [source, host] = await Promise.all([reader.read(endpoint.path), findHost(endpoint.path, state.root, reader)]);
    const mapping = source
      ? springControllers(source)
          .flatMap((controller) => controller.endpoints)
          .find(
            (item) =>
              item.methodName === endpoint.methodName &&
              item.paths.includes(endpoint.url) &&
              (item.httpMethod === endpoint.method || item.httpMethod === "ANY"),
          )
      : null;
    const lookup = source && mapping ? await bodyLookup(endpoint.path, parseSource(source), [mapping], reader) : null;
    const current = useApiClient.getState().tabs.find((tab) => tab.id === draft.id);
    if (
      generation !== workspaceGeneration ||
      !current ||
      (["name", "method", "url", "baseUrl", "path", "query", "headers", "body"] as const).some(
        (key) => current[key] !== draft[key],
      )
    )
      return;
    const headers = mapping
      ? [
          ...mapping.headers.map((header) => pair(header.name, header.value)),
          ...(mapping.produces ? [pair("Accept", mapping.produces)] : []),
          ...(mapping.consumes || mapping.bodyType
            ? [pair("Content-Type", mapping.consumes ?? "application/json")]
            : []),
        ]
      : [];
    updateDraft(draft.id, {
      baseUrl: host,
      query: mapping?.query.map((query) => pair(query.name, query.value ?? "")) ?? [],
      headers,
      body: mapping?.bodyType && lookup ? JSON.stringify(skeleton(mapping.bodyType, lookup), null, 2) : "",
    });
  } catch (error) {
    if (generation === workspaceGeneration)
      useApiClient.setState((s) => ({ errors: { ...s.errors, [draft.id]: message(error) } }));
  }
}

export function saveEnvironment(environment: ApiEnvironment) {
  const next = environmentOf(environment);
  const state = useApiClient.getState();
  const environments = state.environments.some((env) => env.id === next.id)
    ? state.environments.map((env) => (env.id === next.id ? next : env))
    : [...state.environments, next];
  const tabs = state.tabs.map((draft) => (draft.id === state.active ? { ...draft, environmentId: next.id } : draft));
  // Configuration saves fail visibly rather than pretending an unsaved environment survived a restart.
  if (state.location)
    localStorage.setItem(
      WORKSPACE_KEY + state.location,
      JSON.stringify({
        environments,
        selectedEnvironment: next.id,
        tabs,
        active: state.active,
      } satisfies SavedWorkspace),
    );
  useApiClient.setState({ environments, selectedEnvironment: next.id, tabs, storageError: null });
}
export function selectEnvironment(selectedEnvironment: string | null) {
  useApiClient.setState((state) => ({
    selectedEnvironment,
    tabs: state.tabs.map((draft) =>
      draft.id === state.active ? { ...draft, environmentId: selectedEnvironment } : draft,
    ),
  }));
  persist();
}
export function removeEnvironment(id: string) {
  const state = useApiClient.getState();
  const environments = state.environments.filter((env) => env.id !== id);
  const selectedEnvironment = state.selectedEnvironment === id ? null : state.selectedEnvironment;
  const tabs = state.tabs.map((draft) => (draft.environmentId === id ? { ...draft, environmentId: null } : draft));
  if (state.location)
    localStorage.setItem(
      WORKSPACE_KEY + state.location,
      JSON.stringify({
        environments,
        selectedEnvironment,
        tabs,
        active: state.active,
      } satisfies SavedWorkspace),
    );
  useApiClient.setState({ environments, selectedEnvironment, tabs });
}

export async function sendRequest(id: string) {
  const state = useApiClient.getState();
  const draft = state.tabs.find((tab) => tab.id === id);
  if (!draft || state.running[id] !== undefined || !state.root) return;
  let prepared;
  try {
    prepared = prepareRequest(
      draft,
      state.environments.find(
        (env) => env.id === (draft.environmentId === undefined ? state.selectedEnvironment : draft.environmentId),
      ),
    );
  } catch (error) {
    useApiClient.setState((s) => ({ errors: { ...s.errors, [id]: message(error) } }));
    return;
  }
  const request = nextRequestId();
  const generation = workspaceGeneration;
  useApiClient.setState((s) => ({ running: { ...s.running, [id]: request }, errors: { ...s.errors, [id]: "" } }));
  try {
    const exchange = await call(commands.httpExecuteRaw(request, prepared));
    if (generation !== workspaceGeneration || useApiClient.getState().running[id] !== request) return;
    historyGeneration++;
    useApiClient.setState((s) => ({
      responses: { ...s.responses, [id]: exchange },
      history: [exchange.entry, ...s.history.filter((entry) => entry.id !== exchange.entry.id)],
      historyLoading: false,
    }));
  } catch (error) {
    if (generation === workspaceGeneration && useApiClient.getState().running[id] === request && !isCancelled(error))
      useApiClient.setState((s) => ({ errors: { ...s.errors, [id]: message(error) } }));
  } finally {
    if (generation === workspaceGeneration && useApiClient.getState().running[id] === request)
      useApiClient.setState((s) => {
        const running = { ...s.running };
        delete running[id];
        return { running };
      });
  }
}
export function cancelRequest(id: string) {
  const request = useApiClient.getState().running[id];
  if (request === undefined) return;
  void commands.cancelRequest(request).catch(() => {});
  useApiClient.setState((s) => {
    const running = { ...s.running };
    delete running[id];
    return { running };
  });
}

export async function refreshHistory() {
  const generation = ++historyGeneration;
  const workspace = workspaceGeneration;
  useApiClient.setState({ historyLoading: true, historyError: null });
  try {
    const history = await call(commands.httpHistory());
    if (workspace === workspaceGeneration && generation === historyGeneration) useApiClient.setState({ history });
  } catch (error) {
    if (workspace === workspaceGeneration && generation === historyGeneration)
      useApiClient.setState({ historyError: message(error) });
  } finally {
    if (workspace === workspaceGeneration && generation === historyGeneration)
      useApiClient.setState({ historyLoading: false });
  }
}
export async function restoreHistory(id: string) {
  const generation = workspaceGeneration;
  try {
    const exchange = await call(commands.httpHistoryGet(id));
    if (generation !== workspaceGeneration) return;
    addTab(draftFromExchange(exchange), exchange);
    // Its explicit null environment preserves the original address without retargeting other tabs.
  } catch (error) {
    if (generation === workspaceGeneration) useApiClient.setState({ historyError: message(error) });
  }
}

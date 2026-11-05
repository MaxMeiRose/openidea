import { create } from "zustand";
import { call, commands, isCancelled, nextRequestId, type EurekaService, type EurekaStatus } from "@/platform/ipc";
import { tx } from "@/platform/i18n";
import { instanceKey, readSettings, serverAddress, type EurekaEnvironment, type EurekaSettings } from "./model";

export const ENVIRONMENTS_KEY = "openidea.eureka.environments";
export const EUREKA_WINDOW = "eureka";
const SYNC_DELAY = 2500;
const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

function initialSettings(): EurekaSettings & { settingsError: string | null } {
  try {
    return { ...readSettings(localStorage.getItem(ENVIRONMENTS_KEY)), settingsError: null };
  } catch (error) {
    return { environments: [], selected: null, settingsError: message(error) };
  }
}

interface EurekaState extends EurekaSettings {
  services: EurekaService[];
  refreshing: boolean;
  loaded: boolean;
  lastUpdated: number | null;
  error: string | null;
  settingsError: string | null;
  notice: { kind: "success" | "warning"; text: string } | null;
  pending: Set<string>;
}

export const useEureka = create<EurekaState>(() => ({
  ...initialSettings(),
  services: [],
  refreshing: false,
  loaded: false,
  lastUpdated: null,
  error: null,
  notice: null,
  pending: new Set(),
}));

let generation = 0;
let activeRequest: number | null = null;
let inFlight: { environment: EurekaEnvironment; result: Promise<EurekaService[] | null> } | null = null;

export function cancelRefresh() {
  generation++;
  if (activeRequest !== null) void commands.cancelRequest(activeRequest).catch(() => {});
  activeRequest = null;
  inFlight = null;
  useEureka.setState({ refreshing: false });
}

const selectedEnvironment = () => {
  const state = useEureka.getState();
  return state.environments.find((e) => e.id === state.selected);
};
const isCurrent = (env: EurekaEnvironment) => {
  const current = selectedEnvironment();
  return current?.id === env.id && current.url === env.url;
};

function applySettings(settings: EurekaSettings) {
  const previous = selectedEnvironment();
  const current = settings.environments.find((e) => e.id === settings.selected);
  const changed = previous?.id !== current?.id || previous?.url !== current?.url;
  if (changed) cancelRefresh();
  useEureka.setState({
    ...settings,
    settingsError: null,
    ...(changed ? { services: [], loaded: false, lastUpdated: null, error: null, notice: null } : {}),
  });
}

function persist(settings: EurekaSettings) {
  // Save before updating the view: a storage failure must not look like a successful save.
  localStorage.setItem(ENVIRONMENTS_KEY, JSON.stringify(settings));
  applySettings(settings);
}

export function saveEnvironment(env: EurekaEnvironment) {
  const name = env.name.trim();
  if (!name) throw new Error("Enter an environment name");
  const next = { ...env, name, url: serverAddress(env.url) };
  const state = useEureka.getState();
  const environments = state.environments.some((e) => e.id === next.id)
    ? state.environments.map((e) => (e.id === next.id ? next : e))
    : [...state.environments, next];
  persist({ environments, selected: next.id });
}

export function removeEnvironment(id: string) {
  const state = useEureka.getState();
  const environments = state.environments.filter((e) => e.id !== id);
  persist({ environments, selected: state.selected === id ? (environments[0]?.id ?? null) : state.selected });
}

export function selectEnvironment(id: string) {
  const { environments } = useEureka.getState();
  if (environments.some((e) => e.id === id)) persist({ environments, selected: id });
}

export function watchEnvironments(): () => void {
  const change = (event: StorageEvent) => {
    if (event.key !== ENVIRONMENTS_KEY) return;
    try {
      const settings = readSettings(event.newValue);
      // Share configuration edits across windows; keep each window's current environment if it still exists.
      const current = useEureka.getState().selected;
      if (settings.environments.some((e) => e.id === current)) settings.selected = current;
      applySettings(settings);
    } catch (error) {
      useEureka.setState({ settingsError: message(error) });
    }
  };
  window.addEventListener("storage", change);
  return () => window.removeEventListener("storage", change);
}

export function refreshEureka(options: { reusePending?: boolean } = {}): Promise<EurekaService[] | null> {
  const env = selectedEnvironment();
  if (env && options.reusePending && inFlight?.environment.id === env.id && inFlight.environment.url === env.url) {
    return inFlight.result;
  }
  cancelRefresh();
  if (!env) return Promise.resolve(null);
  const version = generation;
  const request = nextRequestId();
  activeRequest = request;
  useEureka.setState({ refreshing: true, error: null });
  const result = (async () => {
    try {
      const services = await call(commands.eurekaServices(request, env.url));
      if (generation !== version || !isCurrent(env)) return null;
      useEureka.setState({ services, loaded: true, lastUpdated: Date.now() });
      return services;
    } catch (error) {
      if (generation === version && isCurrent(env) && !isCancelled(error))
        useEureka.setState({ error: message(error) });
      return null;
    } finally {
      if (generation === version) {
        activeRequest = null;
        inFlight = null;
        useEureka.setState({ refreshing: false });
      }
    }
  })();
  inFlight = { environment: env, result };
  return result;
}

/** A status change always targets the environment captured by the clicked row. */
export async function updateInstance(env: EurekaEnvironment, service: string, instance: string, status: EurekaStatus) {
  const key = instanceKey(env, service, instance);
  if (!isCurrent(env) || useEureka.getState().pending.has(key)) return;
  useEureka.setState((s) => ({ pending: new Set(s.pending).add(key), error: null, notice: null }));
  try {
    await call(commands.eurekaSetStatus(nextRequestId(), env.url, service, instance, status));
    for (let attempt = 0; attempt < 3; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, SYNC_DELAY));
      if (!isCurrent(env)) return;
      const services = await refreshEureka({ reusePending: true });
      if (!isCurrent(env)) return;
      const current = services?.find((s) => s.name === service)?.instance.find((i) => i.instanceId === instance);
      if (current?.status === status) {
        useEureka.setState({ notice: { kind: "success", text: tx`Updated ${instance} to ${status}` } });
        return;
      }
      if (useEureka.getState().error) return;
    }
    if (isCurrent(env)) {
      useEureka.setState({
        notice: {
          kind: "warning",
          text: tx`The update to ${status} was sent for ${instance}. The registry has not confirmed it yet; refresh to check.`,
        },
      });
    }
  } catch (error) {
    if (isCurrent(env)) useEureka.setState({ error: `${service} / ${instance}: ${message(error)}` });
  } finally {
    useEureka.setState((s) => {
      const pending = new Set(s.pending);
      pending.delete(key);
      return { pending };
    });
  }
}

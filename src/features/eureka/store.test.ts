import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { commands } from "@/platform/ipc";
import {
  cancelRefresh,
  ENVIRONMENTS_KEY,
  refreshEureka,
  removeEnvironment,
  saveEnvironment,
  selectEnvironment,
  updateInstance,
  useEureka,
  watchEnvironments,
} from "./store";
import { readSettings, type EurekaEnvironment } from "./model";

vi.mock("@/platform/ipc", async (original) => {
  const actual = await original<typeof import("@/platform/ipc")>();
  return {
    ...actual,
    commands: {
      ...actual.commands,
      cancelRequest: vi.fn(async () => {}),
      eurekaServices: vi.fn(),
      eurekaSetStatus: vi.fn(),
    },
  };
});

const dev: EurekaEnvironment = { id: "dev", name: "Development", url: "http://localhost:32044" };
const test: EurekaEnvironment = { id: "test", name: "Test", url: "http://localhost:32045" };
const list = (status = "UP") => [{ name: "APP", instance: [{ instanceId: "host:app:8080", status }] }];
const ok = <T>(data: T) => ({ status: "ok" as const, data });
const fail = () => ({
  status: "error" as const,
  error: { kind: "io" as const, message: "Connection refused", data: null },
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

beforeEach(() => {
  cancelRefresh();
  vi.clearAllMocks();
  localStorage.clear();
  useEureka.setState({
    environments: [dev, test],
    selected: dev.id,
    services: [],
    loaded: false,
    refreshing: false,
    lastUpdated: null,
    error: null,
    settingsError: null,
    notice: null,
    pending: new Set(),
  });
  vi.mocked(commands.eurekaServices).mockResolvedValue(ok(list()));
  vi.mocked(commands.eurekaSetStatus).mockResolvedValue(ok(null));
});
afterEach(() => {
  cancelRefresh();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("Eureka configuration", () => {
  it("saves addresses and restores the selected environment after removing another one", () => {
    saveEnvironment({ id: "extra", name: " Extra ", url: "localhost:8761/" });
    expect(readSettings(localStorage.getItem(ENVIRONMENTS_KEY))).toMatchObject({
      selected: "extra",
      environments: [dev, test, { id: "extra", name: "Extra", url: "http://localhost:8761" }],
    });
    removeEnvironment("extra");
    expect(useEureka.getState().selected).toBe("dev");
  });
  it("reports persistence failure without pretending the environment was saved", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("Storage full");
    });
    expect(() => saveEnvironment({ ...dev, name: "Changed" })).toThrow("Storage full");
    expect(useEureka.getState().environments[0]).toEqual(dev);
  });
  it("shares edits across windows without switching a still-valid selected environment", () => {
    const dispose = watchEnvironments();
    selectEnvironment(test.id);
    window.dispatchEvent(
      new StorageEvent("storage", {
        key: ENVIRONMENTS_KEY,
        newValue: JSON.stringify({ environments: [{ ...dev, name: "Changed" }, test], selected: dev.id }),
      }),
    );
    expect(useEureka.getState().selected).toBe(test.id);
    expect(useEureka.getState().environments[0]!.name).toBe("Changed");
    dispose();
  });
});

describe("Eureka requests", () => {
  it("ignores an old environment response after switching environments", async () => {
    const first = deferred<ReturnType<typeof ok<ReturnType<typeof list>>>>();
    vi.mocked(commands.eurekaServices).mockReturnValueOnce(first.promise);
    const loading = refreshEureka();
    selectEnvironment(test.id);
    await refreshEureka();
    first.resolve(ok([{ name: "OLD", instance: [] }]));
    await loading;
    expect(useEureka.getState().services).toEqual(list());
    expect(commands.cancelRequest).toHaveBeenCalled();
    expect(commands.eurekaServices).toHaveBeenLastCalledWith(expect.any(Number), test.url);
  });
  it("clears the loading state and shows connection failures", async () => {
    vi.mocked(commands.eurekaServices).mockResolvedValue(fail());
    await refreshEureka();
    expect(useEureka.getState()).toMatchObject({ refreshing: false, loaded: false, error: "Connection refused" });
  });
  it("locks duplicate updates and only shows the new status after the server confirms it", async () => {
    vi.useFakeTimers();
    useEureka.setState({ services: list(), loaded: true });
    vi.mocked(commands.eurekaServices).mockResolvedValue(ok(list("DOWN")));
    const update = updateInstance(dev, "APP", "host:app:8080", "DOWN");
    await updateInstance(dev, "APP", "host:app:8080", "DOWN");
    expect(commands.eurekaSetStatus).toHaveBeenCalledTimes(1);
    expect(useEureka.getState().services[0]!.instance[0]!.status).toBe("UP");
    await vi.advanceTimersByTimeAsync(2500);
    await update;
    expect(useEureka.getState()).toMatchObject({ services: list("DOWN"), notice: { kind: "success" } });
    expect(useEureka.getState().pending.size).toBe(0);
  });
  it("keeps an in-flight write pinned to its original URL and does not refresh another environment", async () => {
    vi.useFakeTimers();
    const write = deferred<ReturnType<typeof ok<null>>>();
    vi.mocked(commands.eurekaSetStatus).mockReturnValue(write.promise);
    const update = updateInstance(dev, "APP", "host:app:8080", "DOWN");
    selectEnvironment(test.id);
    write.resolve(ok(null));
    await vi.advanceTimersByTimeAsync(2500);
    await update;
    expect(commands.eurekaSetStatus).toHaveBeenCalledWith(expect.any(Number), dev.url, "APP", "host:app:8080", "DOWN");
    expect(commands.eurekaServices).not.toHaveBeenCalled();
    expect(useEureka.getState().notice).toBeNull();
    expect(useEureka.getState().pending.size).toBe(0);
  });
  it("warns when the registry has not synchronized and keeps its actual status", async () => {
    vi.useFakeTimers();
    useEureka.setState({ services: list(), loaded: true });
    const update = updateInstance(dev, "APP", "host:app:8080", "DOWN");
    await vi.advanceTimersByTimeAsync(7500);
    await update;
    expect(commands.eurekaServices).toHaveBeenCalledTimes(3);
    expect(useEureka.getState()).toMatchObject({ services: list(), notice: { kind: "warning" } });
    expect(useEureka.getState().pending.size).toBe(0);
  });
  it("unlocks failed writes so they can be retried", async () => {
    vi.mocked(commands.eurekaSetStatus).mockResolvedValue(fail());
    await updateInstance(dev, "APP", "host:app:8080", "DOWN");
    expect(useEureka.getState().error).toContain("Connection refused");
    expect(useEureka.getState().pending.size).toBe(0);
  });

  it("shares confirmation reads across concurrent instance updates", async () => {
    vi.useFakeTimers();
    const read = deferred<ReturnType<typeof ok<ReturnType<typeof list>>>>();
    vi.mocked(commands.eurekaServices).mockReturnValue(read.promise);
    const one = updateInstance(dev, "APP", "host:app:8080", "DOWN");
    const two = updateInstance(dev, "APP", "second:app:8080", "DOWN");
    await vi.advanceTimersByTimeAsync(2500);
    expect(commands.eurekaServices).toHaveBeenCalledTimes(1);
    read.resolve(
      ok([
        {
          name: "APP",
          instance: [
            { instanceId: "host:app:8080", status: "DOWN" },
            { instanceId: "second:app:8080", status: "DOWN" },
          ],
        },
      ]),
    );
    await Promise.all([one, two]);
    expect(useEureka.getState().pending.size).toBe(0);
    expect(useEureka.getState().notice?.kind).toBe("success");
  });
});

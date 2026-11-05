import { describe, expect, it } from "vitest";
import { filterServices, readSettings, serverAddress } from "./model";

describe("Eureka environments", () => {
  it("accepts configurable IPs, hostnames, ports, HTTPS and gateway prefixes", () => {
    expect(serverAddress(" 127.0.0.1:32044/ ")).toBe("http://127.0.0.1:32044");
    expect(serverAddress("https://dev.internal:8443/gateway/")).toBe("https://dev.internal:8443/gateway");
    expect(serverAddress("http://[::1]:8761")).toBe("http://[::1]:8761");
  });
  it.each([
    "",
    "file:///tmp/settings",
    "http://user:secret@host",
    "http://host/?key=value",
    "http://host/#fragment",
    "http://host/?",
    "http://host/#",
    "http://host:99999",
  ])("rejects invalid server address %s", (address) => {
    expect(() => serverAddress(address)).toThrow();
  });
  it("restores the selected environment and falls back after deletion", () => {
    const environments = [
      { id: "dev", name: "Development", url: "127.0.0.1:32044" },
      { id: "test", name: "Test", url: "https://test.internal" },
    ];
    expect(readSettings(JSON.stringify({ environments, selected: "test" })).selected).toBe("test");
    expect(readSettings(JSON.stringify({ environments, selected: "deleted" })).selected).toBe("dev");
    expect(readSettings(null)).toEqual({ environments: [], selected: null });
  });
  it("does not silently overwrite malformed or duplicate saved environments", () => {
    const env = { id: "dev", name: "Development", url: "http://localhost" };
    for (const saved of [
      "invalid",
      "null",
      "{}",
      JSON.stringify({ environments: [env, env] }),
      JSON.stringify({ environments: [null] }),
    ]) {
      expect(() => readSettings(saved)).toThrow();
    }
  });
});

it("searches service and instance names together and filters their actual status", () => {
  const services = [
    {
      name: "ORDERS",
      instance: [
        { instanceId: "host-a:orders:8080", status: "UP" },
        { instanceId: "host-b:orders:8081", status: "DOWN" },
      ],
    },
    { name: "PAYMENTS", instance: [{ instanceId: "host-c:payments:8082", status: "OUT_OF_SERVICE" }] },
  ];
  expect(filterServices(services, "orders HOST-b", "all")).toEqual([
    { name: "ORDERS", instance: [services[0]!.instance[1]!] },
  ]);
  expect(filterServices(services, "", "UP")[0]!.instance).toHaveLength(1);
  expect(filterServices(services, "", "other")[0]!.name).toBe("PAYMENTS");
  expect(filterServices(services, "host-c", "UP")).toEqual([]);
});

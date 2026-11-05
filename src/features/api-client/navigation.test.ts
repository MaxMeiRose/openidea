import { describe, expect, it } from "vitest";
import type { EndpointEntry } from "@/workbench/contributions";
import { apiNodeKey, branchKeys, endpointGroups, endpointTitle } from "./navigation";

const entry = (module: string, extra: Partial<EndpointEntry> = {}): EndpointEntry => ({
  method: "GET",
  url: "/api/orders/{id}",
  controller: "OrderController",
  methodName: "getOrder",
  path: `/work/${module}/src/main/java/OrderController.java`,
  rel: `${module}/src/main/java/OrderController.java`,
  line: 8,
  col: 12,
  ...extra,
});
describe("API browser groups", () => {
  it("keeps controllers with the same name in separate modules and counts filtered endpoints", () => {
    const first = entry("orders"),
      second = entry("admin");
    const groups = endpointGroups([first, second], "", "work");
    expect(groups.map((node) => node.label)).toEqual(["orders", "admin"]);
    expect(branchKeys(groups)).toHaveLength(4);
    const filtered = endpointGroups([first, second], "admin GET", "work");
    expect(filtered).toMatchObject([{ label: "admin", count: 1, children: [{ label: "OrderController", count: 1 }] }]);
  });
  it("searches API summaries, controller documentation, paths and method names", () => {
    const api = entry("orders", { summary: "查询订单", controllerSummary: "订单管理" });
    for (const query of ["查询", "订单管理", "/api/orders", "getOrder", "GET 查询"]) {
      expect(endpointGroups([api], query, "work")).toHaveLength(1);
    }
    expect(endpointGroups([api], "DELETE 查询", "work")).toEqual([]);
    expect(endpointTitle(api, "summary")).toBe("查询订单");
    expect(endpointTitle(api, "path")).toBe("/api/orders/{id}");
    expect(endpointTitle(entry("orders"), "summary")).toBe("getOrder");
    expect(apiNodeKey(api)).toBe(apiNodeKey({ ...api, summary: "Updated documentation" }));
  });
});

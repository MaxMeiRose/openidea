import { describe, expect, it } from "vitest";
import type { HttpExchange } from "@/bindings";
import {
  baseAddress,
  draftFromExchange,
  effectiveHeaders,
  endpointDraft,
  environmentOf,
  headersFromText,
  newDraft,
  pair,
  pathParameters,
  prepareRequest,
  savedWorkspace,
  type ApiEnvironment,
} from "./model";

const environment = (baseUrl = "https://test.example/gateway"): ApiEnvironment => ({
  id: "test",
  name: "Test",
  baseUrl,
  headers: [pair("Authorization", "Bearer test")],
});
describe("API request construction", () => {
  it("retargets the same relative endpoint between environments and preserves gateway prefixes", () => {
    const draft = {
      ...newDraft(),
      url: "/orders/{id}",
      path: [pair("id", "a/b & c")],
      query: [pair("q", "a&b"), pair("tag", "one"), pair("tag", "two")],
    };
    expect(prepareRequest(draft, environment()).url).toBe(
      "https://test.example/gateway/orders/a%2Fb%20%26%20c?q=a%26b&tag=one&tag=two",
    );
    expect(prepareRequest(draft, environment("http://dev.example:8080")).url).toContain(
      "http://dev.example:8080/orders/",
    );
    expect(draft.url).toBe("/orders/{id}");
  });
  it("allows an exact absolute address without a configured environment", () => {
    const draft = { ...newDraft(), url: "https://example.test/request?existing=1", query: [pair("extra", "2")] };
    expect(prepareRequest(draft, undefined).url).toBe("https://example.test/request?existing=1&extra=2");
    expect(prepareRequest(draft, environment()).url).toBe("https://test.example/gateway/request?existing=1&extra=2");
  });
  it("requires path values and keeps existing values when a URL is edited", () => {
    const previous = [pair("id", "123"), pair("old", "discard")];
    expect(pathParameters("/orders/{id}/{page}", previous).map((row) => [row.key, row.value])).toEqual([
      ["id", "123"],
      ["page", ""],
    ]);
    expect(() => prepareRequest({ ...newDraft(), url: "/{id}" }, undefined)).toThrow("path parameter");
  });
  it("recognizes Spring path regex quantifiers and replaces the entire mapping token", () => {
    const url = "/orders/{id:[0-9]{2}}/{name:[^{}]+}";
    const path = pathParameters(url);
    expect(path.map((row) => row.key)).toEqual(["id", "name"]);
    path[0]!.value = "42";
    path[1]!.value = "a/b";
    expect(prepareRequest({ ...newDraft(), url, path }, undefined).url).toBe("http://localhost:8080/orders/42/a%2Fb");
  });
  it("merges request headers without duplicating environment headers or re-enabling disabled overrides", () => {
    const headers = effectiveHeaders(
      [pair("authorization", "Bearer custom"), { ...pair("Accept"), enabled: false }],
      [pair("Authorization", "Bearer env"), pair("Accept", "application/json"), pair("X-Env", "test")],
    );
    expect(headers.map((row) => [row.key, row.value])).toEqual([
      ["X-Env", "test"],
      ["authorization", "Bearer custom"],
    ]);
  });
  it("retains method, headers and body as a typed request", () => {
    const draft = {
      ...newDraft(),
      method: "POST",
      url: "/orders",
      headers: [pair("Content-Type", "application/json")],
      body: '{"name":"test"}',
    };
    const built = prepareRequest(draft, environment());
    expect(built.method).toBe("POST");
    expect(built.url).toBe("https://test.example/gateway/orders");
    expect(built.headers).toEqual([
      ["Authorization", "Bearer test"],
      ["Content-Type", "application/json"],
    ]);
    expect(built.body).toBe(draft.body);
  });
  it("rejects protocol and header injection instead of constructing a different request", () => {
    expect(() => prepareRequest({ ...newDraft(), url: "file:///tmp/config" }, undefined)).toThrow("HTTP and HTTPS");
    expect(() => prepareRequest({ ...newDraft(), url: "http://" }, environment())).toThrow("valid HTTP request URL");
    expect(() => prepareRequest({ ...newDraft(), headers: [pair("X-Key", "safe\nX-Other: bad")] }, undefined)).toThrow(
      "Header names",
    );
  });
  it("passes body text literally without .http include, script, separator or variable interpretation", () => {
    const body = "\n< /tmp/secret\n> discarded?\n>> script\n<> marker\n###another\n{{token}}\n  \n";
    expect(prepareRequest({ ...newDraft(), method: "POST", body }, undefined).body).toBe(body);
  });
  it("creates source-backed drafts without embedding the host into the endpoint path", () => {
    const endpoint = {
      method: "POST",
      url: "/api/{id}",
      controller: "Controller",
      methodName: "save",
      path: "/src/Controller.java",
      rel: "Controller.java",
      line: 3,
      col: 4,
    };
    const draft = endpointDraft(endpoint);
    expect(draft.url).toBe("/api/{id}");
    expect(draft.source).toEqual(endpoint);
    expect(draft.path.map((row) => row.key)).toEqual(["id"]);
  });
});

describe("API environments and history", () => {
  it("validates names, hosts, prefixes and multiline default headers", () => {
    expect(baseAddress(" localhost:8080/api/ ")).toBe("http://localhost:8080/api");
    expect(headersFromText("Authorization: Bearer abc:def\nAccept: application/json").map((row) => row.value)).toEqual([
      "Bearer abc:def",
      "application/json",
    ]);
    expect(() => environmentOf({ ...environment(), name: " " })).toThrow("environment name");
    expect(() => baseAddress("https://user:password@example.test")).toThrow("credentials");
    expect(() => headersFromText("Bad header without a colon")).toThrow("one header per line");
  });
  it("restores request parameters, body and original server from a history exchange", () => {
    const exchange = {
      request: {
        name: "Saved",
        method: "PATCH",
        url: "https://api.test:8443/orders?a=1&a=2",
        headers: [["Content-Type", "application/json"]],
        body: '{"state":"ok"}',
      },
    } as HttpExchange;
    const draft = draftFromExchange(exchange);
    expect(draft.baseUrl).toBe("https://api.test:8443");
    expect(draft.url).toBe("/orders");
    expect(draft.query.map((row) => row.value)).toEqual(["1", "2"]);
    expect(prepareRequest(draft, undefined).url).toBe(exchange.request.url);
    expect(draft.body).toBe(exchange.request.body);
  });
  it("restores all saved drafts, including inactive tabs, and ignores invalid rows", () => {
    const tabs = Array.from({ length: 35 }, () => newDraft());
    const saved = savedWorkspace(
      JSON.stringify({
        environments: [environment()],
        selectedEnvironment: "test",
        tabs: [...tabs, tabs[0], { id: "invalid" }],
        active: tabs[10]!.id,
      }),
    );
    expect(saved.tabs).toHaveLength(35);
    expect(saved.active).toBe(tabs[10]!.id);
    expect(saved.selectedEnvironment).toBe("test");
    expect(() => savedWorkspace("null")).toThrow("restore");
  });
});

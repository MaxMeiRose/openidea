import type { EndpointEntry } from "@/workbench/contributions";
import { endpointKey } from "./model";

export type EndpointDisplay = "path" | "summary";
export type ApiNode =
  | { kind: "module" | "controller"; id: string; label: string; detail?: string; count: number; children: ApiNode[] }
  | { kind: "endpoint"; id: string; label: string; endpoint: EndpointEntry };

export const apiNodeKey = (endpoint: EndpointEntry) => `endpoint:${endpointKey(endpoint)}`;

export function endpointGroups(endpoints: EndpointEntry[], query: string, projectName: string): ApiNode[] {
  const tokens = query.toLowerCase().trim().split(/\s+/).filter(Boolean);
  const modules = new Map<string, Extract<ApiNode, { children: ApiNode[] }>>();
  const controllers = new Map<string, Extract<ApiNode, { children: ApiNode[] }>>();
  for (const endpoint of endpoints) {
    if (
      !tokens.every((token) =>
        `${endpoint.controller} ${endpoint.controllerSummary ?? ""} ${endpoint.summary ?? ""} ${endpoint.method} ${endpoint.url} ${endpoint.rel} ${endpoint.methodName}`
          .toLowerCase()
          .includes(token),
      )
    )
      continue;
    const rel = endpoint.rel.replaceAll("\\", "/");
    const source = rel.search(/(?:^|\/)src\//);
    const module = source < 0 ? "" : rel.slice(0, source);
    const moduleKey = `module:${module}`;
    let moduleNode = modules.get(moduleKey);
    if (!moduleNode) {
      moduleNode = {
        kind: "module",
        id: moduleKey,
        label: module.split("/").at(-1) || projectName,
        ...(module ? { detail: module } : {}),
        count: 0,
        children: [],
      };
      modules.set(moduleKey, moduleNode);
    }
    const id = `controller:${endpoint.path}:${endpoint.controller}`;
    let controller = controllers.get(id);
    if (!controller) {
      controller = {
        kind: "controller",
        id,
        label: endpoint.controllerSummary || endpoint.controller.replace(/Controller$/, "") || endpoint.controller,
        detail: endpoint.controller,
        count: 0,
        children: [],
      };
      controllers.set(id, controller);
      moduleNode.children.push(controller);
    }
    moduleNode.count++;
    controller.count++;
    controller.children.push({
      kind: "endpoint",
      id: apiNodeKey(endpoint),
      label: `${endpoint.method} ${endpoint.url}`,
      endpoint,
    });
  }
  const groups = [...modules.values()];
  // A single module adds no information and costs an indentation level in a narrow sidebar.
  return groups.length === 1 ? groups[0]!.children : groups;
}

export function branchKeys(nodes: readonly ApiNode[]): string[] {
  return nodes.flatMap((node) => ("children" in node ? [node.id, ...branchKeys(node.children)] : []));
}

/** Reveal the active request, falling back to the first API when opening an empty workspace. */
export function apiBranchPath(nodes: readonly ApiNode[], endpointId?: string): string[] {
  for (const node of nodes) {
    if (node.kind === "endpoint") {
      if (!endpointId || node.id === endpointId) return [node.id];
    } else {
      const nested = apiBranchPath(node.children, endpointId);
      if (nested.length) return [node.id, ...nested];
    }
  }
  return [];
}

export function endpointTitle(endpoint: EndpointEntry, display: EndpointDisplay): string {
  return display === "summary" ? endpoint.summary || endpoint.methodName : endpoint.url;
}

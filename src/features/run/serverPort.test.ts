import { describe, expect, it } from "vitest";
import { mergePorts, startedPorts } from "./serverPort";

describe("application listening ports", () => {
  it.each([
    ["Tomcat started on port(s): 8080 (http), 8443 (https) with context path '/'", [8080, 8443]],
    ["2026-11-05 12:34:56 INFO [GIN-debug] Listening and serving HTTP on :9090", [9090]],
    ["⇨ http server started on [::]:1323", [1323]],
    ["INFO: Uvicorn running on http://127.0.0.1:8000 (Press CTRL+C to quit)", [8000]],
    ["* Running on http://127.0.0.1:5000", [5000]],
    ["Now listening on: https://localhost:7051", [7051]],
    ["➜  Local:   http://localhost:5173/", [5173]],
    ['{"msg":"server listening","pid":1234,"addr":":8080"}', [8080]],
    ['{"msg":"listening","port":8080,"pid":1234}', [8080]],
    ["Server is listening on port 3000", [3000]],
  ])("reads %s", (line, ports) => expect(startedPorts(line)).toEqual(ports));
  it.each([
    "Listening for transport dt_socket at address: 5005",
    "Debugger listening on ws://127.0.0.1:9229/token",
    "DAP server listening at: 127.0.0.1:5555",
    "ERROR failed to listen on :8080: address already in use",
    "Tomcat initialized with port 8080 (http)",
    "Local request to http://remote.example:9000/health",
    "server listening on port 99999",
    "Server listening on :0",
  ])("ignores non-application or failed bindings: %s", (line) => expect(startedPorts(line)).toEqual([]));
  it("deduplicates application ports without retaining invalid ports", () => {
    expect(mergePorts([8080], [8080, 8443, 0, 70000])).toEqual([8080, 8443]);
  });
});

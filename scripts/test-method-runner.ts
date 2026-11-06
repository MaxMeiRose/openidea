/** Real JVM verification: node scripts/test-method-runner.ts. Uses a temporary copy of the Maven fixture. */
import { strict as assert } from "node:assert";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { connect } from "node:net";
const root = resolve(import.meta.dirname, "..");
const directory = mkdtempSync(join(tmpdir(), "openidea-method-verification-"));
const module = join(directory, "module");
const runner = join(directory, "runner");
const javaHome = process.env.JAVA_HOME;
const java = javaHome ? join(javaHome, "bin/java") : "java";
const javac = javaHome ? join(javaHome, "bin/javac") : "javac";
const mavenOptions = process.env.OPENIDEA_METHOD_SPRING_VERSION
  ? [
      "-Dspring.version=" + process.env.OPENIDEA_METHOD_SPRING_VERSION,
      "-Dmaven.compiler.source=8",
      "-Dmaven.compiler.target=8",
      "-Dmockito.version=2.28.2",
    ]
  : [];
function command(executable: string, args: string[], cwd = directory) {
  const result = spawnSync(executable, args, { cwd, encoding: "utf8", timeout: 180000, maxBuffer: 10 * 1024 * 1024 });
  assert.equal(result.status, 0, result.stdout + result.stderr + String(result.error ?? ""));
  return result.stdout;
}
try {
  cpSync(join(root, "fixtures/java-method-test"), module, {
    recursive: true,
    filter: (path) => !path.includes("/target/") && !path.endsWith("/target"),
  });
  mkdirSync(runner);
  command(javac, [
    "-source",
    "8",
    "-target",
    "8",
    "-g",
    "-d",
    runner,
    join(root, "crates/ide-run/src/method/OpenIdeaMethodRunner.java"),
  ]);
  const classpathFile = join(directory, "classpath.txt");
  command(
    "mvn",
    [
      "--batch-mode",
      "-q",
      ...mavenOptions,
      "test-compile",
      "dependency:build-classpath",
      `-Dmdep.outputFile=${classpathFile}`,
    ],
    module,
  );
  const classpath = [runner, join(module, "target/classes"), readFileSync(classpathFile, "utf8").trim()].join(
    delimiter,
  );
  let sequence = 0;
  const mock = {
    repository: { kind: "mock", stubs: [{ method: "load", args: [7], returns: { id: 7, name: "sample" } }] },
  };
  function invoke(overrides: Record<string, unknown>, success = true) {
    const dir = join(directory, `call-${++sequence}`);
    mkdirSync(dir);
    const request = {
      sourcePath: join(module, "src/main/java/demo/OrderService.java"),
      className: "demo.OrderService",
      methodName: "load",
      parameterTypes: ["long"],
      argumentsJson: "[7]",
      mode: "object",
      dependenciesJson: JSON.stringify(mock),
      propertiesJson: "{}",
      configurationClasses: [],
      profiles: [],
      mavenProfiles: [],
      heapMb: 384,
      timeoutSeconds: 120,
      ...overrides,
    };
    writeFileSync(join(dir, "request.json"), JSON.stringify(request));
    const process = spawnSync(java, ["-cp", classpath, "OpenIdeaMethodRunner", "--invoke", dir], {
      encoding: "utf8",
      timeout: 20000,
    });
    const result = JSON.parse(readFileSync(join(dir, "result.json"), "utf8"));
    assert.equal(result.success, success, process.stdout + process.stderr);
    assert.equal(process.status, success ? 0 : 1);
    return result;
  }
  assert.deepEqual(JSON.parse(invoke({}).valueJson), { id: 7, name: "sample" });
  assert.deepEqual(
    JSON.parse(
      invoke({ methodName: "echo", parameterTypes: ["java.util.List"], argumentsJson: '[[{"id":2,"name":"typed"}]]' })
        .valueJson,
    ),
    [{ id: 2, name: "typed" }],
  );
  assert.deepEqual(
    JSON.parse(
      invoke({
        methodName: "mapping",
        parameterTypes: ["java.util.Map"],
        argumentsJson: '[{"one":{"id":1,"name":"mapped"}}]',
      }).valueJson,
    ),
    { one: { id: 1, name: "mapped" } },
  );
  assert.equal(
    JSON.parse(invoke({ methodName: "overloaded", parameterTypes: ["int"], argumentsJson: "[3]" }).valueJson),
    "int:3",
  );
  assert.equal(
    JSON.parse(invoke({ methodName: "overloaded", parameterTypes: ["String"], argumentsJson: '["three"]' }).valueJson),
    "string:three",
  );
  assert.match(invoke({ argumentsJson: "[8]" }, false).error, /No mock response/);
  assert.match(invoke({ dependenciesJson: "{}" }, false).error, /Cannot construct/);
  assert.match(
    invoke({ methodName: "sum", parameterTypes: ["int", "int"], argumentsJson: "[null,1]" }, false).error,
    /null cannot/,
  );
  assert.match(
    invoke({ methodName: "failure", parameterTypes: [], argumentsJson: "[]" }, false).stackTrace,
    /OrderService.java/,
  );
  assert.equal(
    JSON.parse(
      invoke({
        className: "demo.OrderService$GreetingService",
        methodName: "greet",
        parameterTypes: ["String"],
        argumentsJson: '["Ada"]',
        mode: "spring",
        dependenciesJson: "{}",
        propertiesJson: '{"greeting":"Hi"}',
      }).valueJson,
    ),
    "Hi Ada",
  );
  // The context uses a JDK transaction proxy: invocation must go through that proxy.
  assert.equal(
    JSON.parse(
      invoke({
        methodName: "transactionActive",
        parameterTypes: [],
        argumentsJson: "[]",
        mode: "spring",
        configurationClasses: ["demo.OrderService$Config"],
      }).valueJson,
    ),
    true,
  );
  const prepared = join(directory, "prepared");
  assert.equal(
    JSON.parse(invoke({ methodName: "state", parameterTypes: ["State"], argumentsJson: '["ACTIVE"]' }).valueJson),
    "ACTIVE",
  );
  assert.match(
    invoke({ methodName: "async", parameterTypes: [], argumentsJson: "[]" }, false).error,
    /synchronous public methods/,
  );
  assert.match(
    invoke(
      {
        className: "demo.OrderService$GreetingService",
        methodName: "greet",
        parameterTypes: ["String"],
        argumentsJson: '["Ada"]',
        dependenciesJson: "{}",
      },
      false,
    ).error,
    /Property injection/,
  );
  assert.equal(
    JSON.parse(
      invoke({
        className: "demo.OrderService$ConcreteService",
        methodName: "value",
        parameterTypes: ["int"],
        argumentsJson: "[2]",
        dependenciesJson: JSON.stringify({
          repository: { kind: "mock", stubs: [{ method: "value", args: [2], returns: "mocked" }] },
        }),
      }).valueJson,
    ),
    "mocked",
  );
  mkdirSync(prepared);
  writeFileSync(
    join(prepared, "request.json"),
    JSON.stringify({
      className: "demo.OrderService",
      methodName: "sum",
      parameterTypes: ["int", "int"],
      argumentsJson: "[2,5]",
      mode: "object",
      dependenciesJson: "{}",
      propertiesJson: "{}",
      configurationClasses: [],
      profiles: [],
    }),
  );
  const property = (value: string) => value.replaceAll("\\", "\\\\").replaceAll("\n", "\\n");
  writeFileSync(
    join(prepared, "launch.properties"),
    Object.entries({
      module,
      java,
      maven: "mvn",
      heap: "256",
      timeout: "120",
      profiles: "",
      ...Object.fromEntries(mavenOptions.map((value, index) => ["mavenOption" + index, value])),
    })
      .map(([key, value]) => `${key}=${property(value)}\n`)
      .join(""),
  );
  command(java, ["-cp", runner, "OpenIdeaMethodRunner", "--prepare", prepared]);
  assert.equal(JSON.parse(JSON.parse(readFileSync(join(prepared, "result.json"), "utf8")).valueJson), 7);
  // A real JDWP handshake verifies that only the final invocation JVM suspends.
  const child = spawn(java, ["-cp", runner, "OpenIdeaMethodRunner", "--prepare", prepared], {
    env: {
      ...process.env,
      OPENIDEA_METHOD_JDWP: "-agentlib:jdwp=transport=dt_socket,server=y,suspend=y,address=127.0.0.1:0",
    },
  });
  let output = "";
  const exited = new Promise<number | null>((resolve) => child.once("exit", resolve));
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const port = await new Promise<number>((resolve, reject) => {
      timer = setTimeout(() => {
        child.kill();
        reject(new Error("JDWP launch timed out: " + output));
      }, 60000);
      child.on("error", reject);
      child.once("exit", () => reject(new Error("JVM exited before JDWP attached: " + output)));
      const collect = (data: Buffer) => {
        output += data.toString();
        const match = /Listening for transport dt_socket at address: (\d+)/.exec(output);
        if (match) resolve(Number(match[1]));
      };
      child.stdout.on("data", collect);
      child.stderr.on("data", collect);
    });
    assert.ok(output.indexOf("Invoking in an isolated JVM") < output.indexOf("Listening for transport"), output);
    await new Promise<void>((resolve, reject) => {
      const socket = connect(port, "127.0.0.1", () => socket.write("JDWP-Handshake"));
      let data = Buffer.alloc(0);
      socket.on("error", reject);
      socket.on("data", (chunk) => {
        data = Buffer.concat([data, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);
        if (data.length < 14) return;
        assert.equal(data.subarray(0, 14).toString(), "JDWP-Handshake");
        const dispose = Buffer.alloc(11);
        dispose.writeUInt32BE(11, 0);
        dispose.writeUInt32BE(1, 4);
        dispose[9] = 1;
        dispose[10] = 6;
        socket.removeAllListeners("data");
        socket.end(dispose);
        resolve();
      });
    });
    assert.equal(await exited, 0, output);
    assert.equal(JSON.parse(JSON.parse(readFileSync(join(prepared, "result.json"), "utf8")).valueJson), 7);
  } finally {
    clearTimeout(timer);
    if (child.exitCode === null) child.kill();
  }
  console.log(`Verified ${sequence} invocation cases, the complete Maven launcher and a real JDWP attachment.`);
} finally {
  rmSync(directory, { recursive: true, force: true });
}

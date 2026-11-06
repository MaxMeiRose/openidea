# Java Service method tests

Open a local Maven project's Java Service or implementation file and click the test icon beside a public method. The editor context menu also offers **Test Java Method**. Interface declarations require a fully qualified implementation class; open the implementation file when it belongs to a different Maven module.

The Parameters view generates one field per declared parameter. Enter strings directly without quotes or array brackets; numbers and booleans have their own controls, while DTOs, arrays, `List<DTO>` and `Map<String, DTO>` use JSON fields. Reference parameters have an explicit `null` toggle. The optional JSON view edits the complete positional array. Long integers retain their exact digits; decimal inputs for `BigDecimal` are encoded as text to avoid JavaScript precision loss. Saved cases are local to the project and include arguments, dependency choices and environment settings.

**Object** constructs the selected class and supplies configured constructor/field dependencies. It does not provide Spring transactions, property injection or other interceptors. **Spring** creates an `AnnotationConfigApplicationContext` with the target, explicit configuration classes and selected dependency classes. It invokes through the Spring proxy, including JDK interface proxies. Register the infrastructure configuration needed for transactions, persistence, caching or other framework behavior. Spring and Maven profiles are configured separately.

Dependencies are keyed by field name. An explicit `className` can be used when the field is not available on the selected source declaration:

```json
{
  "repository": {
    "kind": "mock",
    "stubs": [{ "method": "findById", "args": [7], "returns": { "id": 7, "name": "Example" } }]
  },
  "otherService": { "kind": "instance", "className": "com.example.OtherService" },
  "limit": { "kind": "value", "value": 10 }
}
```

Omit a stub's `args` to match any arguments. Supply `parameterTypes` to distinguish overloads, or `throws` to configure an exception. Unconfigured mock calls fail instead of silently returning null. Interface mocks use JDK proxies; class mocks require a compatible Mockito dependency on the project's test classpath.

The first version supports synchronous public Java methods, Maven, JDK 8 or newer, and Jackson 2 (`jackson-databind`) on the module's test classpath. Ordinary Run does not start JDT LS. Debug uses OpenIDEA's existing Java debugger and requires JDT LS with Microsoft java-debug.

Run first saves the editor and checks the selected source signature. Maven `test-compile` builds the module; `dependency:build-classpath` and `help:effective-pom` supply dependencies and output directories. A failed build prevents invocation. The project must build normally with its configured Maven settings and profiles, including resolution of sibling-module dependencies. The launcher and request files live in the IDE cache; it does not add project dependencies, change the POM or generate business/test source files.

Return values, total invocation duration (including context setup/teardown), exceptions and mock calls appear in **Method Test**. Build/application output and clickable stack frames use the **Services** console. Repeated calls to the same method reuse its console. Stop terminates the process group. The timeout covers building and execution; a Debug invocation waits for the debugger without an execution timeout. The heap setting applies to the invocation JVM, not Maven or total process RSS. The disposable JVM exits after the result is written.

Real dependencies can write data or call external systems. A transaction rollback is not applied automatically. Mock execution exercises the selected logic but does not validate integration with the real dependency.

The isolated fixture verification is `JAVA_HOME=/path/to/jdk-17 node scripts/test-method-runner.ts`. It checks typed DTO/collection arguments, overloads, dependency failures, Spring property injection, transaction proxies, the Maven launcher and a real JDWP handshake. To verify Java 8 with Spring 5, use a JDK 8 and `OPENIDEA_METHOD_SPRING_VERSION=5.3.19`.

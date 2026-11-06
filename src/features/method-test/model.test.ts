import { describe, expect, it } from "vitest";
import { environment, invocation, javaMethods, newDraft, restore } from "./model";

const SOURCE = `package demo;
import java.util.List;
import java.util.Map;
@Service
public class UserService {
  private final UserRepository repository;
  public UserService(UserRepository repository) { this.repository=repository; }
  public List<User> find(@Valid final Query query, int limit) { return null; }
  public User find(long id) { return null; }
  public static Map<String,User>[] group(List<User> users) { return null; }
  protected void hidden() {}
  private void secret() {}
  void packageMethod() {}
}
`;
describe("Java method targets", () => {
  it("distinguishes overloads, erases imported generic signatures, and excludes constructors/non-public methods", () => {
    const methods = javaMethods("/project/UserService.java", SOURCE);
    expect(methods.map((method) => [method.className, method.methodName, method.parameterTypes])).toEqual([
      ["demo.UserService", "find", ["Query", "int"]],
      ["demo.UserService", "find", ["long"]],
      ["demo.UserService", "group", ["java.util.List"]],
    ]);
    expect(methods[0]!.parameters).toEqual([
      { name: "query", type: "Query" },
      { name: "limit", type: "int" },
    ]);
    expect(methods[0]!.service).toBe(true);
  });
  it("offers public interface signatures with an explicit implementation requirement", () => {
    const [method] = javaMethods(
      "/project/OrderService.java",
      "package demo; public interface OrderService { Order get(long id); }",
    );
    expect(method).toMatchObject({ className: "demo.OrderService", methodName: "get", needsImplementation: true });
    expect(newDraft(method!).implementationClass).toBe("");
  });
  it("keeps nested classes distinct and ignores method-looking strings/comments", () => {
    const methods = javaMethods(
      "/project/Example.java",
      `class Example { // public void ignored() {}
      String text="public void ignored() {}";
      public static class InnerService { public String call() { return "ok"; } }
    }`,
    );
    expect(methods.map((method) => method.className)).toEqual(["Example$InnerService"]);
  });
});
it("validates argument order and string environment values before native preparation", () => {
  const draft = newDraft(javaMethods("/project/UserService.java", SOURCE)[0]!);
  expect(invocation(draft).argumentsJson).toBe("[\n  {},\n  0\n]");
  draft.argumentsJson = '{"query":{}}';
  expect(() => invocation(draft)).toThrow("JSON array");
  draft.argumentsJson = "[{}]";
  expect(() => invocation(draft)).toThrow("one value");
  draft.argumentsJson = "[{},1]";
  draft.environmentJson = '{"TOKEN":42}';
  expect(() => environment(draft)).toThrow("string values");
});
it("restores cases without accepting unrelated or malformed saved data", () => {
  const draft = newDraft(javaMethods("/project/UserService.java", SOURCE)[1]!);
  expect(restore(JSON.stringify({ draft, cases: [{ id: "case", name: "one", draft }] })).cases).toHaveLength(1);
  expect(restore('{"draft":{"target":null},"cases":[]}').draft).toBeNull();
  expect(restore("broken")).toEqual({ draft: null, cases: [] });
});

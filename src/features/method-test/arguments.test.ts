import { expect, it } from "vitest";
import { argumentError, argumentKind, argumentLiterals, packArguments } from "./arguments";
import { argumentDefault } from "./model";
it("uses scalar controls for Java scalars and JSON controls for objects/collections", () => {
  expect(["String", "java.lang.String", "long", "boolean", "String[]", "List<User>", "User"].map(argumentKind)).toEqual(
    ["text", "text", "number", "boolean", "json", "json", "json"],
  );
});
it("matches defaults to the displayed scalar and collection controls", () => {
  expect(["String", "OffsetDateTime", "long", "boolean", "List", "String..."].map(argumentDefault)).toEqual([
    "",
    "",
    0,
    false,
    [],
    [],
  ]);
});
it("preserves exact long literals and escaped commas while editing another argument", () => {
  const values = argumentLiterals('["hello, \\"quoted\\"",9007199254740993,{"a":[1,2]}]', 3);
  expect(values).toEqual(['"hello, \\"quoted\\""', "9007199254740993", '{"a":[1,2]}']);
  values![0] = JSON.stringify("changed");
  expect(packArguments(values!)).toBe('["changed",9007199254740993,{"a":[1,2]}]');
});
it("validates scalar types, primitive nulls and incomplete numeric values", () => {
  expect(argumentError("String", '"sku"')).toBeNull();
  expect(argumentError("String", "[]")).toContain("text");
  expect(argumentError("long", "null")).toContain("cannot be null");
  expect(argumentError("Long", "null")).toBeNull();
  expect(argumentError("boolean", "false")).toBeNull();
  expect(argumentError("boolean", '"false"')).toContain("true or false");
  expect(argumentError("long", "-42")).toBeNull();
  expect(argumentError("long", "1.5")).toContain("integer");
  expect(argumentError("long", "-")).toContain("valid JSON");
  expect(argumentError("BigDecimal", '"123456789.123456789"')).toBeNull();
});

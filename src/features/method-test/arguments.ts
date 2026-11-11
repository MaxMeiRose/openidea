export type ArgumentKind = "text" | "character" | "number" | "boolean" | "json";
const PRIMITIVES = new Set(["byte", "short", "int", "long", "float", "double", "boolean", "char"]);

export function argumentKind(type: string): ArgumentKind {
  if (/\[\]|\.\.\.|[<>]/.test(type)) return "json";
  const name = type.split(".").pop() ?? type;
  if (["char", "Character"].includes(name)) return "character";
  if (["String", "UUID", "LocalDate", "LocalDateTime", "Instant", "OffsetDateTime", "ZonedDateTime"].includes(name))
    return "text";
  if (name === "boolean" || name === "Boolean") return "boolean";
  if (/^(?:byte|short|int|long|float|double|Byte|Short|Integer|Long|Float|Double|BigDecimal|BigInteger)$/.test(name))
    return "number";
  return "json";
}
export const nullableArgument = (type: string) => !PRIMITIVES.has(type);
export const decimalText = (type: string) => /(?:^|\.)(?:BigDecimal|BigInteger)$/.test(type);

/** Keep individual JSON literals, including integers beyond JavaScript's safe range. */
export function argumentLiterals(text: string, count: number): string[] | null {
  try {
    const parsed: unknown = JSON.parse(text);
    if (!Array.isArray(parsed) || parsed.length !== count) return null;
  } catch {
    return null;
  }
  const source = text.trim();
  if (count === 0) return [];
  const values: string[] = [];
  let start = 1,
    depth = 0,
    string = false,
    escaped = false;
  for (let index = 1; index < source.length - 1; index++) {
    const char = source[index];
    if (string) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') string = false;
    } else if (char === '"') string = true;
    else if (char === "[" || char === "{") depth++;
    else if (char === "]" || char === "}") depth--;
    else if (char === "," && depth === 0) {
      values.push(source.slice(start, index).trim());
      start = index + 1;
    }
  }
  values.push(source.slice(start, -1).trim());
  return values;
}
export const packArguments = (literals: string[]) => `[${literals.join(",")}]`;

export function argumentError(type: string, literal: string): string | null {
  let value: unknown;
  try {
    value = JSON.parse(literal);
  } catch {
    return "Enter a valid JSON value";
  }
  if (value === null) return nullableArgument(type) ? null : "This primitive parameter cannot be null";
  const kind = argumentKind(type);
  if ((kind === "text" || kind === "character") && typeof value !== "string") return "Enter text for this parameter";
  if (kind === "character" && (value as string).length !== 1) return "Enter one character";
  if (kind === "boolean" && typeof value !== "boolean") return "Choose true or false";
  if (kind === "number") {
    const number = decimalText(type) && typeof value === "string" ? value : literal;
    if (!/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(number)) return "Enter a number";
    if (/(?:^|\.)(?:byte|short|int|long|Byte|Short|Integer|Long|BigInteger)$/.test(type) && !/^-?\d+$/.test(number))
      return "Enter an integer";
  }
  return null;
}

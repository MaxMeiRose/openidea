import type { MethodInvocation } from "@/bindings";
import { argumentError, argumentKind, argumentLiterals } from "./arguments";
import { parseSource, tokenize, type ClassDecl, type SourceFile } from "@/features/http-client/spring/source";

export interface MethodTarget {
  path: string;
  className: string;
  methodName: string;
  parameterTypes: string[];
  parameters: Array<{ name: string; type: string }>;
  fields: Array<{ name: string; type: string }>;
  line: number;
  from: number;
  to: number;
  service: boolean;
  needsImplementation: boolean;
}

function erased(type: string, file: SourceFile): string {
  const bare = type.replace(/<.*>/g, "").replace(/\.\.\./g, "[]");
  const base = bare.replace(/\[\]/g, "");
  const imported = file.imports.find((name) => name.endsWith(`.${base}`));
  return imported ? bare.replace(base, imported) : bare;
}

export function javaMethods(path: string, source: string): MethodTarget[] {
  if (!path.endsWith(".java")) return [];
  const file = parseSource(source);
  const found: MethodTarget[] = [];
  const visit = (declarations: ClassDecl[], parent: string) => {
    for (const declaration of declarations) {
      const name = parent ? `${parent}$${declaration.name}` : declaration.name;
      const className = file.packageName ? `${file.packageName}.${name}` : name;
      const header = tokenize(source.slice(declaration.start, declaration.nameStart));
      const isInterface = header.some((token) => token.text === "interface");
      const service =
        declaration.annotations.some((annotation) => annotation.name === "Service") ||
        /Service(?:Impl)?$/.test(declaration.name);
      for (const method of declaration.methods) {
        const modifiers = tokenize(source.slice(method.start, method.nameStart));
        if (
          method.name === declaration.name ||
          modifiers.some((token) => ["private", "protected"].includes(token.text))
        )
          continue;
        if (!isInterface && !modifiers.some((token) => token.text === "public")) continue;
        if (modifiers.some((token) => token.text === "abstract") && !isInterface) continue;
        found.push({
          path,
          className,
          methodName: method.name,
          parameterTypes: method.params.map((parameter) => erased(parameter.type, file)),
          parameters: method.params.map(({ name, type }) => ({ name, type })),
          fields: declaration.fields.filter((field) => !field.isStatic).map(({ name, type }) => ({ name, type })),
          line: source.slice(0, method.nameStart).split("\n").length - 1,
          from: method.nameStart,
          to: method.end,
          service,
          needsImplementation: isInterface,
        });
      }
      visit(declaration.classes, name);
    }
  };
  visit(file.classes, "");
  return found;
}

export const methodKey = (target: MethodTarget) =>
  JSON.stringify([target.path, target.className, target.methodName, target.parameterTypes]);
export const methodLabel = (target: MethodTarget) =>
  `${target.className}#${target.methodName}(${target.parameterTypes.join(", ")})`;

export function argumentDefault(type: string): unknown {
  const container = type.replace(/<.*>/, "").split(".").pop();
  if (/\[\]$|\.\.\.$/.test(type) || ["List", "Set", "Collection", "Iterable"].includes(container ?? "")) return [];
  const kind = argumentKind(type);
  if (kind === "number") return 0;
  if (kind === "boolean") return false;
  if (kind === "text" || kind === "character") return "";
  return {};
}

export interface MethodDraft {
  target: MethodTarget;
  implementationClass: string;
  mode: "object" | "spring";
  argumentsJson: string;
  dependenciesJson: string;
  propertiesJson: string;
  environmentJson: string;
  configurationClasses: string;
  profiles: string;
  mavenProfiles: string;
  heapMb: number;
  timeoutSeconds: number;
}
export interface MethodCase {
  id: string;
  name: string;
  draft: MethodDraft;
}

export function newDraft(target: MethodTarget): MethodDraft {
  return {
    target,
    implementationClass: target.needsImplementation ? "" : target.className,
    mode: "object",
    argumentsJson: JSON.stringify(
      target.parameters.map((parameter) => argumentDefault(parameter.type)),
      null,
      2,
    ),
    dependenciesJson: "{}",
    propertiesJson: "{}",
    environmentJson: "{}",
    configurationClasses: "",
    profiles: "",
    mavenProfiles: "",
    heapMb: 384,
    timeoutSeconds: 300,
  };
}

export function jsonObject(text: string, label: string): Record<string, unknown> {
  const value: unknown = JSON.parse(text);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be a JSON object`);
  return value as Record<string, unknown>;
}
const names = (text: string) => text.split(/[\s,]+/).filter(Boolean);
export function invocation(draft: MethodDraft): MethodInvocation {
  const args: unknown = JSON.parse(draft.argumentsJson);
  if (!Array.isArray(args) || args.length !== draft.target.parameters.length)
    throw new Error("Arguments must be a JSON array with one value per parameter");
  const literals = argumentLiterals(draft.argumentsJson, draft.target.parameters.length)!;
  for (const [index, parameter] of draft.target.parameters.entries()) {
    const error = argumentError(parameter.type, literals[index]!);
    if (error) throw new Error(`${parameter.name}: ${error}`);
  }
  if (!draft.implementationClass.trim()) throw new Error("Enter the fully qualified implementation class");
  jsonObject(draft.dependenciesJson, "Dependencies");
  jsonObject(draft.propertiesJson, "Properties");
  environment(draft);
  return {
    sourcePath: draft.target.path,
    className: draft.implementationClass.trim(),
    methodName: draft.target.methodName,
    parameterTypes: draft.target.parameterTypes,
    argumentsJson: draft.argumentsJson,
    mode: draft.mode,
    dependenciesJson: draft.dependenciesJson,
    propertiesJson: draft.propertiesJson,
    configurationClasses: names(draft.configurationClasses),
    profiles: names(draft.profiles),
    mavenProfiles: names(draft.mavenProfiles),
    heapMb: draft.heapMb,
    timeoutSeconds: draft.timeoutSeconds,
  };
}
export function environment(draft: MethodDraft): Record<string, string> {
  const values = jsonObject(draft.environmentJson, "Environment");
  for (const [key, value] of Object.entries(values))
    if (!key || /[=\0]/.test(key) || typeof value !== "string" || value.includes("\0"))
      throw new Error("Environment variables need valid names and string values");
  return values as Record<string, string>;
}

export function restore(raw: string | null): { draft: MethodDraft | null; cases: MethodCase[] } {
  try {
    const parsed = raw ? JSON.parse(raw) : null;
    const valid = (draft: MethodDraft | undefined): draft is MethodDraft =>
      !!draft &&
      typeof draft.target?.path === "string" &&
      typeof draft.target.className === "string" &&
      typeof draft.target.methodName === "string" &&
      Array.isArray(draft.target.parameters) &&
      Array.isArray(draft.target.parameterTypes) &&
      Array.isArray(draft.target.fields) &&
      draft.target.fields.every((field) => typeof field?.name === "string" && typeof field.type === "string") &&
      draft.target.parameters.every(
        (parameter) => typeof parameter?.name === "string" && typeof parameter.type === "string",
      ) &&
      draft.target.parameterTypes.every((type) => typeof type === "string") &&
      ["object", "spring"].includes(draft.mode) &&
      [
        draft.implementationClass,
        draft.argumentsJson,
        draft.dependenciesJson,
        draft.propertiesJson,
        draft.environmentJson,
        draft.configurationClasses,
        draft.profiles,
        draft.mavenProfiles,
      ].every((value) => typeof value === "string") &&
      Number.isFinite(draft.heapMb) &&
      Number.isFinite(draft.timeoutSeconds);
    return {
      draft: valid(parsed?.draft) ? parsed.draft : null,
      cases: Array.isArray(parsed?.cases)
        ? parsed.cases
            .filter(
              (entry: MethodCase) =>
                !!entry && typeof entry.id === "string" && typeof entry.name === "string" && valid(entry.draft),
            )
            .slice(0, 30)
        : [],
    };
  } catch {
    return { draft: null, cases: [] };
  }
}

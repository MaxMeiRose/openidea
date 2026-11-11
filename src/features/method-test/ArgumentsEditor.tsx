import { useState } from "react";
import { Checkbox, Input, Tabs, T } from "@/ui";
import { useTx } from "@/platform/i18n";
import {
  argumentKind,
  argumentError,
  argumentLiterals,
  decimalText,
  nullableArgument,
  packArguments,
} from "./arguments";
import { argumentDefault, type MethodDraft } from "./model";
import styles from "./MethodTest.module.css";

export function ArgumentsEditor({
  draft,
  disabled,
  onChange,
}: {
  draft: MethodDraft;
  disabled: boolean;
  onChange: (value: string) => void;
}) {
  const tx = useTx();
  const [mode, setMode] = useState("parameters");
  const [fields, setFields] = useState(() => ({
    source: draft.argumentsJson,
    values: argumentLiterals(draft.argumentsJson, draft.target.parameters.length),
  }));
  if (fields.source !== draft.argumentsJson)
    setFields({
      source: draft.argumentsJson,
      values: argumentLiterals(draft.argumentsJson, draft.target.parameters.length),
    });
  const change = (index: number, literal: string) => {
    if (!fields.values) return;
    const values = [...fields.values];
    values[index] = literal;
    const source = packArguments(values);
    setFields({ source, values });
    onChange(source);
  };
  return (
    <div className={styles.arguments}>
      <Tabs
        variant="compact"
        aria-label="Argument input mode"
        activeId={mode}
        onSelect={setMode}
        items={[
          { id: "parameters", label: tx("Parameters") },
          { id: "json", label: "JSON" },
        ]}
      />
      {mode === "json" ? (
        <>
          <p className={styles.hint}>
            <T>Advanced: a JSON array containing one value per method parameter.</T>
          </p>
          <textarea
            className={styles.json}
            aria-label={tx("Method arguments")}
            spellCheck={false}
            value={draft.argumentsJson}
            disabled={disabled}
            onChange={(event) => onChange(event.target.value)}
            onKeyDown={(event) => {
              if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "a") event.stopPropagation();
            }}
          />
        </>
      ) : fields.values === null ? (
        <p className={styles.error} role="alert">
          <T>The saved arguments do not match this method. Use JSON mode to enter one value per parameter.</T>
        </p>
      ) : draft.target.parameters.length === 0 ? (
        <p className={styles.hint}>
          <T>This method has no parameters.</T>
        </p>
      ) : (
        <div className={styles.parameterList}>
          {draft.target.parameters.map((parameter, index) => {
            const literal = fields.values![index]!;
            const kind = argumentKind(parameter.type);
            const isNull = literal === "null";
            const error = argumentError(parameter.type, literal);
            let text = literal;
            if (kind === "text" || kind === "character" || decimalText(parameter.type)) {
              try {
                const value: unknown = JSON.parse(literal);
                text = value === null ? "" : typeof value === "string" ? value : literal;
              } catch {
                /* retain the user's unfinished value */
              }
            }
            const label = `Argument ${parameter.name}`;
            return (
              <div className={styles.parameter} key={`${index}:${parameter.name}`}>
                <div className={styles.parameterHeading}>
                  <span>{parameter.name}</span>
                  <code>{parameter.type}</code>
                  <span className={styles.spacer} />
                  {nullableArgument(parameter.type) && (
                    <Checkbox
                      aria-label={tx`Null argument ${parameter.name}`}
                      checked={isNull}
                      disabled={disabled}
                      label="null"
                      onChange={(checked) =>
                        change(index, checked ? "null" : JSON.stringify(argumentDefault(parameter.type)))
                      }
                    />
                  )}
                </div>
                {kind === "boolean" ? (
                  <Checkbox
                    aria-label={tx(label)}
                    checked={literal === "true"}
                    disabled={disabled || isNull}
                    label={isNull ? "null" : literal}
                    onChange={(checked) => change(index, String(checked))}
                  />
                ) : kind === "json" ? (
                  <textarea
                    className={`${styles.json} ${styles.parameterJson}`}
                    aria-label={tx(label)}
                    spellCheck={false}
                    value={literal}
                    disabled={disabled || isNull}
                    onChange={(event) => change(index, event.target.value)}
                  />
                ) : (
                  <Input
                    aria-label={tx(label)}
                    mono
                    value={isNull ? "" : text}
                    disabled={disabled || isNull}
                    invalid={!!error}
                    placeholder={kind === "number" ? "Enter a number" : "Enter text"}
                    inputMode={kind === "number" ? "decimal" : "text"}
                    onChange={(event) =>
                      change(
                        index,
                        kind === "text" || kind === "character" || decimalText(parameter.type)
                          ? JSON.stringify(event.target.value)
                          : event.target.value,
                      )
                    }
                  />
                )}
                {error && (
                  <span className={styles.error} role="alert">
                    {tx(error)}
                  </span>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

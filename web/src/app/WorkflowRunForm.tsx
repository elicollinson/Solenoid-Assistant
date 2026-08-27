import { useState, type CSSProperties } from "react";
import { Button, MonoLabel, Panel } from "../kit";
import type { WorkflowInputField } from "./api";

/**
 * What a workflow needs before it can be started.
 *
 * Drawn from the fields the server sends rather than written per workflow, so a
 * workflow added to src/workflows/catalog.ts arrives here with its form already
 * made. The design has no text input in it — the editor is the one screen it
 * leaves out on purpose — so the control below is built from the same tokens
 * every kit component reads rather than promoted into the kit, which stays a
 * port of the design and not a place to invent.
 *
 * Nothing is validated here. The schema on the server is the one that decides,
 * and it is the only one that can — a second opinion in the browser is a second
 * thing to keep in step. What comes back from a refusal is put on screen.
 */
export function WorkflowRunForm({
  inputs,
  pending,
  error,
  onRun,
  onCancel,
}: {
  inputs: readonly WorkflowInputField[];
  pending: boolean;
  /** What the server said when it refused. Null while nothing is wrong. */
  error: string | null;
  onRun: (args: Record<string, string>) => void;
  onCancel: () => void;
}) {
  const [values, setValues] = useState<Record<string, string>>(() => defaults(inputs));

  const missing = inputs.filter((input) => input.required && !values[input.name]?.trim());

  return (
    <Panel style={{ maxWidth: 560, gap: "var(--sp-6)" }}>
      <MonoLabel>Run this now</MonoLabel>

      <div style={{ display: "flex", flexDirection: "column", gap: "var(--sp-5)" }}>
        {inputs.map((input) => (
          <Field
            key={input.name}
            input={input}
            value={values[input.name] ?? ""}
            onChange={(next) => setValues((current) => ({ ...current, [input.name]: next }))}
          />
        ))}
      </div>

      {error ? (
        <p style={{ margin: 0, font: "var(--text-body-sm)", color: "var(--danger-text)", textWrap: "pretty" }}>{error}</p>
      ) : null}

      <div style={{ display: "flex", alignItems: "center", gap: "var(--sp-3)" }}>
        <Button
          variant="affirm"
          disabled={pending || missing.length > 0}
          onClick={() => onRun(values)}
        >
          {pending ? "Starting…" : "Run it"}
        </Button>
        <Button variant="bare" onClick={onCancel}>
          Not now
        </Button>
        {missing.length ? (
          <span style={{ font: "var(--text-mono-meta)", color: "var(--text-4)" }}>
            {missing.map((input) => input.label.toLowerCase()).join(" and ")} first
          </span>
        ) : null}
      </div>
    </Panel>
  );
}

/** Everything prefilled the way the server said it would fall back anyway. */
function defaults(inputs: readonly WorkflowInputField[]): Record<string, string> {
  const values: Record<string, string> = {};
  for (const input of inputs) values[input.name] = input.default == null ? "" : String(input.default);
  return values;
}

const CONTROL: CSSProperties = {
  boxSizing: "border-box",
  width: "100%",
  padding: "7px 10px",
  border: "var(--border-strong)",
  borderRadius: "var(--radius-control)",
  background: "var(--surface-app)",
  color: "var(--text-1)",
  font: "var(--text-body-sm)",
  outline: "none",
};

/* `datetime-local` is what the browser has, and what it gives back is a local
   wall clock with no zone on it — which is exactly what someone typing "from
   Tuesday morning" means. The server parses it in its own zone, the one the
   whole product runs in. */
const TYPE: Record<WorkflowInputField["kind"], string> = {
  text: "text",
  textarea: "text",
  number: "number",
  datetime: "datetime-local",
};

function Field({
  input,
  value,
  onChange,
}: {
  input: WorkflowInputField;
  value: string;
  onChange: (value: string) => void;
}) {
  const [focused, setFocused] = useState(false);
  const style: CSSProperties = { ...CONTROL, borderColor: focused ? "var(--accent)" : undefined };

  return (
    <label style={{ display: "flex", flexDirection: "column", gap: "var(--sp-2)" }}>
      <MonoLabel>
        {input.label}
        {input.required ? " ·" : ""}
      </MonoLabel>
      {input.kind === "textarea" ? (
        <textarea
          rows={4}
          value={value}
          placeholder={input.placeholder ?? undefined}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          onChange={(event) => onChange(event.target.value)}
          style={{ ...style, resize: "vertical", font: "var(--text-mono)", lineHeight: 1.5 }}
        />
      ) : (
        <input
          type={TYPE[input.kind]}
          value={value}
          placeholder={input.placeholder ?? undefined}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          onChange={(event) => onChange(event.target.value)}
          style={style}
        />
      )}
      {input.help ? (
        <span style={{ font: "var(--text-mono-meta)", color: "var(--text-4)" }}>{input.help}</span>
      ) : null}
    </label>
  );
}

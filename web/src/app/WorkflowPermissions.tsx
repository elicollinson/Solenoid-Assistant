import { useState } from "react";
import { Badge, Button, Chip, MonoLabel, type BadgeTone } from "../kit";
import type { WorkflowPermissionItem } from "./api";

const COLUMN = { display: "flex", flexDirection: "column", gap: "var(--sp-4)" } as const;

export interface WorkflowPermissionsProps {
  permissions: readonly WorkflowPermissionItem[];
  busy: boolean;
  onChange: (capability: string, mode: "allow" | "ask" | "deny") => void;
}

export function WorkflowPermissions({ permissions, busy, onChange }: WorkflowPermissionsProps) {
  if (permissions.length === 0) {
    return (
      <div style={COLUMN}>
        <MonoLabel>Default tool permissions</MonoLabel>
        <p style={{ margin: 0, font: "var(--text-body-sm)", color: "var(--text-3)", textWrap: "pretty" }}>
          This workflow holds no write tools — it only looks.
        </p>
      </div>
    );
  }

  return (
    <div style={COLUMN}>
      <MonoLabel>Default tool permissions</MonoLabel>
      <div style={{ display: "flex", flexDirection: "column", gap: "var(--sp-5)" }}>
        {permissions.map((item) => (
          <PermissionCard key={item.capability} item={item} busy={busy} onChange={onChange} />
        ))}
      </div>
    </div>
  );
}

function PermissionCard({
  item,
  busy,
  onChange,
}: {
  item: WorkflowPermissionItem;
  busy: boolean;
  onChange: (capability: string, mode: "allow" | "ask" | "deny") => void;
}) {
  const [editing, setEditing] = useState(false);

  const tone: BadgeTone = item.mode === "allow" ? "running" : item.mode === "deny" ? "neutral" : "attention";
  const badgeText =
    item.mode === "allow" ? "Pre-approved" : item.mode === "deny" ? "Blocked" : "Requires approval";

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--sp-3)" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "var(--sp-2)", flexWrap: "wrap" }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: "var(--sp-2)" }}>
          <span style={{ font: "var(--text-title)", color: "var(--text-1)" }}>
            {item.label}
          </span>
          <span style={{ font: "var(--text-mono-meta)", color: "var(--text-4)" }}>
            {item.capability}
          </span>
        </div>
        <Badge tone={tone}>{badgeText}</Badge>
      </div>

      {item.description ? (
        <p style={{ margin: 0, font: "var(--text-body-sm)", color: "var(--text-2)", textWrap: "pretty" }}>
          {item.description}
        </p>
      ) : null}

      {/* The tool list is machine text under a mono label, which is the aside's
          own pattern for a named value — not a prose word glued to the front of
          a mono line. */}
      {item.tools.length > 0 ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
          <MonoLabel>Tools</MonoLabel>
          <span style={{ font: "var(--text-mono)", color: "var(--text-4)", overflowWrap: "anywhere" }}>
            {item.tools.join(", ")}
          </span>
        </div>
      ) : null}

      {editing ? (
        <div style={{ display: "flex", flexDirection: "column", gap: "var(--sp-2)", paddingTop: "var(--sp-1)" }}>
          <div style={{ display: "flex", gap: "var(--sp-2)", flexWrap: "wrap", opacity: busy ? 0.6 : 1 }}>
            <Chip
              selected={item.mode === "allow"}
              onClick={() => {
                onChange(item.capability, "allow");
                setEditing(false);
              }}
            >
              Pre-approve
            </Chip>
            <Chip
              selected={item.mode === "ask"}
              onClick={() => {
                onChange(item.capability, "ask");
                setEditing(false);
              }}
            >
              Ask every time
            </Chip>
            <Chip
              selected={item.mode === "deny"}
              onClick={() => {
                onChange(item.capability, "deny");
                setEditing(false);
              }}
            >
              Block
            </Chip>
          </div>
          <Button variant="bare" size="sm" onClick={() => setEditing(false)} style={{ alignSelf: "flex-start" }}>
            Cancel
          </Button>
        </div>
      ) : (
        <Button variant="bare" size="sm" onClick={() => setEditing(true)} style={{ alignSelf: "flex-start" }}>
          Edit permission
        </Button>
      )}
    </div>
  );
}

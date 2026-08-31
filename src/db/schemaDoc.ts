// A Drizzle table, described for an agent.
//
// The point of this file is one line of it: `ColumnNotes<T>` is a mapped type
// over the table's own select model, so a column added to a documented table is
// a COMPILE ERROR until somebody either writes a sentence about it or marks it
// `null` — deliberately not shown. That is what keeps a briefing honest without
// anybody remembering to update it.
//
// Everything else — the type, whether it is required, its default, its enum
// members, what it points at — is read off the table at render time and cannot
// drift from the schema, because it IS the schema.
//
// A group whose data this database does not hold (an OKF bundle, the Photos
// library) builds its FieldDoc[] by hand instead. FieldDoc is the seam; this is
// one producer of it.
import { SQL, getTableColumns, getTableName, type Column } from "drizzle-orm";
import { getTableConfig, type SQLiteTable } from "drizzle-orm/sqlite-core";
import type { FieldDoc } from "../core/toolGroups";

/**
 * One entry per column of `T`. A string documents it; `null` says "the agent
 * does not need to know this column exists" — join keys, internal bookkeeping.
 *
 * There is no third option on purpose. Silence is how a column ends up in the
 * schema and out of the briefing.
 */
export type ColumnNotes<T extends SQLiteTable> = {
  [K in keyof T["$inferSelect"]]-?: string | null;
};

/** What to call a column's type in a sentence a model reads. */
function renderType(column: Column): string {
  const enumValues = column.enumValues;
  if (enumValues?.length) return `one of: ${enumValues.join(" | ")}`;
  switch (column.dataType) {
    case "date":
      return "timestamp";
    case "number":
      return "number";
    case "bigint":
      return "bigint";
    case "boolean":
      return "boolean";
    case "json":
      return "json";
    case "array":
      return "array";
    case "buffer":
      return "blob";
    default:
      return "text";
  }
}

function renderDefault(column: Column): string | undefined {
  if (!column.hasDefault) return undefined;
  // `.default(x)` carries the value; `.$defaultFn()` carries nothing.
  if (column.default === undefined) return "generated";
  if (column.default instanceof Date) return column.default.toISOString();
  // A `sql` default is an SQL object, and stringifying one spills Drizzle's
  // query builder (`{"decoder":{},"queryChunks":[...]}`) into the briefing.
  if (column.default instanceof SQL) return renderSqlDefault(column.default);
  return JSON.stringify(column.default);
}

/**
 * The literal text of a `sql` default, when it is only literal text.
 *
 * Anything with a bound parameter in it says "generated" instead: a partial
 * rendering that dropped the parameter would read as a complete default and be
 * wrong, which is worse in a briefing than saying less.
 */
function renderSqlDefault(value: SQL): string {
  const chunks = (value as unknown as { queryChunks?: unknown[] }).queryChunks ?? [];
  const literals: string[] = [];
  for (const chunk of chunks) {
    const parts = (chunk as { value?: unknown } | null)?.value;
    if (!Array.isArray(parts) || parts.some((part) => typeof part !== "string")) {
      return "generated";
    }
    literals.push(parts.join(""));
  }
  const text = literals.join("").trim();
  return text || "generated";
}

/**
 * Every column of `table` the notes do not hide, in declaration order.
 *
 * Names are the TypeScript property, not the SQL column, because the tools and
 * the payloads the agent actually sees are camelCase.
 */
export function describeTable<T extends SQLiteTable>(
  table: T,
  notes: ColumnNotes<T>,
): FieldDoc[] {
  const columns = getTableColumns(table) as Record<string, Column>;
  const references = foreignKeyTargets(table, columns);

  const fields: FieldDoc[] = [];
  for (const [property, column] of Object.entries(columns)) {
    const note = (notes as Record<string, string | null>)[property];
    if (note === null) continue;
    const target = references.get(column);
    const fallback = renderDefault(column);
    fields.push({
      name: property,
      type: renderType(column),
      required: column.notNull && !column.hasDefault,
      ...(fallback === undefined ? {} : { default: fallback }),
      ...(target === undefined ? {} : { references: target }),
      ...(note ? { note } : {}),
    });
  }
  return fields;
}

/**
 * Column → "workflows.id".
 *
 * Keyed by the Column object rather than its name: `getTableColumns` gives the
 * same instances the foreign key holds, so identity is exact and there is no
 * camelCase/snake_case mapping to get wrong.
 */
function foreignKeyTargets(
  table: SQLiteTable,
  columns: Record<string, Column>,
): Map<Column, string> {
  const owned = new Set(Object.values(columns));
  const targets = new Map<Column, string>();
  for (const key of getTableConfig(table).foreignKeys) {
    const reference = key.reference();
    const foreignTable = getTableName(reference.foreignTable);
    reference.columns.forEach((column, index) => {
      if (!owned.has(column)) return;
      const foreignColumn = reference.foreignColumns[index];
      if (!foreignColumn) return;
      // A composite key would overwrite; last one wins and reads fine, since
      // this is a hint about where to look, not a constraint definition.
      targets.set(column, `${foreignTable}.${foreignColumn.name}`);
    });
  }
  return targets;
}

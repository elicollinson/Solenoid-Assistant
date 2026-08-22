import { existsSync, readFileSync, writeFileSync } from "node:fs";

export function setEnvValue(key: string, value: string, path = ".env"): void {
  if (!/^[A-Z][A-Z0-9_]*$/.test(key)) throw new Error(`Invalid environment key: ${key}`);
  if (value.includes("\n") || value.includes("\r")) {
    throw new Error(`Environment value for ${key} must be a single line`);
  }

  if (!existsSync(path)) {
    writeFileSync(path, `${key}=${value}\n`);
    return;
  }
  const lines = readFileSync(path, "utf8").split("\n");
  const prefix = `${key}=`;
  let found = false;
  const updated = lines.map((line) => {
    if (!line.startsWith(prefix)) return line;
    found = true;
    return `${key}=${value}`;
  });
  if (!found) updated.push(`${key}=${value}`);
  writeFileSync(path, updated.join("\n"));
}

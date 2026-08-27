import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "sqlite",
  schema: "./src/db/schema/index.ts",
  out: "./drizzle",
  // TypeScript stays camelCase; the database stays snake_case.
  casing: "snake_case",
  dbCredentials: { url: process.env.DATABASE_URL ?? "./data/solenoid.db" },
  verbose: true,
  strict: true,
});

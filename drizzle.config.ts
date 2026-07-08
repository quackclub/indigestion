import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "postgresql",
  schema: "src/db/schema.ts",
  out: "drizzle",
  dbCredentials: {
    url: process.env.DATABASE_URL || "postgres://indigestion:indigestion@localhost:5432/indigestion",
  },
});

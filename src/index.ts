import { serve } from "@hono/node-server";
import app from "./app";

const PORT = parseInt(process.env.PORT || "8080");

serve({
  fetch: app.fetch,
  port: PORT,
});

console.log(`indigestion listening on http://localhost:${PORT}`);

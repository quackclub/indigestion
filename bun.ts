import app from "./app";

const PORT = parseInt(process.env.PORT || "8080");

Bun.serve({
  port: PORT,
  fetch: app.fetch,
});

console.log(`indigestion listening on http://localhost:${PORT}`);

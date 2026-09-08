import { defineConfig } from "vite";

// Dev proxy: forward WS + /api + /health to the FastAPI hub server so the
// canvas and the event stream talk to the same origin in development.
export default defineConfig({
  server: {
    port: 5173,
    proxy: {
      "/health": "http://127.0.0.1:8000",
      "/api": "http://127.0.0.1:8000",
      "/ws": { target: "ws://127.0.0.1:8000", ws: true },
    },
  },
});

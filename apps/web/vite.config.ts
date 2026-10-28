import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const api = process.env.PARSEJUDGE_API ?? "http://127.0.0.1:8787";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/v1": { target: api, ws: true, changeOrigin: true },
      "/blobs": { target: api, changeOrigin: true },
    },
  },
});

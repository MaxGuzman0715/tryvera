import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";

export default defineConfig(({ mode }) => {
  const envDir = resolve(__dirname, "..");
  const env = loadEnv(mode, envDir, "");
  const apiPort = env.PORT || "3001";

  return {
    envDir,
    plugins: [react()],
    server: {
      host: '127.0.0.1',
      port: 5173,
      proxy: {
        // Use 127.0.0.1 (not localhost) so Windows/Node does not prefer ::1 and fail with EACCES / proxy errors.
        "/api": { target: `http://127.0.0.1:${apiPort}`, changeOrigin: true },
      },
    },
  };
});

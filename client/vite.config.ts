import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";

export default defineConfig(({ mode }) => {
  const envDir = resolve(__dirname, "..");
  const env = loadEnv(mode, envDir, "");
  const apiPort = env.PORT || "5001";
  // Dev-server port. Overridable via CLIENT_PORT in the root .env so several
  // instances (e.g. two devs on one VPS) can run side by side without clashing.
  const clientPort = Number(env.CLIENT_PORT || 5273);

  return {
    envDir,
    plugins: [react()],
    server: {
      host: '127.0.0.1',
      port: clientPort,
      // Fail loudly instead of silently drifting to the next free port. On a
      // shared host a silent +1 means the proxy/API base you configured no
      // longer matches where the dev server actually is.
      strictPort: true,
      proxy: {
        // Use 127.0.0.1 (not localhost) so Windows/Node does not prefer ::1 and fail with EACCES / proxy errors.
        "/api": { target: `http://127.0.0.1:${apiPort}`, changeOrigin: true },
      },
    },
  };
});

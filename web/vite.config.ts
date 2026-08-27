import babel from "@rolldown/plugin-babel";
import react, { reactCompilerPreset } from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// React Compiler runs through Babel rather than the experimental Rust port:
// `babel-plugin-react-compiler` is the stable release, and the whole point of
// turning it on is that components stay written plainly — no useMemo, no
// useCallback, no React.memo anywhere in the kit.
export default defineConfig({
  root: import.meta.dirname,
  plugins: [react(), babel({ presets: [reactCompilerPreset()] })],
  server: {
    port: 5173,
    // The API lives in the Elysia server (bun run start:server, PORT=3000).
    proxy: { "/api": { target: "http://localhost:3000", changeOrigin: true } },
  },
  build: { outDir: "dist", emptyOutDir: true },
});

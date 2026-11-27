import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";

export default defineConfig({
  server: { port: 8040, host: "127.0.0.1" },
  resolve: {
    alias: {
      "@ocean/sim": fileURLToPath(new URL("../sim/src/index.ts", import.meta.url)),
    },
  },
});

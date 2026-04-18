import { defineConfig } from "vitest/config";
import { resolve } from "node:path";

export default defineConfig({
  resolve: {
    alias: {
      "@ambicuity/kindx-schemas": resolve(__dirname, "../kindx-schemas/src/index.ts"),
    },
  },
});

import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./apps/web/src", import.meta.url))
    }
  },
  test: {
    environment: "node",
    include: ["apps/*/test/**/*.test.ts", "packages/*/test/**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/dist/**"]
  }
});

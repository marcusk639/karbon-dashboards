import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    exclude: ["node_modules/**", "dist/**", ...(process.env.LIVE === "1" ? [] : ["test/live/**"])],
  },
});

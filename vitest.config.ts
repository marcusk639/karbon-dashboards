import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    exclude: ["node_modules/**", "dist/**", ...(process.env.LIVE === "1" ? [] : ["test/live/**"]),
      ...(process.env.LIVE_DB === "1" ? [] : ["test/store/*.live.test.ts"])],
  },
});

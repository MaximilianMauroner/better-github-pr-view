import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "jsdom",
    environmentOptions: {
      jsdom: {
        url: "https://github.com/octocat/hello-world/pulls"
      }
    },
    include: ["tests/**/*.test.ts"]
  }
});

import { defineConfig } from "vitest/config";

export default defineConfig({
    test: {
        include: ["specs/**/*.test.ts"],
        exclude: ["specs/test-src/**", "node_modules/**", "dist/**"],
        testTimeout: 120_000,
        hookTimeout: 120_000,
        pool: "forks",
        fileParallelism: true,
        coverage: {
            provider: "v8",
            reporter: ["text", "json", "html", "lcov"],
            include: ["engine/**/*.ts"],
            exclude: [
                "engine/**/*.d.ts",
                "engine/benchmarks.ts",
            ],
            thresholds: {
                statements: 56,
                branches: 48,
                functions: 70,
                lines: 57,
            },
        },
    },
});

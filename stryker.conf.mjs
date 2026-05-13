const PACKAGE_CONFIGS = {
  agent: {
    mutate: [
      "packages/agent/src/**/*.ts",
      "!packages/agent/src/**/__tests__/**",
      "!packages/agent/src/**/*.test.ts",
      "!packages/agent/src/index.ts",
      "!packages/agent/src/hooks.ts",
      "!packages/agent/src/subagents/**",
      "!packages/agent/src/queryAudit.ts",
      "!packages/agent/src/wakeChannel.ts",
    ],
    testFiles: [
      "packages/agent/src/__tests__/autoQueue.test.ts",
      "packages/agent/src/__tests__/autoReviewHandler.test.ts",
      "packages/agent/src/__tests__/errorClassifier.test.ts",
      "packages/agent/src/__tests__/gitBranch.test.ts",
      "packages/agent/src/__tests__/notifier.test.ts",
      "packages/agent/src/__tests__/planChecker.test.ts",
      "packages/agent/src/__tests__/planLayers.test.ts",
      "packages/agent/src/__tests__/pollScheduler.test.ts",
      "packages/agent/src/__tests__/reviewContract.test.ts",
      "packages/agent/src/__tests__/reviewGate.test.ts",
      "packages/agent/src/__tests__/stageAbort.test.ts",
      "packages/agent/src/__tests__/stageErrorHandler.test.ts",
      "packages/agent/src/__tests__/stderrCollector.test.ts",
      "packages/agent/src/__tests__/taskWatchdog.test.ts",
    ],
    vitestConfigFile: "packages/agent/vitest.config.ts",
  },
  api: {
    mutate: [
      "packages/api/src/**/*.ts",
      "!packages/api/src/**/__tests__/**",
      "!packages/api/src/**/*.test.ts",
      "!packages/api/src/index.ts",
      "!packages/api/src/ws.ts",
      "!packages/api/src/middleware/**",
      "!packages/api/src/routes/projects.ts",
    ],
    testFiles: ["packages/api/src/__tests__/**/*.test.ts"],
    vitestConfigFile: "packages/api/vitest.config.ts",
  },
  data: {
    mutate: [
      "packages/data/src/**/*.ts",
      "!packages/data/src/**/__tests__/**",
      "!packages/data/src/**/*.test.ts",
    ],
    testFiles: ["packages/data/src/__tests__/**/*.test.ts"],
    vitestConfigFile: "packages/data/vitest.config.ts",
  },
  mcp: {
    mutate: [
      "packages/mcp/src/**/*.ts",
      "!packages/mcp/src/**/__tests__/**",
      "!packages/mcp/src/**/*.test.ts",
      "!packages/mcp/src/index.ts",
      "!packages/mcp/src/tools/*.ts",
    ],
    testFiles: ["packages/mcp/src/__tests__/**/*.test.ts"],
    vitestConfigFile: "packages/mcp/vitest.config.ts",
  },
  runtime: {
    mutate: [
      "packages/runtime/src/**/*.ts",
      "!packages/runtime/src/**/__tests__/**",
      "!packages/runtime/src/**/*.test.ts",
      "!packages/runtime/src/index.ts",
      "!packages/runtime/src/adapters/TEMPLATE.ts",
      "!packages/runtime/src/adapters/codex/appServer/generated/**",
      "!packages/runtime/src/adapters/codex/modelDiscovery.ts",
    ],
    testFiles: ["packages/runtime/src/__tests__/**/*.test.ts"],
    vitestConfigFile: "packages/runtime/vitest.config.ts",
  },
  shared: {
    mutate: [
      "packages/shared/src/**/*.ts",
      "!packages/shared/src/**/__tests__/**",
      "!packages/shared/src/**/*.test.ts",
      "!packages/shared/src/index.ts",
      "!packages/shared/src/browser.ts",
      "!packages/shared/src/types.ts",
      "!packages/shared/src/constants.ts",
      "!packages/shared/src/db.ts",
    ],
    testFiles: [
      "packages/shared/src/__tests__/attachments.test.ts",
      "packages/shared/src/__tests__/env.test.ts",
      "packages/shared/src/__tests__/gitIsolation.test.ts",
      "packages/shared/src/__tests__/loadEnv.test.ts",
      "packages/shared/src/__tests__/logger.test.ts",
      "packages/shared/src/__tests__/pathValidation.test.ts",
      "packages/shared/src/__tests__/planPath.test.ts",
      "packages/shared/src/__tests__/projectConfig.test.ts",
      "packages/shared/src/__tests__/projectInit.test.ts",
      "packages/shared/src/__tests__/runtimeLimitUtils.test.ts",
      "packages/shared/src/__tests__/stateMachine.test.ts",
      "packages/shared/src/__tests__/sync.test.ts",
      "packages/shared/src/__tests__/taskUsage.test.ts",
      "packages/shared/src/__tests__/telegram.test.ts",
      "packages/shared/src/__tests__/withTimeout.test.ts",
      "packages/shared/src/__tests__/workspaceResolutionGuard.test.ts",
    ],
    vitestConfigFile: "packages/shared/vitest.config.ts",
  },
  web: {
    mutate: [
      "packages/web/src/**/*.{ts,tsx}",
      "!packages/web/src/**/__tests__/**",
      "!packages/web/src/**/*.test.{ts,tsx}",
      "!packages/web/src/test-setup.ts",
      "!packages/web/src/main.tsx",
      "!packages/web/src/vite-env.d.ts",
    ],
    testFiles: ["packages/web/src/__tests__/**/*.{test,spec}.{ts,tsx}"],
    vitestConfigFile: "packages/web/vitest.config.ts",
  },
};

const packageName = process.env.AIF_MUTATION_PACKAGE;
const packageConfig = packageName ? PACKAGE_CONFIGS[packageName] : null;

if (!packageName || !packageConfig) {
  const validPackages = Object.keys(PACKAGE_CONFIGS).join(", ");
  throw new Error(
    `Set AIF_MUTATION_PACKAGE to one of: ${validPackages}. Prefer running npm run mutation.`,
  );
}

/**
 * Mutation testing is intentionally opt-in. Full monorepo runs are expensive;
 * `scripts/mutation.mjs` runs packages sequentially and forwards extra Stryker
 * CLI flags such as `--dryRunOnly`.
 */
export default {
  packageManager: "npm",
  testRunner: "vitest",
  coverageAnalysis: "perTest",
  concurrency: 2,
  reporters: ["clear-text", "progress", "html"],
  tempDirName: `.stryker-tmp/${packageName}`,
  ignorePatterns: [
    "/packages/**/dist/**",
    "/packages/**/coverage/**",
    "/packages/web/playwright-report/**",
    "/packages/web/test-results/**",
    "/art/**",
  ],
  mutate: packageConfig.mutate,
  testFiles: packageConfig.testFiles,
  vitest: {
    configFile: packageConfig.vitestConfigFile,
    related: false,
  },
  thresholds: {
    high: 80,
    low: 60,
    break: 50,
  },
};

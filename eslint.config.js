import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "node_modules",
      ".roark",
      "coverage",
      "dist",
      "repos/**",
      "eslint.config.js",
    ],
  },
  ...tseslint.configs.recommendedTypeChecked,
  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "@typescript-eslint/consistent-type-imports": [
        "error",
        {
          fixStyle: "inline-type-imports",
          prefer: "type-imports",
        },
      ],
      "@typescript-eslint/await-thenable": "error",
      "@typescript-eslint/consistent-type-exports": "error",
      "@typescript-eslint/no-confusing-void-expression": "error",
      "@typescript-eslint/no-deprecated": "warn",
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": [
        "error",
        {
          checksVoidReturn: {
            arguments: false,
            attributes: false,
          },
        },
      ],
      "@typescript-eslint/no-non-null-assertion": "error",
      "@typescript-eslint/no-unsafe-assignment": "error",
      "@typescript-eslint/no-unsafe-call": "error",
      "@typescript-eslint/no-unsafe-member-access": "error",
      "@typescript-eslint/no-unsafe-return": "error",
      "@typescript-eslint/no-unnecessary-condition": "error",
      "@typescript-eslint/no-unnecessary-type-assertion": "error",
      "@typescript-eslint/prefer-nullish-coalescing": [
        "error",
        {
          ignoreConditionalTests: false,
          ignoreMixedLogicalExpressions: false,
        },
      ],
      "@typescript-eslint/prefer-optional-chain": "error",
      "@typescript-eslint/return-await": [
        "error",
        "error-handling-correctness-only",
      ],
      "@typescript-eslint/restrict-template-expressions": [
        "error",
        {
          allowBoolean: false,
          allowNever: false,
          allowNullish: false,
          allowNumber: true,
          allowRegExp: false,
        },
      ],
      "@typescript-eslint/strict-boolean-expressions": [
        "error",
        {
          allowNullableBoolean: false,
          allowNullableNumber: false,
          allowNullableObject: true,
          allowNullableString: true,
          allowNumber: false,
          allowString: true,
        },
      ],
      "@typescript-eslint/switch-exhaustiveness-check": "error",
    },
  },
  {
    files: [
      "lib/workflow/{phases,tasks,git,readiness,progression,issue-curation}.ts",
      "lib/prompts/workflow-prompts.ts",
      "lib/presentation/phase.ts",
      "lib/structured-output/runner.ts",
      "lib/observability/{observer,events,summary}.ts",
      "lib/issue-curation/{create-issues,labels}.ts",
      "lib/issue-publishing/{github,service}.ts",
      "lib/autorun/{discovery,continue,continue-plan,copy-path,observability,attempt-lifecycle,completion,publish-flow,publish,branch,labels,failure,triage-stop,ledger-comments,lock,verification,workspace,workspace-service}.ts",
      "lib/pr-review/{workflow,artifacts}.ts",
      "lib/github/{labels,pr-publishing,service}.ts",
    ],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: [
                "**/*-promise.ts",
                "**/promise-boundary.ts",
                "**/runtime/application.ts",
              ],
              message:
                "Workflow internals compose native Effects; Promise adapters belong at entry points.",
            },
          ],
        },
      ],
      "no-restricted-syntax": [
        "error",
        {
          selector:
            ":matches(FunctionDeclaration, FunctionExpression, ArrowFunctionExpression)[async=true]",
          message:
            "Workflow operations compose Effects; adapt Promise APIs at their external boundary.",
        },
        {
          selector: "TryStatement:has(YieldExpression)",
          message:
            "Handle yielded Effect failures with Effect combinators, not JavaScript try/catch.",
        },
        {
          selector:
            "CallExpression[callee.object.name='Effect'][callee.property.name=/^run(Promise|Sync|Fork|Callback)/]",
          message:
            "Only application entry points may execute an Effect runtime.",
        },
      ],
    },
  },
);

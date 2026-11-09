/**
 * ESLint Configuration for BelivrHQ Backend
 *
 * Uses @typescript-eslint for TypeScript-specific linting rules
 * and Prettier for code formatting integration.
 *
 * @see https://eslint.org/docs/user-guide/configuring
 * @see https://typescript-eslint.io/getting-started
 */

module.exports = {
  // Use the TypeScript ESLint parser to enable parsing of TypeScript syntax.
  // This allows ESLint to understand TypeScript-specific constructs like
  // interfaces, type annotations, decorators, and enums.
  parser: '@typescript-eslint/parser',

  parserOptions: {
    // Point to the tsconfig.json so the parser can resolve types and
    // understand the project's TypeScript configuration.
    project: 'tsconfig.eslint.json',
    tsconfigRootDir: __dirname,
    // Parse files as ES modules (required for import/export syntax).
    sourceType: 'module',
  },

  // Plugins extend ESLint's core rules with additional functionality.
  // @typescript-eslint adds TypeScript-specific linting rules.
  plugins: ['@typescript-eslint/eslint-plugin'],

  // Extends merge pre-built configurations into the base config.
  // Order matters: later configs override earlier ones.
  extends: [
    // Apply recommended TypeScript-ESLint rules (subset of all rules).
    'plugin:@typescript-eslint/recommended',
    // Apply Prettier integration — disables formatting rules that conflict
    // with Prettier and reports formatting issues as ESLint errors.
    'plugin:prettier/recommended',
  ],

  // Mark this as the root ESLint config to stop ESLint from searching
  // parent directories (prevents conflicts with root-level configs).
  root: true,

  // Define global variables available in the environment.
  env: {
    node: true,   // Enable Node.js globals (process, __dirname, require, etc.)
    jest: true,   // Enable Jest globals (describe, it, expect, beforeEach, etc.)
  },

  // Files to exclude from linting.
  ignorePatterns: ['.eslintrc.js', '.config/prisma.config.*'],

  // Operations helpers are standalone Node scripts, outside the TS project.
  overrides: [{
    files: ['scripts/ops/**/*.cjs', 'test/ops/**/*.cjs', 'test/load/**/*.cjs', 'test/load/**/*.mjs', 'test/load/**/*.js'],
    parserOptions: { project: null, ecmaVersion: 2022 },
    rules: {
      '@typescript-eslint/no-var-requires': 'off',
      '@typescript-eslint/no-require-imports': 'off',
    },
  }],

  // Custom rule overrides.
  // These rules extend or relax the recommended rules for this project.
  rules: {
    // Allow interfaces without the "I" prefix (e.g., UserService instead of IUserService).
    '@typescript-eslint/interface-name-prefix': 'off',

    // Allow functions without explicit return types. This is relaxed for
    // brevity in NestJS handlers and callbacks where TypeScript infers the type.
    '@typescript-eslint/explicit-function-return-type': 'off',

    // Allow module boundaries (controllers, services) without explicit return
    // types on exported functions. TypeScript inference is sufficient here.
    '@typescript-eslint/explicit-module-boundary-types': 'off',

    // Warn on usage of `any` type instead of erroring. Encourages gradual
    // type improvement without blocking development.
    '@typescript-eslint/no-explicit-any': 'warn',

    // Error on unused variables, but ignore parameters prefixed with underscore.
    // Convention: function parameters starting with _ (e.g., _id) are intentionally unused.
    '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
  },
};

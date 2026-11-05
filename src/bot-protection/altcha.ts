// altcha-lib 2.x exports CJS correctly, but its legacy `types` field points at a
// missing file. Resolve declarations directly for this project's node10 resolver;
// Runtime imports use literal require() calls so Vercel's dependency tracer
// includes these public package exports in the deployed function.
export type { Challenge, Payload } from 'altcha-lib/dist/esm/v2/types';
export const { createChallenge, verifySolution, solveChallenge } =
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- literal CJS imports are required for serverless tracing with legacy TS resolution.
  require('altcha-lib') as typeof import('altcha-lib/dist/esm/v2/pow');
export const { deriveKey } =
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- see the declaration-resolution compatibility note above.
  require('altcha-lib/algorithms/sha') as typeof import('altcha-lib/dist/esm/v2/algorithms/sha');

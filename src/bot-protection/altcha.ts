import { createRequire } from 'node:module';
// altcha-lib 2.x exports CJS correctly, but its legacy `types` field points at a
// missing file. Resolve declarations directly for this project's node10 resolver;
// runtime imports still use the package's supported public exports.
export type { Challenge, Payload } from 'altcha-lib/dist/esm/v2/types';
const load = createRequire(__filename);
export const { createChallenge, verifySolution, solveChallenge } = load(
  'altcha-lib',
) as typeof import('altcha-lib/dist/esm/v2/pow');
export const { deriveKey } = load(
  'altcha-lib/algorithms/sha',
) as typeof import('altcha-lib/dist/esm/v2/algorithms/sha');

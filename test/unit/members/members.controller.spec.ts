/**
 * @file Regression guards for MembersController route ordering.
 *
 * Express matches routes in declaration order: literal paths such as
 * /members/search and /members/export/* MUST be declared before the
 * parameterized @Get(':memberId') route or they are shadowed by it
 * (memberId = "search" / "export").
 *
 * Asserted against the source text to avoid pulling the controller's
 * transitive ESM-only dependencies into the Jest runtime.
 */

import * as fs from 'fs';
import * as path from 'path';

const CONTROLLER_PATH = path.join(__dirname, '../../../src/members/members.controller.ts');

describe('MembersController route ordering', () => {
  const source = fs.readFileSync(CONTROLLER_PATH, 'utf8');

  const indexOfDecorator = (match: string) => {
    const idx = source.indexOf(match);
    expect(idx).toBeGreaterThan(-1);
    return idx;
  };

  it('declares literal GET routes before the :memberId param route', () => {
    const findOneIdx = indexOfDecorator("@Get(':memberId')\n  @ApiGetEndpoint('Get member by ID'");

    for (const literal of [
      "@Get('dashboard')",
      "@Get('search')",
      "@Get('export/csv')",
      "@Get('export/xlsx')",
    ]) {
      expect(indexOfDecorator(literal)).toBeLessThan(findOneIdx);
    }
  });
});

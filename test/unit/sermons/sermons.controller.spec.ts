/**
 * @file Regression guards for SermonsController permission decorators.
 *
 * The global PermissionsGuard only enforces routes that carry
 * @RequirePermissions. Every sermons route must declare its surface-level
 * permission (create -> sermons:new:create, list -> sermons:list:read,
 * series -> sermons:series:read, speakers -> sermons:speakers:read, detail ->
 * sermons:list:read, update/delete stay coarse sermons:update/delete) while the
 * member-scoped bookmark endpoints stay auth-only.
 *
 * Asserted against the source text to avoid pulling the controller's
 * transitive ESM-only dependencies into the Jest runtime.
 */

import * as fs from 'fs';
import * as path from 'path';

const CONTROLLER_PATH = path.join(__dirname, '../../../src/sermons/sermons.controller.ts');

describe('SermonsController permission decorators', () => {
  const source = fs.readFileSync(CONTROLLER_PATH, 'utf8');

  const blockBetween = (start: string, end: string): string => {
    const startIdx = source.indexOf(start);
    expect(startIdx).toBeGreaterThan(-1);
    const endIdx = source.indexOf(end, startIdx);
    expect(endIdx).toBeGreaterThan(-1);
    return source.slice(startIdx, endIdx);
  };

  it('requires sermons:new:create on POST /sermons', () => {
    expect(blockBetween('@Post()', 'async createSermon(')).toContain(
      "@RequirePermissions('sermons:new:create')",
    );
  });

  it('requires sermons:list:read on GET /sermons', () => {
    expect(blockBetween('@Get()', 'async listSermons(')).toContain(
      "@RequirePermissions('sermons:list:read')",
    );
  });

  it('requires sermons:series:read on GET /sermons/series', () => {
    expect(blockBetween("@Get('series')", 'async listSeries(')).toContain(
      "@RequirePermissions('sermons:series:read')",
    );
  });

  it('requires sermons:speakers:read on GET /sermons/speakers', () => {
    expect(blockBetween("@Get('speakers')", 'async listSpeakers(')).toContain(
      "@RequirePermissions('sermons:speakers:read')",
    );
  });

  it('authorizes create and edit suggestions with their respective form grants', () => {
    expect(blockBetween("@Get('new/options')", 'async newSermonOptions(')).toContain(
      "@RequirePermissions('sermons:new:create')",
    );
    expect(blockBetween("@Get('edit/options')", 'async editSermonOptions(')).toContain(
      "@RequirePermissions('sermons:update')",
    );
    expect(source.indexOf("@Get('new/options')")).toBeLessThan(source.indexOf("@Get(':sermonId')"));
    expect(source.indexOf("@Get('edit/options')")).toBeLessThan(
      source.indexOf("@Get(':sermonId')"),
    );
  });

  it('requires sermons:list:read on GET /sermons/:sermonId', () => {
    expect(blockBetween("@Get(':sermonId')", 'async getSermon(')).toContain(
      "@RequirePermissions('sermons:list:read')",
    );
  });

  it('requires sermons:update on PATCH /sermons/:sermonId', () => {
    expect(blockBetween("@Patch(':sermonId')", 'async updateSermon(')).toContain(
      "@RequirePermissions('sermons:update')",
    );
  });

  it('requires sermons:delete on DELETE /sermons/:sermonId', () => {
    expect(blockBetween("@Delete(':sermonId')", 'async deleteSermon(')).toContain(
      "@RequirePermissions('sermons:delete')",
    );
  });

  it('guards POST /sermons/:sermonId/archive with role + sermons:update', () => {
    const block = blockBetween("@Post(':sermonId/archive')", 'async archiveSermon(');
    expect(block).toContain("@RequirePermissions('sermons:update')");
    expect(block).not.toContain('@RequireRoles(');
  });

  it('guards POST /sermons/:sermonId/restore with role + sermons:update', () => {
    const block = blockBetween("@Post(':sermonId/restore')", 'async restoreSermon(');
    expect(block).toContain("@RequirePermissions('sermons:update')");
    expect(block).not.toContain('@RequireRoles(');
  });

  it('keeps bookmark endpoints auth-only (no permission leak to admin reads)', () => {
    const bookmarksStart = source.indexOf('// ─── BOOKMARKS');
    expect(bookmarksStart).toBeGreaterThan(-1);
    const bookmarksBlock = source.slice(bookmarksStart);
    expect(bookmarksBlock).not.toContain('@RequirePermissions(');
  });
});

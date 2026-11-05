import { RequestContextService } from '../../../src/common/services/request-context.service';
/**
 * @file branch-scope.service.spec.ts
 * @description Unit tests for BranchScopeService — the single point of truth
 * for the branch-vs-church-wide data-scoping decision (admin-hq flag).
 */
import { BranchScopeService } from '../../../src/common/services/branch-scope.service';

describe('BranchScopeService', () => {
  let service: BranchScopeService;

  const hqBranchId = '10000000-0000-0000-0000-000000000000';
  const branchId = '11111111-1111-1111-1111-111111111111';
  const memberId = '22222222-2222-2222-2222-222222222222';

  beforeEach(() => {
    service = new BranchScopeService(new RequestContextService());
  });

  describe('resolve', () => {
    it('returns church-wide scope when there is no viewer', () => {
      expect(service.resolve()).toEqual({ churchOnly: true });
      expect(service.resolve(null)).toEqual({ churchOnly: true });
    });

    it('returns church-wide scope for an admin-hq holder', () => {
      const viewer = {
        church_id: 'church',
        branch_id: branchId,
        role: 'branch_pastor',
        is_admin_hq: true,
      };
      expect(service.resolve(viewer)).toEqual({ churchOnly: true });
    });

    it('restricts a non-HQ viewer to their own branch', () => {
      const viewer = {
        church_id: 'church',
        branch_id: branchId,
        role: 'branch_pastor',
        is_admin_hq: false,
      };
      expect(service.resolve(viewer)).toEqual({ churchOnly: false, branchId });
    });

    it('restricts a viewer with no branch to an undefined branch', () => {
      const viewer = {
        church_id: 'church',
        role: 'secretary',
        is_admin_hq: false,
      };
      expect(service.resolve(viewer)).toEqual({
        churchOnly: false,
        branchId: '00000000-0000-0000-0000-000000000000',
      });
    });
  });

  describe('isBranchRestricted', () => {
    it('is false for HQ holders and no viewer', () => {
      expect(service.isBranchRestricted(null)).toBe(false);
      expect(
        service.isBranchRestricted({
          church_id: 'c',
          branch_id: branchId,
          role: 'x',
          is_admin_hq: true,
        }),
      ).toBe(false);
    });

    it('is true for a non-HQ viewer', () => {
      expect(
        service.isBranchRestricted({
          church_id: 'c',
          branch_id: branchId,
          role: 'x',
          is_admin_hq: false,
        }),
      ).toBe(true);
    });
  });

  describe('isVisible', () => {
    it('sees everything with no viewer or as HQ', () => {
      expect(service.isVisible(null, branchId)).toBe(true);
      expect(
        service.isVisible(
          { church_id: 'c', branch_id: hqBranchId, role: 'x', is_admin_hq: true },
          branchId,
        ),
      ).toBe(true);
    });

    it("only sees rows in the viewer's own branch", () => {
      const viewer = { church_id: 'c', branch_id: branchId, role: 'x', is_admin_hq: false };
      expect(service.isVisible(viewer, branchId)).toBe(true);
      expect(service.isVisible(viewer, hqBranchId)).toBe(false);
    });

    it('sees nothing when the viewer has no branch', () => {
      const viewer = { church_id: 'c', role: 'x', is_admin_hq: false };
      expect(service.isVisible(viewer, branchId)).toBe(false);
      expect(service.isVisible(viewer, null)).toBe(false);
    });
  });

  describe('resolveCellGroupScope', () => {
    it('returns church-wide for HQ holders and no viewer', () => {
      expect(service.resolveCellGroupScope(null)).toEqual({ churchOnly: true });
      expect(
        service.resolveCellGroupScope({
          church_id: 'c',
          branch_id: branchId,
          role: 'x',
          is_admin_hq: true,
        }),
      ).toEqual({ churchOnly: true });
    });

    it('scopes a cell_leader (non-HQ) to the groups they lead', () => {
      const viewer = {
        church_id: 'c',
        branch_id: branchId,
        member_id: memberId,
        role: 'cell_leader',
        permissions: ['cell_groups:own:read', 'cell_groups:own:update'],
        roles: ['cell_leader'],
        is_admin_hq: false,
      };
      expect(service.resolveCellGroupScope(viewer)).toEqual({
        churchOnly: false,
        leaderId: memberId,
      });
    });

    it('detects cell_leader from the roles array even when not primary', () => {
      const viewer = {
        church_id: 'c',
        branch_id: branchId,
        member_id: memberId,
        role: 'secretary',
        roles: ['secretary', 'cell_leader'],
        permissions: ['cell_groups:own:read'],
        is_admin_hq: false,
      };
      expect(service.resolveCellGroupScope(viewer)).toEqual({
        churchOnly: false,
        leaderId: memberId,
      });
    });

    it('scopes other non-HQ viewers to their own branch', () => {
      const viewer = {
        church_id: 'c',
        branch_id: branchId,
        role: 'branch_pastor',
        is_admin_hq: false,
      };
      expect(service.resolveCellGroupScope(viewer)).toEqual({
        churchOnly: false,
        branchId,
      });
    });
  });

  describe('resolveDepartmentScope', () => {
    it('returns church-wide for HQ holders and no viewer', () => {
      expect(service.resolveDepartmentScope(null)).toEqual({ churchOnly: true });
      expect(
        service.resolveDepartmentScope({
          church_id: 'c',
          branch_id: branchId,
          role: 'department_head',
          permissions: ['departments:own:read', 'departments:own:update'],
          is_admin_hq: true,
        }),
      ).toEqual({ churchOnly: true });
    });

    it('scopes a department_head (non-HQ) to the departments they head', () => {
      const viewer = {
        church_id: 'c',
        branch_id: branchId,
        member_id: memberId,
        role: 'department_head',
        permissions: ['departments:own:read', 'departments:own:update'],
        roles: ['department_head'],
        is_admin_hq: false,
      };
      expect(service.resolveDepartmentScope(viewer)).toEqual({
        churchOnly: false,
        headId: memberId,
      });
    });

    it('detects department_head from the roles array even when not primary', () => {
      const viewer = {
        church_id: 'c',
        branch_id: branchId,
        member_id: memberId,
        role: 'secretary',
        roles: ['secretary', 'department_head'],
        permissions: ['departments:own:read'],
        is_admin_hq: false,
      };
      expect(service.resolveDepartmentScope(viewer)).toEqual({
        churchOnly: false,
        headId: memberId,
      });
    });

    it('stays church-wide for other non-HQ viewers (departments are not branch-scoped)', () => {
      const viewer = {
        church_id: 'c',
        branch_id: branchId,
        role: 'branch_pastor',
        is_admin_hq: false,
      };
      expect(service.resolveDepartmentScope(viewer)).toEqual({ churchOnly: false, branchId });
    });
  });
});

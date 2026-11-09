/**
 * @file request-context.service.ts
 * @description AsyncLocalStorage-based service for per-request tenant context.
 *
 * Stores { userId, churchId, branchId, role } in Node.js AsyncLocalStorage
 * so any service in the call stack can retrieve the current request context
 * without explicit parameter passing.
 *
 * @module common/services/request-context
 * @since 1.0.0
 */

import { ForbiddenException, Injectable } from '@nestjs/common';
import type { ViewerScope } from './branch-scope.service';
import { AsyncLocalStorage } from 'async_hooks';

export interface RequestContextData {
  userId: string;
  churchId: string;
  branchId?: string;
  role: string;
  viewer?: ViewerScope;
}

const asyncLocalStorage = new AsyncLocalStorage<RequestContextData>();

@Injectable()
export class RequestContextService {
  /**
   * Runs a callback within a request context.
   *
   * @param context - The tenant context to attach to the current async scope
   * @param callback - The function to execute within the context
   * @returns The return value of the callback
   *
   * @example
   * ```typescript
   * await this.requestContext.run(
   *   { userId, churchId, role: 'church_admin' },
   *   () => this.membersService.findAll(),
   * );
   * ```
   */
  run<T>(context: RequestContextData, callback: () => T | Promise<T>): Promise<T> | T {
    return asyncLocalStorage.run(context, callback);
  }

  /**
   * Retrieves the current request context from async storage.
   *
   * @returns The current context, or undefined if called outside a request
   *
   * @example
   * ```typescript
   * const ctx = this.requestContext.getStore();
   * if (ctx) {
   *   console.log(ctx.churchId); // Scoped to current request
   * }
   * ```
   */
  getStore(): RequestContextData | undefined {
    return asyncLocalStorage.getStore();
  }

  /** Direct branch-owned records; missing branches fail closed. */
  branchWhere(churchId: string): { branch_id?: string } {
    const context = this.getStore();
    // Background jobs have no HTTP context and supply their own tenant scope.
    if (!context) return {};
    const viewer = context.viewer;
    if (!viewer || context.churchId !== churchId || viewer.church_id !== churchId)
      throw new ForbiddenException('Invalid tenant context');
    if (viewer.is_admin_hq) return {};
    return { branch_id: viewer.branch_id ?? '00000000-0000-0000-0000-000000000000' };
  }

  branchOrSharedWhere(churchId: string): { OR?: { branch_id: string | null }[] } {
    const branchId = this.branchWhere(churchId).branch_id;
    return branchId ? { OR: [{ branch_id: branchId }, { branch_id: null }] } : {};
  }

  branchIdForWrite(churchId: string, requested?: string | null): string | undefined {
    const ownBranch = this.branchWhere(churchId).branch_id;
    if (!ownBranch) return requested ?? undefined;
    if (ownBranch === '00000000-0000-0000-0000-000000000000')
      throw new ForbiddenException('A branch assignment is required');
    if (requested != null && requested !== ownBranch)
      throw new ForbiddenException('You can only manage records in your branch');
    return ownBranch;
  }

  /**
   * Retrieves the current churchId from the request context.
   * Throws if no context is available.
   */
  getChurchId(): string {
    const ctx = this.getStore();
    if (!ctx) {
      throw new Error('RequestContext not available: ensure middleware is registered');
    }
    return ctx.churchId;
  }

  /**
   * Retrieves the current userId from the request context.
   * Throws if no context is available.
   */
  getUserId(): string {
    const ctx = this.getStore();
    if (!ctx) {
      throw new Error('RequestContext not available: ensure middleware is registered');
    }
    return ctx.userId;
  }
}

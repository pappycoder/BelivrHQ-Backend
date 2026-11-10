import type { SubscriptionSnapshot } from '../../billing/entitlements';
import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import type { JWTPayload } from 'jose';
import { Request } from 'express';
import { SupabaseJwtPayload } from '../../auth/strategies/jwt.strategy';

/**
 * Interface representing the authenticated Supabase user.
 * Extracted from the JWT token after verification by JwtAuthGuard.
 */
export type SupabaseUser = SupabaseJwtPayload;

/**
 * Interface representing the full request with authenticated user context.
 * The JwtAuthGuard attaches `user` and `profile` to the request.
 */
export interface AuthenticatedRequest extends Request {
  subscriptionSnapshot?: SubscriptionSnapshot;
  verifiedJwt?: JWTPayload;
  /** The authenticated Supabase user */
  user: SupabaseJwtPayload;
  /** The user's BelivrHQ profile (role, church_id, branch_id) */
  profile?: {
    id: string;
    church_id: string;
    branch_id?: string;
    /** Linked member id (for cell_leader own-group scoping) */
    member_id?: string;
    /** Primary role (highest rank held) */
    role: string;
    /** All roles held, ordered by rank descending */
    roles?: string[];
    status?: string;
    /** Set when the profile's church is archived (ISO string) */
    church_archived_at?: string;
    profile_archived_at?: string;
    /** HQ access override: when true, the viewer sees data from ALL branches */
    is_admin_hq?: boolean;
    permissions?: string[];
    subscriptionReadOnly?: boolean;
    subscriptionPaidUntil?: string;
    two_factor_enabled?: boolean;
    authenticator?: { revision: string } | null;
  };
}

/**
 * Parameter decorator to extract the authenticated user from the request.
 *
 * Can extract the full user object or a specific property.
 *
 * @param data - Optional property name to extract (e.g., 'id', 'email')
 * @returns The authenticated user or the specified property
 *
 * @example
 * ```typescript
 * // Get full user object
 * @Get('profile')
 * async getProfile(@CurrentUser() user: SupabaseUser) {
 *   return user;
 * }
 *
 * // Get just the user ID
 * @Get('profile')
 * async getProfile(@CurrentUser('id') userId: string) {
 *   return userId;
 * }
 * ```
 */
export const CurrentUser = createParamDecorator(
  (data: keyof SupabaseUser | undefined, ctx: ExecutionContext) => {
    const request = ctx.switchToHttp().getRequest<AuthenticatedRequest>();
    const user = request.user;

    if (!user) {
      return null;
    }

    return data ? user[data] : user;
  },
);

/**
 * Parameter decorator to extract the authenticated user's profile from the request.
 *
 * The profile contains church-specific context: church_id, branch_id, role, permissions.
 * This is populated by the SupabaseAuthGuard after verifying the JWT and fetching
 * the user's profile from the database.
 *
 * @param data - Optional property name to extract (e.g., 'church_id', 'role')
 * @returns The user's profile or the specified property
 *
 * @example
 * ```typescript
 * // Get full profile
 * @Get('church-data')
 * async getChurchData(@CurrentUserProfile() profile: UserProfile) {
 *   return profile;
 * }
 *
 * // Get just the church_id
 * @Get('church-data')
 * async getChurchData(@CurrentUserProfile('church_id') churchId: string) {
 *   return churchId;
 * }
 * ```
 */
export const CurrentUserProfile = createParamDecorator(
  (data: string | undefined, ctx: ExecutionContext) => {
    const request = ctx.switchToHttp().getRequest<AuthenticatedRequest>();
    const profile = request.profile;

    if (!profile) {
      return null;
    }

    return data ? (profile as Record<string, unknown>)[data] : profile;
  },
);

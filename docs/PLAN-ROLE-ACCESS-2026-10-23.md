# Subscription roles and permissions

| Plan | Staff capacity | Assignable staff roles | Custom roles |
| --- | --- | --- | --- |
| Essentials | 2 active staff accounts total | Existing Church Admin plus one Senior Pastor, Branch Pastor or Secretary; one role on the additional account | Unavailable |
| Community | 5 active staff accounts total | All built-in church staff roles; multiple roles per user supported | Unavailable |
| Network | 15 active staff accounts total | All built-in church staff roles and church-owned custom roles | Create, assign and configure |
| Enterprise | Agreed staff capacity | Network role functionality | Create, assign and configure |

Prices, member/location allowances and staff capacities are unchanged. Church Admin can assign Senior Pastor within the subscription policy; platform Super Admin remains protected and absent from church pickers.

## Enforcement

- `billing/role-policy.ts` supplies assignment policy for both invitation APIs, single/full profile role replacement and legacy church staff role changes. Tenant ownership, existing self-change/platform-account protections, caller permissions and branch validation still apply.
- `staff_roles` starts on Community and `custom_roles` on Network. `roles:create` maps to `custom_roles`; creation and owned-role permission changes additionally validate entitlements in the service.
- All role update DTOs now accept church-owned names, with actual role lookup, plan and actor checks in the services.
- Effective user permissions discard roles outside the current plan before looking in the role cache. Cache namespace v30 replaces v29. An ineligible custom role cannot keep granting access after downgrade.
- Role summaries and assignment pickers follow the plan. Essentials retains the current administrator when editing their existing assignment, but never offers a new Church Admin invitation. Its role selection is single-choice. Low-plan custom-role detail pages cannot edit the retained role.
- Existing transactional staff reservations and capacity triggers enforce the two/five/fifteen account totals, including concurrent invitations and reactivation.
- Migration `20261023120000_plan_role_access` updates the SQL feature catalog, blocks church-owned role creation/updates below Network, and checks new/reactivated role assignments. First administrator provisioning remains possible before registration payment. It does not rewrite existing accounts or delete roles.

## Downgrades and existing data

Existing profiles, custom roles, stored assignments and historical records are retained. Roles that are outside the new plan stop contributing effective permissions immediately; upgrade again or assign an eligible role to restore staff access. No users are automatically deleted or deactivated. Previously existing administrator assignments are preserved; a new extra administrator cannot be assigned on Essentials. Existing capacity enforcement blocks growth above the current allowance rather than deleting excess historical accounts.

## Display and deployment

Landing pricing, plan details and subscription billing cards share `BelivrHQ-Web/src/components/marketing/plans.ts`. All show the role differences. The assistant policy and generated server catalog match the new features.

Apply the migration to the target database, regenerate Prisma and deploy API/web together. No production database migration, live invitation or deployment was performed in this task. Local checks cover allowed/blocked plan assignments, custom-role creation and downgrade caching, real database role triggers and concurrent final staff-seat allocation, plus the plan-specific browser pickers and public pricing copy.

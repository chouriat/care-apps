// F-5 [safety]: Server-side entitlement check for Edge Functions.
// Spec: docs/spec/carecircle.md > Part 1 > Entitlements.
// Server code reads entitlements only from public.entitlements, never from client claims.

export type CareCircleEntitlementId = 'carecircle_family';
export const CARECIRCLE_FAMILY_ENTITLEMENT: CareCircleEntitlementId = 'carecircle_family';

export interface EntitlementRow {
  user_id: string;
  entitlement: CareCircleEntitlementId;
  active: boolean;
  expires_at: string | null;
}

export interface EntitlementReadStore {
  getEntitlement(
    userId: string,
    entitlement: CareCircleEntitlementId,
  ): Promise<{ data: EntitlementRow | null; error: { message: string } | null }>;
}

export type ServerEntitlementVerification =
  | { allowed: true }
  | { allowed: false; reason: 'ENTITLEMENT_REQUIRED' | 'STORE_ERROR' };

export interface VerifyServerEntitlementInput {
  authenticatedUserId: string;
  entitlement?: CareCircleEntitlementId;
  clientClaim?: unknown;
  store: EntitlementReadStore;
  now?: Date;
}

export async function verifyServerEntitlement(
  input: VerifyServerEntitlementInput,
): Promise<ServerEntitlementVerification> {
  const userId =
    typeof input.authenticatedUserId === 'string' ? input.authenticatedUserId.trim() : '';
  if (!userId) {
    return { allowed: false, reason: 'ENTITLEMENT_REQUIRED' };
  }

  const targetEntitlement: CareCircleEntitlementId =
    input.entitlement ?? CARECIRCLE_FAMILY_ENTITLEMENT;
  const nowMs = (input.now ?? new Date()).getTime();

  let lookup: { data: EntitlementRow | null; error: { message: string } | null };
  try {
    lookup = await input.store.getEntitlement(userId, targetEntitlement);
  } catch {
    return { allowed: false, reason: 'STORE_ERROR' };
  }

  if (lookup.error !== null) {
    return { allowed: false, reason: 'STORE_ERROR' };
  }

  const row = lookup.data;
  if (!row) {
    return { allowed: false, reason: 'ENTITLEMENT_REQUIRED' };
  }

  if (
    typeof row !== 'object' ||
    row.user_id !== userId ||
    row.entitlement !== targetEntitlement ||
    typeof row.active !== 'boolean'
  ) {
    return { allowed: false, reason: 'ENTITLEMENT_REQUIRED' };
  }

  if (row.active !== true) {
    return { allowed: false, reason: 'ENTITLEMENT_REQUIRED' };
  }

  if (row.expires_at !== null) {
    if (typeof row.expires_at !== 'string') {
      return { allowed: false, reason: 'STORE_ERROR' };
    }
    const expiresMs = Date.parse(row.expires_at);
    if (Number.isNaN(expiresMs)) {
      return { allowed: false, reason: 'STORE_ERROR' };
    }
    if (expiresMs <= nowMs) {
      return { allowed: false, reason: 'ENTITLEMENT_REQUIRED' };
    }
  }

  return { allowed: true };
}

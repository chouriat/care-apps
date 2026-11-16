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

export interface CircleOwnerLookupStore extends EntitlementReadStore {
  getCircleOwnerUserId(
    circleId: string,
  ): Promise<{ data: string | null; error: { message: string } | null }>;
}

export interface VerifyCircleFamilyEntitlementInput {
  circleId: string;
  store: CircleOwnerLookupStore;
  now?: Date;
}

/**
 * Checks whether a circle is on the CareCircle Family plan by looking up the circle owner's
 * `user_id` in `public.circle_members` (`role = 'owner'`) and verifying their `carecircle_family`
 * row in `public.entitlements` via `verifyServerEntitlement` (same rule as `accept_invite`).
 */
export async function verifyCircleFamilyEntitlement(
  input: VerifyCircleFamilyEntitlementInput,
): Promise<ServerEntitlementVerification> {
  const circleId = typeof input.circleId === 'string' ? input.circleId.trim() : '';
  if (!circleId) {
    return { allowed: false, reason: 'ENTITLEMENT_REQUIRED' };
  }

  let ownerLookup: { data: string | null; error: { message: string } | null };
  try {
    ownerLookup = await input.store.getCircleOwnerUserId(circleId);
  } catch {
    return { allowed: false, reason: 'STORE_ERROR' };
  }

  if (ownerLookup.error !== null) {
    return { allowed: false, reason: 'STORE_ERROR' };
  }

  const ownerUserId = ownerLookup.data;
  if (!ownerUserId) {
    return { allowed: false, reason: 'ENTITLEMENT_REQUIRED' };
  }

  return verifyServerEntitlement({
    authenticatedUserId: ownerUserId,
    entitlement: CARECIRCLE_FAMILY_ENTITLEMENT,
    store: input.store,
    now: input.now,
  });
}

export function createPostgrestCircleEntitlementStore(
  fetchImpl: typeof fetch,
  getEnv: (key: string) => string | undefined,
): CircleOwnerLookupStore {
  return {
    async getCircleOwnerUserId(circleId: string) {
      const url = getEnv('SUPABASE_URL');
      const apikey = getEnv('SUPABASE_SERVICE_ROLE_KEY');
      if (!url || !apikey) {
        return { data: null, error: { message: 'circle owner lookup not configured' } };
      }
      const query = `circle_id=eq.${encodeURIComponent(circleId)}&role=eq.owner&select=user_id&limit=1`;
      const res = await fetchImpl(`${url}/rest/v1/circle_members?${query}`, {
        method: 'GET',
        headers: {
          authorization: `Bearer ${apikey}`,
          apikey,
        },
      });
      if (!res.ok) {
        return { data: null, error: { message: `circle_members owner lookup HTTP ${res.status}` } };
      }
      const rows = (await res.json()) as Array<{ user_id?: unknown }>;
      const ownerId =
        Array.isArray(rows) && typeof rows[0]?.user_id === 'string' ? rows[0].user_id : null;
      return { data: ownerId, error: null };
    },

    async getEntitlement(userId: string, entitlement: CareCircleEntitlementId) {
      const url = getEnv('SUPABASE_URL');
      const apikey = getEnv('SUPABASE_SERVICE_ROLE_KEY');
      if (!url || !apikey) {
        return { data: null, error: { message: 'entitlements lookup not configured' } };
      }
      const query = `user_id=eq.${encodeURIComponent(userId)}&entitlement=eq.${encodeURIComponent(entitlement)}&select=user_id,entitlement,active,expires_at&limit=1`;
      const res = await fetchImpl(`${url}/rest/v1/entitlements?${query}`, {
        method: 'GET',
        headers: {
          authorization: `Bearer ${apikey}`,
          apikey,
        },
      });
      if (!res.ok) {
        return { data: null, error: { message: `entitlements lookup HTTP ${res.status}` } };
      }
      const rows = (await res.json()) as EntitlementRow[];
      return {
        data: Array.isArray(rows) && rows[0] ? rows[0] : null,
        error: null,
      };
    },
  };
}

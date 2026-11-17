// CC-10 [safety 2/2]: `delete-account` Edge Function handler (`POST /functions/v1/delete-account`).
// Spec: `docs/spec/carecircle.md` > Account deletion & APIs (`POST /functions/v1/delete-account`).

export interface DeleteAccountState {
  authUsers: Set<string>;
  users_profile: Array<{ user_id: string }>;
  circle_members: Array<{
    circle_id: string;
    user_id: string;
    role: 'owner' | 'helper' | 'viewer';
  }>;
  push_tokens: Array<{ user_id: string; token: string }>;
  entitlements: Array<{ user_id: string; entitlement: string }>;
  ai_calls: Array<{ id: string; user_id: string }>;
  circles: Array<{ id: string; created_by: string | null }>;
  invites: Array<{ id: string; circle_id: string; used_by: string | null }>;
  medications: Array<{ id: string; circle_id: string }>;
  dose_events: Array<{ id: string; circle_id: string; acted_by: string | null }>;
  appointments: Array<{ id: string; circle_id: string; driver_user_id: string | null }>;
  tasks: Array<{
    id: string;
    circle_id: string;
    assignee: string | null;
    done_by: string | null;
  }>;
  visit_notes: Array<{ id: string; circle_id: string; created_by: string | null }>;
  log_entries: Array<{
    id: string;
    circle_id: string;
    created_by: string | null;
    ref_id: string | null;
  }>;
  storageObjects: Record<string, string[]>;
}

export interface DeleteAccountDeps {
  verifyJwt?: (token: string) => Promise<{ userId: string } | null>;
  state?: DeleteAccountState;
  fetchImpl?: typeof fetch;
  getEnv?: (key: string) => string | undefined;
  logger?: (entry: Record<string, unknown>) => void;
}

function jsonResponse(body: Record<string, unknown>, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

function createDefaultVerifyJwt(
  fetchImpl: typeof fetch,
  getEnv: (key: string) => string | undefined,
): (token: string) => Promise<{ userId: string } | null> {
  return async (token: string) => {
    const url = getEnv('SUPABASE_URL');
    const apikey = getEnv('SUPABASE_ANON_KEY') ?? getEnv('SUPABASE_SERVICE_ROLE_KEY');
    if (!url || !apikey) {
      return null;
    }
    const res = await fetchImpl(`${url}/auth/v1/user`, {
      method: 'GET',
      headers: {
        authorization: `Bearer ${token}`,
        apikey,
      },
    });
    if (!res.ok) {
      return null;
    }
    const payload = (await res.json()) as { id?: unknown };
    return typeof payload.id === 'string' && payload.id.length > 0 ? { userId: payload.id } : null;
  };
}

function deleteAccountInMemory(
  state: DeleteAccountState,
  userId: string,
): { ok: true; deletedCirclesCount: number } | { ok: false; code: 'OWNER_MUST_TRANSFER' } {
  if (!state.authUsers.has(userId)) {
    return { ok: true, deletedCirclesCount: 0 };
  }

  const ownedCircles = state.circle_members
    .filter((cm) => cm.user_id === userId && cm.role === 'owner')
    .map((cm) => cm.circle_id);

  for (const circleId of ownedCircles) {
    const hasOtherMembers = state.circle_members.some(
      (cm) => cm.circle_id === circleId && cm.user_id !== userId,
    );
    if (hasOtherMembers) {
      return { ok: false, code: 'OWNER_MUST_TRANSFER' };
    }
  }

  const soloCircleSet = new Set(ownedCircles);

  // 1. Delete solo-owned circles and all their domain rows + log_entries
  if (soloCircleSet.size > 0) {
    state.circles = state.circles.filter((c) => !soloCircleSet.has(c.id));
    state.circle_members = state.circle_members.filter((cm) => !soloCircleSet.has(cm.circle_id));
    state.invites = state.invites.filter((i) => !soloCircleSet.has(i.circle_id));
    state.medications = state.medications.filter((m) => !soloCircleSet.has(m.circle_id));
    state.dose_events = state.dose_events.filter((d) => !soloCircleSet.has(d.circle_id));
    state.appointments = state.appointments.filter((a) => !soloCircleSet.has(a.circle_id));
    state.tasks = state.tasks.filter((t) => !soloCircleSet.has(t.circle_id));
    state.visit_notes = state.visit_notes.filter((v) => !soloCircleSet.has(v.circle_id));
    state.log_entries = state.log_entries.filter((l) => !soloCircleSet.has(l.circle_id));
  }

  // 2. Delete user-owned rows across all user tables
  state.users_profile = state.users_profile.filter((r) => r.user_id !== userId);
  state.circle_members = state.circle_members.filter((r) => r.user_id !== userId);
  state.push_tokens = state.push_tokens.filter((r) => r.user_id !== userId);
  state.entitlements = state.entitlements.filter((r) => r.user_id !== userId);
  state.ai_calls = state.ai_calls.filter((r) => r.user_id !== userId);

  // 3. Set nullable user reference columns to null in surviving circles
  for (const c of state.circles) {
    if (c.created_by === userId) c.created_by = null;
  }
  for (const inv of state.invites) {
    if (inv.used_by === userId) inv.used_by = null;
  }
  for (const d of state.dose_events) {
    if (d.acted_by === userId) d.acted_by = null;
  }
  for (const a of state.appointments) {
    if (a.driver_user_id === userId) a.driver_user_id = null;
  }
  for (const t of state.tasks) {
    if (t.assignee === userId) t.assignee = null;
    if (t.done_by === userId) t.done_by = null;
  }
  for (const v of state.visit_notes) {
    if (v.created_by === userId) v.created_by = null;
  }
  for (const l of state.log_entries) {
    if (l.created_by === userId) l.created_by = null;
    if (l.ref_id === userId) l.ref_id = null;
  }

  // 4. Delete Storage objects under userId/ and any deleted soloCircleId/ prefix in every bucket
  const prefixesToDelete = [userId, ...ownedCircles];
  for (const [bucket, paths] of Object.entries(state.storageObjects)) {
    state.storageObjects[bucket] = paths.filter(
      (p) => !prefixesToDelete.some((prefix) => p.startsWith(`${prefix}/`)),
    );
  }

  // 5. Remove auth user
  state.authUsers.delete(userId);

  return { ok: true, deletedCirclesCount: ownedCircles.length };
}

async function deleteStoragePrefixObjects(
  fetchImpl: typeof fetch,
  baseUrl: string,
  serviceKey: string,
  bucket: string,
  prefix: string,
): Promise<void> {
  const listRes = await fetchImpl(`${baseUrl}/storage/v1/object/list/${bucket}`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${serviceKey}`,
      apikey: serviceKey,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      prefix,
      limit: 1000,
      offset: 0,
    }),
  });
  if (!listRes.ok) {
    return;
  }
  const items = (await listRes.json()) as Array<{ name?: unknown }>;
  if (!Array.isArray(items) || items.length === 0) {
    return;
  }
  const objectPaths = items
    .map((item) => (typeof item.name === 'string' ? item.name.trim() : ''))
    .filter((name) => name.length > 0)
    .map((name) => (name.startsWith(`${prefix}/`) ? name : `${prefix}/${name}`));

  if (objectPaths.length === 0) {
    return;
  }

  await fetchImpl(`${baseUrl}/storage/v1/object/${bucket}`, {
    method: 'DELETE',
    headers: {
      authorization: `Bearer ${serviceKey}`,
      apikey: serviceKey,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ prefixes: objectPaths }),
  });
}

export function createDeleteAccountHandler(deps: DeleteAccountDeps = {}) {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const getEnv = deps.getEnv ?? ((key: string) => Deno.env.get(key));
  const verifyJwt = deps.verifyJwt ?? createDefaultVerifyJwt(fetchImpl, getEnv);
  const logger =
    deps.logger ??
    ((entry: Record<string, unknown>) => {
      console.info(JSON.stringify(entry));
    });

  return async (req: Request): Promise<Response> => {
    if (req.method !== 'POST') {
      return jsonResponse(
        {
          ok: false,
          code: 'METHOD_NOT_ALLOWED',
          error: { code: 'METHOD_NOT_ALLOWED', message: 'Method not allowed' },
        },
        405,
      );
    }

    const authHeader = (req.headers.get('authorization') ?? '').trim();
    const bearerMatch = /^Bearer\s+(.+)$/i.exec(authHeader);
    if (!bearerMatch || !bearerMatch[1]) {
      return jsonResponse(
        {
          ok: false,
          code: 'UNAUTHENTICATED',
          error: { code: 'UNAUTHENTICATED', message: 'Authentication required' },
        },
        401,
      );
    }

    let authUser: { userId: string } | null = null;
    try {
      authUser = await verifyJwt(bearerMatch[1].trim());
    } catch {
      authUser = null;
    }

    if (!authUser || !authUser.userId) {
      return jsonResponse(
        {
          ok: false,
          code: 'UNAUTHENTICATED',
          error: { code: 'UNAUTHENTICATED', message: 'Authentication required' },
        },
        401,
      );
    }

    const userId = authUser.userId;

    if (deps.state) {
      const memResult = deleteAccountInMemory(deps.state, userId);
      if (!memResult.ok) {
        return jsonResponse(
          {
            ok: false,
            code: 'OWNER_MUST_TRANSFER',
            error: {
              code: 'OWNER_MUST_TRANSFER',
              message: 'Transfer or delete your circle before deleting your account.',
            },
          },
          409,
        );
      }
      logger({
        event: 'delete_account_completed',
        userId,
        deletedCirclesCount: memResult.deletedCirclesCount,
      });
      return jsonResponse({ ok: true }, 200);
    }

    const url = getEnv('SUPABASE_URL');
    const serviceKey = getEnv('SUPABASE_SERVICE_ROLE_KEY');
    if (!url || !serviceKey) {
      return jsonResponse(
        {
          ok: false,
          code: 'INTERNAL_ERROR',
          error: { code: 'INTERNAL_ERROR', message: 'Server configuration missing' },
        },
        500,
      );
    }

    const rpcRes = await fetchImpl(`${url}/rest/v1/rpc/delete_own_account`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${serviceKey}`,
        apikey: serviceKey,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ p_target_user_id: userId }),
    });

    if (!rpcRes.ok) {
      const errText = await rpcRes.text();
      if (errText.includes('OWNER_MUST_TRANSFER')) {
        return jsonResponse(
          {
            ok: false,
            code: 'OWNER_MUST_TRANSFER',
            error: {
              code: 'OWNER_MUST_TRANSFER',
              message: 'Transfer or delete your circle before deleting your account.',
            },
          },
          409,
        );
      }
      return jsonResponse(
        {
          ok: false,
          code: 'DELETE_ACCOUNT_FAILED',
          error: { code: 'DELETE_ACCOUNT_FAILED', message: 'Could not delete account' },
        },
        500,
      );
    }

    const rpcBody = (await rpcRes.json().catch(() => ({}))) as {
      deletedCircleIds?: unknown;
    };
    const deletedCircleIds = Array.isArray(rpcBody.deletedCircleIds)
      ? rpcBody.deletedCircleIds.filter((id): id is string => typeof id === 'string')
      : [];

    // Best-effort Storage API cleanup for user prefix and deleted solo circle prefixes
    await deleteStoragePrefixObjects(
      fetchImpl,
      url,
      serviceKey,
      'prescription-photos',
      userId,
    ).catch(() => undefined);

    for (const circleId of deletedCircleIds) {
      await deleteStoragePrefixObjects(fetchImpl, url, serviceKey, 'visit-audio', circleId).catch(
        () => undefined,
      );
      await deleteStoragePrefixObjects(fetchImpl, url, serviceKey, 'log-exports', circleId).catch(
        () => undefined,
      );
    }

    // Ensure Auth Admin also removes the user session/account if not already deleted by the RPC
    await fetchImpl(`${url}/auth/v1/admin/users/${encodeURIComponent(userId)}`, {
      method: 'DELETE',
      headers: {
        authorization: `Bearer ${serviceKey}`,
        apikey: serviceKey,
      },
    }).catch(() => undefined);

    logger({
      event: 'delete_account_completed',
      userId,
      deletedCirclesCount: deletedCircleIds.length,
    });

    return jsonResponse({ ok: true }, 200);
  };
}

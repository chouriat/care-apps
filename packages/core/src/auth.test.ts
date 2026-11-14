import * as CoreModule from './index';

type AuthProvider = 'apple' | 'google';
type AuthStatus = 'loading' | 'authenticated' | 'unauthenticated';

interface AuthSession {
  access_token: string;
  refresh_token: string;
  expires_at?: number;
  user: {
    id: string;
    email?: string | null;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

interface SecureStoreAdapter {
  getItemAsync(key: string): Promise<string | null>;
  setItemAsync(key: string, value: string): Promise<void>;
  deleteItemAsync(key: string): Promise<void>;
}

interface ChunkedSessionStorage {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
}

interface AuthLogger {
  info(event: string, meta?: Record<string, string | number | boolean>): void;
  warn(event: string, meta?: Record<string, string | number | boolean>): void;
  error(event: string, meta?: Record<string, string | number | boolean>): void;
}

interface AuthAnalytics {
  track(event: string, properties?: Record<string, string | number | boolean>): void;
}

interface SupabaseAuthAdapter {
  signInWithOtp(params: {
    email: string;
    options?: { emailRedirectTo?: string };
  }): Promise<{ error: { message: string; code?: string } | null }>;
  signInWithOAuth(params: {
    provider: AuthProvider;
    options?: { redirectTo?: string };
  }): Promise<{ data?: { url?: string | null }; error: { message: string; code?: string } | null }>;
  exchangeCodeForSession(code: string): Promise<{
    data: { session: AuthSession | null };
    error: { message: string; code?: string } | null;
  }>;
  signOut(): Promise<{ error: { message: string; code?: string } | null }>;
}

interface AuthState {
  status: AuthStatus;
  session: AuthSession | null;
  errorCode: string | null;
  magicLinkSent: boolean;
  isSubmitting: boolean;
}

interface AuthController {
  getState(): AuthState;
  subscribe(listener: (state: AuthState) => void): () => void;
  initialize(): Promise<AuthState>;
  signInWithEmail(email: string): Promise<boolean>;
  signInWithOAuth(provider: AuthProvider): Promise<boolean>;
  receiveSession(session: AuthSession): Promise<void>;
  handleAuthCallback(url: string): Promise<boolean>;
  signOut(): Promise<void>;
}

interface AuthModuleContract {
  SESSION_STORAGE_KEY: string;
  createChunkedSecureStorage(adapter: SecureStoreAdapter): ChunkedSessionStorage;
  createAuthController(options: {
    secureStore: SecureStoreAdapter;
    supabaseAuth: SupabaseAuthAdapter;
    logger?: AuthLogger;
    analytics?: AuthAnalytics;
    redirectUrl?: string;
  }): AuthController;
  resolveAuthRedirect(status: AuthStatus, pathname: string): string | null;
  buildSupabaseAuthOptions(adapter: SecureStoreAdapter): {
    storage: ChunkedSessionStorage;
    storageKey: string;
    persistSession: boolean;
    autoRefreshToken: boolean;
    detectSessionInUrl: boolean;
    flowType: string;
  };
}

const SECURE_STORE_LIMIT_BYTES = 2048;

function utf8Bytes(value: string): number {
  let bytes = 0;
  for (const char of value) {
    const codePoint = char.codePointAt(0) ?? 0;
    bytes += codePoint < 0x80 ? 1 : codePoint < 0x800 ? 2 : codePoint < 0x10000 ? 3 : 4;
  }
  return bytes;
}

function requireAuthModule(): AuthModuleContract {
  const candidate = CoreModule as Partial<AuthModuleContract>;
  if (
    !candidate.createAuthController ||
    !candidate.createChunkedSecureStorage ||
    !candidate.resolveAuthRedirect ||
    !candidate.buildSupabaseAuthOptions ||
    !candidate.SESSION_STORAGE_KEY
  ) {
    throw new Error('F-4 auth exports are not implemented in @carecircle/core yet.');
  }
  return candidate as AuthModuleContract;
}

function createInMemorySecureStore() {
  const backingMap = new Map<string, string>();
  const adapter: SecureStoreAdapter = {
    async getItemAsync(key: string): Promise<string | null> {
      return backingMap.get(key) ?? null;
    },
    async setItemAsync(key: string, value: string): Promise<void> {
      // The SecureStore limit is in bytes, not characters (names and emails can be non-ASCII).
      const bytes = utf8Bytes(value);
      if (bytes > SECURE_STORE_LIMIT_BYTES) {
        throw new Error(`SecureStore value for ${key} exceeds ${SECURE_STORE_LIMIT_BYTES} bytes`);
      }
      backingMap.set(key, value);
    },
    async deleteItemAsync(key: string): Promise<void> {
      backingMap.delete(key);
    },
  };
  return { backingMap, adapter };
}

function buildRealisticLargeSession(): AuthSession {
  const accessPayload = 'a'.repeat(1200);
  const refreshPayload = 'r'.repeat(1000);
  return {
    access_token: `eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.${accessPayload}.sig`,
    refresh_token: `refresh_${refreshPayload}`,
    expires_at: 1_900_000_000,
    user: {
      id: '550e8400-e29b-41d4-a716-446655440000',
      email: 'caregiver.nadia@example.com',
      app_metadata: { provider: 'email', providers: ['email', 'apple', 'google'] },
      // Multi-byte characters: chunking by string length instead of bytes must fail.
      user_metadata: {
        display_name: 'Nadïa Ébène Caregiver 👵🏽'.repeat(40),
        locale: 'fr',
        timezone: 'Europe/Paris',
      },
    },
  };
}

function createMockSupabaseAuth(overrides: Partial<SupabaseAuthAdapter> = {}): SupabaseAuthAdapter {
  return {
    signInWithOtp: async () => ({ error: null }),
    signInWithOAuth: async () => ({ data: { url: 'https://supabase.local/oauth' }, error: null }),
    exchangeCodeForSession: async () => ({ data: { session: null }, error: null }),
    signOut: async () => ({ error: null }),
    ...overrides,
  };
}

describe('F-4 Auth core (@carecircle/core)', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('chunks realistic >2 KB sessions into SecureStore and clears all keys on sign-out', async () => {
    const auth = requireAuthModule();
    const { backingMap, adapter } = createInMemorySecureStore();
    const controller = auth.createAuthController({
      secureStore: adapter,
      supabaseAuth: createMockSupabaseAuth(),
    });

    const largeSession = buildRealisticLargeSession();
    expect(JSON.stringify(largeSession).length).toBeGreaterThan(SECURE_STORE_LIMIT_BYTES);

    await controller.receiveSession(largeSession);
    expect(controller.getState().status).toBe('authenticated');
    expect(backingMap.size).toBeGreaterThanOrEqual(2);
    for (const storedValue of backingMap.values()) {
      expect(utf8Bytes(storedValue)).toBeLessThanOrEqual(SECURE_STORE_LIMIT_BYTES);
    }

    await controller.signOut();
    expect(controller.getState().status).toBe('unauthenticated');
    expect(controller.getState().session).toBeNull();
    expect(backingMap.size).toBe(0);

    const chunkedStorage = auth.createChunkedSecureStorage(adapter);
    expect(await chunkedStorage.getItem(auth.SESSION_STORAGE_KEY)).toBeNull();
  });

  it('restores a stored session on start and signs out cleanly on corrupted or partial storage', async () => {
    const auth = requireAuthModule();
    const { backingMap, adapter } = createInMemorySecureStore();
    const largeSession = buildRealisticLargeSession();

    const writer = auth.createAuthController({
      secureStore: adapter,
      supabaseAuth: createMockSupabaseAuth(),
    });
    await writer.receiveSession(largeSession);

    const coldStartReader = auth.createAuthController({
      secureStore: adapter,
      supabaseAuth: createMockSupabaseAuth(),
    });
    const restoredState = await coldStartReader.initialize();
    expect(restoredState.status).toBe('authenticated');
    expect(restoredState.session?.user.id).toBe(largeSession.user.id);
    expect(restoredState.session?.access_token).toBe(largeSession.access_token);

    // Corrupted JSON payload must sign out cleanly without throwing.
    const chunkedStorage = auth.createChunkedSecureStorage(adapter);
    await chunkedStorage.setItem(auth.SESSION_STORAGE_KEY, '{not-valid-json');
    const corruptedReader = auth.createAuthController({
      secureStore: adapter,
      supabaseAuth: createMockSupabaseAuth(),
    });
    const corruptedState = await corruptedReader.initialize();
    expect(corruptedState.status).toBe('unauthenticated');
    expect(corruptedState.session).toBeNull();
    expect(backingMap.size).toBe(0);

    // Losing any one stored key of a multi-chunk session (whatever the key naming) must sign out
    // cleanly and leave no token fragments behind.
    await writer.receiveSession(largeSession);
    const storedKeys = [...backingMap.keys()];
    expect(storedKeys.length).toBeGreaterThanOrEqual(2);
    for (const lostKey of storedKeys) {
      await writer.receiveSession(largeSession);
      expect(backingMap.delete(lostKey)).toBe(true);
      const partialReader = auth.createAuthController({
        secureStore: adapter,
        supabaseAuth: createMockSupabaseAuth(),
      });
      const partialState = await partialReader.initialize();
      expect(partialState.status).toBe('unauthenticated');
      expect(partialState.session).toBeNull();
      expect(backingMap.size).toBe(0);
    }

    // Valid JSON missing required session fields (partial object) must also sign out and clear storage.
    const { refresh_token: _omitted, ...withoutRefresh } = largeSession;
    expect(_omitted).toBeTruthy();
    await chunkedStorage.setItem(auth.SESSION_STORAGE_KEY, JSON.stringify(withoutRefresh));
    const incompleteReader = auth.createAuthController({
      secureStore: adapter,
      supabaseAuth: createMockSupabaseAuth(),
    });
    const incompleteState = await incompleteReader.initialize();
    expect(incompleteState.status).toBe('unauthenticated');
    expect(incompleteState.session).toBeNull();
    expect(backingMap.size).toBe(0);
  });

  it('never logs or tracks email, access token, refresh token, or user ID', async () => {
    const auth = requireAuthModule();
    const { adapter } = createInMemorySecureStore();
    const capturedCalls: string[] = [];
    // JSON.stringify turns an Error into {}, which would hide a leaked message, so capture
    // Error messages and stacks explicitly.
    const recordCall = (...args: unknown[]) => {
      capturedCalls.push(
        JSON.stringify(args, (_key, value: unknown) =>
          value instanceof Error ? `${value.name}: ${value.message} ${value.stack ?? ''}` : value,
        ),
      );
    };

    type ConsoleLike = Record<
      'log' | 'info' | 'warn' | 'error' | 'debug',
      (...args: unknown[]) => void
    >;
    const runtimeConsole = (globalThis as unknown as { console: ConsoleLike }).console;
    jest.spyOn(runtimeConsole, 'log').mockImplementation(recordCall);
    jest.spyOn(runtimeConsole, 'info').mockImplementation(recordCall);
    jest.spyOn(runtimeConsole, 'warn').mockImplementation(recordCall);
    jest.spyOn(runtimeConsole, 'error').mockImplementation(recordCall);
    jest.spyOn(runtimeConsole, 'debug').mockImplementation(recordCall);

    const logger: AuthLogger = {
      info: (event, meta) => recordCall('logger.info', event, meta),
      warn: (event, meta) => recordCall('logger.warn', event, meta),
      error: (event, meta) => recordCall('logger.error', event, meta),
    };
    const analytics: AuthAnalytics = {
      track: (event, properties) => recordCall('analytics.track', event, properties),
    };

    const sensitiveEmail = 'private.member@example.com';
    const sensitiveAccessToken = 'eyJhbGciOiJIUzI1NiJ9.secret-jwt-access-token-789.sig';
    const sensitiveRefreshToken = 'secret-refresh-token-xyz-987654';
    const sensitiveUserId = '99999999-8888-4777-8666-555555555555';

    let shouldFail = false;
    let shouldThrow = false;
    const leakyError = () =>
      new Error(`network down for ${sensitiveEmail} ${sensitiveAccessToken}`);
    const supabaseAuth = createMockSupabaseAuth({
      exchangeCodeForSession: async () => {
        if (shouldThrow) throw leakyError();
        return shouldFail
          ? { data: { session: null }, error: { message: `bad code for ${sensitiveEmail}` } }
          : {
              data: {
                session: {
                  access_token: sensitiveAccessToken,
                  refresh_token: sensitiveRefreshToken,
                  user: { id: sensitiveUserId, email: sensitiveEmail },
                },
              },
              error: null,
            };
      },
      signOut: async () => {
        if (shouldThrow) throw leakyError();
        return { error: null };
      },
      signInWithOtp: async () => {
        if (shouldThrow) throw leakyError();
        return shouldFail
          ? {
              error: {
                message: `OTP failed for ${sensitiveEmail} with token ${sensitiveAccessToken}`,
                code: 'OTP_REJECTED',
              },
            }
          : { error: null };
      },
      signInWithOAuth: async () => {
        if (shouldThrow) throw leakyError();
        return shouldFail
          ? {
              error: {
                message: `OAuth failed for ${sensitiveEmail}`,
                code: 'OAUTH_REJECTED',
              },
            }
          : { data: { url: 'https://supabase.local/oauth' }, error: null };
      },
    });

    const controller = auth.createAuthController({
      secureStore: adapter,
      supabaseAuth,
      logger,
      analytics,
    });

    // 1. Successful sign-in flows.
    expect(await controller.signInWithEmail(sensitiveEmail)).toBe(true);
    expect(await controller.signInWithOAuth('apple')).toBe(true);
    expect(await controller.signInWithOAuth('google')).toBe(true);
    expect(await controller.handleAuthCallback('carecircle://auth/callback?code=ok-code')).toBe(
      true,
    );
    expect(controller.getState().session?.access_token).toBe(sensitiveAccessToken);

    // 2. Failed sign-in flows: error results, then thrown errors (offline).
    shouldFail = true;
    expect(await controller.signInWithEmail(sensitiveEmail)).toBe(false);
    expect(await controller.signInWithOAuth('apple')).toBe(false);
    expect(await controller.handleAuthCallback('carecircle://auth/callback?code=bad')).toBe(false);
    shouldThrow = true;
    expect(await controller.signInWithEmail(sensitiveEmail)).toBe(false);
    expect(await controller.signInWithOAuth('google')).toBe(false);
    expect(await controller.handleAuthCallback('carecircle://auth/callback?code=x')).toBe(false);

    // 3. Sign-out flow, including when the server cannot be reached.
    await controller.signOut();
    expect(controller.getState().status).toBe('unauthenticated');

    expect(capturedCalls.length).toBeGreaterThanOrEqual(5);
    const combinedLogs = capturedCalls.join('\n');
    expect(combinedLogs).not.toContain(sensitiveEmail);
    expect(combinedLogs).not.toContain(sensitiveAccessToken);
    expect(combinedLogs).not.toContain(sensitiveRefreshToken);
    expect(combinedLogs).not.toContain(sensitiveUserId);
  });

  it('clears local storage on sign-out even when the server sign-out fails or is offline', async () => {
    const auth = requireAuthModule();
    const failures: SupabaseAuthAdapter['signOut'][] = [
      async () => ({ error: { message: 'session_not_found', code: 'session_not_found' } }),
      async () => {
        throw new Error('Network request failed');
      },
    ];
    for (const signOut of failures) {
      const { backingMap, adapter } = createInMemorySecureStore();
      const controller = auth.createAuthController({
        secureStore: adapter,
        supabaseAuth: createMockSupabaseAuth({ signOut }),
      });
      await controller.receiveSession(buildRealisticLargeSession());
      await controller.signOut();
      expect(controller.getState().status).toBe('unauthenticated');
      expect(controller.getState().session).toBeNull();
      expect(backingMap.size).toBe(0);
    }
  });

  it('starts signed out instead of crashing when SecureStore cannot be read', async () => {
    const auth = requireAuthModule();
    const { adapter } = createInMemorySecureStore();
    const lockedKeychain: SecureStoreAdapter = {
      ...adapter,
      getItemAsync: async () => {
        throw new Error('User interaction is not allowed.');
      },
    };
    const controller = auth.createAuthController({
      secureStore: lockedKeychain,
      supabaseAuth: createMockSupabaseAuth(),
    });
    const state = await controller.initialize();
    expect(state.status).toBe('unauthenticated');
    expect(state.session).toBeNull();
  });

  it('keeps the Supabase session only in SecureStore and uses the PKCE flow', async () => {
    const auth = requireAuthModule();
    const { backingMap, adapter } = createInMemorySecureStore();
    const options = auth.buildSupabaseAuthOptions(adapter);
    expect(options).toMatchObject({
      storageKey: auth.SESSION_STORAGE_KEY,
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: false,
      flowType: 'pkce',
    });
    // What the Supabase client writes (including token refreshes) must land in SecureStore.
    const value = JSON.stringify(buildRealisticLargeSession());
    await options.storage.setItem(auth.SESSION_STORAGE_KEY, value);
    expect(backingMap.size).toBeGreaterThanOrEqual(2);
    expect(await options.storage.getItem(auth.SESSION_STORAGE_KEY)).toBe(value);
    await options.storage.removeItem(auth.SESSION_STORAGE_KEY);
    expect(backingMap.size).toBe(0);
  });

  it('sends the app redirect URL and accepts only a PKCE code in the sign-in callback', async () => {
    const auth = requireAuthModule();
    const { backingMap, adapter } = createInMemorySecureStore();
    const session = buildRealisticLargeSession();
    const otp = jest.fn<ReturnType<SupabaseAuthAdapter['signInWithOtp']>, [never]>(async () => ({
      error: null,
    }));
    const oauth = jest.fn<ReturnType<SupabaseAuthAdapter['signInWithOAuth']>, [never]>(
      async () => ({ data: { url: 'https://supabase.local/oauth' }, error: null }),
    );
    const exchange = jest.fn<ReturnType<SupabaseAuthAdapter['exchangeCodeForSession']>, [string]>(
      async () => ({ data: { session }, error: null }),
    );
    const controller = auth.createAuthController({
      secureStore: adapter,
      supabaseAuth: createMockSupabaseAuth({
        signInWithOtp: otp,
        signInWithOAuth: oauth,
        exchangeCodeForSession: exchange,
      }),
      redirectUrl: 'carecircle://auth/callback',
    });

    await controller.signInWithEmail('caregiver@example.com');
    expect(otp).toHaveBeenCalledWith(
      expect.objectContaining({
        email: 'caregiver@example.com',
        options: expect.objectContaining({ emailRedirectTo: 'carecircle://auth/callback' }),
      }),
    );
    await controller.signInWithOAuth('apple');
    expect(oauth).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: 'apple',
        options: expect.objectContaining({ redirectTo: 'carecircle://auth/callback' }),
      }),
    );

    // Tokens placed directly in a link (implicit flow) could sign the user into someone
    // else's account (session fixation). They must be ignored.
    for (const forged of [
      'carecircle://auth/callback#access_token=attacker&refresh_token=attacker',
      'carecircle://auth/callback?access_token=attacker&refresh_token=attacker',
      'carecircle://auth/callback?error=access_denied',
    ]) {
      expect(await controller.handleAuthCallback(forged)).toBe(false);
      expect(controller.getState().status).not.toBe('authenticated');
      expect(backingMap.size).toBe(0);
    }
    expect(exchange).not.toHaveBeenCalled();

    expect(await controller.handleAuthCallback('carecircle://auth/callback?code=pkce-code')).toBe(
      true,
    );
    expect(exchange).toHaveBeenCalledWith('pkce-code');
    expect(controller.getState().status).toBe('authenticated');
    expect(controller.getState().session?.access_token).toBe(session.access_token);
    expect(backingMap.size).toBeGreaterThanOrEqual(2);
  });

  it('computes route redirects for signed-out, loading, and signed-in states', () => {
    const { resolveAuthRedirect } = requireAuthModule();

    expect(resolveAuthRedirect('unauthenticated', '/')).toBe('/(auth)/sign-in');
    expect(resolveAuthRedirect('unauthenticated', '/gallery')).toBe('/(auth)/sign-in');
    expect(resolveAuthRedirect('unauthenticated', '/meds/scan?id=42')).toBe('/(auth)/sign-in');
    for (const protectedPath of ['/(tabs)/today', '/today', '/visit/new', '/circle', '/log']) {
      expect(resolveAuthRedirect('unauthenticated', protectedPath)).toBe('/(auth)/sign-in');
    }
    expect(resolveAuthRedirect('unauthenticated', '/(auth)/sign-in')).toBeNull();
    // Expo Router's usePathname() drops route groups, so the sign-in route reports '/sign-in'.
    // Redirecting it would loop forever.
    expect(resolveAuthRedirect('unauthenticated', '/sign-in')).toBeNull();
    expect(resolveAuthRedirect('authenticated', '/sign-in')).toBe('/');

    expect(resolveAuthRedirect('authenticated', '/')).toBeNull();
    expect(resolveAuthRedirect('authenticated', '/gallery')).toBeNull();
    expect(resolveAuthRedirect('authenticated', '/(auth)/sign-in')).toBe('/');

    expect(resolveAuthRedirect('loading', '/gallery')).toBeNull();
  });
});

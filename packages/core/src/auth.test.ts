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
}

const SECURE_STORE_LIMIT_BYTES = 2048;

function requireAuthModule(): AuthModuleContract {
  const candidate = CoreModule as Partial<AuthModuleContract>;
  if (
    !candidate.createAuthController ||
    !candidate.createChunkedSecureStorage ||
    !candidate.resolveAuthRedirect ||
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
      if (value.length > SECURE_STORE_LIMIT_BYTES) {
        throw new Error(
          `SecureStore value for ${key} exceeds ${SECURE_STORE_LIMIT_BYTES} bytes (${value.length})`,
        );
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
      user_metadata: { display_name: 'Nadia Caregiver', locale: 'en', timezone: 'Europe/Paris' },
    },
  };
}

function createMockSupabaseAuth(overrides: Partial<SupabaseAuthAdapter> = {}): SupabaseAuthAdapter {
  return {
    signInWithOtp: async () => ({ error: null }),
    signInWithOAuth: async () => ({ data: { url: 'https://supabase.local/oauth' }, error: null }),
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
      expect(storedValue.length).toBeLessThanOrEqual(SECURE_STORE_LIMIT_BYTES);
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

    // Partial chunk (missing chunk 1 of a multi-chunk session) must also sign out cleanly.
    await writer.receiveSession(largeSession);
    expect(backingMap.delete(`${auth.SESSION_STORAGE_KEY}.__chunk_1`)).toBe(true);
    const partialReader = auth.createAuthController({
      secureStore: adapter,
      supabaseAuth: createMockSupabaseAuth(),
    });
    const partialState = await partialReader.initialize();
    expect(partialState.status).toBe('unauthenticated');
    expect(partialState.session).toBeNull();
    expect(backingMap.size).toBe(0);

    // Valid JSON missing required session fields (partial object) must also sign out and clear storage.
    await chunkedStorage.setItem(auth.SESSION_STORAGE_KEY, JSON.stringify({ access_token: 'tok' }));
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
    const recordCall = (...args: unknown[]) => {
      capturedCalls.push(JSON.stringify(args));
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
    const supabaseAuth = createMockSupabaseAuth({
      signInWithOtp: async () =>
        shouldFail
          ? {
              error: {
                message: `OTP failed for ${sensitiveEmail} with token ${sensitiveAccessToken}`,
                code: 'OTP_REJECTED',
              },
            }
          : { error: null },
      signInWithOAuth: async () =>
        shouldFail
          ? {
              error: {
                message: `OAuth failed for ${sensitiveEmail}`,
                code: 'OAUTH_REJECTED',
              },
            }
          : { data: { url: 'https://supabase.local/oauth' }, error: null },
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
    await controller.receiveSession({
      access_token: sensitiveAccessToken,
      refresh_token: sensitiveRefreshToken,
      user: { id: sensitiveUserId, email: sensitiveEmail },
    });

    // 2. Failed sign-in flows.
    shouldFail = true;
    expect(await controller.signInWithEmail(sensitiveEmail)).toBe(false);
    expect(await controller.signInWithOAuth('apple')).toBe(false);

    // 3. Sign-out flow.
    await controller.signOut();

    expect(capturedCalls.length).toBeGreaterThanOrEqual(5);
    const combinedLogs = capturedCalls.join('\n');
    expect(combinedLogs).not.toContain(sensitiveEmail);
    expect(combinedLogs).not.toContain(sensitiveAccessToken);
    expect(combinedLogs).not.toContain(sensitiveRefreshToken);
    expect(combinedLogs).not.toContain(sensitiveUserId);
  });

  it('computes route redirects for signed-out, loading, and signed-in states', () => {
    const { resolveAuthRedirect } = requireAuthModule();

    expect(resolveAuthRedirect('unauthenticated', '/')).toBe('/(auth)/sign-in');
    expect(resolveAuthRedirect('unauthenticated', '/gallery')).toBe('/(auth)/sign-in');
    expect(resolveAuthRedirect('unauthenticated', '/meds/scan?id=42')).toBe('/(auth)/sign-in');
    expect(resolveAuthRedirect('unauthenticated', '/(auth)/sign-in')).toBeNull();

    expect(resolveAuthRedirect('authenticated', '/')).toBeNull();
    expect(resolveAuthRedirect('authenticated', '/gallery')).toBeNull();
    expect(resolveAuthRedirect('authenticated', '/(auth)/sign-in')).toBe('/');

    expect(resolveAuthRedirect('loading', '/gallery')).toBeNull();
  });
});

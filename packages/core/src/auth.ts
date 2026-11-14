export type AuthProvider = 'apple' | 'google';
export type AuthStatus = 'loading' | 'authenticated' | 'unauthenticated';

export interface AuthSession {
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

export interface SecureStoreAdapter {
  getItemAsync(key: string): Promise<string | null>;
  setItemAsync(key: string, value: string): Promise<void>;
  deleteItemAsync(key: string): Promise<void>;
}

export interface ChunkedSessionStorage {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
}

export interface AuthLogger {
  info(event: string, meta?: Record<string, string | number | boolean>): void;
  warn(event: string, meta?: Record<string, string | number | boolean>): void;
  error(event: string, meta?: Record<string, string | number | boolean>): void;
}

export interface AuthAnalytics {
  track(event: string, properties?: Record<string, string | number | boolean>): void;
}

export interface SupabaseAuthAdapter {
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

export interface AuthState {
  status: AuthStatus;
  session: AuthSession | null;
  errorCode: string | null;
  magicLinkSent: boolean;
  isSubmitting: boolean;
}

export interface AuthController {
  getState(): AuthState;
  subscribe(listener: (state: AuthState) => void): () => void;
  initialize(): Promise<AuthState>;
  signInWithEmail(email: string): Promise<boolean>;
  signInWithOAuth(provider: AuthProvider): Promise<boolean>;
  receiveSession(session: AuthSession): Promise<void>;
  handleAuthCallback(url: string): Promise<boolean>;
  signOut(): Promise<void>;
}

export const SESSION_STORAGE_KEY = 'carecircle.auth.session';
const SECURE_STORE_CHUNK_BYTE_LIMIT = 2048;
const MAX_SESSION_CHUNKS = 32;
const DEFAULT_REDIRECT_URL = 'carecircle://auth/callback';

function chunkCountKey(baseKey: string): string {
  return `${baseKey}__chunks`;
}

function chunkItemKey(baseKey: string, index: number): string {
  return `${baseKey}__chunk_${index}`;
}

function utf8ByteLength(codePoint: number): number {
  if (codePoint < 0x80) return 1;
  if (codePoint < 0x800) return 2;
  if (codePoint < 0x10000) return 3;
  return 4;
}

function splitIntoUtf8ByteChunks(value: string, maxBytes: number): string[] {
  if (value.length === 0) {
    return [''];
  }
  const chunks: string[] = [];
  let current = '';
  let currentBytes = 0;

  for (const char of value) {
    const codePoint = char.codePointAt(0) ?? 0;
    const charBytes = utf8ByteLength(codePoint);
    if (currentBytes + charBytes > maxBytes && current.length > 0) {
      chunks.push(current);
      current = char;
      currentBytes = charBytes;
    } else {
      current += char;
      currentBytes += charBytes;
    }
  }

  if (current.length > 0) {
    chunks.push(current);
  }
  return chunks;
}

function sanitizeErrorCode(rawCode: string | undefined, fallback: string): string {
  if (!rawCode) {
    return fallback;
  }
  return /^[A-Za-z0-9_.-]{1,64}$/.test(rawCode) ? rawCode : fallback;
}

export function createChunkedSecureStorage(adapter: SecureStoreAdapter): ChunkedSessionStorage {
  const removeItem = async (key: string): Promise<void> => {
    await adapter.deleteItemAsync(key);
    await adapter.deleteItemAsync(chunkCountKey(key));
    for (let i = 0; i < MAX_SESSION_CHUNKS; i += 1) {
      await adapter.deleteItemAsync(chunkItemKey(key, i));
    }
  };

  return {
    async getItem(key: string): Promise<string | null> {
      const countRaw = await adapter.getItemAsync(chunkCountKey(key));
      if (countRaw === null) {
        await removeItem(key);
        return null;
      }

      const count = Number.parseInt(countRaw, 10);
      if (!Number.isFinite(count) || count <= 0 || count > MAX_SESSION_CHUNKS) {
        await removeItem(key);
        return null;
      }

      const parts: string[] = [];
      for (let i = 0; i < count; i += 1) {
        const part = await adapter.getItemAsync(chunkItemKey(key, i));
        if (part === null) {
          await removeItem(key);
          return null;
        }
        parts.push(part);
      }

      return parts.join('');
    },

    async setItem(key: string, value: string): Promise<void> {
      await removeItem(key);
      const chunks = splitIntoUtf8ByteChunks(value, SECURE_STORE_CHUNK_BYTE_LIMIT);
      if (chunks.length > MAX_SESSION_CHUNKS) {
        throw new Error('Session payload exceeds maximum chunk count');
      }
      await adapter.setItemAsync(chunkCountKey(key), String(chunks.length));
      for (const [i, chunk] of chunks.entries()) {
        await adapter.setItemAsync(chunkItemKey(key, i), chunk);
      }
    },

    removeItem,
  };
}

export function buildSupabaseAuthOptions(adapter: SecureStoreAdapter): {
  storage: ChunkedSessionStorage;
  storageKey: string;
  persistSession: boolean;
  autoRefreshToken: boolean;
  detectSessionInUrl: boolean;
  flowType: 'pkce';
} {
  return {
    storage: createChunkedSecureStorage(adapter),
    storageKey: SESSION_STORAGE_KEY,
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: false,
    flowType: 'pkce',
  };
}

function isValidSession(candidate: unknown): candidate is AuthSession {
  if (!candidate || typeof candidate !== 'object') {
    return false;
  }
  const record = candidate as Record<string, unknown>;
  if (typeof record.access_token !== 'string' || record.access_token.trim().length === 0) {
    return false;
  }
  if (typeof record.refresh_token !== 'string' || record.refresh_token.trim().length === 0) {
    return false;
  }
  if (!record.user || typeof record.user !== 'object') {
    return false;
  }
  const userRecord = record.user as Record<string, unknown>;
  return typeof userRecord.id === 'string' && userRecord.id.trim().length > 0;
}

function parseUrlParams(segment: string): Record<string, string> {
  const params: Record<string, string> = {};
  if (!segment) {
    return params;
  }
  for (const pair of segment.split('&')) {
    if (!pair) continue;
    const eqIndex = pair.indexOf('=');
    const rawKey = eqIndex >= 0 ? pair.slice(0, eqIndex) : pair;
    const rawVal = eqIndex >= 0 ? pair.slice(eqIndex + 1) : '';
    try {
      params[decodeURIComponent(rawKey)] = decodeURIComponent(rawVal);
    } catch {
      params[rawKey] = rawVal;
    }
  }
  return params;
}

function extractPkceCode(callbackUrl: string): string | null {
  if (!callbackUrl || typeof callbackUrl !== 'string') {
    return null;
  }
  const hashIndex = callbackUrl.indexOf('#');
  const beforeHash = hashIndex >= 0 ? callbackUrl.slice(0, hashIndex) : callbackUrl;
  const hashSegment = hashIndex >= 0 ? callbackUrl.slice(hashIndex + 1) : '';
  const queryIndex = beforeHash.indexOf('?');
  const querySegment = queryIndex >= 0 ? beforeHash.slice(queryIndex + 1) : '';

  const queryParams = parseUrlParams(querySegment);
  const hashParams = parseUrlParams(hashSegment);

  const forbiddenKeys = ['access_token', 'refresh_token', 'token', 'error', 'error_description'];
  for (const key of forbiddenKeys) {
    if (key in queryParams || key in hashParams) {
      return null;
    }
  }

  const code = queryParams.code;
  if (typeof code !== 'string' || code.trim().length === 0) {
    return null;
  }
  return code;
}

const defaultLogger: AuthLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

export function createAuthController(options: {
  secureStore: SecureStoreAdapter;
  supabaseAuth: SupabaseAuthAdapter;
  logger?: AuthLogger;
  analytics?: AuthAnalytics;
  redirectUrl?: string;
}): AuthController {
  const storage = createChunkedSecureStorage(options.secureStore);
  const logger = options.logger ?? defaultLogger;
  const redirectUrl = options.redirectUrl ?? DEFAULT_REDIRECT_URL;
  const listeners = new Set<(state: AuthState) => void>();

  let state: AuthState = {
    status: 'loading',
    session: null,
    errorCode: null,
    magicLinkSent: false,
    isSubmitting: false,
  };

  const setState = (patch: Partial<AuthState>): AuthState => {
    state = { ...state, ...patch };
    for (const listener of listeners) {
      listener(state);
    }
    return state;
  };

  const clearStoredSessionSafely = async (): Promise<void> => {
    try {
      await storage.removeItem(SESSION_STORAGE_KEY);
    } catch {
      logger.warn('auth.storage_clear_failed', { code: 'STORAGE_CLEAR_FAILED' });
    }
  };

  return {
    getState(): AuthState {
      return state;
    },

    subscribe(listener: (nextState: AuthState) => void): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    async initialize(): Promise<AuthState> {
      try {
        const raw = await storage.getItem(SESSION_STORAGE_KEY);
        if (!raw) {
          return setState({
            status: 'unauthenticated',
            session: null,
            errorCode: null,
          });
        }

        const parsed: unknown = JSON.parse(raw);
        if (!isValidSession(parsed)) {
          await clearStoredSessionSafely();
          logger.warn('auth.session_invalid', { code: 'INVALID_STORED_SESSION' });
          return setState({
            status: 'unauthenticated',
            session: null,
            errorCode: 'INVALID_STORED_SESSION',
          });
        }

        logger.info('auth.session_restored', { restored: true });
        return setState({
          status: 'authenticated',
          session: parsed,
          errorCode: null,
        });
      } catch {
        await clearStoredSessionSafely();
        logger.warn('auth.session_restore_failed', { code: 'SESSION_RESTORE_FAILED' });
        return setState({
          status: 'unauthenticated',
          session: null,
          errorCode: null,
        });
      }
    },

    async signInWithEmail(email: string): Promise<boolean> {
      const trimmed = email.trim();
      if (!trimmed) {
        logger.warn('auth.magic_link_invalid_input', { code: 'INVALID_EMAIL' });
        setState({ errorCode: 'INVALID_EMAIL', magicLinkSent: false, isSubmitting: false });
        return false;
      }

      setState({ isSubmitting: true, errorCode: null, magicLinkSent: false });
      try {
        const { error } = await options.supabaseAuth.signInWithOtp({
          email: trimmed,
          options: { emailRedirectTo: redirectUrl },
        });
        if (error) {
          const code = sanitizeErrorCode(error.code, 'OTP_SIGN_IN_FAILED');
          logger.warn('auth.magic_link_failed', { code });
          setState({ isSubmitting: false, errorCode: code, magicLinkSent: false });
          return false;
        }

        logger.info('auth.magic_link_requested', { method: 'email_otp' });
        setState({ isSubmitting: false, errorCode: null, magicLinkSent: true });
        return true;
      } catch {
        logger.error('auth.magic_link_exception', { code: 'NETWORK_ERROR' });
        setState({ isSubmitting: false, errorCode: 'NETWORK_ERROR', magicLinkSent: false });
        return false;
      }
    },

    async signInWithOAuth(provider: AuthProvider): Promise<boolean> {
      setState({ isSubmitting: true, errorCode: null });
      try {
        const { error } = await options.supabaseAuth.signInWithOAuth({
          provider,
          options: { redirectTo: redirectUrl },
        });
        if (error) {
          const code = sanitizeErrorCode(error.code, 'OAUTH_SIGN_IN_FAILED');
          logger.warn('auth.oauth_failed', { provider, code });
          setState({ isSubmitting: false, errorCode: code });
          return false;
        }

        logger.info('auth.oauth_started', { provider });
        setState({ isSubmitting: false, errorCode: null });
        return true;
      } catch {
        logger.error('auth.oauth_exception', { provider, code: 'NETWORK_ERROR' });
        setState({ isSubmitting: false, errorCode: 'NETWORK_ERROR' });
        return false;
      }
    },

    async receiveSession(session: AuthSession): Promise<void> {
      if (!isValidSession(session)) {
        await clearStoredSessionSafely();
        logger.warn('auth.receive_session_invalid', { code: 'INVALID_SESSION' });
        setState({
          status: 'unauthenticated',
          session: null,
          errorCode: 'INVALID_SESSION',
        });
        return;
      }

      await storage.setItem(SESSION_STORAGE_KEY, JSON.stringify(session));
      logger.info('auth.session_established', { authenticated: true });
      setState({
        status: 'authenticated',
        session,
        errorCode: null,
        magicLinkSent: false,
        isSubmitting: false,
      });
    },

    async handleAuthCallback(url: string): Promise<boolean> {
      const code = extractPkceCode(url);
      if (!code) {
        logger.warn('auth.callback_rejected', { code: 'CALLBACK_REJECTED' });
        setState({ errorCode: 'CALLBACK_REJECTED', isSubmitting: false });
        return false;
      }

      setState({ isSubmitting: true, errorCode: null });
      try {
        const { data, error } = await options.supabaseAuth.exchangeCodeForSession(code);
        if (error || !isValidSession(data?.session)) {
          const errCode = sanitizeErrorCode(error?.code, 'CODE_EXCHANGE_FAILED');
          logger.warn('auth.callback_failed', { code: errCode });
          setState({ isSubmitting: false, errorCode: errCode });
          return false;
        }

        await storage.setItem(SESSION_STORAGE_KEY, JSON.stringify(data.session));
        logger.info('auth.callback_succeeded', { authenticated: true });
        setState({
          status: 'authenticated',
          session: data.session,
          errorCode: null,
          magicLinkSent: false,
          isSubmitting: false,
        });
        return true;
      } catch {
        logger.error('auth.callback_exception', { code: 'NETWORK_ERROR' });
        setState({ isSubmitting: false, errorCode: 'NETWORK_ERROR' });
        return false;
      }
    },

    async signOut(): Promise<void> {
      try {
        const { error } = await options.supabaseAuth.signOut();
        if (error) {
          const code = sanitizeErrorCode(error.code, 'SIGN_OUT_FAILED');
          logger.warn('auth.sign_out_server_warning', { code });
        }
      } catch {
        logger.warn('auth.sign_out_offline', { code: 'NETWORK_ERROR' });
      } finally {
        await clearStoredSessionSafely();
        logger.info('auth.sign_out', { authenticated: false });
        setState({
          status: 'unauthenticated',
          session: null,
          errorCode: null,
          magicLinkSent: false,
          isSubmitting: false,
        });
      }
    },
  };
}

function isSignInRoute(pathname: string): boolean {
  const withoutQuery = pathname.split('?')[0] ?? '';
  const normalized = withoutQuery.replace(/\/+$/, '') || '/';
  return (
    normalized === '/sign-in' ||
    normalized === '/(auth)/sign-in' ||
    normalized.startsWith('/(auth)/')
  );
}

export function resolveAuthRedirect(status: AuthStatus, pathname: string): string | null {
  if (status === 'loading') {
    return null;
  }

  const onSignIn = isSignInRoute(pathname);

  if (status === 'unauthenticated') {
    return onSignIn ? null : '/(auth)/sign-in';
  }

  if (status === 'authenticated' && onSignIn) {
    return '/';
  }

  return null;
}

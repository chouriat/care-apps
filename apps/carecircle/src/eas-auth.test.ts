import { AppState, type AppStateStatus } from 'react-native';
import appEasConfig from '../eas.json';
import {
  getSupabaseClient,
  resetSupabaseClientForTests,
  resolveSupabaseConfig,
} from './features/auth/api';

describe('F-8 EAS profiles and Supabase client configuration (apps/carecircle)', () => {
  // Change process.env in place: Expo's Babel plugin rewrites process.env.EXPO_PUBLIC_* to an
  // env object that keeps pointing at the original process.env.
  const originalUrl = process.env.EXPO_PUBLIC_SUPABASE_URL;
  const originalKey = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;
  const globalDevRef = globalThis as { __DEV__?: boolean };
  const originalDev = globalDevRef.__DEV__;

  beforeEach(() => {
    resetSupabaseClientForTests();
    delete process.env.EXPO_PUBLIC_SUPABASE_URL;
    delete process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;
    globalDevRef.__DEV__ = true;
  });

  afterEach(() => {
    resetSupabaseClientForTests();
    process.env.EXPO_PUBLIC_SUPABASE_URL = originalUrl;
    process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY = originalKey;
    if (originalUrl === undefined) delete process.env.EXPO_PUBLIC_SUPABASE_URL;
    if (originalKey === undefined) delete process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;
    globalDevRef.__DEV__ = originalDev;
    jest.restoreAllMocks();
  });

  it('defines development and preview Android APK profiles in eas.json', () => {
    expect(appEasConfig.build.development).toMatchObject({
      developmentClient: true,
      distribution: 'internal',
      environment: 'development',
      android: { buildType: 'apk' },
    });
    // A Supabase URL baked into a profile would override apps/carecircle/.env and point real
    // phones and the iOS simulator at the Android emulator's host address.
    for (const profile of Object.values(appEasConfig.build)) {
      expect(JSON.stringify(profile)).not.toMatch(/EXPO_PUBLIC_SUPABASE/);
    }
    expect(appEasConfig.build.preview).toMatchObject({
      distribution: 'internal',
      environment: 'preview',
      android: { buildType: 'apk' },
    });
    expect(appEasConfig.build.production).toMatchObject({
      environment: 'production',
      android: { buildType: 'app-bundle' },
    });
  });

  it('throws on first client creation when EXPO_PUBLIC_SUPABASE_ANON_KEY is missing, and when EXPO_PUBLIC_SUPABASE_URL is missing in non-dev builds', () => {
    // Missing anon key throws on client creation (never uses placeholder key)
    expect(() => getSupabaseClient()).toThrow(/EXPO_PUBLIC_SUPABASE_ANON_KEY/);

    // Non-dev build (__DEV__ === false) without EXPO_PUBLIC_SUPABASE_URL throws
    globalDevRef.__DEV__ = false;
    process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY = 'anon-test-key';
    expect(() => getSupabaseClient()).toThrow(/EXPO_PUBLIC_SUPABASE_URL/);
    expect(() =>
      resolveSupabaseConfig({ EXPO_PUBLIC_SUPABASE_ANON_KEY: 'anon-test-key' }, false),
    ).toThrow(/EXPO_PUBLIC_SUPABASE_URL/);

    // Dev build (__DEV__ === true) without EXPO_PUBLIC_SUPABASE_URL warns and falls back to local URL
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const resolved = resolveSupabaseConfig(
      { EXPO_PUBLIC_SUPABASE_ANON_KEY: 'anon-test-key' },
      true,
    );
    expect(resolved.url).toMatch(/^http:\/\/(127\.0\.0\.1|10\.0\.2\.2):54321$/);
    expect(resolved.anonKey).toBe('anon-test-key');
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it('starts and stops Supabase token auto-refresh when React Native AppState changes', () => {
    let capturedListener: ((state: AppStateStatus) => void) | undefined;
    const removeSpy = jest.fn();
    jest.spyOn(AppState, 'addEventListener').mockImplementation((_type, listener) => {
      capturedListener = listener;
      return { remove: removeSpy };
    });

    process.env.EXPO_PUBLIC_SUPABASE_URL = 'https://example.supabase.co';
    process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY = 'anon-test-key';

    const client = getSupabaseClient();
    const startSpy = jest.spyOn(client.auth, 'startAutoRefresh').mockResolvedValue();
    const stopSpy = jest.spyOn(client.auth, 'stopAutoRefresh').mockResolvedValue();

    expect(capturedListener).toBeDefined();

    capturedListener?.('active');
    expect(startSpy).toHaveBeenCalledTimes(1);
    expect(stopSpy).not.toHaveBeenCalled();

    capturedListener?.('background');
    expect(stopSpy).toHaveBeenCalledTimes(1);

    capturedListener?.('inactive');
    expect(stopSpy).toHaveBeenCalledTimes(2);
  });

  it('reads the Supabase variables in the literal form that Expo copies into release builds', () => {
    // Found by the Maestro CI run: reading process.env through another object compiled to
    // undefined in the release APK, so the app crashed on launch.
    const fs = jest.requireActual<{ readFileSync(path: string, encoding: 'utf8'): string }>('fs');
    const { testPath = '' } = expect.getState();
    const source = fs.readFileSync(
      testPath.replace(/eas-auth\.test\.ts$/, 'features/auth/api.ts'),
      'utf8',
    );
    expect(source).toContain('process.env.EXPO_PUBLIC_SUPABASE_URL');
    expect(source).toContain('process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY');
    expect(source).not.toMatch(/=\s*process\.env\s*[;,)]/);
    expect(source).not.toMatch(/as Record<string, string \| undefined>\)\s*:/);
  });
});

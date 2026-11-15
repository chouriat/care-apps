import { CARECIRCLE_MOCKS } from '@carecircle/core';

export type CareCircleMocks = typeof CARECIRCLE_MOCKS;

export function isMocksEnabled(env?: Record<string, string | undefined>): boolean {
  if (env !== undefined) {
    return env.MOCKS === '1' || env.EXPO_PUBLIC_MOCKS === '1';
  }
  return process.env.MOCKS === '1' || process.env.EXPO_PUBLIC_MOCKS === '1';
}

export function loadCareCircleMocks(
  env?: Record<string, string | undefined>,
): CareCircleMocks | null {
  if (!isMocksEnabled(env)) {
    return null;
  }
  return CARECIRCLE_MOCKS;
}

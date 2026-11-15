import type { AuthState } from '@carecircle/core';
import { useEffect } from 'react';
import { getAppObservability } from './api';

export function useObservability(authState: Pick<AuthState, 'status' | 'session'>): void {
  useEffect(() => {
    getAppObservability().syncAuthState(authState);
  }, [authState]);
}

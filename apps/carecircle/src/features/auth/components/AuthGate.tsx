import { resolveAuthRedirect, type AuthStatus } from '@carecircle/core';
import { useEffect, type ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';

export interface AuthGateProps {
  status: AuthStatus;
  pathname: string;
  onRedirect?: (targetRoute: string) => void;
  children: ReactNode;
}

export function AuthGate({ status, pathname, onRedirect, children }: AuthGateProps) {
  const redirectTarget = resolveAuthRedirect(status, pathname);

  useEffect(() => {
    if (redirectTarget && onRedirect) {
      onRedirect(redirectTarget);
    }
  }, [redirectTarget, pathname, onRedirect]);

  if (status === 'loading') {
    return <View testID="auth-loading" style={styles.loading} />;
  }

  if (redirectTarget !== null) {
    return null;
  }

  return <>{children}</>;
}

const styles = StyleSheet.create({
  loading: {
    flex: 1,
  },
});

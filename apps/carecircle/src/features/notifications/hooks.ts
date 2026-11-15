import type { AuthStatus } from '@carecircle/core';
import { useEffect } from 'react';
import { getAppPushNotificationsController } from './api';

export function usePushNotifications(status: AuthStatus): void {
  useEffect(() => {
    void getAppPushNotificationsController().syncAuthStatus(status);
  }, [status]);
}

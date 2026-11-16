import type { MemberRole } from '@carecircle/core';
import { useCallback, useEffect, useState } from 'react';
import { View } from 'react-native';
import en from '../i18n/en.json';
import {
  CircleSettingsScreen,
  createInviteViaRpc,
  loadCircleSettings,
  removeCircleMember,
  updateMemberRole,
  type CircleMemberItem,
  type CircleSettingsDeps,
  type CreateInviteErrorCode,
  type InviteAssignableRole,
  type MemberActionErrorCode,
} from '../src/features/circle';
import { PaywallSheet } from '../src/features/paywall/components';

export interface CircleRouteProps {
  deps?: CircleSettingsDeps;
}

export default function CircleRoute({ deps }: CircleRouteProps = {}) {
  const [isLoading, setIsLoading] = useState(true);
  const [isOffline, setIsOffline] = useState(false);
  const [hasError, setHasError] = useState(false);
  const [circleId, setCircleId] = useState('');
  const [circleName, setCircleName] = useState('');
  const [currentUserId, setCurrentUserId] = useState('');
  const [currentUserRole, setCurrentUserRole] = useState<MemberRole>('viewer');
  const [members, setMembers] = useState<CircleMemberItem[]>([]);
  const [inviteUrl, setInviteUrl] = useState<string | null>(null);
  const [inviteExpiresAt, setInviteExpiresAt] = useState<string | null>(null);
  const [errorCode, setErrorCode] = useState<CreateInviteErrorCode | MemberActionErrorCode | null>(
    null,
  );
  const [actionNotice, setActionNotice] = useState<string | null>(null);
  const [paywallVisible, setPaywallVisible] = useState(false);

  const reload = useCallback(async () => {
    setIsLoading(true);
    setHasError(false);
    setIsOffline(false);
    const result = await loadCircleSettings(deps);
    if (result.ok) {
      setCircleId(result.circleId);
      setCircleName(result.circleName);
      setCurrentUserId(result.currentUserId);
      setCurrentUserRole(result.currentUserRole);
      setMembers(result.members);
    } else {
      setIsOffline(result.isOffline);
      setHasError(!result.isOffline);
    }
    setIsLoading(false);
  }, [deps]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const handleCreateInvite = useCallback(
    async (role: InviteAssignableRole) => {
      if (!circleId) return;
      setErrorCode(null);
      setActionNotice(null);
      const res = await createInviteViaRpc(
        { circleId, role },
        deps?.getClient ? { getClient: deps.getClient as never } : undefined,
      );
      if (res.ok) {
        setInviteUrl(res.url);
        setInviteExpiresAt(res.expiresAt);
      } else {
        setIsOffline(res.isOffline);
        setErrorCode(res.errorCode);
        if (res.errorCode !== 'CIRCLE_FULL' && !res.isOffline) {
          setActionNotice(en.circle.notSavedMessage);
        }
      }
    },
    [circleId, deps],
  );

  const handleChangeMemberRole = useCallback(
    async (userId: string, nextRole: InviteAssignableRole) => {
      if (!circleId) return;
      setErrorCode(null);
      setActionNotice(null);
      const res = await updateMemberRole(
        { circleId, targetUserId: userId, role: nextRole },
        deps?.getClient ? { getClient: deps.getClient as never } : undefined,
      );
      if (!res.ok) {
        setIsOffline(res.isOffline);
        setErrorCode(res.errorCode);
        setActionNotice(en.circle.notSavedMessage);
        return;
      }

      // Reload from the server to confirm the row actually changed (PostgREST returns error: null
      // even when RLS filtered out 0 rows).
      const reloaded = await loadCircleSettings(deps);
      if (reloaded.ok) {
        setMembers(reloaded.members);
        const updatedMember = reloaded.members.find((m) => m.userId === userId);
        if (updatedMember?.role !== nextRole) {
          setErrorCode('MEMBER_ACTION_FAILED');
          setActionNotice(en.circle.notSavedMessage);
        }
      } else {
        setErrorCode('MEMBER_ACTION_FAILED');
        setActionNotice(en.circle.notSavedMessage);
      }
    },
    [circleId, deps],
  );

  const handleRemoveMember = useCallback(
    async (userId: string) => {
      if (!circleId) return;
      setErrorCode(null);
      setActionNotice(null);
      const res = await removeCircleMember(
        { circleId, targetUserId: userId },
        deps?.getClient ? { getClient: deps.getClient as never } : undefined,
      );
      if (!res.ok) {
        setIsOffline(res.isOffline);
        setErrorCode(res.errorCode);
        setActionNotice(en.circle.notSavedMessage);
        return;
      }

      const reloaded = await loadCircleSettings(deps);
      if (reloaded.ok) {
        setMembers(reloaded.members);
        const stillPresent = reloaded.members.some((m) => m.userId === userId);
        if (stillPresent) {
          setErrorCode('MEMBER_ACTION_FAILED');
          setActionNotice(en.circle.notSavedMessage);
        }
      } else {
        setErrorCode('MEMBER_ACTION_FAILED');
        setActionNotice(en.circle.notSavedMessage);
      }
    },
    [circleId, deps],
  );

  return (
    <View style={{ flex: 1 }}>
      <CircleSettingsScreen
        circleId={circleId}
        circleName={circleName}
        currentUserId={currentUserId}
        currentUserRole={currentUserRole}
        members={members}
        isLoading={isLoading}
        isOffline={isOffline}
        hasError={hasError}
        actionNotice={actionNotice}
        inviteUrl={inviteUrl}
        inviteExpiresAt={inviteExpiresAt}
        errorCode={errorCode}
        onCreateInvite={handleCreateInvite}
        onChangeMemberRole={handleChangeMemberRole}
        onRemoveMember={handleRemoveMember}
        onShowPaywall={() => setPaywallVisible(true)}
        onRetry={() => {
          void reload();
        }}
      />
      <PaywallSheet visible={paywallVisible} onClose={() => setPaywallVisible(false)} />
    </View>
  );
}

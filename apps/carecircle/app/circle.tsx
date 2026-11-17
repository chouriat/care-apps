import type { MemberRole } from '@carecircle/core';
import { useRouter } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
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
  const router = useRouter();
  const depsRef = useRef(deps);
  depsRef.current = deps;

  const [isLoading, setIsLoading] = useState(true);
  const [isOffline, setIsOffline] = useState(false);
  const [hasError, setHasError] = useState(false);
  const [circleId, setCircleId] = useState('');
  const [circleName, setCircleName] = useState('');
  const [currentUserId, setCurrentUserId] = useState('');
  const [currentUserRole, setCurrentUserRole] = useState<MemberRole>('viewer');
  const [planName, setPlanName] = useState<'free' | 'family'>('free');
  const [members, setMembers] = useState<CircleMemberItem[]>([]);
  const [inviteUrl, setInviteUrl] = useState<string | null>(null);
  const [inviteExpiresAt, setInviteExpiresAt] = useState<string | null>(null);
  const [errorCode, setErrorCode] = useState<CreateInviteErrorCode | MemberActionErrorCode | null>(
    null,
  );
  const [actionNotice, setActionNotice] = useState<string | null>(null);
  const [paywallVisible, setPaywallVisible] = useState(false);
  const [paywallTrigger, setPaywallTrigger] = useState<'members' | 'settings'>('members');

  const reload = useCallback(async () => {
    setIsLoading(true);
    setHasError(false);
    setIsOffline(false);
    const result = await loadCircleSettings(depsRef.current);
    if (result.ok) {
      setCircleId(result.circleId);
      setCircleName(result.circleName);
      setCurrentUserId(result.currentUserId);
      setCurrentUserRole(result.currentUserRole);
      setPlanName(result.planName);
      setMembers(result.members);
    } else {
      setIsOffline(result.isOffline);
      setHasError(!result.isOffline);
    }
    setIsLoading(false);
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const handleCreateInvite = useCallback(
    async (role: InviteAssignableRole) => {
      if (!circleId) return;
      setErrorCode(null);
      setActionNotice(null);
      const currentDeps = depsRef.current;
      const res = await createInviteViaRpc(
        { circleId, role },
        currentDeps?.getClient ? { getClient: currentDeps.getClient as never } : undefined,
      );
      if (res.ok) {
        setInviteUrl(res.url);
        setInviteExpiresAt(res.expiresAt);
      } else {
        setIsOffline(res.isOffline);
        setErrorCode(res.errorCode);
        if (res.errorCode === 'CIRCLE_FULL') {
          setPaywallTrigger('members');
          setPaywallVisible(true);
        } else if (!res.isOffline) {
          setActionNotice(en.circle.notSavedMessage);
        }
      }
    },
    [circleId],
  );

  const handleChangeMemberRole = useCallback(
    async (userId: string, nextRole: InviteAssignableRole) => {
      if (!circleId) return;
      setErrorCode(null);
      setActionNotice(null);
      const currentDeps = depsRef.current;
      const res = await updateMemberRole(
        { circleId, targetUserId: userId, role: nextRole },
        currentDeps?.getClient ? { getClient: currentDeps.getClient as never } : undefined,
      );
      if (!res.ok) {
        setIsOffline(res.isOffline);
        setErrorCode(res.errorCode);
        setActionNotice(en.circle.notSavedMessage);
        return;
      }

      // Reload from the server to confirm the row actually changed (PostgREST returns error: null
      // even when RLS filtered out 0 rows).
      const reloaded = await loadCircleSettings(currentDeps);
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
    [circleId],
  );

  const handleRemoveMember = useCallback(
    async (userId: string) => {
      if (!circleId) return;
      setErrorCode(null);
      setActionNotice(null);
      const currentDeps = depsRef.current;
      const res = await removeCircleMember(
        { circleId, targetUserId: userId },
        currentDeps?.getClient ? { getClient: currentDeps.getClient as never } : undefined,
      );
      if (!res.ok) {
        setIsOffline(res.isOffline);
        setErrorCode(res.errorCode);
        setActionNotice(en.circle.notSavedMessage);
        return;
      }

      const reloaded = await loadCircleSettings(currentDeps);
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
    [circleId],
  );

  return (
    <View style={{ flex: 1 }}>
      <CircleSettingsScreen
        circleId={circleId}
        circleName={circleName}
        currentUserId={currentUserId}
        currentUserRole={currentUserRole}
        planName={planName}
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
        onShowPaywall={() => {
          setPaywallTrigger('members');
          setPaywallVisible(true);
        }}
        onUpgradePlan={() => {
          setPaywallTrigger('settings');
          setPaywallVisible(true);
        }}
        onOpenCareLog={() => router.push('/log' as never)}
        onRetry={() => {
          void reload();
        }}
      />
      <PaywallSheet
        visible={paywallVisible}
        trigger={paywallTrigger}
        onClose={() => setPaywallVisible(false)}
      />
    </View>
  );
}

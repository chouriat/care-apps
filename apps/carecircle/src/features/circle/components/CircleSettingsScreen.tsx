import type { MemberRole } from '@carecircle/core';
import { Button, Card, ErrorState, Header, useTheme } from '@carecircle/ui';
import { useState } from 'react';
import { ActivityIndicator, ScrollView, Share, StyleSheet, Text, View } from 'react-native';
import en from '../../../../i18n/en.json';
import type {
  CircleMemberItem,
  CreateInviteErrorCode,
  InviteAssignableRole,
  MemberActionErrorCode,
} from '../api';

export interface CircleSettingsScreenProps {
  circleId: string;
  circleName: string;
  currentUserId: string;
  currentUserRole: MemberRole;
  planName?: 'free' | 'family';
  members: CircleMemberItem[];
  isLoading?: boolean;
  isOffline?: boolean;
  hasError?: boolean;
  actionNotice?: string | null;
  inviteUrl?: string | null;
  inviteExpiresAt?: string | null;
  errorCode?: CreateInviteErrorCode | MemberActionErrorCode | null;
  onCreateInvite?: (role: InviteAssignableRole) => void | Promise<void>;
  onChangeMemberRole?: (userId: string, nextRole: InviteAssignableRole) => void | Promise<void>;
  onRemoveMember?: (userId: string) => void | Promise<void>;
  onShowPaywall?: () => void;
  onRetry?: () => void;
}

function roleLabelFor(role: MemberRole): string {
  if (role === 'owner') return en.circle.roleOwner;
  if (role === 'helper') return en.circle.roleHelper;
  return en.circle.roleViewer;
}

export function CircleSettingsScreen({
  circleName,
  currentUserId,
  currentUserRole,
  members,
  isLoading = false,
  isOffline = false,
  hasError = false,
  actionNotice = null,
  inviteUrl = null,
  errorCode = null,
  onCreateInvite,
  onChangeMemberRole,
  onRemoveMember,
  onShowPaywall,
  onRetry,
}: CircleSettingsScreenProps) {
  const { colors, radii, spacing, typography } = useTheme();
  const [selectedInviteRole, setSelectedInviteRole] = useState<InviteAssignableRole>('helper');

  const isOwner = currentUserRole === 'owner';
  const showStateOnly = isLoading || isOffline || hasError;
  const showNotSavedBanner =
    Boolean(actionNotice) ||
    errorCode === 'MEMBER_ACTION_FAILED' ||
    errorCode === 'PERMISSION_DENIED';

  return (
    <ScrollView
      testID="circle-settings-screen"
      style={[styles.screen, { backgroundColor: colors.background }]}
      contentContainerStyle={[
        styles.content,
        {
          padding: spacing.lg,
          gap: spacing.md,
        },
      ]}
    >
      <Header title={circleName || en.circle.title} />

      {isLoading ? (
        <View testID="circle-settings-loading" style={[styles.statusRow, { gap: spacing.sm }]}>
          <ActivityIndicator color={colors.primary} />
          <Text
            style={{
              color: colors.textPrimary,
              fontSize: typography.body.fontSize,
              lineHeight: typography.body.lineHeight,
            }}
          >
            {en.circle.loading}
          </Text>
        </View>
      ) : null}

      {isOffline ? (
        <View testID="circle-settings-offline">
          <ErrorState
            title={en.circle.offlineTitle}
            message={en.circle.offlineMessage}
            retryLabel={en.circle.retry}
            onRetry={() => onRetry?.()}
          />
        </View>
      ) : null}

      {hasError && !isOffline ? (
        <View testID="circle-settings-error" style={{ gap: spacing.sm }}>
          <Text
            style={{
              color: colors.danger,
              fontSize: typography.subtitle.fontSize,
              lineHeight: typography.subtitle.lineHeight,
              fontWeight: typography.subtitle.fontWeight,
            }}
          >
            {en.circle.errorTitle}
          </Text>
          <Text
            style={{
              color: colors.textSecondary,
              fontSize: typography.body.fontSize,
              lineHeight: typography.body.lineHeight,
            }}
          >
            {en.circle.errorMessage}
          </Text>
          <View testID="circle-settings-retry-button">
            <Button
              label={en.circle.retry}
              accessibilityLabel={en.circle.retry}
              onPress={() => onRetry?.()}
            />
          </View>
        </View>
      ) : null}

      {showNotSavedBanner ? (
        <Card>
          <View testID="circle-action-notice" style={{ gap: spacing.xs }}>
            <Text
              style={{
                color: colors.danger,
                fontSize: typography.subtitle.fontSize,
                lineHeight: typography.subtitle.lineHeight,
                fontWeight: typography.subtitle.fontWeight,
              }}
            >
              {en.circle.notSavedTitle}
            </Text>
            <Text
              style={{
                color: colors.textSecondary,
                fontSize: typography.body.fontSize,
                lineHeight: typography.body.lineHeight,
              }}
            >
              {actionNotice ?? en.circle.notSavedMessage}
            </Text>
          </View>
        </Card>
      ) : null}

      {!showStateOnly ? (
        <Card>
          {/* On Android, a plain View is left out of the accessibility tree that Maestro and
              screen readers read, and its children are lifted next to it. Marking the list as
              important keeps the names and roles inside it, so `childOf: circle-member-list`
              finds them. */}
          <View
            testID="circle-member-list"
            importantForAccessibility="yes"
            style={{ gap: spacing.md }}
          >
            <Text
              style={{
                color: colors.textPrimary,
                fontSize: typography.subtitle.fontSize,
                lineHeight: typography.subtitle.lineHeight,
                fontWeight: typography.subtitle.fontWeight,
              }}
            >
              {en.circle.membersHeading}
            </Text>

            {members.map((member) => {
              const canManageMember =
                isOwner && member.role !== 'owner' && member.userId !== currentUserId;
              const nextRole: InviteAssignableRole = member.role === 'helper' ? 'viewer' : 'helper';

              return (
                <View
                  key={member.userId}
                  testID={`circle-member-row-${member.userId}`}
                  style={[
                    styles.memberRow,
                    {
                      borderColor: colors.border,
                      borderRadius: radii.md,
                      padding: spacing.sm,
                      gap: spacing.sm,
                    },
                  ]}
                >
                  <View style={styles.memberInfo}>
                    <Text
                      style={{
                        color: colors.textPrimary,
                        fontSize: typography.body.fontSize,
                        lineHeight: typography.body.lineHeight,
                        fontWeight: typography.subtitle.fontWeight,
                      }}
                    >
                      {member.displayName || en.circle.defaultMemberName}
                    </Text>
                    <Text
                      style={{
                        color: colors.textSecondary,
                        fontSize: typography.caption.fontSize,
                        lineHeight: typography.caption.lineHeight,
                      }}
                    >
                      {roleLabelFor(member.role)}
                    </Text>
                  </View>

                  {canManageMember ? (
                    <View style={[styles.memberActions, { gap: spacing.xs }]}>
                      <View testID={`circle-member-role-toggle-${member.userId}`}>
                        <Button
                          variant="secondary"
                          label={
                            member.role === 'helper' ? en.circle.makeViewer : en.circle.makeHelper
                          }
                          accessibilityLabel={
                            member.role === 'helper' ? en.circle.makeViewer : en.circle.makeHelper
                          }
                          onPress={() => {
                            void onChangeMemberRole?.(member.userId, nextRole);
                          }}
                        />
                      </View>
                      <View testID={`circle-member-remove-${member.userId}`}>
                        <Button
                          variant="secondary"
                          label={en.circle.removeMember}
                          accessibilityLabel={en.circle.removeMember}
                          onPress={() => {
                            void onRemoveMember?.(member.userId);
                          }}
                        />
                      </View>
                    </View>
                  ) : null}
                </View>
              );
            })}
          </View>
        </Card>
      ) : null}

      {!showStateOnly && isOwner ? (
        <Card>
          <View style={{ gap: spacing.sm }}>
            <Text
              style={{
                color: colors.textPrimary,
                fontSize: typography.subtitle.fontSize,
                lineHeight: typography.subtitle.lineHeight,
                fontWeight: typography.subtitle.fontWeight,
              }}
            >
              {en.circle.inviteHeading}
            </Text>
            <Text
              style={{
                color: colors.textSecondary,
                fontSize: typography.body.fontSize,
                lineHeight: typography.body.lineHeight,
              }}
            >
              {en.circle.inviteBody}
            </Text>

            <View style={[styles.roleSelectorRow, { gap: spacing.sm }]}>
              <View testID="circle-invite-role-helper" style={styles.roleButton}>
                <Button
                  variant={selectedInviteRole === 'helper' ? 'primary' : 'secondary'}
                  label={en.circle.inviteRoleHelper}
                  accessibilityLabel={en.circle.inviteRoleHelper}
                  onPress={() => setSelectedInviteRole('helper')}
                />
              </View>
              <View testID="circle-invite-role-viewer" style={styles.roleButton}>
                <Button
                  variant={selectedInviteRole === 'viewer' ? 'primary' : 'secondary'}
                  label={en.circle.inviteRoleViewer}
                  accessibilityLabel={en.circle.inviteRoleViewer}
                  onPress={() => setSelectedInviteRole('viewer')}
                />
              </View>
            </View>

            <View testID="circle-create-invite-button">
              <Button
                label={en.circle.createInvite}
                accessibilityLabel={en.circle.createInviteA11y}
                onPress={() => {
                  void onCreateInvite?.(selectedInviteRole);
                }}
              />
            </View>

            {inviteUrl ? (
              <View style={{ gap: spacing.xs }}>
                <Text
                  testID="circle-invite-link-value"
                  selectable
                  style={{
                    color: colors.textPrimary,
                    fontSize: typography.caption.fontSize,
                    lineHeight: typography.caption.lineHeight,
                  }}
                >
                  {inviteUrl}
                </Text>
                <View testID="circle-share-invite-button">
                  <Button
                    variant="secondary"
                    label={en.circle.shareInvite}
                    accessibilityLabel={en.circle.shareInviteA11y}
                    onPress={() => {
                      void Share.share({ message: inviteUrl }).catch(() => undefined);
                    }}
                  />
                </View>
              </View>
            ) : null}

            {errorCode === 'CIRCLE_FULL' ? (
              <View style={{ gap: spacing.xs }}>
                <Text
                  style={{
                    color: colors.danger,
                    fontSize: typography.caption.fontSize,
                    lineHeight: typography.caption.lineHeight,
                  }}
                >
                  {en.circle.circleFullMessage}
                </Text>
                <View testID="circle-upgrade-paywall-button">
                  <Button
                    label={en.circle.upgradeCta}
                    accessibilityLabel={en.circle.upgradeA11y}
                    onPress={() => onShowPaywall?.()}
                  />
                </View>
              </View>
            ) : null}
          </View>
        </Card>
      ) : null}

      <Text
        style={{
          color: colors.textMuted,
          fontSize: typography.caption.fontSize,
          lineHeight: typography.caption.lineHeight,
        }}
      >
        {en.common.notMedicalAdvice}
      </Text>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
  },
  content: {
    flexGrow: 1,
  },
  statusRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  memberRow: {
    borderWidth: 1,
  },
  memberInfo: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  memberActions: {
    flexDirection: 'row',
    flexWrap: 'wrap',
  },
  roleSelectorRow: {
    flexDirection: 'row',
  },
  roleButton: {
    flex: 1,
  },
});

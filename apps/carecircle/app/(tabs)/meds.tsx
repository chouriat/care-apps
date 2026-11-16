import type { MemberRole } from '@carecircle/core';
import { useCallback, useEffect, useState } from 'react';
import {
  addMedication,
  loadMedicationsScreen,
  pauseMedication,
  updateMedication,
  type ActiveMedicationItem,
  type MedsDeps,
} from '../../src/features/meds/api';
import {
  MedsScreenView,
  type ValidatedMedicationFormPayload,
} from '../../src/features/meds/components';

export interface MedsRouteProps {
  deps?: MedsDeps;
}

export default function MedsScreen({ deps }: MedsRouteProps = {}) {
  const [isLoading, setIsLoading] = useState(true);
  const [hasError, setHasError] = useState(false);
  const [isOffline, setIsOffline] = useState(Boolean(deps?.isOffline));
  const [notSavedNotice, setNotSavedNotice] = useState(false);
  const [circleId, setCircleId] = useState('');
  const [circleTitle, setCircleTitle] = useState<string | undefined>(undefined);
  const [memberRole, setMemberRole] = useState<MemberRole>('viewer');
  const [items, setItems] = useState<ActiveMedicationItem[]>([]);

  const reload = useCallback(async () => {
    setIsLoading(true);
    setHasError(false);
    const res = await loadMedicationsScreen(deps);
    if (res.ok) {
      setCircleId(res.circle.id);
      setCircleTitle(
        res.circle.careRecipientName
          ? `${res.circle.name} · ${res.circle.careRecipientName}`
          : res.circle.name,
      );
      setMemberRole(res.memberRole);
      setItems(res.items);
      setIsOffline(res.isOffline);
      setHasError(false);
    } else {
      setIsOffline(res.isOffline);
      setHasError(!res.isOffline);
    }
    setIsLoading(false);
  }, [deps]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const handleSaveMedication = useCallback(
    async (
      payload: ValidatedMedicationFormPayload,
      editingMedicationId: string | null,
    ): Promise<boolean> => {
      if (!circleId) return false;
      setNotSavedNotice(false);

      const res = editingMedicationId
        ? await updateMedication(
            {
              circleId,
              medicationId: editingMedicationId,
              ...payload,
              memberRole,
            },
            deps,
          )
        : await addMedication(
            {
              circleId,
              ...payload,
              memberRole,
            },
            deps,
          );

      if (!res.ok) {
        setIsOffline(res.isOffline);
        setNotSavedNotice(true);
        return false;
      }

      // Reload from the server before showing the change as saved.
      const reloaded = await loadMedicationsScreen(deps);
      if (reloaded.ok) {
        setItems(reloaded.items);
        setMemberRole(reloaded.memberRole);
        return true;
      }

      setNotSavedNotice(true);
      return false;
    },
    [circleId, deps, memberRole],
  );

  const handlePauseMedication = useCallback(
    async (medicationId: string): Promise<boolean> => {
      if (!circleId) return false;
      setNotSavedNotice(false);

      const res = await pauseMedication(
        {
          circleId,
          medicationId,
          memberRole,
        },
        deps,
      );

      if (!res.ok) {
        setIsOffline(res.isOffline);
        setNotSavedNotice(true);
        return false;
      }

      const reloaded = await loadMedicationsScreen(deps);
      if (reloaded.ok) {
        setItems(reloaded.items);
        setMemberRole(reloaded.memberRole);
        return true;
      }

      setNotSavedNotice(true);
      return false;
    },
    [circleId, deps, memberRole],
  );

  return (
    <MedsScreenView
      circleTitle={circleTitle}
      memberRole={memberRole}
      items={items}
      isLoading={isLoading}
      hasError={hasError}
      isOffline={isOffline}
      notSavedNotice={notSavedNotice}
      onRetry={() => {
        void reload();
      }}
      onSaveMedication={handleSaveMedication}
      onPauseMedication={handlePauseMedication}
    />
  );
}

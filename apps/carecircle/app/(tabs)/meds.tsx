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
  onScanPrescription?: () => void;
}

function defaultOpenScanScreen(): void {
  void import('expo-router').then(({ router }) => {
    router.push('/meds/scan' as never);
  });
}

export default function MedsScreen({ deps, onScanPrescription }: MedsRouteProps = {}) {
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

  // After a confirmed save: reload without the full-screen spinner.
  const refreshList = useCallback(async () => {
    const res = await loadMedicationsScreen(deps);
    if (res.ok) {
      setItems(res.items);
      setMemberRole(res.memberRole);
      setIsOffline(res.isOffline);
      setHasError(false);
    } else {
      setIsOffline(res.isOffline);
      setHasError(!res.isOffline);
    }
  }, [deps]);

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

      // The server confirmed the save. Show the list as the server has it now. If only this
      // reload fails, the change IS saved: close the form and show the load error, never
      // "Not saved" (the person would tap Save again and add the medicine twice).
      await refreshList();
      return true;
    },
    [circleId, deps, memberRole, refreshList],
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

      await refreshList();
      return true;
    },
    [circleId, deps, memberRole, refreshList],
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
      onScanPrescription={onScanPrescription ?? defaultOpenScanScreen}
      onSaveMedication={handleSaveMedication}
      onPauseMedication={handlePauseMedication}
    />
  );
}

import {
  createMaterializeDosesHandler,
  type ActiveMedicationWithTimezoneRow,
  type DoseEventInsertRow,
  type MaterializeDosesStore,
} from './handler.ts';

interface JoinedMedicationRow {
  id: string;
  circle_id: string;
  schedule: Record<string, unknown>;
  start_date: string | null;
  end_date: string | null;
  active: boolean;
  circles: { timezone: string } | Array<{ timezone: string }>;
}

function createPostgrestStore(
  supabaseUrl: string,
  serviceRoleKey: string,
  fetchImpl: typeof fetch = fetch,
): Required<MaterializeDosesStore> {
  const baseUrl = supabaseUrl.replace(/\/$/, '');
  const authHeaders = {
    apikey: serviceRoleKey,
    authorization: `Bearer ${serviceRoleKey}`,
  };

  return {
    async listActiveMedications(): Promise<ActiveMedicationWithTimezoneRow[]> {
      const res = await fetchImpl(
        `${baseUrl}/rest/v1/medications?active=eq.true&select=id,circle_id,schedule,start_date,end_date,active,circles!inner(timezone)`,
        {
          method: 'GET',
          headers: {
            ...authHeaders,
            accept: 'application/json',
          },
        },
      );
      if (!res.ok) {
        throw new Error(`listActiveMedications failed with HTTP ${res.status}`);
      }
      const rows = (await res.json()) as JoinedMedicationRow[];
      return rows.map((row) => {
        const circleObj = Array.isArray(row.circles) ? row.circles[0] : row.circles;
        return {
          id: row.id,
          circle_id: row.circle_id,
          schedule: row.schedule,
          start_date: row.start_date,
          end_date: row.end_date,
          active: row.active,
          circle_timezone: circleObj?.timezone ?? '',
        };
      });
    },

    async insertPendingDoseEvents(rows: DoseEventInsertRow[]): Promise<{ inserted: number }> {
      if (rows.length === 0) {
        return { inserted: 0 };
      }
      // Equivalent to supabase-js `.upsert(rows, { onConflict: 'medication_id,due_at', ignoreDuplicates: true }).select('id')`:
      // PostgREST executes `INSERT ... ON CONFLICT (medication_id, due_at) DO NOTHING RETURNING id`,
      // returning only the rows actually inserted.
      const res = await fetchImpl(
        `${baseUrl}/rest/v1/dose_events?on_conflict=medication_id,due_at&select=id`,
        {
          method: 'POST',
          headers: {
            ...authHeaders,
            'content-type': 'application/json',
            prefer: 'resolution=ignore-duplicates,return=representation',
          },
          body: JSON.stringify(rows),
        },
      );
      if (!res.ok) {
        throw new Error(`insertPendingDoseEvents failed with HTTP ${res.status}`);
      }
      const insertedRows = (await res.json()) as Array<{ id: string }>;
      return { inserted: Array.isArray(insertedRows) ? insertedRows.length : 0 };
    },

    async deleteFuturePendingDoseEventsForMedication(
      medicationId: string,
      afterIso: string,
    ): Promise<{ deleted: number }> {
      const res = await fetchImpl(
        `${baseUrl}/rest/v1/dose_events?medication_id=eq.${encodeURIComponent(medicationId)}&status=eq.pending&due_at=gt.${encodeURIComponent(afterIso)}&select=id`,
        {
          method: 'DELETE',
          headers: {
            ...authHeaders,
            prefer: 'return=representation',
          },
        },
      );
      if (!res.ok) {
        throw new Error(
          `deleteFuturePendingDoseEventsForMedication failed with HTTP ${res.status}`,
        );
      }
      const deletedRows = (await res.json()) as Array<{ id: string }>;
      return { deleted: Array.isArray(deletedRows) ? deletedRows.length : 0 };
    },
  };
}

Deno.serve((req: Request) => {
  const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? '';
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
  const cronSecret = Deno.env.get('CRON_SECRET') ?? '';

  const store = createPostgrestStore(supabaseUrl, serviceRoleKey);
  const handler = createMaterializeDosesHandler({ cronSecret, store });
  return handler(req);
});

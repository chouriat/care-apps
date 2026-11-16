// A small stand-in for the Supabase client used by the Today tests. Unlike a fake that returns
// the same rows whatever the query, it really applies `eq`, `gte`, `lte`, `order` and `limit`,
// so a query that forgets a filter (for example the signed-in user's id on circle_members)
// gets the wrong rows and the test fails.

type Row = Record<string, unknown>;

export interface FakeQueryCall {
  table: string;
  op?: 'select' | 'insert' | 'update';
  values?: Record<string, unknown>;
  filters: Array<[op: 'eq' | 'gte' | 'lte', column: string, value: unknown]>;
}

export interface FakeTodayClientOptions {
  tables: Record<string, Row[]>;
  isOnline?: () => boolean;
  writeError?: (
    table: string,
    op: 'insert' | 'update',
    values: Record<string, unknown>,
  ) => { message: string; code?: string } | null;
  rpc?: (
    fn: string,
    args: Record<string, unknown>,
  ) => { data: unknown; error: { message: string; code?: string } | null };
}

export function createFakeTodayClient(options: FakeTodayClientOptions) {
  const queries: FakeQueryCall[] = [];
  const rpcCalls: Array<{ fn: string; args: Record<string, unknown> }> = [];
  const isOnline = options.isOnline ?? (() => true);
  let nextSeq = 1;

  function from(table: string) {
    const call: FakeQueryCall = { table, filters: [] };
    let orderBy: { column: string; ascending: boolean } | null = null;
    let limitN: number | null = null;
    let pendingOp: 'select' | 'insert' | 'update' = 'select';
    let pendingValues: Record<string, unknown> | null = null;

    const run = () => {
      queries.push(call);
      if (!isOnline()) {
        return { data: null, error: { message: 'TypeError: Network request failed' } };
      }

      if (pendingOp === 'insert' && pendingValues) {
        const err = options.writeError?.(table, 'insert', pendingValues) ?? null;
        if (err) {
          return { data: null, error: err };
        }
        const id =
          typeof pendingValues.id === 'string'
            ? pendingValues.id
            : `c1200099-0000-4000-8000-${String(nextSeq++).padStart(12, '0')}`;
        const created: Row = {
          id,
          strength: null,
          instructions: null,
          start_date: '2026-11-15',
          end_date: null,
          active: true,
          ...pendingValues,
        };
        const tableRows = options.tables[table] ?? [];
        tableRows.push(created);
        options.tables[table] = tableRows;
        return { data: [created], error: null };
      }

      if (pendingOp === 'update' && pendingValues) {
        const err = options.writeError?.(table, 'update', pendingValues) ?? null;
        if (err) {
          return { data: null, error: err };
        }
        const tableRows = options.tables[table] ?? [];
        const updatedRows: Row[] = [];
        options.tables[table] = tableRows.map((row) => {
          const matches = call.filters.every(([op, column, value]) => {
            if (op === 'eq') return row[column] === value;
            return true;
          });
          if (!matches) return row;
          const updated = { ...row, ...pendingValues };
          updatedRows.push(updated);
          return updated;
        });
        return { data: updatedRows, error: null };
      }

      let rows = [...(options.tables[table] ?? [])];
      for (const [op, column, value] of call.filters) {
        rows = rows.filter((row) => {
          const cell = row[column];
          if (op === 'eq') return cell === value;
          const a = new Date(String(cell)).getTime();
          const b = new Date(String(value)).getTime();
          return op === 'gte' ? a >= b : a <= b;
        });
      }
      if (orderBy) {
        const { column, ascending } = orderBy;
        rows.sort((x, y) => {
          const cmp = String(x[column]).localeCompare(String(y[column]));
          return ascending ? cmp : -cmp;
        });
      }
      if (limitN !== null) rows = rows.slice(0, limitN);
      return { data: rows, error: null };
    };

    const builder = {
      select: () => builder,
      insert: (values: Record<string, unknown>) => {
        pendingOp = 'insert';
        pendingValues = values;
        call.op = 'insert';
        call.values = values;
        return builder;
      },
      update: (values: Record<string, unknown>) => {
        pendingOp = 'update';
        pendingValues = values;
        call.op = 'update';
        call.values = values;
        return builder;
      },
      eq: (column: string, value: unknown) => {
        call.filters.push(['eq', column, value]);
        return builder;
      },
      gte: (column: string, value: unknown) => {
        call.filters.push(['gte', column, value]);
        return builder;
      },
      lte: (column: string, value: unknown) => {
        call.filters.push(['lte', column, value]);
        return builder;
      },
      order: (column: string, opts?: { ascending?: boolean }) => {
        orderBy = { column, ascending: opts?.ascending !== false };
        return builder;
      },
      limit: (n: number) => {
        limitN = n;
        return builder;
      },
      then: <T>(resolve: (value: ReturnType<typeof run>) => T, reject?: (e: unknown) => T) => {
        try {
          return Promise.resolve(resolve(run()));
        } catch (e) {
          return reject ? Promise.resolve(reject(e)) : Promise.reject(e);
        }
      },
    };
    return builder;
  }

  const client = {
    from,
    rpc: async (fn: string, args: Record<string, unknown>) => {
      if (!isOnline()) {
        return { data: null, error: { message: 'TypeError: Network request failed' } };
      }
      rpcCalls.push({ fn, args });
      return options.rpc
        ? options.rpc(fn, args)
        : { data: { id: args.doseEventId, status: args.status }, error: null };
    },
  };

  return { client: client as never, queries, rpcCalls };
}

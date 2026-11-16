// A small stand-in for the Supabase client used by the Today tests. Unlike a fake that returns
// the same rows whatever the query, it really applies `eq`, `gte`, `lte`, `order` and `limit`,
// so a query that forgets a filter (for example the signed-in user's id on circle_members)
// gets the wrong rows and the test fails.

type Row = Record<string, unknown>;

export interface FakeQueryCall {
  table: string;
  filters: Array<[op: 'eq' | 'gte' | 'lte', column: string, value: unknown]>;
}

export interface FakeTodayClientOptions {
  tables: Record<string, Row[]>;
  isOnline?: () => boolean;
  rpc?: (
    fn: string,
    args: Record<string, unknown>,
  ) => { data: unknown; error: { message: string; code?: string } | null };
}

export function createFakeTodayClient(options: FakeTodayClientOptions) {
  const queries: FakeQueryCall[] = [];
  const rpcCalls: Array<{ fn: string; args: Record<string, unknown> }> = [];
  const isOnline = options.isOnline ?? (() => true);

  function from(table: string) {
    const call: FakeQueryCall = { table, filters: [] };
    let orderBy: { column: string; ascending: boolean } | null = null;
    let limitN: number | null = null;

    const run = () => {
      queries.push(call);
      if (!isOnline()) {
        return { data: null, error: { message: 'TypeError: Network request failed' } };
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

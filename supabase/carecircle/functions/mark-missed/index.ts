import { createMarkMissedHandler } from './handler.ts';
import { createMarkMissedPostgrestStore, createSendPushViaFunction } from './store.ts';

Deno.serve((req: Request) => {
  const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? '';
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
  const cronSecret = Deno.env.get('CRON_SECRET') ?? '';

  const store = createMarkMissedPostgrestStore(supabaseUrl, serviceRoleKey);
  const sendPush = createSendPushViaFunction(supabaseUrl, serviceRoleKey);
  const handler = createMarkMissedHandler({ cronSecret, store, sendPush });
  return handler(req);
});

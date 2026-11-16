import { createMaterializeDosesHandler } from './handler.ts';
import { createPostgrestStore } from './store.ts';

Deno.serve((req: Request) => {
  const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? '';
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
  const cronSecret = Deno.env.get('CRON_SECRET') ?? '';

  const store = createPostgrestStore(supabaseUrl, serviceRoleKey);
  const handler = createMaterializeDosesHandler({ cronSecret, store });
  return handler(req);
});

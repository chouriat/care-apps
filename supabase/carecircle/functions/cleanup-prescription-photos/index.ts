import { createCleanupPrescriptionPhotosHandler } from './handler.ts';

if (import.meta.main) {
  Deno.serve(createCleanupPrescriptionPhotosHandler());
}

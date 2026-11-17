import { createExportLogHandler } from './handler.ts';

Deno.serve(createExportLogHandler());

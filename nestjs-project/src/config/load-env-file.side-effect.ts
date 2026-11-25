import { loadEnvFile } from './load-env-file';

/** Imported first by an entrypoint whose decorators read the configuration (`src/worker.ts`). */
loadEnvFile();

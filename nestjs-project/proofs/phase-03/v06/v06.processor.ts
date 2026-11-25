// V-06 — processor mínimo (WorkerHost do @nestjs/bullmq) da prova; não faz parte da aplicação.
import { Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job } from 'bullmq';

export const V06_QUEUE = 'v06-proof';

@Processor(V06_QUEUE)
export class V06Processor extends WorkerHost {
  process(
    job: Job<{ a: number; b: number }>,
  ): Promise<{ sum: number; moduleSystem: string }> {
    // `module` e `require` só existem quando o código roda como CommonJS.
    const moduleSystem =
      typeof module !== 'undefined' && typeof require === 'function'
        ? 'commonjs'
        : 'esm';
    return Promise.resolve({ sum: job.data.a + job.data.b, moduleSystem });
  }
}

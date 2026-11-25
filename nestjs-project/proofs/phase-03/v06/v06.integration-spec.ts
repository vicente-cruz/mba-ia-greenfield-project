// V-06 — spec do Jest 30 em CommonJS contra o Redis real. Fica fora da suíte normal (rootDir `src`);
// roda pelo roteiro: `npx jest --rootDir . --roots '<rootDir>/proofs/phase-03/v06'`.
import { getQueueToken } from '@nestjs/bullmq';
import { Test } from '@nestjs/testing';
import { Queue, QueueEvents } from 'bullmq';
import Redis from 'ioredis';
import { V06_PREFIX, V06Module } from './v06.module';
import { V06_QUEUE } from './v06.processor';

describe('V-06: Nest + @nestjs/bullmq + BullMQ + Redis em CommonJS', () => {
  it('processa um job pelo WorkerHost e encerra as conexões sem deixar chaves', async () => {
    expect(typeof require).toBe('function');
    expect(typeof module).toBe('object');
    const moduleRef = await Test.createTestingModule({
      imports: [V06Module],
    }).compile();
    await moduleRef.init();
    const queue = moduleRef.get<Queue>(getQueueToken(V06_QUEUE));
    const events = new QueueEvents(V06_QUEUE, {
      connection: queue.opts.connection,
      prefix: V06_PREFIX,
    });
    try {
      await events.waitUntilReady();
      const job = await queue.add(
        'soma',
        { a: 2, b: 3 },
        { jobId: 'v06-job-1' },
      );
      const result: unknown = await job.waitUntilFinished(events, 15_000);
      expect(result).toEqual({ sum: 5, moduleSystem: 'commonjs' });
      const stored = await queue.getJob('v06-job-1');
      expect(await stored?.getState()).toBe('completed');
    } finally {
      await queue.obliterate({ force: true });
      await events.close();
      await moduleRef.close();
    }
    // O BullMQ 6 não expõe mais `queue.client`; a conferência usa um cliente ioredis próprio.
    const redis = new Redis({
      host: process.env.REDIS_HOST,
      port: Number(process.env.REDIS_PORT),
      lazyConnect: true,
    });
    try {
      await redis.connect();
      expect(await redis.keys(`${V06_PREFIX}:*`)).toEqual([]);
    } finally {
      await redis.quit();
    }
  });
});

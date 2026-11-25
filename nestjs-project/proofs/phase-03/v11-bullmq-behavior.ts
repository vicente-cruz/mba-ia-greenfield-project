// V-11 — BullMQ 6.7.7 no Redis real: padrões e entrega, geração e retenção, e manutenção
// (phase-03-videos/TD-09, TD-10, TD-12, AMB-6). Roda dentro do container `nestjs-api`, chamado
// por `bullmq-proof-roteiro.sh v11`. Não faz parte da aplicação.
//
// Subcomandos:
//   core <runId>         grupo 1 (padrões e entrega) e grupo 2 (geração e retenção);
//   maintenance <runId>  grupo 3 (Job Scheduler com duas instâncias, repetição, reinício do
//                        worker e indisponibilidade do Redis). Imprime V11_AGUARDANDO_PARADA_DO_REDIS
//                        e espera o roteiro parar e religar o serviço `redis` do Compose;
//   child <config>       processo filho com um Worker, para SIGKILL, SIGSTOP e SIGTERM reais (interno);
//   cleanup <prefixo>    encerra filhos restantes e apaga as chaves do prefixo (proofs-v06-, proofs-v11-);
//   snapshot             retrato do Redis, só leitura.
//
// Tudo usa o prefixo exclusivo `proofs-v11-<runId>`. Os itens obrigatórios (PASSOU/FALHOU) fazem a
// prova falhar; os INFO são informativos (inclusive o `Job.retry()`, que não condiciona a TD-12).
// As leituras diretas de chaves do BullMQ (lock e stalled-check) servem só para medir a prova.
// Código de saída: 0 com sucesso, 1 com item obrigatório reprovado, 2 com erro de execução.
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { BullModule, Processor, WorkerHost } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import {
  type Job,
  Queue,
  QueueEvents,
  UnrecoverableError,
  Worker,
  type WorkerOptions,
} from 'bullmq';
import Redis from 'ioredis';
import { Checks, readProjectEnv, requireKey, sleep } from './proof-support';

interface Connection {
  host: string;
  port: number;
}

type JobData = Record<string, unknown>;

/** Configuração curta de lock e stall; `maxStalledCount` fica no padrão para medir o valor efetivo. */
const SHORT = { lockDuration: 1_000, stalledInterval: 500 } as const;
const STALL_REASON = 'job stalled more than allowable limit';
const SCRIPT_MARK = 'v11-bullmq-behavior';

function connection(): Connection {
  const env = readProjectEnv();
  return {
    host: requireKey(env, 'REDIS_HOST'),
    port: Number(requireKey(env, 'REDIS_PORT')),
  };
}

const prefixOf = (runId: string): string => `proofs-v11-${runId}`;

const describeError = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

async function waitUntil(
  label: string,
  timeoutMs: number,
  probe: () => boolean | Promise<boolean>,
  intervalMs = 100,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await probe())) {
    if (Date.now() > deadline) {
      throw new Error(`tempo esgotado (${timeoutMs} ms) esperando: ${label}`);
    }
    await sleep(intervalMs);
  }
}

interface Deferred {
  promise: Promise<void>;
  resolve: () => void;
}

function deferred(): Deferred {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** Retrato de uma entrega, lido do objeto `Job` recebido pelo processor. */
interface Delivery {
  jobId: string;
  name: string;
  ats: number;
  atm: number;
  stc: number;
  at: number;
  by: string;
}

const deliveryOf = (job: Job, by: string): Delivery => ({
  jobId: job.id ?? '',
  name: job.name,
  ats: job.attemptsStarted,
  atm: job.attemptsMade,
  stc: job.stalledCounter,
  at: Date.now(),
  by,
});

const describeOpts = (opts: WorkerOptions): string =>
  `lockDuration ${String(opts.lockDuration)}, lockRenewTime ${String(opts.lockRenewTime)}, stalledInterval ${String(opts.stalledInterval)}, maxStalledCount ${String(opts.maxStalledCount)}, concurrency ${String(opts.concurrency)}`;

// ---------------------------------------------------------------------------------------------
// Processo filho: um Worker real em outro processo Node, para receber SIGKILL, SIGSTOP e SIGTERM.
// ---------------------------------------------------------------------------------------------

type Step = 'complete' | 'throw' | 'hang' | 'sleep-complete' | 'sleep-throw';

interface ChildConfig {
  instance: string;
  prefix: string;
  queue: string;
  connection: Connection;
  workerOptions: Partial<
    Pick<
      WorkerOptions,
      'lockDuration' | 'stalledInterval' | 'maxStalledCount' | 'concurrency'
    >
  >;
  /** Comportamento por entrega recebida por este processo (a última se repete). */
  steps: Step[];
  /** Comportamento por nome do job; tem precedência sobre `steps`. */
  byName?: Record<string, Step>;
  sleepMs?: number;
  /** Job Scheduler registrado quando o pai escreve `upsert` no stdin. */
  scheduler?: { id: string; every: number; jobName: string };
}

interface ChildEvent {
  ev: string;
  at: number;
  instance: string;
  jobId?: string;
  name?: string;
  ats?: number;
  atm?: number;
  stc?: number;
  delivery?: number;
  message?: string;
  opts?: string;
}

async function runChild(raw: string): Promise<void> {
  const cfg = JSON.parse(raw) as ChildConfig;
  const emit = (ev: string, extra: Partial<ChildEvent> = {}): void => {
    process.stdout.write(
      `${JSON.stringify({ ev, at: Date.now(), instance: cfg.instance, ...extra })}\n`,
    );
  };
  let deliveries = 0;
  const worker = new Worker<JobData>(
    cfg.queue,
    async (job) => {
      const delivery = deliveries++;
      emit('start', {
        jobId: job.id,
        name: job.name,
        ats: job.attemptsStarted,
        atm: job.attemptsMade,
        stc: job.stalledCounter,
        delivery,
      });
      const step =
        cfg.byName?.[job.name] ??
        cfg.steps[Math.min(delivery, cfg.steps.length - 1)];
      if (step === 'hang') {
        await sleep(3_600_000);
      }
      if (step === 'sleep-complete' || step === 'sleep-throw') {
        await sleep(cfg.sleepMs ?? 0);
      }
      if (step === 'throw' || step === 'sleep-throw') {
        emit('throwing', { jobId: job.id, ats: job.attemptsStarted });
        throw new Error(`falha transitória simulada (${cfg.instance})`);
      }
      emit('returning', { jobId: job.id, ats: job.attemptsStarted });
      return { by: cfg.instance, ats: job.attemptsStarted };
    },
    { connection: cfg.connection, prefix: cfg.prefix, ...cfg.workerOptions },
  );
  worker.on('completed', (job) => emit('worker-completed', { jobId: job.id }));
  worker.on('failed', (job, error) =>
    emit('worker-failed', { jobId: job?.id, message: error.message }),
  );
  worker.on('error', (error) =>
    emit('worker-error', { message: error.message }),
  );
  worker.on('lockRenewalFailed', (jobIds) =>
    emit('lock-renewal-failed', { message: jobIds.join(',') }),
  );
  worker.on('stalled', (jobId) => emit('stalled', { jobId }));
  await worker.waitUntilReady();

  let queue: Queue | undefined;
  const scheduler = cfg.scheduler;
  if (scheduler) {
    queue = new Queue(cfg.queue, {
      connection: cfg.connection,
      prefix: cfg.prefix,
    });
    queue.on('error', (error) =>
      emit('queue-error', { message: describeError(error) }),
    );
    const schedulerQueue = queue;
    createInterface({ input: process.stdin }).on('line', (line) => {
      if (line !== 'upsert') {
        return;
      }
      schedulerQueue
        .upsertJobScheduler(
          scheduler.id,
          { every: scheduler.every },
          { name: scheduler.jobName, data: { batchSize: 100 } },
        )
        .then((job) => emit('upserted', { jobId: job?.id }))
        .catch((error: unknown) =>
          emit('upsert-error', { message: describeError(error) }),
        );
    });
  }
  // Parada graciosa documentada: SIGTERM → worker.close(), que espera os jobs ativos.
  process.on('SIGTERM', () => {
    emit('sigterm');
    worker
      .close()
      .then(() => queue?.close())
      .then(() => {
        emit('closed');
        process.exit(0);
      })
      .catch((error: unknown) => {
        emit('close-error', { message: describeError(error) });
        process.exit(3);
      });
  });
  emit('ready', { opts: describeOpts(worker.opts) });
}

const CHILDREN = new Set<ChildHandle>();

class ChildHandle {
  readonly events: ChildEvent[] = [];
  readonly stderr: string[] = [];
  readonly proc: ChildProcess;
  exit: { code: number | null; signal: NodeJS.Signals | null } | undefined;

  constructor(readonly cfg: ChildConfig) {
    this.proc = spawn(
      process.execPath,
      [
        '-r',
        'ts-node/register/transpile-only',
        __filename,
        'child',
        JSON.stringify(cfg),
      ],
      { stdio: ['pipe', 'pipe', 'pipe'] },
    );
    if (this.proc.stdout) {
      createInterface({ input: this.proc.stdout }).on('line', (line) => {
        try {
          this.events.push(JSON.parse(line) as ChildEvent);
        } catch {
          this.stderr.push(`stdout: ${line}`);
        }
      });
    }
    if (this.proc.stderr) {
      createInterface({ input: this.proc.stderr }).on('line', (line) =>
        this.stderr.push(line),
      );
    }
    this.proc.on('exit', (code, signal) => {
      this.exit = { code, signal };
    });
    CHILDREN.add(this);
  }

  get alive(): boolean {
    return this.exit === undefined;
  }

  find(predicate: (e: ChildEvent) => boolean): ChildEvent | undefined {
    return this.events.find(predicate);
  }

  async waitEvent(
    label: string,
    predicate: (e: ChildEvent) => boolean,
    timeoutMs = 20_000,
  ): Promise<ChildEvent> {
    await waitUntil(`${this.cfg.instance}: ${label}`, timeoutMs, () => {
      if (!this.alive && !this.find(predicate)) {
        throw new Error(
          `${this.cfg.instance} terminou antes de: ${label} (stderr: ${this.stderr.slice(-5).join(' | ')})`,
        );
      }
      return this.find(predicate) !== undefined;
    });
    return this.find(predicate) as ChildEvent;
  }

  waitReady(): Promise<ChildEvent> {
    return this.waitEvent('ready', (e) => e.ev === 'ready', 30_000);
  }

  signal(signal: NodeJS.Signals): void {
    if (this.alive) {
      this.proc.kill(signal);
    }
  }

  send(line: string): void {
    this.proc.stdin?.write(`${line}\n`);
  }

  async waitExit(timeoutMs = 20_000): Promise<void> {
    await waitUntil(
      `${this.cfg.instance}: saída`,
      timeoutMs,
      () => !this.alive,
    );
  }

  /** Encerramento forçado no fim da prova (SIGCONT antes, caso esteja parado). */
  async destroy(): Promise<void> {
    if (this.alive) {
      this.proc.kill('SIGCONT');
      this.proc.kill('SIGKILL');
      await this.waitExit(10_000).catch(() => undefined);
    }
    this.proc.stdin?.destroy();
  }
}

// ---------------------------------------------------------------------------------------------
// Contexto comum do pai: filas, workers, cliente Redis de medição e encerramento garantido.
// ---------------------------------------------------------------------------------------------

class ProofContext {
  readonly conn = connection();
  readonly checks = new Checks();
  readonly redis: Redis;
  private readonly queues = new Map<string, Queue>();
  private readonly workers: Worker[] = [];
  private readonly events: QueueEvents[] = [];
  private readonly holds: Deferred[] = [];

  constructor(readonly prefix: string) {
    this.redis = new Redis({
      ...this.conn,
      lazyConnect: true,
      maxRetriesPerRequest: 1,
    });
    this.redis.on('error', () => undefined);
  }

  async init(): Promise<void> {
    await this.redis.connect();
  }

  key(queue: string, suffix: string): string {
    return `${this.prefix}:${queue}:${suffix}`;
  }

  /** Uma instância de `Queue` por nome, reaproveitada entre os cenários. */
  queue(name: string): Queue {
    const existing = this.queues.get(name);
    if (existing) {
      return existing;
    }
    const queue = new Queue(name, {
      connection: this.conn,
      prefix: this.prefix,
    });
    queue.on('error', (error) =>
      console.log(`AVISO | fila ${name}: ${describeError(error)}`),
    );
    this.queues.set(name, queue);
    return queue;
  }

  queueEvents(name: string): QueueEvents {
    const events = new QueueEvents(name, {
      connection: this.conn,
      prefix: this.prefix,
    });
    events.on('error', (error) =>
      console.log(`AVISO | eventos ${name}: ${describeError(error)}`),
    );
    this.events.push(events);
    return events;
  }

  worker(
    name: string,
    processor: (job: Job<JobData>) => Promise<unknown>,
    opts: Partial<WorkerOptions> = {},
  ): Worker<JobData> {
    const worker = new Worker<JobData>(name, processor, {
      connection: this.conn,
      prefix: this.prefix,
      ...opts,
    });
    worker.on('error', (error) =>
      console.log(`AVISO | worker ${name}: ${describeError(error)}`),
    );
    this.workers.push(worker);
    return worker;
  }

  hold(): Deferred {
    const d = deferred();
    this.holds.push(d);
    return d;
  }

  child(cfg: Omit<ChildConfig, 'prefix' | 'connection'>): ChildHandle {
    return new ChildHandle({
      ...cfg,
      prefix: this.prefix,
      connection: this.conn,
    });
  }

  async closeWorker(worker: Worker): Promise<void> {
    await worker.close();
    const index = this.workers.indexOf(worker as Worker<JobData>);
    if (index >= 0) {
      this.workers.splice(index, 1);
    }
  }

  async close(): Promise<void> {
    for (const hold of this.holds) {
      hold.resolve();
    }
    for (const child of CHILDREN) {
      await child.destroy();
    }
    await Promise.allSettled(this.workers.map((w) => w.close(true)));
    await Promise.allSettled(this.events.map((e) => e.close()));
    await Promise.allSettled([...this.queues.values()].map((q) => q.close()));
    this.redis.disconnect();
  }
}

// ---------------------------------------------------------------------------------------------
// Grupo 1 — padrões e entrega (TD-10, TD-12)
// ---------------------------------------------------------------------------------------------

@Processor('nest-defaults')
class NestDefaultsProcessor extends WorkerHost {
  process(): Promise<string> {
    return Promise.resolve('ok');
  }
}

@Processor('nest-configured', {
  lockDuration: 5_000,
  stalledInterval: 2_500,
  maxStalledCount: 2,
  concurrency: 3,
})
class NestConfiguredProcessor extends WorkerHost {
  process(): Promise<string> {
    return Promise.resolve('ok');
  }
}

function nestModule(conn: Connection, prefix: string) {
  @Module({
    imports: [
      BullModule.forRoot({ connection: conn, prefix }),
      BullModule.registerQueue(
        { name: 'nest-defaults' },
        { name: 'nest-configured' },
      ),
    ],
    providers: [NestDefaultsProcessor, NestConfiguredProcessor],
  })
  class V11NestModule {}
  return V11NestModule;
}

async function defaultsAndLock(ctx: ProofContext): Promise<void> {
  const { checks } = ctx;
  const expectedDefaults =
    'lockDuration 30000, lockRenewTime 15000, stalledInterval 30000, maxStalledCount 1, concurrency 1';
  const idle = ctx.worker('defaults-idle', () => Promise.resolve(), {
    autorun: false,
  });
  const idleOpts = describeOpts(idle.opts);
  checks.add(
    '1.1 Padrões efetivos de um Worker sem opções (bullmq 6.7.7)',
    expectedDefaults,
    idleOpts,
    idleOpts === expectedDefaults,
  );
  await ctx.closeWorker(idle);

  const app = await NestFactory.createApplicationContext(
    nestModule(ctx.conn, ctx.prefix),
    { logger: false },
  );
  try {
    const nestDefaults = describeOpts(
      app.get(NestDefaultsProcessor).worker.opts,
    );
    checks.add(
      '1.1 Padrões efetivos pelo @nestjs/bullmq 11.0.5 (@Processor sem opções)',
      expectedDefaults,
      nestDefaults,
      nestDefaults === expectedDefaults,
    );
    const nestConfigured = describeOpts(
      app.get(NestConfiguredProcessor).worker.opts,
    );
    const expectedConfigured =
      'lockDuration 5000, lockRenewTime 2500, stalledInterval 2500, maxStalledCount 2, concurrency 3';
    checks.add(
      '1.1 Opções do @Processor repassadas ao Worker (caminho de configuração da SI-03.8)',
      expectedConfigured,
      nestConfigured,
      nestConfigured === expectedConfigured,
    );
  } finally {
    await app.close();
  }

  // Lock e stalled-check medidos no Redis, com um Worker sem opções.
  const name = 'defaults';
  const queue = ctx.queue(name);
  const release = ctx.hold();
  let activatedAt = 0;
  const worker = ctx.worker(name, async () => {
    activatedAt = Date.now();
    await release.promise;
    return 'ok';
  });
  await worker.waitUntilReady();
  await queue.add('lock', {}, { jobId: 'lock-1' });
  await waitUntil('job lock-1 ativo', 15_000, () => activatedAt > 0);
  const lockKey = ctx.key(name, 'lock-1:lock');
  const firstLockTtl = await ctx.redis.pttl(lockKey);
  const stalledCheckTtl = await ctx.redis.pttl(ctx.key(name, 'stalled-check'));
  // A 6.7.7 roda o renovador a cada lockRenewTime/2 e renova os jobs ativos há mais de
  // lockRenewTime/2: a primeira renovação cai entre 7,5 e 15 s, e as seguintes a cada ~7,5 s.
  let previous = firstLockTtl;
  let minTtl = firstLockTtl;
  const renewals: { afterMs: number; ttl: number }[] = [];
  while (Date.now() - activatedAt < 24_000) {
    await sleep(200);
    const ttl = await ctx.redis.pttl(lockKey);
    if (ttl > previous + 1_000) {
      renewals.push({ afterMs: Date.now() - activatedAt, ttl });
    }
    minTtl = Math.min(minTtl, ttl);
    previous = ttl;
  }
  release.resolve();
  await waitUntil(
    'lock-1 concluído',
    10_000,
    async () => (await queue.getJobState('lock-1')) === 'completed',
  );
  await ctx.closeWorker(worker);
  checks.add(
    '1.1 lockDuration efetivo: TTL do lock logo depois da ativação',
    'entre 25000 e 30000 ms',
    `${firstLockTtl} ms`,
    firstLockTtl > 25_000 && firstLockTtl <= 30_000,
  );
  const gaps = renewals.slice(1).map((r, i) => r.afterMs - renewals[i].afterMs);
  checks.add(
    '1.1 lockRenewTime efetivo (15000): renovação do lock durante o processamento',
    'primeira renovação entre 7000 e 16000 ms após a ativação; seguintes a cada 7000–8500 ms; TTL volta a mais de 28000 ms e nunca chega a 0',
    `renovações em [${renewals.map((r) => `${r.afterMs} ms → TTL ${r.ttl}`).join(', ')}]; intervalos [${gaps.join(', ')}] ms; menor TTL ${minTtl} ms`,
    renewals.length >= 2 &&
      renewals[0].afterMs >= 7_000 &&
      renewals[0].afterMs <= 16_000 &&
      gaps.every((g) => g >= 7_000 && g <= 8_500) &&
      renewals.every((r) => r.ttl > 28_000) &&
      minTtl > 0,
  );
  checks.add(
    '1.1 stalledInterval efetivo: TTL da marca stalled-check gravada pelo verificador',
    'entre 25000 e 30000 ms',
    `${stalledCheckTtl} ms`,
    stalledCheckTtl > 25_000 && stalledCheckTtl <= 30_000,
  );
}

async function redeliveryAfterSigkill(ctx: ProofContext): Promise<void> {
  const { checks } = ctx;
  const name = 'kill';
  const queue = ctx.queue(name);
  const child = ctx.child({
    instance: 'kill-a',
    queue: name,
    workerOptions: SHORT,
    steps: ['hang'],
  });
  const ready = await child.waitReady();
  checks.info('1.2 Opções do worker filho', ready.opts ?? '');
  await queue.add('kill', { n: 1 }, { jobId: 'kill-1' });
  const first = await child.waitEvent(
    'start kill-1',
    (e) => e.ev === 'start' && e.jobId === 'kill-1',
  );
  child.signal('SIGKILL');
  const killedAt = Date.now();
  await child.waitExit();
  const deliveries: Delivery[] = [];
  const stalled: string[] = [];
  const worker = ctx.worker(
    name,
    (job) => {
      deliveries.push(deliveryOf(job, 'pai'));
      return Promise.resolve('ok');
    },
    SHORT,
  );
  worker.on('stalled', (jobId) => stalled.push(jobId));
  await waitUntil(
    'kill-1 concluído pela reentrega',
    20_000,
    async () => (await queue.getJobState('kill-1')) === 'completed',
  );
  await ctx.closeWorker(worker);
  const final = await queue.getJob('kill-1');
  const second = deliveries.find((d) => d.jobId === 'kill-1');
  checks.add(
    '1.2 Worker morto por SIGKILL durante o processamento',
    'processo filho termina pelo sinal SIGKILL',
    `saída: código ${String(child.exit?.code)}, sinal ${String(child.exit?.signal)}`,
    child.exit?.signal === 'SIGKILL',
  );
  checks.add(
    '1.2 Reentrega após SIGKILL: evento stalled e nova entrega do mesmo job',
    'stalled emitido para kill-1; uma nova entrega, com attemptsStarted maior',
    `stalled: [${stalled.join(', ')}]; entregas: filho ats ${String(first.ats)}, pai ats ${String(second?.ats)}`,
    stalled.includes('kill-1') &&
      second !== undefined &&
      second.ats > (first.ats ?? Infinity),
  );
  checks.add(
    '1.2 Job concluído pela reentrega, com stalledCounter 1',
    'completed, stalledCounter 1',
    `${await queue.getJobState('kill-1')}, stalledCounter ${String(final?.stalledCounter)}`,
    final?.stalledCounter === 1,
  );
  checks.info(
    '1.2 Contadores na reentrega após stall',
    `attemptsMade ${String(first.atm)} → ${String(second?.atm)} (o stall não consome tentativa); tempo do SIGKILL à reentrega: ${second ? second.at - killedAt : -1} ms com lockDuration ${SHORT.lockDuration} e stalledInterval ${SHORT.stalledInterval}`,
  );
}

async function stallAboveLimit(ctx: ProofContext): Promise<void> {
  const { checks } = ctx;
  const name = 'stall-limit';
  const queue = ctx.queue(name);
  const childA = ctx.child({
    instance: 'stall-a',
    queue: name,
    workerOptions: SHORT,
    steps: ['hang'],
  });
  await childA.waitReady();
  await queue.add(
    'stall',
    { n: 1 },
    { jobId: 'stall-1', attempts: 3, backoff: { type: 'fixed', delay: 300 } },
  );
  const firstDelivery = await childA.waitEvent(
    'start stall-1',
    (e) => e.ev === 'start' && e.jobId === 'stall-1',
  );
  childA.signal('SIGKILL');
  await childA.waitExit();
  const childB = ctx.child({
    instance: 'stall-b',
    queue: name,
    workerOptions: SHORT,
    steps: ['hang'],
  });
  const secondDelivery = await childB.waitEvent(
    'start stall-1 (reentrega)',
    (e) => e.ev === 'start' && e.jobId === 'stall-1',
    30_000,
  );
  childB.signal('SIGKILL');
  await childB.waitExit();
  let processorCalls = 0;
  const failedEvents: string[] = [];
  const worker = ctx.worker(
    name,
    () => {
      processorCalls += 1;
      return Promise.resolve('não deveria rodar');
    },
    SHORT,
  );
  worker.on('failed', (job, error) =>
    failedEvents.push(`${job?.id}: ${error.name}: ${error.message}`),
  );
  await waitUntil(
    'stall-1 falhado',
    20_000,
    async () => (await queue.getJobState('stall-1')) === 'failed',
  );
  await sleep(1_000);
  await ctx.closeWorker(worker);
  const state = await queue.getJobState('stall-1');
  const job = await queue.getJob('stall-1');
  checks.add(
    '1.3 maxStalledCount efetivo (padrão 1): a primeira parada é reentregue',
    'segunda entrega com stalledCounter 1',
    `entregas: ats ${String(firstDelivery.ats)} (stc ${String(firstDelivery.stc)}) e ats ${String(secondDelivery.ats)} (stc ${String(secondDelivery.stc)})`,
    secondDelivery.stc === 1 &&
      (secondDelivery.ats ?? 0) > (firstDelivery.ats ?? Infinity),
  );
  checks.add(
    '1.3 Stall acima do limite: failedReason do job',
    `failed com "${STALL_REASON}"`,
    `${state}, "${job?.failedReason ?? ''}"`,
    state === 'failed' && job?.failedReason === STALL_REASON,
  );
  checks.add(
    '1.3 O job falhado por stall não passa pelo processor nem é retentado (attempts 3)',
    'processor chamado 0 vezes; continua failed 1 s depois',
    `processor chamado ${processorCalls} vez(es); estado ${state}; evento failed: ${failedEvents.join(' | ')}`,
    processorCalls === 0 && state === 'failed',
  );
  checks.info(
    '1.3 Contadores finais do job falhado por stall',
    `attemptsStarted ${String(job?.attemptsStarted)}, attemptsMade ${String(job?.attemptsMade)}, stalledCounter ${String(job?.stalledCounter)}. A 6.7.7 marca a falha adiada (campo defa) e devolve o job à espera; um worker o move para failed com UnrecoverableError, sem chamar o processor`,
  );
}

async function lastAttempt(ctx: ProofContext): Promise<void> {
  const { checks } = ctx;
  const name = 'last';
  const queue = ctx.queue(name);
  const attempts = 3;
  const deliveries: Delivery[] = [];
  const worker = ctx.worker(name, (job) => {
    deliveries.push(deliveryOf(job, 'pai'));
    return Promise.reject(new Error('falha transitória simulada'));
  });
  await queue.add(
    'last',
    {},
    { jobId: 'last-1', attempts, backoff: { type: 'fixed', delay: 200 } },
  );
  await waitUntil(
    'last-1 falhado',
    15_000,
    async () => (await queue.getJobState('last-1')) === 'failed',
  );
  const job = await queue.getJob('last-1');
  const isLast = deliveries.map((d) => d.atm + 1 >= attempts);
  checks.add(
    '1.4 job.attemptsMade identifica a última tentativa (attempts 3)',
    'attemptsMade 0, 1, 2 nas entregas; attemptsMade + 1 >= attempts só na terceira',
    `attemptsMade [${deliveries.map((d) => d.atm).join(', ')}]; última? [${isLast.join(', ')}]`,
    deliveries.map((d) => d.atm).join(',') === '0,1,2' &&
      isLast.join(',') === 'false,false,true',
  );
  checks.add(
    '1.4 Falha final regular: estado, attemptsMade e failedReason distinto do stall',
    'failed, attemptsMade 3, failedReason "falha transitória simulada"',
    `${await queue.getJobState('last-1')}, attemptsMade ${String(job?.attemptsMade)}, "${job?.failedReason ?? ''}"`,
    // A igualdade exata também garante que o motivo difere de STALL_REASON.
    job?.attemptsMade === 3 &&
      job.failedReason === 'falha transitória simulada',
  );

  // Informativo: UnrecoverableError não é retentado (falha permanente de mídia, T-14).
  const unrecQueue = ctx.queue('unrecoverable');
  let unrecCalls = 0;
  ctx.worker('unrecoverable', () => {
    unrecCalls += 1;
    return Promise.reject(new UnrecoverableError('mídia inválida simulada'));
  });
  await unrecQueue.add(
    'unrec',
    {},
    { jobId: 'unrec-1', attempts, backoff: { type: 'fixed', delay: 200 } },
  );
  await waitUntil(
    'unrec-1 falhado',
    15_000,
    async () => (await unrecQueue.getJobState('unrec-1')) === 'failed',
  );
  await sleep(500);
  const unrec = await unrecQueue.getJob('unrec-1');
  checks.info(
    '1.4 UnrecoverableError com attempts 3',
    `processor chamado ${unrecCalls} vez(es); estado ${await unrecQueue.getJobState('unrec-1')}; attemptsMade ${String(unrec?.attemptsMade)}; failedReason "${unrec?.failedReason ?? ''}"`,
  );
  await ctx.closeWorker(worker);
}

async function gracefulShutdown(ctx: ProofContext): Promise<void> {
  const { checks } = ctx;
  const name = 'graceful';
  const queue = ctx.queue(name);
  const sleepMs = 2_000;
  const child = ctx.child({
    instance: 'graceful-a',
    queue: name,
    workerOptions: {},
    steps: ['sleep-complete'],
    sleepMs,
  });
  await child.waitReady();
  await queue.add('graceful', {}, { jobId: 'graceful-1' });
  const started = await child.waitEvent(
    'start graceful-1',
    (e) => e.ev === 'start' && e.jobId === 'graceful-1',
  );
  await sleep(200);
  child.signal('SIGTERM');
  await child.waitEvent('sigterm', (e) => e.ev === 'sigterm');
  await queue.add('graceful', {}, { jobId: 'graceful-2' });
  await child.waitExit(15_000);
  const exitedAt = Date.now();
  const returned = child.find(
    (e) => e.ev === 'returning' && e.jobId === 'graceful-1',
  );
  const closed = child.find((e) => e.ev === 'closed');
  checks.add(
    '1.5 Parada graciosa: SIGTERM → worker.close() espera o job ativo',
    `job graceful-1 concluído pelo próprio worker (≥ ${sleepMs} ms) antes do close; processo sai com código 0`,
    `processor terminou ${returned ? returned.at - started.at : -1} ms após o início; close ${closed ? closed.at - started.at : -1} ms; saída ${exitedAt - started.at} ms, código ${String(child.exit?.code)}; estado ${await queue.getJobState('graceful-1')}`,
    returned !== undefined &&
      closed !== undefined &&
      returned.at - started.at >= sleepMs &&
      closed.at >= returned.at &&
      child.exit?.code === 0 &&
      (await queue.getJobState('graceful-1')) === 'completed',
  );
  checks.add(
    '1.5 Depois do SIGTERM o worker não busca jobs novos',
    'graceful-2, adicionado depois do SIGTERM, continua waiting',
    `${await queue.getJobState('graceful-2')}; entregas no filho: ${child.events.filter((e) => e.ev === 'start').length}`,
    (await queue.getJobState('graceful-2')) === 'waiting',
  );
}

// ---------------------------------------------------------------------------------------------
// Grupo 2 — geração e retenção (revisão de recuperações por geração da TD-12)
// ---------------------------------------------------------------------------------------------

async function attemptsStartedSequence(ctx: ProofContext): Promise<void> {
  const { checks } = ctx;
  const name = 'sequence';
  const queue = ctx.queue(name);
  const child = ctx.child({
    instance: 'seq-a',
    queue: name,
    workerOptions: SHORT,
    steps: ['throw', 'hang'],
  });
  await child.waitReady();
  await queue.add(
    'seq',
    {},
    { jobId: 'seq-1', attempts: 3, backoff: { type: 'fixed', delay: 300 } },
  );
  await child.waitEvent(
    'segunda entrega de seq-1 (retentativa por backoff)',
    (e) => e.ev === 'start' && e.jobId === 'seq-1' && e.delivery === 1,
  );
  child.signal('SIGKILL');
  await child.waitExit();
  const deliveries: Delivery[] = [];
  const worker = ctx.worker(
    name,
    (job) => {
      deliveries.push(deliveryOf(job, 'pai'));
      return Promise.resolve('ok');
    },
    SHORT,
  );
  await waitUntil(
    'seq-1 concluído',
    20_000,
    async () => (await queue.getJobState('seq-1')) === 'completed',
  );
  await ctx.closeWorker(worker);
  const childStarts = child.events.filter(
    (e) => e.ev === 'start' && e.jobId === 'seq-1',
  );
  const all = [
    ...childStarts.map((e) => ({ ats: e.ats ?? -1, atm: e.atm ?? -1 })),
    ...deliveries.map((d) => ({ ats: d.ats, atm: d.atm })),
  ];
  const ats = all.map((d) => d.ats);
  const strictlyIncreasing = ats.every((v, i) => i === 0 || v > ats[i - 1]);
  const job = await queue.getJob('seq-1');
  checks.add(
    '2.1 attemptsStarted cresce estritamente no mesmo job: entrega, retentativa por backoff e reentrega após stall',
    '3 entregas (falha, SIGKILL, conclusão) com attemptsStarted estritamente crescente',
    `attemptsStarted [${ats.join(', ')}]; attemptsMade [${all.map((d) => d.atm).join(', ')}]`,
    all.length === 3 && strictlyIncreasing,
  );
  checks.info(
    '2.1 Estado final de seq-1',
    `${await queue.getJobState('seq-1')}, attemptsStarted ${String(job?.attemptsStarted)}, attemptsMade ${String(job?.attemptsMade)}, stalledCounter ${String(job?.stalledCounter)}`,
  );
}

async function retentionAndRemoval(ctx: ProofContext): Promise<void> {
  const { checks } = ctx;
  const name = 'retention';
  const queue = ctx.queue(name);
  ctx.worker(name, (job) =>
    job.name === 'fail'
      ? Promise.reject(new Error('falha simulada'))
      : Promise.resolve('ok'),
  );
  const keep = { removeOnComplete: false, removeOnFail: false };
  await queue.add('ok', {}, { jobId: 'kept-completed', ...keep });
  await queue.add('fail', {}, { jobId: 'kept-failed', ...keep });
  await queue.add(
    'ok',
    {},
    { jobId: 'control-removed', removeOnComplete: true },
  );
  for (let i = 1; i <= 5; i += 1) {
    await queue.add('ok', {}, { jobId: `filler-${i}`, ...keep });
  }
  await waitUntil(
    'jobs de retenção terminados',
    15_000,
    async () => (await queue.getJobState('filler-5')) === 'completed',
  );
  await sleep(500);
  const completedState = await queue.getJobState('kept-completed');
  const failedState = await queue.getJobState('kept-failed');
  const controlState = await queue.getJobState('control-removed');
  checks.add(
    '2.2 removeOnComplete: false e removeOnFail: false retêm os jobs depois de outros terminarem',
    'kept-completed em completed e kept-failed em failed',
    `kept-completed ${completedState}; kept-failed ${failedState}`,
    completedState === 'completed' && failedState === 'failed',
  );
  checks.add(
    '2.2 Controle: a mesma fila com removeOnComplete: true remove o job',
    'control-removed ausente (unknown)',
    controlState,
    controlState === 'unknown',
  );
  const removed: string[] = [];
  for (const id of ['kept-completed', 'kept-failed']) {
    const job = await queue.getJob(id);
    await job?.remove();
    removed.push(
      `${id}: ${await queue.getJobState(id)}, chave ${await ctx.redis.exists(ctx.key(name, id))}`,
    );
  }
  checks.add(
    '2.2 job.remove() funciona para completed e failed',
    'os dois ausentes (unknown) e sem a chave do job',
    removed.join('; '),
    removed.every((r) => r.includes('unknown, chave 0')),
  );
}

async function removeActiveRefused(ctx: ProofContext): Promise<void> {
  const { checks } = ctx;
  const name = 'locked';
  const queue = ctx.queue(name);
  const release = ctx.hold();
  let active = false;
  ctx.worker(name, async () => {
    active = true;
    await release.promise;
    return 'ok';
  });
  await queue.add('locked', {}, { jobId: 'locked-1' });
  await waitUntil('locked-1 ativo', 15_000, () => active);
  let jobRemoveError = '';
  try {
    await (await queue.getJob('locked-1'))?.remove();
  } catch (error) {
    jobRemoveError = describeError(error);
  }
  const queueRemoveResult = await queue.remove('locked-1');
  const stateAfter = await queue.getJobState('locked-1');
  const lockExists = await ctx.redis.exists(ctx.key(name, 'locked-1:lock'));
  release.resolve();
  await waitUntil(
    'locked-1 concluído',
    10_000,
    async () => (await queue.getJobState('locked-1')) === 'completed',
  );
  checks.add(
    '2.3 job.remove() é recusado para job active com lock',
    'erro "could not be removed because it is locked"; o job continua active e conclui depois',
    `erro: "${jobRemoveError}"; estado depois ${stateAfter}; lock presente ${lockExists}; estado final ${await queue.getJobState('locked-1')}`,
    jobRemoveError.includes('could not be removed because it is locked') &&
      stateAfter === 'active' &&
      lockExists === 1,
  );
  checks.info(
    '2.3 queue.remove(jobId) para job active',
    `devolveu ${queueRemoveResult} e não removeu (estado ${stateAfter})`,
  );
}

async function duplicateAdd(ctx: ProofContext): Promise<void> {
  const { checks } = ctx;
  const original = { v: 1 };
  const duplicate = { v: 2 };
  const totalOf = async (queue: Queue): Promise<number> =>
    Object.values(await queue.getJobCounts()).reduce((a, b) => a + b, 0);

  interface Case {
    state: string;
    queue: string;
    prepare: (queue: Queue) => Promise<() => void>;
  }
  const processedCount = new Map<string, number>();
  const makeProcessingWorker = (
    name: string,
    behavior: 'complete' | 'fail' | 'hold',
    release?: Deferred,
  ): void => {
    ctx.worker(name, async () => {
      processedCount.set(name, (processedCount.get(name) ?? 0) + 1);
      if (behavior === 'hold') {
        await release?.promise;
      }
      if (behavior === 'fail') {
        throw new Error('falha simulada');
      }
      return 'ok';
    });
  };
  const cases: Case[] = [
    {
      state: 'waiting',
      queue: 'dup-waiting',
      prepare: async (queue) => {
        await queue.add('dup', original, { jobId: 'dup' });
        return () => undefined;
      },
    },
    {
      state: 'delayed',
      queue: 'dup-delayed',
      prepare: async (queue) => {
        await queue.add('dup', original, { jobId: 'dup', delay: 60_000 });
        return () => undefined;
      },
    },
    {
      state: 'active',
      queue: 'dup-active',
      prepare: async (queue) => {
        const release = ctx.hold();
        makeProcessingWorker('dup-active', 'hold', release);
        await queue.add('dup', original, { jobId: 'dup' });
        await waitUntil(
          'dup ativo',
          15_000,
          async () => (await queue.getJobState('dup')) === 'active',
        );
        return () => release.resolve();
      },
    },
    {
      state: 'completed',
      queue: 'dup-completed',
      prepare: async (queue) => {
        makeProcessingWorker('dup-completed', 'complete');
        await queue.add('dup', original, {
          jobId: 'dup',
          removeOnComplete: false,
        });
        await waitUntil(
          'dup concluído',
          15_000,
          async () => (await queue.getJobState('dup')) === 'completed',
        );
        return () => undefined;
      },
    },
    {
      state: 'failed',
      queue: 'dup-failed',
      prepare: async (queue) => {
        makeProcessingWorker('dup-failed', 'fail');
        await queue.add('dup', original, { jobId: 'dup', removeOnFail: false });
        await waitUntil(
          'dup falhado',
          15_000,
          async () => (await queue.getJobState('dup')) === 'failed',
        );
        return () => undefined;
      },
    },
  ];
  const duplicatedEvents: string[] = [];
  const waitingEvents = ctx.queueEvents('dup-waiting');
  waitingEvents.on('duplicated', ({ jobId }) => duplicatedEvents.push(jobId));
  await waitingEvents.waitUntilReady();

  for (const c of cases) {
    const queue = ctx.queue(c.queue);
    const after = await c.prepare(queue);
    const before = await queue.getJob('dup');
    const totalBefore = await totalOf(queue);
    const processedBefore = processedCount.get(c.queue) ?? 0;
    const returned = await queue.add('dup', duplicate, { jobId: 'dup' });
    await sleep(700);
    const stored = await queue.getJob('dup');
    const state = await queue.getJobState('dup');
    const totalAfter = await totalOf(queue);
    const processedAfter = processedCount.get(c.queue) ?? 0;
    after();
    const unchanged =
      state === c.state &&
      JSON.stringify(stored?.data) === JSON.stringify(original) &&
      stored?.timestamp === before?.timestamp &&
      stored?.attemptsStarted === before?.attemptsStarted &&
      totalAfter === totalBefore &&
      processedAfter === processedBefore;
    checks.add(
      `2.4 add com jobId existente ignorado no estado ${c.state}`,
      `continua ${c.state}, data ${JSON.stringify(original)}, mesmo timestamp e attemptsStarted, total da fila igual, sem nova execução`,
      `${state}, data ${JSON.stringify(stored?.data)}, timestamp ${stored?.timestamp === before?.timestamp ? 'igual' : 'diferente'}, attemptsStarted ${String(before?.attemptsStarted)} → ${String(stored?.attemptsStarted)}, total ${totalBefore} → ${totalAfter}, execuções ${processedBefore} → ${processedAfter}`,
      unchanged,
    );
    checks.info(
      `2.4 Objeto devolvido pelo add duplicado (${c.state})`,
      `id ${String(returned.id)}, data ${JSON.stringify(returned.data)}`,
    );
  }
  await waitUntil(
    'dup-active concluído',
    10_000,
    async () =>
      (await ctx.queue('dup-active').getJobState('dup')) === 'completed',
  );
  checks.info(
    '2.4 Execuções de dup-active depois de liberar',
    `${processedCount.get('dup-active') ?? 0} execução(ões)`,
  );
  checks.info(
    '2.4 Evento duplicated no QueueEvents (estado waiting)',
    `[${duplicatedEvents.join(', ')}]`,
  );
}

async function counterReset(ctx: ProofContext): Promise<void> {
  const { checks } = ctx;
  const name = 'reset';
  const queue = ctx.queue(name);
  const deliveries: Delivery[] = [];
  const firstWorker = ctx.worker(name, (job) => {
    deliveries.push(deliveryOf(job, 'w1'));
    return deliveries.filter((d) => d.jobId === job.id).length === 1
      ? Promise.reject(new Error('falha simulada'))
      : Promise.resolve('ok');
  });
  await queue.add(
    'gen',
    {},
    {
      jobId: 'gen-a',
      attempts: 2,
      backoff: { type: 'fixed', delay: 100 },
      removeOnComplete: false,
    },
  );
  await waitUntil(
    'gen-a concluído',
    15_000,
    async () => (await queue.getJobState('gen-a')) === 'completed',
  );
  await ctx.closeWorker(firstWorker);
  const beforeRemoval = await queue.getJob('gen-a');
  await beforeRemoval?.remove();
  await queue.add('gen', {}, { jobId: 'gen-a', removeOnComplete: false });
  await queue.add('gen', {}, { jobId: 'gen-b', removeOnComplete: false });
  const readded = await queue.getJob('gen-a');
  const readdedState = await queue.getJobState('gen-a');
  const other = await queue.getJob('gen-b');
  const secondWorker = ctx.worker(name, (job) => {
    deliveries.push(deliveryOf(job, 'w2'));
    return Promise.resolve('ok');
  });
  await waitUntil(
    'gen-a e gen-b concluídos',
    15_000,
    async () =>
      (await queue.getJobState('gen-a')) === 'completed' &&
      (await queue.getJobState('gen-b')) === 'completed',
  );
  await ctx.closeWorker(secondWorker);
  const afterA = deliveries.find((d) => d.by === 'w2' && d.jobId === 'gen-a');
  const afterB = deliveries.find((d) => d.by === 'w2' && d.jobId === 'gen-b');
  checks.add(
    '2.5 Job removido e adicionado de novo com o mesmo jobId recomeça os contadores',
    'antes da remoção attemptsStarted 2; readicionado em waiting com 0; primeira entrega nova com attemptsStarted 1',
    `antes ${String(beforeRemoval?.attemptsStarted)} (attemptsMade ${String(beforeRemoval?.attemptsMade)}); readicionado ${String(readded?.attemptsStarted)} (attemptsMade ${String(readded?.attemptsMade)}, estado ${readdedState}); entrega nova ${String(afterA?.ats)}`,
    beforeRemoval?.attemptsStarted === 2 &&
      readded?.attemptsStarted === 0 &&
      readded.attemptsMade === 0 &&
      readdedState === 'waiting' &&
      afterA?.ats === 1,
  );
  checks.add(
    '2.5 Job com outro jobId (geração nova) começa do início',
    'attemptsStarted 0 ao entrar e 1 na primeira entrega',
    `${String(other?.attemptsStarted)} ao entrar; ${String(afterB?.ats)} na primeira entrega`,
    other?.attemptsStarted === 0 && afterB?.ats === 1,
  );
}

async function removedJobDelivery(ctx: ProofContext): Promise<void> {
  const { checks } = ctx;
  const name = 'removed';
  const queue = ctx.queue(name);
  const child = ctx.child({
    instance: 'stale-a',
    queue: name,
    workerOptions: { ...SHORT, concurrency: 2 },
    steps: ['complete'],
    byName: { 'stale-ok': 'sleep-complete', 'stale-fail': 'sleep-throw' },
    sleepMs: 1_500,
  });
  await child.waitReady();
  await queue.add('stale-ok', {}, { jobId: 'stale-ok' });
  await queue.add('stale-fail', {}, { jobId: 'stale-fail' });
  const ids = ['stale-ok', 'stale-fail'];
  for (const id of ids) {
    await child.waitEvent(
      `start ${id}`,
      (e) => e.ev === 'start' && e.jobId === id,
    );
  }
  // SIGSTOP congela o processo: o lock não é renovado, mas a entrega continua "em execução".
  child.signal('SIGSTOP');
  const newer: Delivery[] = [];
  const worker = ctx.worker(
    name,
    (job) => {
      newer.push(deliveryOf(job, 'pai'));
      return Promise.resolve('entrega nova');
    },
    SHORT,
  );
  await waitUntil(
    'stale-ok e stale-fail concluídos pela entrega nova',
    20_000,
    async () =>
      (await queue.getJobState('stale-ok')) === 'completed' &&
      (await queue.getJobState('stale-fail')) === 'completed',
  );
  await ctx.closeWorker(worker);
  for (const id of ids) {
    await (await queue.getJob(id))?.remove();
  }
  const removedStates = await Promise.all(
    ids.map((id) => queue.getJobState(id)),
  );
  child.signal('SIGCONT');
  await child.waitEvent(
    'stale-ok retornou no processo antigo',
    (e) => e.ev === 'returning' && e.jobId === 'stale-ok',
  );
  await child.waitEvent(
    'stale-fail lançou no processo antigo',
    (e) => e.ev === 'throwing' && e.jobId === 'stale-fail',
  );
  await sleep(3_000);
  const states = await Promise.all(ids.map((id) => queue.getJobState(id)));
  const keys = await Promise.all(
    ids.map((id) => ctx.redis.exists(ctx.key(name, id))),
  );
  const counts = await queue.getJobCounts();
  const finishEvents = child.events.filter(
    (e) =>
      (e.ev === 'worker-completed' || e.ev === 'worker-failed') &&
      ids.includes(e.jobId ?? ''),
  );
  const errors = child.events
    .filter((e) => e.ev === 'worker-error')
    .map((e) => e.message ?? '');
  const oldOk = child.find(
    (e) => e.ev === 'returning' && e.jobId === 'stale-ok',
  );
  const oldFail = child.find(
    (e) => e.ev === 'throwing' && e.jobId === 'stale-fail',
  );
  checks.add(
    '2.6 Preparação: as entregas novas concluíram e os jobs foram removidos com a entrega antiga ainda em execução',
    'entregas novas com attemptsStarted 2; jobs ausentes antes do SIGCONT',
    `entregas novas ats [${newer.map((d) => `${d.jobId} ${d.ats}`).join(', ')}]; estados depois da remoção [${removedStates.join(', ')}]`,
    newer.length === 2 &&
      newer.every((d) => d.ats === 2) &&
      removedStates.every((s) => s === 'unknown'),
  );
  checks.add(
    '2.6 A entrega antiga mantém os valores antigos',
    'attemptsStarted 1 no objeto Job da entrega antiga',
    `stale-ok ${String(oldOk?.ats)}; stale-fail ${String(oldFail?.ats)}`,
    oldOk?.ats === 1 && oldFail?.ats === 1,
  );
  checks.add(
    '2.6 A entrega antiga não consegue concluir nem falhar o job removido',
    'jobs continuam ausentes, sem chave e sem entrada em completed ou failed; nenhum evento completed/failed no processo antigo',
    `estados [${states.join(', ')}]; chaves [${keys.join(', ')}]; completed ${counts.completed}, failed ${counts.failed}; eventos de término no processo antigo: ${finishEvents.length}`,
    states.every((s) => s === 'unknown') &&
      keys.every((k) => k === 0) &&
      counts.completed === 0 &&
      counts.failed === 0 &&
      finishEvents.length === 0,
  );
  checks.info(
    '2.6 Erros emitidos pelo worker antigo',
    errors.length > 0 ? errors.join(' | ') : 'nenhum',
  );
  checks.info(
    '2.6 Falha de renovação de lock no worker antigo',
    child.events
      .filter((e) => e.ev === 'lock-renewal-failed')
      .map((e) => e.message ?? '')
      .join(' | ') || 'nenhuma',
  );
}

async function retryInfo(ctx: ProofContext): Promise<void> {
  // Informativo: a reconciliação não usa Job.retry() (revisão de recuperações por geração da TD-12).
  const { checks } = ctx;
  const failedQueue = ctx.queue('last');
  const failedJob = await failedQueue.getJob('last-1');
  if (failedJob) {
    await failedJob.retry('failed');
    const after = await failedQueue.getJob('last-1');
    checks.info(
      '2.7 Job.retry("failed") num job retido',
      `estado ${await failedQueue.getJobState('last-1')}; attemptsMade ${String(failedJob.attemptsMade)} → ${String(after?.attemptsMade)}; attemptsStarted ${String(failedJob.attemptsStarted)} → ${String(after?.attemptsStarted)}`,
    );
  }
  const completedQueue = ctx.queue('kill');
  const completedJob = await completedQueue.getJob('kill-1');
  if (completedJob) {
    await completedJob.retry('completed');
    const after = await completedQueue.getJob('kill-1');
    checks.info(
      '2.7 Job.retry("completed") num job retido',
      `estado ${await completedQueue.getJobState('kill-1')}; attemptsMade ${String(completedJob.attemptsMade)} → ${String(after?.attemptsMade)}; attemptsStarted ${String(completedJob.attemptsStarted)} → ${String(after?.attemptsStarted)}`,
    );
  }
}

async function runCore(runId: string): Promise<boolean> {
  const ctx = new ProofContext(prefixOf(runId));
  console.log(`V-11 núcleo — prefixo ${ctx.prefix}`);
  await ctx.init();
  const scenarios: [string, (c: ProofContext) => Promise<void>][] = [
    ['1.1 padrões, lock e stalled-check', defaultsAndLock],
    ['1.2 reentrega após SIGKILL', redeliveryAfterSigkill],
    ['1.3 stall acima do limite', stallAboveLimit],
    ['1.4 última tentativa', lastAttempt],
    ['1.5 parada graciosa', gracefulShutdown],
    ['2.1 attemptsStarted', attemptsStartedSequence],
    ['2.2 retenção e remoção', retentionAndRemoval],
    ['2.3 remoção de job active', removeActiveRefused],
    ['2.4 add duplicado', duplicateAdd],
    ['2.5 contador reiniciado', counterReset],
    ['2.6 entrega de job removido', removedJobDelivery],
    ['2.7 Job.retry (informativo)', retryInfo],
  ];
  try {
    for (const [label, scenario] of scenarios) {
      const startedAt = Date.now();
      console.log(`--- ${label}`);
      await scenario(ctx);
      console.log(`--- ${label}: ${Date.now() - startedAt} ms`);
    }
  } finally {
    for (const child of CHILDREN) {
      if (child.stderr.length > 0) {
        console.log(
          `STDERR ${child.cfg.instance}: ${child.stderr.slice(0, 5).join(' | ')}`,
        );
      }
    }
    await ctx.close();
  }
  console.log(`RESUMO núcleo: ${ctx.checks.summary()}`);
  return ctx.checks.allPassed;
}

// ---------------------------------------------------------------------------------------------
// Grupo 3 — manutenção (AMB-6): Job Scheduler, várias instâncias, reinício e Redis indisponível
// ---------------------------------------------------------------------------------------------

async function redisReachable(conn: Connection): Promise<boolean> {
  const client = new Redis({
    ...conn,
    lazyConnect: true,
    connectTimeout: 500,
    maxRetriesPerRequest: 0,
    enableOfflineQueue: false,
    retryStrategy: () => null,
  });
  client.on('error', () => undefined);
  try {
    await client.connect();
    return (await client.ping()) === 'PONG';
  } catch {
    return false;
  } finally {
    client.disconnect();
  }
}

async function runMaintenance(runId: string): Promise<boolean> {
  const ctx = new ProofContext(prefixOf(runId));
  const { checks } = ctx;
  const name = 'maintenance';
  const schedulerId = 'v11-sweep';
  const every = 1_000;
  const jobName = 'sweep-upload-sessions';
  console.log(`V-11 manutenção — prefixo ${ctx.prefix}`);
  await ctx.init();
  const queue = ctx.queue(name);
  const children: ChildHandle[] = [];
  const spawnInstance = (instance: string): ChildHandle => {
    const child = ctx.child({
      instance,
      queue: name,
      workerOptions: { concurrency: 1 },
      steps: ['complete'],
      scheduler: { id: schedulerId, every, jobName },
    });
    children.push(child);
    return child;
  };
  const executions = (): ChildEvent[] =>
    children
      .flatMap((c) => c.events)
      .filter((e) => e.ev === 'start' && e.name === jobName)
      .sort((a, b) => a.at - b.at);
  const pendingSamples: number[] = [];
  const samplePending = async (durationMs: number): Promise<void> => {
    const end = Date.now() + durationMs;
    while (Date.now() < end) {
      const counts = await queue.getJobCounts(
        'delayed',
        'waiting',
        'prioritized',
      );
      pendingSamples.push(counts.delayed + counts.waiting + counts.prioritized);
      await sleep(250);
    }
  };
  const register = async (
    pair: ChildHandle[],
  ): Promise<(string | undefined)[]> => {
    await Promise.all(pair.map((c) => c.waitReady()));
    for (const child of pair) {
      child.send('upsert');
    }
    const upserted = await Promise.all(
      pair.map((c) => c.waitEvent('upserted', (e) => e.ev === 'upserted')),
    );
    return upserted.map((e) => e.jobId);
  };
  const noDuplicates = (): string => {
    const ids = executions().map((e) => e.jobId ?? '');
    const unique = new Set(ids).size;
    return unique === ids.length ? 'ok' : `${ids.length - unique} repetida(s)`;
  };
  const spacing = (list: ChildEvent[]): string => {
    const gaps = list.slice(1).map((e, i) => e.at - list[i].at);
    return gaps.length > 0
      ? `intervalos ${Math.min(...gaps)}–${Math.max(...gaps)} ms`
      : 'sem intervalos';
  };

  try {
    // M1 — duas instâncias registram o mesmo scheduler ao mesmo tempo.
    const a = spawnInstance('maint-a');
    const b = spawnInstance('maint-b');
    const firstIds = await register([a, b]);
    const countAfterRegister = await queue.getJobSchedulersCount();
    const scheduler = await queue.getJobScheduler(schedulerId);
    checks.add(
      '3.1 Duas instâncias registrando o mesmo upsertJobScheduler ao mesmo tempo',
      `1 scheduler "${schedulerId}" com every ${every}`,
      `${countAfterRegister} scheduler(s); every ${String(scheduler?.every)}; nome ${String(scheduler?.name)}; jobs devolvidos [${firstIds.join(', ')}]`,
      countAfterRegister === 1 &&
        scheduler?.every === every &&
        scheduler.name === jobName,
    );
    const m1Start = Date.now();
    await samplePending(6_000);
    const m1 = executions().filter((e) => e.at >= m1Start);
    const m1Instances = new Set(m1.map((e) => e.instance));
    checks.add(
      '3.2 Repetição com duas instâncias: execuções periódicas sem duplicação',
      'pelo menos 4 execuções em 6 s; cada job do scheduler executado uma única vez; no máximo 1 iteração pendente',
      `${m1.length} execuções (${[...m1Instances].join(', ')}); ${spacing(m1)}; ids únicos: ${noDuplicates()}; pendentes no máximo ${Math.max(...pendingSamples)}`,
      m1.length >= 4 &&
        noDuplicates() === 'ok' &&
        Math.max(...pendingSamples) <= 1,
    );

    // M2 — reinício do worker: as duas instâncias param (SIGKILL e SIGTERM) e voltam.
    a.signal('SIGKILL');
    b.signal('SIGTERM');
    await Promise.all([a.waitExit(), b.waitExit()]);
    const downAt = Date.now();
    pendingSamples.length = 0;
    await samplePending(4_000);
    const pendingWhileDown = Math.max(...pendingSamples);
    const executionsBefore = executions().length;
    const a2 = spawnInstance('maint-a2');
    const b2 = spawnInstance('maint-b2');
    await register([a2, b2]);
    const restartedAt = Date.now();
    const countAfterRestart = await queue.getJobSchedulersCount();
    await sleep(5_000);
    const m2 = executions().filter((e) => e.at >= restartedAt);
    const burst = m2.filter((e) => e.at - restartedAt < 500).length;
    checks.add(
      '3.3 Reinício do worker: sem acúmulo durante a parada e repetição retomada',
      'no máximo 1 iteração pendente com os workers parados; 1 scheduler após o novo registro; pelo menos 3 execuções em 5 s; ids únicos',
      `saídas: ${String(a.exit?.signal ?? a.exit?.code)} e ${String(b.exit?.signal ?? b.exit?.code)}; parados ${restartedAt - downAt} ms com até ${pendingWhileDown} pendente(s); ${countAfterRestart} scheduler(s); ${m2.length} execuções depois do reinício (${burst} nos primeiros 500 ms); ${spacing(m2)}; ids únicos: ${noDuplicates()}`,
      pendingWhileDown <= 1 &&
        countAfterRestart === 1 &&
        m2.length >= 3 &&
        noDuplicates() === 'ok',
    );
    checks.info(
      '3.3 Execuções antes da parada e encerramento das instâncias',
      `${executionsBefore} execuções antes da parada; maint-b saiu com código ${String(b.exit?.code)} depois do SIGTERM (close gracioso)`,
    );

    // M3 — indisponibilidade do Redis: o roteiro no host executa `docker compose stop redis` e `start`.
    const errorsBefore = children
      .flatMap((c) => c.events)
      .filter((e) => e.ev === 'worker-error' || e.ev === 'queue-error').length;
    console.log('V11_AGUARDANDO_PARADA_DO_REDIS');
    await waitUntil(
      'Redis indisponível',
      90_000,
      async () => !(await redisReachable(ctx.conn)),
      250,
    );
    const outageAt = Date.now();
    console.log('V11_REDIS_INDISPONIVEL');
    await waitUntil(
      'Redis disponível de novo',
      180_000,
      () => redisReachable(ctx.conn),
      250,
    );
    const backAt = Date.now();
    console.log('V11_REDIS_DISPONIVEL');
    const countAfterOutage = await queue.getJobSchedulersCount();
    await waitUntil(
      'execuções retomadas depois da volta do Redis',
      60_000,
      () => executions().filter((e) => e.at >= backAt).length >= 3,
      250,
    );
    const m3 = executions().filter((e) => e.at >= backAt);
    const outageErrors = children
      .flatMap((c) => c.events)
      .filter(
        (e) =>
          (e.ev === 'worker-error' || e.ev === 'queue-error') &&
          e.at >= outageAt - 2_000,
      );
    checks.add(
      '3.4 Recuperação depois de docker compose stop/start do Redis',
      'as duas instâncias seguem vivas; o scheduler persiste sem novo registro; a repetição volta; ids únicos',
      `instâncias vivas: ${[a2, b2].map((c) => `${c.cfg.instance} ${c.alive ? 'sim' : 'não'}`).join(', ')}; Redis fora por ${backAt - outageAt} ms; ${countAfterOutage} scheduler(s) depois da volta; primeira execução ${m3.length > 0 ? m3[0].at - backAt : -1} ms depois da volta; ${m3.length} execuções; ids únicos: ${noDuplicates()}`,
      a2.alive &&
        b2.alive &&
        countAfterOutage === 1 &&
        m3.length >= 3 &&
        noDuplicates() === 'ok',
    );
    checks.info(
      '3.4 Erros emitidos pelas instâncias durante a indisponibilidade',
      `${outageErrors.length} evento(s) (antes da parada: ${errorsBefore}); exemplos: ${[...new Set(outageErrors.map((e) => e.message ?? ''))].slice(0, 3).join(' | ')}`,
    );

    // Encerramento gracioso e remoção do scheduler.
    for (const child of [a2, b2]) {
      child.signal('SIGTERM');
    }
    await Promise.all([a2.waitExit(), b2.waitExit()]);
    const removed = await queue.removeJobScheduler(schedulerId);
    checks.add(
      '3.5 Encerramento das instâncias e remoção do scheduler',
      'saída com código 0 depois do SIGTERM; removeJobScheduler devolve true; 0 schedulers',
      `códigos ${String(a2.exit?.code)} e ${String(b2.exit?.code)}; removeJobScheduler ${removed}; ${await queue.getJobSchedulersCount()} scheduler(s)`,
      a2.exit?.code === 0 &&
        b2.exit?.code === 0 &&
        removed &&
        (await queue.getJobSchedulersCount()) === 0,
    );
    checks.info(
      '3.x Execuções por instância no total',
      [...new Set(executions().map((e) => e.instance))]
        .map(
          (i) => `${i}: ${executions().filter((e) => e.instance === i).length}`,
        )
        .join(', '),
    );
  } finally {
    for (const child of children) {
      if (child.stderr.length > 0) {
        console.log(
          `STDERR ${child.cfg.instance}: ${child.stderr.slice(0, 5).join(' | ')}`,
        );
      }
    }
    await ctx.close();
  }
  console.log(`RESUMO manutenção: ${checks.summary()}`);
  return checks.allPassed;
}

// ---------------------------------------------------------------------------------------------
// Limpeza e retrato
// ---------------------------------------------------------------------------------------------

/**
 * Processos desta prova ainda vivos no container (lidos de /proc): filhos (`child`) e execuções
 * órfãs de `core` ou `maintenance`, caso o roteiro tenha sido interrompido. O processo de limpeza
 * e o seu pai (`npx`) não entram, porque o subcomando deles é `cleanup`.
 */
function leftoverProcesses(): number[] {
  const pids: number[] = [];
  const commands = ['child', 'core', 'maintenance'];
  for (const entry of readdirSync('/proc')) {
    const pid = Number(entry);
    if (!Number.isInteger(pid) || pid === process.pid || pid === process.ppid) {
      continue;
    }
    try {
      const cmdline = readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0');
      if (
        cmdline.some((a) => a.includes(SCRIPT_MARK)) &&
        cmdline.some((a) => commands.includes(a))
      ) {
        pids.push(pid);
      }
    } catch {
      // processo já terminou
    }
  }
  return pids;
}

async function scanKeys(redis: Redis, pattern: string): Promise<string[]> {
  const keys: string[] = [];
  let cursor = '0';
  do {
    const [next, batch] = await redis.scan(
      cursor,
      'MATCH',
      pattern,
      'COUNT',
      1000,
    );
    cursor = next;
    keys.push(...batch);
  } while (cursor !== '0');
  return keys;
}

async function runCleanup(prefix: string): Promise<boolean> {
  if (!/^proofs-v(06|11)-/.test(prefix)) {
    throw new Error(`prefixo de limpeza recusado: ${prefix}`);
  }
  const killed = leftoverProcesses();
  for (const pid of killed) {
    try {
      process.kill(pid, 'SIGCONT');
      process.kill(pid, 'SIGKILL');
    } catch {
      // já terminou
    }
  }
  if (killed.length > 0) {
    await sleep(1_000);
  }
  const redis = new Redis({ ...connection(), lazyConnect: true });
  try {
    await redis.connect();
    const keys = await scanKeys(redis, `${prefix}*`);
    for (let i = 0; i < keys.length; i += 500) {
      await redis.unlink(...keys.slice(i, i + 500));
    }
    const left = await scanKeys(redis, `${prefix}*`);
    const processesLeft = leftoverProcesses().length;
    console.log(
      `LIMPEZA prefixo ${prefix}: ${killed.length} processo(s) da prova encerrado(s), ${keys.length} chave(s) removida(s); restam ${left.length} chave(s) e ${processesLeft} processo(s)`,
    );
    return left.length === 0 && processesLeft === 0;
  } finally {
    await redis.quit();
  }
}

async function runSnapshot(): Promise<boolean> {
  const redis = new Redis({ ...connection(), lazyConnect: true });
  try {
    await redis.connect();
    const keys = (await scanKeys(redis, '*')).sort();
    const lines: string[] = [];
    for (const key of keys) {
      lines.push(`${key}|${await redis.type(key)}`);
    }
    const digest = createHash('sha256').update(lines.join('\n')).digest('hex');
    console.log(
      `SNAPSHOT_REDIS dbsize=${await redis.dbsize()} chaves=${keys.length} sha256=${digest}`,
    );
    return true;
  } finally {
    await redis.quit();
  }
}

function main(): void {
  const [command, arg] = process.argv.slice(2);
  const execute = async (): Promise<boolean> => {
    switch (command) {
      case 'core':
        if (arg) return runCore(arg);
        break;
      case 'maintenance':
        if (arg) return runMaintenance(arg);
        break;
      case 'child':
        if (arg) {
          await runChild(arg);
          return true;
        }
        break;
      case 'cleanup':
        if (arg) return runCleanup(arg);
        break;
      case 'snapshot':
        return runSnapshot();
    }
    throw new Error(
      'uso: core <runId> | maintenance <runId> | cleanup <prefixo> | snapshot',
    );
  };
  execute()
    .then((ok) => {
      if (command !== 'child') {
        process.exitCode = ok ? 0 : 1;
        // Tudo foi fechado explicitamente; se algum handle ainda prender o processo, o aviso
        // fica no log e a saída preserva o código já definido.
        setTimeout(() => {
          console.log(
            'AVISO | handle aberto depois do encerramento; saída forçada',
          );
          process.exit(process.exitCode);
        }, 5_000).unref();
      }
    })
    .catch((error: unknown) => {
      console.error(error);
      process.exitCode = 2;
      if (command === 'child') {
        process.exit(2);
      }
    });
}

main();

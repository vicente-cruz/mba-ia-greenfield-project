---
libs:
  "@aws-sdk/client-s3":
    version: "^3.1170.0"
    context7_id: "/aws/aws-sdk-js-v3/v3.1153.0"
    fetched_at: "2026-11-17T17:20:56-03:00"
  "@aws-sdk/s3-request-presigner":
    version: "^3.1170.0"
    context7_id: "/aws/aws-sdk-js-v3/v3.1153.0"
    fetched_at: "2026-11-17T17:20:56-03:00"
  bullmq:
    version: "^6.7.7"
    context7_id: "/taskforcesh/bullmq/v6.5.3"
    fetched_at: "2026-11-17T21:13:27-03:00"
  "@nestjs/bullmq":
    version: "^11.0.5"
    context7_id: "/nestjs/bull"
    fetched_at: "2026-11-17T17:20:56-03:00"
  ioredis:
    version: "5.11.1"
    context7_id: "/redis/ioredis/v5.11.1"
    fetched_at: "2026-11-18T11:03:35-03:00"
sources_mtime:
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-11-20T23:41:45-03:00"
---

# phase-03-videos — Library References

Documentação destilada das bibliotecas decididas nesta fase, obtida pelo Context7. A SI-03.2 instalou todas no `nestjs-project`; as versões efetivas estão no `package-lock.json`. Buscar de novo quando a TD correspondente mudar.

**Discrepâncias de versão (sinalizadas conforme o CLAUDE.md):**
- **AWS SDK:** alvo 3.1170.0; a versão mais próxima no Context7 é a 3.1153.0. O comportamento de `signableHeaders`, `unhoistableHeaders` e checksum precisa ser revalidado na versão instalada (V-03 e V-09).
- **BullMQ:** alvo 6.7.7; a documentação do Context7 é da 6.5.3. Padrões de lock, stall, Job Schedulers, contadores (`attemptsStarted`, `attemptsMade`), retenção e remoção precisam ser confirmados na 6.7.7 (V-11).
- **`@nestjs/bullmq`:** a documentação do Context7 (`/nestjs/bull`) não tem versão. Alguns exemplos misturam a opção `redis:` do pacote `@nestjs/bull` antigo com a `connection:` do `@nestjs/bullmq`; nesta fase vale `connection:` (V-06).

## Bibliotecas

### @aws-sdk/client-s3

**Source:** `/aws/aws-sdk-js-v3/v3.1153.0` (Context7). Atende `phase-03-videos/TD-01`, `TD-02`, `TD-03`, `TD-07`, `TD-11` e `TD-14`.

#### Cliente para storage compatível com S3 (TD-07)

O cliente aceita um `endpoint` estático; `s3ForcePathStyle` da v2 virou `forcePathStyle` na v3. Para o S3, `requestChecksumCalculation` e `responseChecksumValidation` aceitam `WHEN_REQUIRED` ou `WHEN_SUPPORTED`; a TD-07 usa `WHEN_REQUIRED` (V-03). A TD-07 prevê dois clientes: um com o endpoint interno, para as operações, e outro com o endpoint público, usado só para assinar URLs do navegador.

```typescript
import { S3Client } from '@aws-sdk/client-s3';

const internal = new S3Client({
  endpoint: storageConfig.internalEndpoint, // por variável de ambiente
  forcePathStyle: true,
  requestChecksumCalculation: 'WHEN_REQUIRED',
  responseChecksumValidation: 'WHEN_REQUIRED',
});
```

#### Comandos do ciclo multipart (TD-02)

- `CreateMultipartUploadCommand` (com `Metadata`, se necessário), `UploadPartCommand`, `ListPartsCommand` (paginado), `CompleteMultipartUploadCommand`, `AbortMultipartUploadCommand` e `HeadObjectCommand`.
- O corpo do `CompleteMultipartUpload` lista, por parte, `PartNumber`, `ETag` e o checksum da parte (`ChecksumSHA256`, entre outros algoritmos). A TD-02 monta essa lista a partir do registro da própria API, não do `ListParts`.
- O `Upload` de `@aws-sdk/lib-storage` faz multipart do lado do servidor e não se aplica ao upload direto do navegador desta fase.

### @aws-sdk/s3-request-presigner

**Source:** `/aws/aws-sdk-js-v3/v3.1153.0` (Context7). Atende `phase-03-videos/TD-01`, `TD-02`, `TD-03`, `TD-11` e `TD-14`.

#### URL pré-assinada com headers assinados (TD-01, TD-03, TD-02)

`getSignedUrl(client, command, { expiresIn })` gera URLs para qualquer comando, não só `PutObject`; o `expiresIn` padrão é 900 segundos. Headers que não são `x-amz-*` (como `content-length`) entram em `signableHeaders` para serem exigidos. Headers `x-amz-*` (como `x-amz-checksum-sha256`) precisam ir em `unhoistableHeaders`, o que os mantém como headers obrigatórios em vez de parâmetros da query.

```typescript
import { UploadPartCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

const command = new UploadPartCommand({
  Bucket, Key, UploadId, PartNumber,
  ContentLength: partSize,       // TD-03: tamanho assinado
  ChecksumSHA256: partChecksum,  // TD-02: checksum por parte (V-09)
});

const url = await getSignedUrl(publicClient, command, {
  expiresIn,
  signableHeaders: new Set(['content-length']),
  unhoistableHeaders: new Set(['x-amz-checksum-sha256']),
});
```

O exemplo da documentação usa `PutObjectCommand`; a aplicação a `UploadPartCommand` com `content-length` é a hipótese que a V-02, a V-08 e a V-09 precisam provar.

### bullmq

**Source:** `/taskforcesh/bullmq/v6.5.3` (Context7). Atende `phase-03-videos/TD-09` e `TD-12`.

#### `jobId` e deduplicação (TD-12)

Um `jobId` customizado precisa ser único na fila; adicionar um job com um id que já existe é ignorado. Evitar `:` e ids só com dígitos. Se o job foi removido (`removeOnComplete`/`removeOnFail`), ele deixa de contar como existente, e um novo job com o mesmo id pode entrar. Por isso, nesta fase, o `jobId` inclui a geração reservada no banco, e a remoção automática fica desligada (revisão de recuperações por geração da TD-12; P5 do plano).

```typescript
await queue.add(
  'process-video',
  { videoId, run },
  { jobId: `video-${videoId}-${run}-${dispatch}`, removeOnComplete: false, removeOnFail: false },
);
```

#### Locks, stall e processamento repetido (TD-10, TD-12)

A estratégia é "at least once". O worker mantém um lock por `lockDuration` e o renova a cada `lockRenewTime` (em geral metade). Se o lock vence, o job é considerado *stalled*, reiniciado e processado de novo. Isso acontece quando o processo morre ou quando o event loop fica bloqueado. Depois de `maxStalledCount` (padrão 1), o job falha com "job stalled more than allowable limit". A documentação recomenda escutar o evento `stalled`. Na busca manual de jobs, o lock padrão é de 30 segundos. Valores a confirmar na 6.7.7 (V-11).

#### Contadores, retenção e remoção (TD-12; P3 e P5 do plano)

- **`job.attemptsStarted`:** aumenta toda vez que o job é movido para `active`, o que inclui a reentrega de um job *stalled*. É o componente `seq` do token de ordem da tentativa vigente.
- **`job.attemptsMade`:** aumenta em cada conclusão ou falha regular, inclusive nas retentativas por `backoff`. Não aumenta com os erros especiais `RateLimitError`, `DelayedError` e `WaitingChildrenError`. É usado para identificar a última tentativa (`attemptsMade + 1 >= attempts`).
- **Remoção automática:** `removeOnComplete` e `removeOnFail` aceitam `true`, uma contagem ou `{ age, count }`, e a remoção é preguiçosa: só acontece quando outro job termina. Nesta fase os dois ficam `false`, porque o job é a evidência usada na deduplicação e na retomada.
- **Remoção explícita:** `job.remove()` ou `queue.remove(jobId)` apaga o job. Um job travado (`active`, com lock) não pode ser removido e gera erro; a coleta de P5 só remove jobs `completed` e `failed`.
- **`maxStartedAttempts`:** a documentação cita essa opção para limitar quantas vezes um job começa. Ela não é usada nesta fase.

A documentação consultada é da 6.5.3; esses comportamentos entram no roteiro da V-11 para a 6.7.7.

#### Parada graciosa (TD-10)

`await worker.close()` espera os jobs ativos terminarem, sem timeout embutido em TypeScript. O padrão documentado é tratar `SIGINT` e `SIGTERM` chamando `close()`; jobs que passam do período de carência ainda podem ficar *stalled*.

#### Job Schedulers (TD-12, manutenção)

`queue.upsertJobScheduler(schedulerId, repeatOptions, template)` cria ou atualiza um scheduler. Usar `upsert` em vez de `add` evita duplicação. O id estável do scheduler é o que impede schedulers duplicados quando várias instâncias registram o mesmo id. `repeatOptions` aceita `every` (ms) ou `pattern` (cron); o `template` define `name`, `data` e `opts`. Não é possível escolher o `jobId` dos jobs gerados por um scheduler.

```typescript
await maintenanceQueue.upsertJobScheduler(
  'upload-session-sweep',              // id estável
  { every: config.sweepIntervalMs },
  { name: 'sweep-upload-sessions', data: { batchSize: config.sweepBatchSize } },
);
```

### @nestjs/bullmq

**Source:** `/nestjs/bull` (Context7, sem versão). Atende `phase-03-videos/TD-09`, `TD-10` e `TD-12`.

#### Registro (TD-09)

`BullModule.forRootAsync({ inject: [ConfigService], useFactory })` registra a conexão compartilhada, alinhada à convenção herdada de configuração por `registerAs`. `BullModule.registerQueue` ou `registerQueueAsync` registra cada fila, com `connection` e `defaultJobOptions` (por exemplo `attempts` e `backoff`). O token de DI é `BullQueue_${name}`, e `@InjectQueue(name)` injeta a fila num serviço. `RegisterQueueOptions` aceita `backendFactory` (bullmq ≥ 6) e `forceDisconnectOnShutdown`.

```typescript
BullModule.forRootAsync({
  inject: [queueConfig.KEY],
  useFactory: (config: ConfigType<typeof queueConfig>) => ({
    connection: { host: config.host, port: config.port },
  }),
});
```

#### Processors (TD-10, TD-12)

Um processor é uma classe com `@Processor(nameOrOptions, workerOptions)` que estende `WorkerHost` e implementa `process(job, token?)`. As opções do worker, como `concurrency` e `limiter`, vão no segundo argumento; por isso a fila de manutenção pode ter concorrência própria, separada da fila de vídeos (TD-10). `@OnWorkerEvent('stalled' | 'failed' | 'completed' | …)` liga métodos aos eventos do worker; listeners em processors com escopo de request são ignorados com aviso.

```typescript
@Processor('video-maintenance', { concurrency: 1 })
export class MaintenanceProcessor extends WorkerHost {
  async process(job: Job): Promise<void> { /* varredura, limpeza ou reconciliação */ }

  @OnWorkerEvent('stalled')
  onStalled(jobId: string) { /* registrar */ }
}
```

### ioredis

**Source:** `/redis/ioredis/v5.11.1` (Context7, a mesma versão instalada). O papel no BullMQ vem do changelog da 6.0.0 (`/websites/bullmq_io`) e do guia "Connections" (`/taskforcesh/bullmq/v6.5.3`). Atende `phase-03-videos/TD-09` (revisão de 2026-11-18).

#### Papel na fase (TD-09)

Desde a 6.0.0, o `bullmq` não instala mais o `ioredis`. Ele passou a ser peer dependency opcional (`>=5.0.0`), ao lado de `redis`, `pg` e `bullmq-otel`, e quem usa Redis precisa declará-lo. O projeto declara `ioredis` 5.11.1, com versão exata, em `dependencies`. A aplicação não importa o `ioredis`: o BullMQ cria as conexões a partir de `connection: { host, port }`, como no registro do `@nestjs/bullmq` acima, com o nome do serviço do Compose como host.

#### Opções de conexão

`new Redis({ host, port })` conecta na criação; com `lazyConnect: true`, a conexão espera o primeiro comando ou um `connect()` explícito. O padrão de `maxRetriesPerRequest` é 20; com `null`, os comandos aguardam a reconexão sem limite. Nos `Worker`s, o BullMQ usa `null` por padrão e alerta se receber outro valor. O `ioredis` reconecta sozinho quando a conexão cai, exceto se ela foi fechada por `quit()` ou `disconnect()`.

```typescript
const connection = { host: config.host, port: config.port }; // REDIS_HOST=redis
const queue = new Queue('video-processing', { connection });
const worker = new Worker('video-processing', processor, { connection });
```

#### Encerramento

`worker.close()` e `queue.close()` fecham as conexões que o BullMQ abriu a partir das opções. Na verificação da SI-03.2, depois deles não restou nenhum cliente no Redis, e o processo Node terminou sem conexão pendente.

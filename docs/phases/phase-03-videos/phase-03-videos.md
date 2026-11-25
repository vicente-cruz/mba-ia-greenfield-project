---
kind: phase
name: phase-03-videos
test_specs_aware: true
sources_mtime:
  docs/phases/phase-03-videos/context.md: "2026-11-20T23:42:22-03:00"
  docs/phases/phase-03-videos/library-refs.md: "2026-11-20T23:42:22-03:00"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-11-20T23:41:45-03:00"
  docs/decisions/technical-decisions-phase-02-auth.md: "2026-11-17T17:20:01-03:00"
  docs/decisions/technical-decisions-openapi-docs-nestjs.md: "2026-11-13T16:18:07-03:00"
  docs/decisions/technical-decisions-next-frontend-openapi-typing.md: "2026-11-13T16:18:07-03:00"
  docs/decisions/technical-decisions-next-frontend-config-base.md: "2026-11-13T16:18:07-03:00"
---

# Phase 03 — Upload e Processamento de Vídeos

## Objective

Entregar o upload de até 10GB funcional, retomável e direto do navegador ao storage S3/MinIO, com pré-cadastro automático do vídeo como rascunho, processamento automático em segundo plano (filas) com extração de duração e metadados e geração de thumbnail, URL única por vídeo, reprodução via streaming e download pelo usuário, sobre storage, fila e worker reais no Docker Compose, precedidos pelas provas de viabilidade que condicionam as decisões.

---

## Step Implementations

### SI-03.1 — Infra: storage, inicialização do bucket, Redis e FFmpeg no ambiente

**Description:** Sobe a infraestrutura real mínima para as provas e para a fase (storage S3 compatível fixado por digest, bucket privado, Redis e FFmpeg na imagem), sem código de aplicação.

**Technical actions:**

1. Adicionar ao `nestjs-project/compose.yaml` o serviço `storage` com `pgsty/silo:RELEASE.2026-11-12T00-00-00Z@sha256:c20d112390b9a9ce8c11b8af95ad35bcaa62f4759663c09c936cd8d2b511f329`, volume próprio, `MINIO_ROOT_USER`, `MINIO_ROOT_PASSWORD`, `MINIO_API_CORS_ALLOW_ORIGIN` (origem do frontend e da página de prova da V-08), `MINIO_API_STALE_UPLOADS_EXPIRY=48h`, portas 9000 e 9001 e healthcheck de prontidão (per `phase-03-videos/TD-07`, `phase-03-videos/TD-08`)
2. Adicionar o serviço de execução única `storage-init` com `pgsty/mc@sha256:b532278b7a3747dbab6fe45eebb40a653efa704e6758e24e9d9ec54fc96c1800`, que cria o bucket `S3_BUCKET` sem política anônima e uma credencial da aplicação restrita a ele (per `phase-03-videos/TD-06`)
3. Adicionar o serviço `redis` com `redis:8.8.4`, `--maxmemory-policy noeviction` (exigência do BullMQ, conferida na V-06), volume e healthcheck `redis-cli ping` (per `phase-03-videos/TD-09`)
4. Incluir `ffmpeg` no `apt install` do `Dockerfile.dev` (Debian bookworm, FFmpeg 5.1) e fazer o `nestjs-api` depender de `storage` e `redis` saudáveis e de `storage-init` concluído (per `phase-03-videos/TD-10`, revisão DG-1)
5. Acrescentar ao `.env.example` e ao `.env` local as chaves `S3_*`, `REDIS_HOST=redis` e `REDIS_PORT=6379`, sempre com nomes de serviço do Compose e sem caracteres especiais fora de aspas (`nestjs-project/CLAUDE.md`)

**Tests:** _(empty — Infra)_

**Dependencies:** none

**Acceptance criteria:**

- `docker compose ps` mostra `db`, `storage` e `redis` saudáveis, e `storage-init` termina com código 0
- Um `GET` anônimo, sem assinatura, a um objeto do bucket recebe `403` do storage
- `docker compose exec redis redis-cli CONFIG GET maxmemory-policy` devolve `noeviction`
- `docker compose exec nestjs-api ffmpeg -version` e `ffprobe -version` informam a versão 5.1.x
- Dentro dos containers, os hosts configurados são `storage`, `redis` e `db`, nunca `localhost`

---

### SI-03.2 — Infra: bibliotecas da fase e estrutura das provas

**Description:** Instala as bibliotecas decididas e prepara o lugar e o modelo dos relatórios de prova, sem lógica de aplicação.

**Technical actions:**

1. Instalar no container `@aws-sdk/client-s3@^3.1170.0`, `@aws-sdk/s3-request-presigner@^3.1170.0`, `bullmq@^6.7.7`, `@nestjs/bullmq@^11.0.5` e `ioredis@5.11.1`, este com versão exata: desde a 6.0.0, o cliente Redis do BullMQ é peer dependency opcional e precisa ser declarado. O `package-lock.json` fixa as versões efetivamente provadas (per `phase-03-videos/TD-01`, `phase-03-videos/TD-09`; `library-refs.md`)
2. Criar `nestjs-project/proofs/phase-03/` para os scripts de prova, excluído do build em `tsconfig.build.json` e coberto pelo `tsc --noEmit`
3. Criar `docs/phases/phase-03-videos/proofs/README.md` com o modelo de relatório: prova, TDs afetadas, data, versões (digests, SDK, BullMQ, Node e FFmpeg), procedimento reproduzível, evidências, resultado (`aprovada` ou `reprovada`) e consequência
4. Registrar no modelo a regra: uma prova reprovada reabre a TD afetada, sem fallback automático, e bloqueia as SIs que dependem dela

**Tests:** _(empty — Infra)_

**Dependencies:** none

**Acceptance criteria:**

- O `package-lock.json` resolve `@aws-sdk/client-s3` e `@aws-sdk/s3-request-presigner` 3.1170.x, `bullmq` 6.7.x, `@nestjs/bullmq` 11.0.x e `ioredis` 5.11.1, declarado com versão exata no `package.json`
- `docker compose exec nestjs-api npx tsc --noEmit` passa com `proofs/` incluída, e `npm run build` não emite nada de `proofs/`
- O modelo de relatório define os dois resultados possíveis e a consequência de cada um

---

### SI-03.3 — Prova V-01 e V-03: configuração do Silo e URLs do AWS SDK

**Description:** Prova que o storage fixado aceita a configuração prevista e as URLs pré-assinadas do AWS SDK 3.1170. É passo bloqueante antes de qualquer implementação que dependa do storage.

**Technical actions:**

1. Criar `proofs/phase-03/v01-storage-config.ts` e o roteiro com `mc` para a V-01 (per `phase-03-videos/TD-02`, `phase-03-videos/TD-07`, `phase-03-videos/TD-08`):
   - variáveis `MINIO_*` aceitas e `mc` funcional;
   - CORS padrão expondo `ETag`, e preflight recusado para origem fora de `MINIO_API_CORS_ALLOW_ORIGIN`;
   - a partir de quando `MINIO_API_STALE_UPLOADS_EXPIRY` conta a idade de um multipart incompleto (criação ou última parte), medido com expiração curta numa instância de prova
2. Criar `proofs/phase-03/v03-presigned-urls.ts` para a V-03: presign de `PutObject`, `UploadPart` e `GetObject` com `requestChecksumCalculation` e `responseChecksumValidation` em `WHEN_REQUIRED`. Conferir que a query não traz parâmetros de checksum automáticos e que as URLs funcionam por `curl` (per `phase-03-videos/TD-07`; `library-refs.md` → `@aws-sdk/client-s3`)
3. Registrar `docs/phases/phase-03-videos/proofs/V-01.md` e `V-03.md` com versões, evidências e resultado. A V-01 também confirma ou ajusta os prazos de 24h e 48h (Q-08)

**Tests:** _(empty — prova de viabilidade; o relatório é o entregável)_

**Dependencies:** SI-03.1, SI-03.2

**Acceptance criteria:**

- `V-01.md` registra o resultado de cada item e a regra observada para a idade do multipart
- `V-03.md` registra uma URL de cada tipo, a query gerada e a resposta do storage a ela
- Com resultado `reprovada`, o relatório nomeia as TDs reabertas (TD-02, TD-07 ou TD-08) e as SIs bloqueadas

---

### SI-03.4 — Prova V-02, V-09 (servidor) e V-10: tamanho assinado, checksum e Complete

**Description:** Prova no servidor as garantias de tamanho, checksum e conclusão de que dependem a TD-02 e a TD-03. É passo bloqueante antes do envio de partes e do ciclo da sessão.

**Technical actions:**

1. Criar `proofs/phase-03/v02-content-length.ts`: `UploadPart` pré-assinado com `content-length` em `signableHeaders`. Corpos maiores e menores que o assinado devem ser recusados antes de gravar, e o `ListParts` não pode mostrar a parte (per `phase-03-videos/TD-03`)
2. Criar `proofs/phase-03/v09-checksum-server.ts` (per `phase-03-videos/TD-02`, `phase-03-videos/TD-07`):
   - `x-amz-checksum-sha256` assinado como header (`unhoistableHeaders`);
   - corpo divergente recusado com HTTP 400 depois de recebido, sem registrar a parte: `BadDigest` na AWS; no Silo fixado, `XAmzContentChecksumMismatch` (revisão de 2026-11-18; nenhum outro 4xx equivale);
   - `ListParts` devolvendo `ChecksumSHA256`, e o Complete exigindo os checksums;
   - tudo junto com `WHEN_REQUIRED`
3. Criar `proofs/phase-03/v10-complete-retry.ts` (per `phase-03-videos/TD-02`, AMB-4):
   - um segundo Complete depois do sucesso devolve `NoSuchUpload`;
   - suporte, ou não, a `If-None-Match: *` e a `x-amz-mp-object-size`;
   - duas sessões em chaves `originals/{videoId}/{sessionId}` distintas, concluídas fora de ordem, não se sobrescrevem;
   - o `HeadObject` na chave da sessão confirma o objeto
4. Registrar `V-02.md`, `V-09.md` (parte de servidor) e `V-10.md`. A V-10 decide se o Complete de P2 usa os guardas opcionais. Decisão da revisão de 2026-11-18: a P2 não usa `If-None-Match` nem `x-amz-mp-object-size` nesta fase (ver `V-10.md`)

**Tests:** _(empty — prova de viabilidade; o relatório é o entregável)_

**Dependencies:** SI-03.3

**Acceptance criteria:**

- `V-02.md` registra a resposta do storage para corpo maior e para corpo menor, e o `ListParts` sem a parte recusada
- `V-09.md` registra a recusa do corpo divergente (`BadDigest` na AWS; `XAmzContentChecksumMismatch` no Silo fixado), o checksum devolvido no `ListParts` e o comportamento do Complete sem checksums
- `V-10.md` registra a resposta ao segundo Complete e o suporte, ou não, a cada guarda opcional
- Com resultado `reprovada`, o relatório reabre a TD-02 ou a TD-03, sem adotar fallback com garantias menores

---

### SI-03.5 — Prova V-08 e V-09 (navegador): PUT em navegador real e custo do SHA-256

**Description:** Prova em navegador real que o `Content-Length` assinado e o header de checksum funcionam pelo caminho do cliente, e mede o custo de recalcular os checksums. É prova técnica de infraestrutura, não implementação de frontend.

**Technical actions:**

1. Adicionar ao `compose.yaml` o perfil `proofs` com o serviço `proof-browser`, usando a imagem oficial do Playwright na mesma versão de `@playwright/test` resolvida em `next-frontend/package-lock.json` e montando `nestjs-project/proofs/phase-03/browser/`. A origem da página de prova é incluída em `MINIO_API_CORS_ALLOW_ORIGIN` no ambiente de desenvolvimento
2. Criar a página e o roteiro, executados em Chromium e em Firefox (per `phase-03-videos/TD-01`, `phase-03-videos/TD-03`):
   - (a) o PUT de um `Blob` com o tamanho exato retorna 200 e expõe o `ETag`;
   - (b) um `Blob` de outro tamanho é recusado;
   - (c) um corpo `ReadableStream` sem `Content-Length` falha;
   - (d) o preflight com `x-amz-checksum-sha256` passa
3. Medir em cada navegador o SHA-256 por parte com Web Crypto, uma parte de 64 MiB por vez e fora da thread principal, sobre 1 GiB. Projetar o tempo para 150 partes (V-09, Q-10)
4. Registrar `V-08.md` e a seção de navegador de `V-09.md`

**Tests:** _(empty — prova técnica de infraestrutura; o relatório é o entregável)_

**Dependencies:** SI-03.4

**Acceptance criteria:**

- `V-08.md` registra os quatro casos em Chromium e em Firefox
- `V-09.md` registra o throughput medido de SHA-256 em cada navegador e a projeção para 10.000.000.000 bytes
- Nenhum arquivo de `next-frontend/` é criado ou alterado
- Com resultado `reprovada`, a TD-01 ou a TD-03 é reaberta, sem fallback automático

---

### SI-03.6 — Prova V-04: FFmpeg 5.1 sobre URL assinada, formatos e timeouts

**Description:** Prova que o ffprobe e o ffmpeg da imagem leem MP4 e WebM por URL pré-assinada interna, define timeouts e reconexões e gera as fixtures de vídeo da fase.

**Technical actions:**

1. Criar `nestjs-project/test/fixtures/videos/generate.sh`, que gera fixtures pequenas com o FFmpeg da imagem. As fixtures resultantes, com menos de 1 MB cada, ficam versionadas (per `phase-03-videos/TD-11`, `phase-03-videos/TD-13`):
   - MP4 H.264/AAC com `moov` no início e com `moov` no fim;
   - MP4 sem áudio;
   - WebM VP9/Opus;
   - MOV (`major_brand` `qt  `);
   - arquivo inválido e MP4 truncado
2. Criar `proofs/phase-03/v04-ffmpeg-signed-url.ts`, que roda o ffprobe em JSON e extrai um frame por URL pré-assinada interna para cada fixture. Registra as requisições Range, o tempo e a classificação: aceita, `MEDIA_INVALID`, `MEDIA_CONTAINER_MISMATCH` ou `MEDIA_UNSUPPORTED_CODEC`
3. Testar `-rw_timeout` e as opções `reconnect*` contra um servidor que aceita a conexão e não envia bytes, e definir os valores do timeout por chamada (G-09)
4. Registrar `V-04.md` com as versões efetivamente validadas de Node, FFmpeg e ffprobe (DG-1) e com os valores de timeout e reconexão adotados

**Tests:** _(empty — prova de viabilidade; as fixtures são reutilizadas pelos testes das SIs 03.21, 03.22, 03.27 e 03.28)_

**Dependencies:** SI-03.3

**Acceptance criteria:**

- `V-04.md` registra, para cada fixture, o resultado do ffprobe e da extração de frame por URL assinada
- O relatório registra as versões de Node, FFmpeg e ffprobe da imagem e os timeouts adotados
- Com resultado `reprovada` para MP4 ou WebM, a TD-11 é reaberta; o download completo para disco não é adotado sem nova decisão (revisão IC-5 da TD-11)

---

### SI-03.7 — Prova V-06 e V-11: BullMQ no stack real

**Description:** Prova a integração do BullMQ 6 com o `@nestjs/bullmq` 11, o Redis 8 e o Jest 30 em CommonJS, e os comportamentos da biblioteca de que P3 e P5 dependem.

**Technical actions:**

1. V-06: criar um módulo Nest mínimo em `proofs/phase-03/v06/` com `BullModule.forRootAsync`, `registerQueue` e um processor `WorkerHost`, executado por uma spec do Jest 30 em CommonJS contra o Redis real (per `phase-03-videos/TD-09`; `library-refs.md` → `@nestjs/bullmq`)
2. V-11, padrões e entrega (per `phase-03-videos/TD-10`, `phase-03-videos/TD-12`): valores efetivos de `lockDuration`, `stalledInterval` e `maxStalledCount`; reentrega após `SIGKILL` do worker; `failedReason` do stall acima do limite; `job.attemptsMade` na última tentativa
3. V-11, geração e retenção (revisão de recuperações por geração da TD-12):
   - `attemptsStarted` crescendo estritamente na entrega, na retentativa por `backoff` e na reentrega após stall;
   - `removeOnComplete: false` e `removeOnFail: false` retendo os jobs;
   - `job.remove()` recusado para job `active`;
   - `add` com `jobId` existente ignorado em cada estado;
   - contador reiniciado num job removido e adicionado de novo;
   - entrega de um job removido sem conseguir concluir nem falhar o job
4. V-11, manutenção (AMB-6): duas instâncias registrando o mesmo `upsertJobScheduler`, repetição, reinício do worker e recuperação depois de `docker compose stop redis` e `start`
5. Registrar `V-06.md` e `V-11.md`. O item `Job.retry()` do roteiro original fica informativo e não condiciona a TD-12

**Tests:** _(empty — prova de viabilidade; o relatório é o entregável)_

**Dependencies:** SI-03.1, SI-03.2

**Acceptance criteria:**

- `V-06.md` registra a spec do Jest executada em CommonJS com sucesso, ou a falha observada
- `V-11.md` registra o resultado e os valores medidos de cada cenário dos três grupos
- Com resultado `reprovada`, a TD-09, a TD-10 ou a TD-12 é reaberta, sem troca automática de mecanismo

---

### SI-03.8 — Configuração de storage, fila, vídeo e manutenção

**Description:** Adiciona os namespaces de configuração da fase e suas validações, com os valores confirmados pelas provas.

**Technical actions:**

1. Criar `src/config/storage.config.ts` (`registerAs('storage')`) com `S3_ENDPOINT`, `S3_PUBLIC_ENDPOINT`, `S3_REGION`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_BUCKET` e `S3_FORCE_PATH_STYLE` (per `phase-03-videos/TD-07`; convenção herdada de `registerAs`, `phase-01-configuracao-base/TD-03`)
2. Criar `src/config/queue.config.ts` (per `phase-03-videos/TD-09`, `phase-03-videos/TD-10`) com:
   - `REDIS_HOST` e `REDIS_PORT`;
   - `VIDEO_PROCESSING_ATTEMPTS`, `VIDEO_PROCESSING_BACKOFF_MS`, `VIDEO_PROCESSING_CONCURRENCY` e `VIDEO_PROCESSING_TIMEOUT_MS`;
   - os valores de lock e stall confirmados na V-11
3. Criar `src/config/video.config.ts` (per `phase-03-videos/TD-02`, `phase-03-videos/TD-03`, `phase-03-videos/TD-12`, `phase-03-videos/TD-14`) com:
   - `VIDEO_MAX_SIZE_BYTES=10000000000` e `UPLOAD_PART_SIZE_BYTES=67108864`;
   - `UPLOAD_SESSION_TTL=24h` e `UPLOAD_SESSION_CLAIM_TTL_SECONDS`;
   - `UPLOAD_PART_URL_TTL_SECONDS`, `PLAYBACK_URL_TTL_SECONDS` e `DOWNLOAD_URL_TTL_SECONDS`;
   - `PROCESSING_JOB_ACTION_TTL_SECONDS`, `PROCESSING_MAX_RECOVERIES=2` e `PROCESSING_STUCK_ALERT_MS`;
   - os intervalos, lotes e carências da manutenção (`MAINTENANCE_*`, `PROCESSING_RECONCILE_GRACE_MS` e `STORAGE_CLEANUP_GRACE_MS`)
4. Acrescentar as chaves ao `envValidationSchema` (Joi) e carregar os três namespaces no `ConfigModule.forRoot` do `AppModule` (`phase-01-configuracao-base/TD-02`)
5. Atualizar o `.env.example` com as novas chaves e os valores de desenvolvimento

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `envValidationSchema` | Integration: chaves obrigatórias, padrões e recusa de valores inválidos | `src/config/env.validation.integration-spec.ts` |

**Dependencies:** SI-03.3, SI-03.4, SI-03.5, SI-03.6, SI-03.7 — provas que condicionam a TD-02, a TD-03, a TD-07, a TD-09, a TD-10 e a TD-12 aprovadas. Pré-requisito externo: a tarefa separada D-08, em que o `createTestDataSource` passa a ler `DB_NAME` (a chave do projeto) em vez de `DB_DATABASE`, concluída antes de ampliar a suíte de integração. Concluída em 2026-11-20 (ver `progress.md`)

**Acceptance criteria:**

- A aplicação não inicia sem `S3_BUCKET`, `S3_ENDPOINT` ou `S3_PUBLIC_ENDPOINT`, e o erro nomeia a chave ausente
- Sem valor definido, `VIDEO_MAX_SIZE_BYTES` assume `10000000000` e `UPLOAD_PART_SIZE_BYTES` assume `67108864`
- `PROCESSING_MAX_RECOVERIES` negativo ou não inteiro é recusado na validação
- Os prazos de 24h e 48h ficam como confirmados, ou ajustados, pela V-01
- As chaves novas do `.env.example` não têm caractere especial fora de aspas

---

### SI-03.9 — Módulo de storage

**Description:** Encapsula a S3 API com dois clientes (operações e assinatura) e as operações de multipart, assinatura e objetos usadas pela API e pelo worker.

**Technical actions:**

1. Criar `src/storage/storage.module.ts` com dois `S3Client` injetáveis, ambos com `forcePathStyle` e `WHEN_REQUIRED` (per `phase-03-videos/TD-07`; `library-refs.md` → `@aws-sdk/client-s3`):
   - o interno, em `S3_ENDPOINT`, para as operações;
   - o público, em `S3_PUBLIC_ENDPOINT`, só para assinar URLs do navegador
2. Criar `src/storage/storage.service.ts` com as operações (per `phase-03-videos/TD-02`, `phase-03-videos/TD-06`):
   - multipart: `CreateMultipartUpload` com `ChecksumAlgorithm` `SHA256`, `ListParts` paginado, `CompleteMultipartUpload` sem os guardas opcionais `If-None-Match` e `x-amz-mp-object-size` (V-10 e revisão de 2026-11-18), `AbortMultipartUpload` e `ListMultipartUploads` por prefixo;
   - objetos: `HeadObject`, `PutObject`, `DeleteObject` e `ListObjectsV2`
3. Implementar a assinatura (per `phase-03-videos/TD-03`, `phase-03-videos/TD-14`; `library-refs.md` → `@aws-sdk/s3-request-presigner`):
   - `presignUploadPart`, com `content-length` em `signableHeaders` e `x-amz-checksum-sha256` em `unhoistableHeaders`, devolvendo `url`, `expectedSize`, `headers` e `expiresAt`;
   - `presignGet`, com `ResponseContentType` ou `ResponseContentDisposition`
4. Mapear erros transitórios do SDK para `STORAGE_UNAVAILABLE`, e expor `NoSuchUpload` e `NoSuchKey` como resultados explícitos
5. Criar `src/test/storage.ts` com helpers de teste: prefixo isolado por suíte e limpeza ao final

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `StorageModule` | Unit: compilation test | `src/storage/storage.module.spec.ts` |
| `StorageService` | Integration: ciclo multipart real, PUT por URL assinada com o tamanho exato, `ListParts` paginado e `NoSuchUpload` depois do Complete e do abort | `src/storage/storage.service.integration-spec.ts` |
| `StorageService` | Integration: `presignGet` com `Range` responde `206` e `Content-Range`; requisição anônima recebe `403` | `src/storage/storage.presign.integration-spec.ts` |

**Dependencies:** SI-03.8

**Acceptance criteria:**

- Uma parte enviada por PUT na URL de `presignUploadPart`, com corpo de exatamente `expectedSize` bytes e o header devolvido, é aceita, e o `ListParts` mostra o `ChecksumSHA256` declarado
- A mesma URL com um corpo de outro tamanho é recusada pelo storage
- A URL de `presignGet` responde `206 Partial Content` com `Content-Range` a `Range: bytes=0-1023`
- Um `GET` anônimo no mesmo objeto, sem assinatura, recebe `403`
- Um erro de rede ou 5xx do storage chega ao chamador como `STORAGE_UNAVAILABLE`

---

### SI-03.10 — Entidades e migration de vídeos, sessões e partes

**Description:** Cria o modelo persistente da fase conforme "Data Model" e mantém os helpers de teste coerentes com as novas tabelas.

**Technical actions:**

1. Criar `src/videos/entities/video.entity.ts` (`videos`) com os campos, enums, transformer de `bigint` e relações de "Data Model → Video", e acrescentar o lado inverso `videos` em `Channel` (per `phase-03-videos/TD-04`, `phase-03-videos/TD-05`, `phase-03-videos/TD-12`)
2. Criar `src/videos/entities/upload-session.entity.ts` (`upload_sessions`) e `src/videos/entities/upload-part.entity.ts` (`upload_parts`) conforme o Data Model, com o índice único parcial de `active` e os índices de varredura (per `phase-03-videos/TD-02`, `phase-03-videos/TD-06`)
3. Gerar a migration pelo CLI do TypeORM (`npm run migration:generate`). Conferir:
   - os enums `videos_status_enum`, `upload_sessions_status_enum` e `videos_pending_job_action_enum`;
   - os checks, as FKs (inclusive a circular entre `videos` e `upload_sessions`) e o índice parcial;
   - o `down()` reversível.

   Migrations existentes não são editadas (convenção herdada)
4. Atualizar `cleanAllTables`, na ordem `upload_parts`, `upload_sessions`, `videos` e depois as tabelas existentes, e a lista `MANAGED_TABLES` de `migrations.integration-spec.ts`, com o drop dos novos enums

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `Video` | Integration: `public_id` único, defaults (`draft`, `processing_run`, `processing_dispatch` e `processing_recoveries` em 0), check de `size_bytes` e FK de canal | `src/videos/entities/video.entity.integration-spec.ts` |
| `UploadSession` | Integration: `object_key` único, índice parcial de `active` e FKs circulares | `src/videos/entities/upload-session.entity.integration-spec.ts` |
| `UploadPart` | Integration: unique (`upload_session_id`, `part_number`), check de `part_number` e cascade | `src/videos/entities/upload-part.entity.integration-spec.ts` |
| Migrations | Integration: as migrations da fase sobem e descem em banco limpo | `src/database/migrations.integration-spec.ts` |

**Dependencies:** SI-03.8

**Acceptance criteria:**

- Inserir um segundo vídeo com o mesmo `public_id` viola a restrição única
- Uma segunda sessão `active` para o mesmo vídeo viola o índice parcial; uma sessão `aborted` e outra `active` convivem
- Um vídeo recém-criado tem `status = 'draft'` e `processing_run`, `processing_dispatch` e `processing_recoveries` iguais a 0
- `size_bytes = 10000000000` é lido de volta como número inteiro exato
- `migration:revert` remove as tabelas e os enums da fase sem afetar `users` e `channels`

---

### SI-03.11 — Base do módulo de vídeos: exceções, publicId, bloqueio e dispatch de jobs

**Description:** Cria as peças compartilhadas pelas rotas e pelo worker: códigos de erro, `publicId`, bloqueio da linha do vídeo (P1, P2) e execução e confirmação de ações de fila por geração (P5).

**Technical actions:**

1. Criar `src/videos/exceptions/video.exceptions.ts` com uma subclasse de `DomainException` por código HTTP do "Error Catalog" e as constantes dos códigos persistidos (per `phase-02-auth/TD-07`)
2. Criar `src/videos/public-id.ts` (8 bytes de `node:crypto` em base64url, 11 caracteres), com retentativa em violação do `public_id` único (per `phase-03-videos/TD-05`)
3. Criar `src/videos/video-lock.service.ts`: transação curta com `SELECT … FROM videos WHERE id = :id FOR UPDATE`, sem chamadas ao storage dentro dela (P1, P2; G-01)
4. Criar `src/videos/jobs/video-job-id.ts` e `src/videos/jobs/video-job-dispatcher.service.ts` (P5; revisão de recuperações por geração da `phase-03-videos/TD-12`; `library-refs.md` → `bullmq`):
   - montagem e leitura do `jobId` `video-{videoId}-{run}-{dispatch}`;
   - R2: `add` com `attempts`, `backoff`, `removeOnComplete: false` e `removeOnFail: false`;
   - R3: confirmação condicionada a token e geração
5. Criar `src/videos/videos.module.ts` e registrá-lo no `AppModule` (per `phase-03-videos/TD-09`; `library-refs.md` → `@nestjs/bullmq`):
   - o módulo usa `TypeOrmModule.forFeature`, `StorageModule` e `BullModule.registerQueue('video-processing')`;
   - o `BullModule.forRootAsync` fica registrado uma única vez no `AppModule`;
   - `src/videos/videos-throttle.ts` guarda os limites por rota de "API Contracts"
6. Criar os helpers dos specs E2E da fase, que controlam a fila e o worker reais sem substituí-los (R-10; `library-refs.md` → `bullmq`):
   - `test/helpers/queues.ts`, no `beforeAll`: pausa globalmente `video-processing` e `video-maintenance` (`Queue.pause()`) e espera `getActiveCount()` chegar a 0, porque a pausa global não interrompe o job já ativo;
   - antes de cada cenário: garante as duas filas pausadas e limpa só a `video-processing` (`drain(true)`, mais `clean(0, 1000, 'completed')` e `clean(0, 1000, 'failed')`). A `video-maintenance` nunca é limpa, para não remover o próximo job dos Job Schedulers;
   - num cenário que exige processamento real: retoma só a `video-processing` (`await resume()`), depois de conferir o estado intermediário;
   - no `afterAll`: limpa os jobs da suíte na `video-processing` e retoma as duas filas, que é o estado normal do ambiente. Uma execução interrompida antes do `afterAll` deixa as filas pausadas até a próxima suíte terminar ou até um `resume` manual;
   - `test/helpers/video-fixtures.ts`: grava estados de vídeo, sessão e partes consistentes com o Data Model e, quando o estado exige, os objetos no storage pelo cliente S3 interno (original em `original_key`, thumbnail em `thumbnail_key`). É usado pelos cenários que testam só a rota corrente

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `publicId` | Unit: formato base64url de 11 caracteres e retentativa em colisão | `src/videos/public-id.spec.ts` |
| `VideoLockService` | Integration: duas transações concorrentes sobre o mesmo vídeo são serializadas | `src/videos/video-lock.service.integration-spec.ts` |
| `VideoJobDispatcher` | Integration (Redis e Postgres reais): `add` repetido da mesma geração é ignorado; R3 com token ou geração errados afeta zero linhas; o `jobId` é lido de volta | `src/videos/jobs/video-job-dispatcher.service.integration-spec.ts` |
| `VideosModule` | Unit: compilation test | `src/videos/videos.module.spec.ts` |

**Dependencies:** SI-03.9, SI-03.10

**Acceptance criteria:**

- Um `publicId` gerado casa com `^[A-Za-z0-9_-]{11}$`, e uma colisão forçada leva a nova tentativa sem erro para o chamador
- Duas transações de bloqueio sobre o mesmo vídeo terminam uma depois da outra, nunca sobrepostas
- Dois `add` da geração 1 do mesmo vídeo e da mesma execução deixam um único job `video-{videoId}-{run}-1` na fila `video-processing`
- O job criado tem `removeOnComplete` e `removeOnFail` desligados
- Um `jobId` lido de volta devolve o mesmo `videoId`, `run` e `dispatch` usados na montagem

---

### SI-03.12 — Endpoint POST /videos

**Route:** POST /videos
**Test Specs:** see `nestjs-project/specs/videos-create.plan.md`
**Authorization:** Authenticated (cria no próprio canal)

**Description:** Pré-cadastra o vídeo como rascunho e cria a primeira sessão de upload pelo protocolo de intenção (P1).

**Technical actions:**

1. Criar `src/videos/dto/upload-declaration.dto.ts` (`fileName`, `sizeBytes` e `contentType`, só com validação estrutural) e os DTOs de resposta da criação, conforme "API Contracts → POST /videos"
2. Criar `src/videos/upload-sessions.service.ts` com `createVideoWithSession` (P1; per `phase-03-videos/TD-02`, `phase-03-videos/TD-03`, `phase-03-videos/TD-04`, `phase-03-videos/TD-05`):
   - regras de domínio 413 e 415, aplicadas depois da validação estrutural;
   - canal resolvido pelo `sub`, com `CHANNEL_NOT_FOUND` se não existir;
   - T1: vídeo em `draft` e sessão `initiating`, com chave e token;
   - `CreateMultipartUpload` fora da transação;
   - T2: ativação condicionada ao token
3. Implementar a recuperação de P1:
   - falha do storage → uma compensação apaga o vídeo e a sessão `initiating` que ainda tem o mesmo token, e a resposta é `STORAGE_UNAVAILABLE`;
   - T2 com zero linhas, porque a varredura assumiu a sessão depois do prazo do claim → aborto do próprio `uploadId` e resposta `STORAGE_UNAVAILABLE`, sem compensação: a sessão já não está em `initiating` com o mesmo token, e o vídeo permanece em `draft`, reiniciável
4. Criar `src/videos/videos.controller.ts` com `POST /videos` (`@HttpCode(201)`), `@Throttle` de `videos-throttle.ts` e OpenAPI completo: `@ApiOperation` e um `@ApiResponse` para cada status (201, 400, 401, 404, 413, 415 e 503) (`openapi-docs-nestjs/TD-01`)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `UploadSessionsService.createVideoWithSession` | Unit: 413, 415, `CHANNEL_NOT_FOUND`, compensação e T2 com zero linhas (storage e repositórios mockados) | `src/videos/upload-sessions.service.spec.ts` |
| `UploadSessionsService.createVideoWithSession` | Integration (Postgres e storage reais): vídeo `draft`, sessão `active` com `object_key` `originals/{videoId}/{sessionId}` e multipart nessa chave; compensação sem linhas órfãs (T-05); ativação que perde a posse para a varredura, com o rascunho preservado em `draft` e sem sessão `active` ou `initiating` no prazo | `src/videos/upload-sessions.create.integration-spec.ts` |

Os cenários HTTP (E2E) ficam no spec gerado por `/plan-test-specs`.

**Dependencies:** SI-03.11

**Acceptance criteria:**

- `POST /videos` com `{ "fileName": "a.mp4", "sizeBytes": 10000000000, "contentType": "video/mp4" }` retorna `201`, com:
  - `status: "draft"`;
  - `uploadSession.status: "active"`, `partSize: 67108864`, `partCount: 150` e `checksumAlgorithm: "SHA256"`
- `sizeBytes: 10000000001` retorna `413` com `error: "VIDEO_TOO_LARGE"` e o limite em bytes na mensagem
- `contentType: "video/quicktime"` retorna `415` com `error: "UNSUPPORTED_VIDEO_TYPE"`, e `contentType: "abc"` retorna `400`
- Sem token, a rota retorna `401`
- Quando o `CreateMultipartUpload` falha, retorna `503` com `error: "STORAGE_UNAVAILABLE"`, e a compensação remove o vídeo e a sessão `initiating`: nenhum vídeo fica registrado no canal
- Quando a ativação perde a posse para a varredura depois do prazo do claim, retorna `503` com `error: "STORAGE_UNAVAILABLE"` e o próprio upload é abortado. O vídeo permanece em `draft`, com a sessão vigente em `aborting` ou `aborted` e nenhuma sessão `active` ou `initiating` no prazo, que é a condição de reinício de P1. O reinício em si é verificado na SI-03.18
- Nenhuma resposta expõe o UUID interno do vídeo

---

### SI-03.13 — Endpoint POST part-urls (assinatura e registro em lote)

**Route:** POST /videos/:publicId/upload-sessions/:sessionId/part-urls
**Test Specs:** see `nestjs-project/specs/videos-upload-part-urls.plan.md`
**Authorization:** Owner (sessão `active` e vigente)

**Description:** Assina partes em lote com tamanho e SHA-256 assinados e registra os ETags enviados, sem transportar bytes pela API.

**Technical actions:**

1. Criar `src/videos/dto/part-urls.dto.ts` e o DTO de resposta, conforme "API Contracts":
   - `parts` com até 50 itens e `completedParts` com até 150;
   - `checksumSha256` validado pelo regex `^[A-Za-z0-9+/]{43}=$`;
   - pelo menos um dos dois arrays não vazio
2. Criar `src/videos/upload-parts.service.ts` com `signParts` (per `phase-03-videos/TD-02`, `phase-03-videos/TD-03`; V-09):
   - dono, com 404 para quem não é;
   - sessão vigente, `active`, não vencida e com `file_mismatch_at` nulo;
   - `partNumber` ≤ `partCount`;
   - `expected_size = min(part_size, size_bytes - (part_number - 1) * part_size)`;
   - checksum gravado uma única vez; um checksum diferente grava `file_mismatch_at` e responde `UPLOAD_FILE_MISMATCH`
3. Implementar `registerEtags` no mesmo pedido: só para partes com checksum registrado, senão `UPLOAD_PART_NOT_SIGNED`, gravando `etag` e `etag_registered_at` (G-04)
4. Assinar com `StorageService.presignUploadPart`, devolvendo `expectedSize` separado de `headers` (só `x-amz-checksum-sha256`) e `expiresAt` igual a agora + `UPLOAD_PART_URL_TTL_SECONDS` (per `phase-03-videos/TD-01`, `phase-03-videos/TD-03`)
5. Criar a rota em `src/videos/upload-sessions.controller.ts`, com `@HttpCode(200)`, `@Throttle` e OpenAPI para 200, 400, 401, 404, 409 e 410

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `UploadPartsService.signParts` / `registerEtags` | Unit: tamanho esperado (inclusive múltiplo exato), número fora do plano, checksum divergente com bloqueio, ETag sem assinatura e sessão vencida | `src/videos/upload-parts.service.spec.ts` |
| `UploadPartsService` | Integration: a URL assinada aceita PUT real com `expectedSize` bytes e o header devolvido; o ETag registrado persiste | `src/videos/upload-parts.sign.integration-spec.ts` |

Os cenários HTTP (E2E) ficam no spec gerado por `/plan-test-specs`.

**Dependencies:** SI-03.12

**Acceptance criteria:**

- Numa sessão de 10.000.000.000 bytes, `parts: [{ "partNumber": 150, "checksumSha256": "…" }]` retorna `200` com `expectedSize: 779264` e `headers` contendo só `x-amz-checksum-sha256`
- Numa sessão de 134217728 bytes, a parte 2 vem com `expectedSize: 67108864`
- `partNumber: 151` numa sessão de 150 partes retorna `400` com `error: "INVALID_PART_NUMBER"`
- Reassinar a parte 3 com outro checksum retorna `409` `UPLOAD_FILE_MISMATCH`, e todo pedido seguinte da sessão também retorna `409` `UPLOAD_FILE_MISMATCH`
- `completedParts` com uma parte nunca assinada retorna `409` `UPLOAD_PART_NOT_SIGNED`
- Um usuário que não é dono recebe `404` `VIDEO_NOT_FOUND`

---

### SI-03.14 — Endpoint GET da sessão (retomada)

**Route:** GET /videos/:publicId/upload-sessions/:sessionId
**Test Specs:** see `nestjs-project/specs/videos-upload-session-get.plan.md`
**Authorization:** Owner

**Description:** Expõe o estado da sessão e a classificação de cada parte do plano, base da retomada e da conferência da conclusão.

**Technical actions:**

1. Implementar `UploadPartsService.classifyParts`: compara o `ListParts` paginado com o registro e classifica cada parte do plano como `confirmed`, `missing`, `divergent` ou `unregistered` (per `phase-03-videos/TD-02`; G-04)
2. Implementar `UploadSessionsService.getSession`, com a resposta de "API Contracts" (`expired`, `fileMismatch` e `parts` só para sessão `active`). Um `NoSuchUpload` numa sessão `active` leva ao claim de abort sob o bloqueio do vídeo, a `aborted` e a `410 UPLOAD_SESSION_EXPIRED` (F-10)
3. Criar o DTO de resposta da sessão e a rota no `UploadSessionsController`, com `@Throttle` e OpenAPI para 200, 401, 404, 410 e 503

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `UploadPartsService.classifyParts` | Unit: as quatro classes, com tamanhos e checksums | `src/videos/upload-parts.classify.spec.ts` |
| `UploadPartsService.classifyParts` | Integration: parte reenviada com outro conteúdo depois do registro (ETag divergente) e parte presente sem registro (T-07); paginação do `ListParts` exercitada com página pequena | `src/videos/upload-parts.classify.integration-spec.ts` |

Os cenários HTTP (E2E) ficam no spec gerado por `/plan-test-specs`.

**Dependencies:** SI-03.13

**Acceptance criteria:**

- O GET de uma sessão sem nenhuma parte enviada retorna `200` com todas as partes em `state: "missing"`
- Uma parte enviada e registrada aparece como `confirmed`; enviada sem registro, como `unregistered`; reenviada com outro conteúdo depois do registro, como `divergent`
- Uma sessão `completed` retorna `200` com `parts: []`
- Quando o storage não reconhece mais o upload de uma sessão `active`, a rota retorna `410` `UPLOAD_SESSION_EXPIRED`, e a sessão passa a `aborted`
- Um usuário que não é dono recebe `404` `VIDEO_NOT_FOUND`

---

### SI-03.15 — Endpoint file-verifications (conferência na retomada)

**Route:** POST /videos/:publicId/upload-sessions/:sessionId/file-verifications
**Test Specs:** see `nestjs-project/specs/videos-upload-file-verifications.plan.md`
**Authorization:** Owner (sessão `active` e vigente)

**Description:** Confere, na retomada, que o arquivo selecionado de novo é o mesmo, recalculando o SHA-256 de todas as partes já recebidas.

**Technical actions:**

1. Criar `src/videos/dto/file-verifications.dto.ts`: `parts` com 0 a 150 itens, sem repetição, e o regex do checksum
2. Implementar `UploadPartsService.verifyFile` (per `phase-03-videos/TD-02`; Q-10; F-11; G-11):
   - o conjunto obrigatório são as partes `confirmed` e `unregistered` da classificação da SI-03.14;
   - parte obrigatória ausente → `UPLOAD_VERIFICATION_INCOMPLETE`;
   - parte sem checksum registrado → `INVALID_PART_NUMBER`;
   - checksum divergente → grava `file_mismatch_at` e responde `UPLOAD_FILE_MISMATCH`;
   - lista vazia é aceita quando o conjunto obrigatório está vazio
3. Criar a rota no `UploadSessionsController`, com `@HttpCode(200)`, `@Throttle` e OpenAPI para 200, 400, 401, 404, 409, 410 e 503

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `UploadPartsService.verifyFile` | Unit: conjunto obrigatório, lista vazia, parte sem checksum e divergência com bloqueio | `src/videos/upload-parts.verify.spec.ts` |
| `UploadPartsService.verifyFile` | Integration: um arquivo com 1 byte alterado numa parte confirmada bloqueia a sessão (`file_mismatch_at`) e impede assinar novas partes | `src/videos/upload-parts.verify.integration-spec.ts` |

Os cenários HTTP (E2E) da detecção ficam no spec gerado por `/plan-test-specs`. O fluxo E2E completo do T-06, com a conclusão bloqueada e o reinício explícito, fica no spec da SI-03.18.

**Dependencies:** SI-03.14

**Acceptance criteria:**

- Sem partes recebidas, `parts: []` retorna `200` com `{ "result": "match", "verifiedParts": 0 }`
- Com checksums iguais para todas as partes `confirmed` e `unregistered`, retorna `200` com `verifiedParts` igual ao tamanho do conjunto
- Faltando uma parte `confirmed`, retorna `400` `UPLOAD_VERIFICATION_INCOMPLETE`
- Um checksum diferente retorna `409` `UPLOAD_FILE_MISMATCH` e grava `file_mismatch_at`, e a partir daí `part-urls` também retorna `409` `UPLOAD_FILE_MISMATCH`. A conclusão bloqueada e o reinício são verificados nas SIs 03.16 e 03.18

---

### SI-03.16 — Endpoint completion (conclusão do upload, P2)

**Route:** POST /videos/:publicId/upload-sessions/:sessionId/completion
**Test Specs:** see `nestjs-project/specs/videos-upload-completion.plan.md`
**Authorization:** Owner (sessão vigente)

**Description:** Conclui o upload pelo protocolo P2, muda o vídeo para `processing` com a geração 1 e registra a publicação do job como ação pendente.

**Technical actions:**

1. Criar `src/videos/upload-completion.service.ts` com o passo 1 de P2, sob o `VideoLockService` (per `phase-03-videos/TD-02`; G-01, G-02, G-03):
   - claim `active → completing` com token e prazo, condicionado a `expires_at > now()` e a `file_mismatch_at IS NULL`;
   - retomada de `completing` vencido, com novo token;
   - `200` para sessão `completed` e vigente;
   - `409` ou `410` nos demais casos
2. Implementar o passo 2, fora da transação (per `phase-03-videos/TD-02`, AMB-4; G-04):
   - conferência pela classificação da SI-03.14: todas as partes `confirmed`, sem extras; senão, reversão `completing → active` pelo token, com `UPLOAD_INCOMPLETE` ou `UPLOAD_PART_MISMATCH`;
   - `CompleteMultipartUpload` montado pelo registro, com os guardas aprovados na V-10;
   - `NoSuchUpload` resolvido por `HeadObject` na chave da própria sessão
3. Implementar o passo 3, T2, numa única transação com as duas transições condicionadas (per `phase-03-videos/TD-12`):
   - sessão para `completed` pelo token;
   - vídeo `draft → processing` pelo `current_upload_session_id`;
   - gravação de `original_key`, `processing_run + 1`, `processing_dispatch = 1`, cerca nula, `processing_recoveries = 0` e a ação `publish` pendente
4. Implementar os passos 4 e 5 (P2; F-02):
   - R2 e R3 pelo `VideoJobDispatcher` depois do commit; uma falha no `add` não altera a resposta `202`;
   - releitura depois de zero linhas, conforme a tabela de P2, nunca respondendo `200` só por ter perdido o token
5. Criar a rota no controller, com `@HttpCode` `202` ou `200` conforme o caso, `@Throttle` e OpenAPI para 200, 202, 401, 404, 409, 410 e 503

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `UploadCompletionService` | Unit: claim, retomada, reversão e cada linha da tabela de releitura do passo 5 | `src/videos/upload-completion.service.spec.ts` |
| `UploadCompletionService` | Integration: Complete já feito pelo SDK antes da chamada (T-01); claim `completing` vencido retomado, com o concluidor antigo barrado pelo token e caindo na releitura (T-04); parte divergente e parte sem registro (T-07) | `src/videos/upload-completion.integration-spec.ts` |
| `UploadCompletionService` | Integration: publicação que falha depois do commit deixa a ação `publish` pendente, e o job da geração 1 não existe | `src/videos/upload-completion.publish.integration-spec.ts` |

Os cenários HTTP (E2E), inclusive o T-02 (duas conclusões em paralelo), ficam no spec gerado por `/plan-test-specs`.

**Dependencies:** SI-03.14, SI-03.11

**Acceptance criteria:**

- Com todas as partes confirmadas, a conclusão retorna `202` com `status: "processing"`, e o job `video-{videoId}-1-1` passa a existir na fila `video-processing`
- Repetir a chamada depois do sucesso retorna `200` com o estado atual do vídeo, sem criar outro job
- Com uma parte do plano sem ETag registrado, retorna `409` `UPLOAD_INCOMPLETE`, e a sessão volta a `active`
- Se o Complete já aconteceu no storage (`NoSuchUpload` e objeto com o tamanho declarado na chave da sessão), a chamada conclui com `202`
- Uma chamada que perde a posse para outra conclusão ainda em andamento retorna `409` `UPLOAD_SESSION_COMPLETING`, nunca `200`
- Com o Redis indisponível no momento da publicação, a resposta é `202`, e o vídeo fica em `processing` com `pending_job_action = 'publish'`
- O `original_key` gravado é sempre a `object_key` da sessão concluída
- Numa sessão bloqueada por conferência reprovada (`file_mismatch_at` preenchido), a conclusão retorna `409` `UPLOAD_FILE_MISMATCH`, sem transição e sem job

---

### SI-03.17 — Endpoint DELETE da sessão (abort)

**Route:** DELETE /videos/:publicId/upload-sessions/:sessionId
**Test Specs:** see `nestjs-project/specs/videos-upload-session-abort.plan.md`
**Authorization:** Owner

**Description:** Aborta a sessão de upload com claim por token e abort repetido até o storage confirmar.

**Technical actions:**

1. Implementar `UploadSessionsService.abortSession`, sob o `VideoLockService`, conforme o estado de origem (per `phase-03-videos/TD-02`; F-07):

   | Estado de origem | Conduta |
   |------------------|---------|
   | `active`, ou `initiating`/`aborting` com claim vencido | Passa a `aborting` com novo token |
   | `completing` | `UPLOAD_SESSION_COMPLETING` |
   | `initiating` com claim no prazo | `UPLOAD_SESSION_INITIATING` |
   | `completed` | `UPLOAD_SESSION_NOT_ACTIVE` |
   | `aborted` | Nada a fazer |

2. Fora da transação, fazer `AbortMultipartUpload` repetido até o `ListParts` responder `NoSuchUpload`, localizando os uploads por `upload_id` ou por `ListMultipartUploads` com prefixo `object_key`. Depois, marcar `aborted` condicionado ao token; sem confirmação, a sessão fica `aborting` para a varredura (F-09)
3. Criar a rota no controller, com `@HttpCode(204)`, `@Throttle` e OpenAPI para 204, 401, 404 e 409

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `UploadSessionsService.abortSession` | Unit: cada estado de origem | `src/videos/upload-sessions.abort.spec.ts` |
| `UploadSessionsService.abortSession` | Integration: abort seguido do envio de uma parte pela URL já assinada; a sessão só termina `aborted` depois do `NoSuchUpload` (T-05) | `src/videos/upload-sessions.abort.integration-spec.ts` |

Os cenários HTTP (E2E) ficam no spec gerado por `/plan-test-specs`.

**Dependencies:** SI-03.12

**Acceptance criteria:**

- O DELETE de uma sessão `active` retorna `204`, e o `ListParts` do upload passa a responder `NoSuchUpload`
- Repetir o DELETE numa sessão `aborted` retorna `204`
- O DELETE de uma sessão `completing` retorna `409` `UPLOAD_SESSION_COMPLETING`
- O vídeo continua em `draft` depois do abort

---

### SI-03.18 — Endpoint POST upload-sessions (reinício)

**Route:** POST /videos/:publicId/upload-sessions
**Test Specs:** see `nestjs-project/specs/videos-upload-session-restart.plan.md`
**Authorization:** Owner (vídeo em `draft`)

**Description:** Reinicia o upload de um rascunho com nova sessão e nova chave do original, serializado com conclusões e outros reinícios (P1).

**Technical actions:**

1. Implementar `UploadSessionsService.restartSession` (per `phase-03-videos/TD-02`, `phase-03-videos/TD-04`; Q-04):
   - mesmas regras de domínio da criação;
   - P1 com sessão anterior, sob o `VideoLockService`:

     | Sessão vigente | Conduta |
     |----------------|---------|
     | `completing` | 409 `UPLOAD_SESSION_COMPLETING` |
     | `initiating` com claim no prazo | 409 `UPLOAD_SESSION_INITIATING` |
     | `initiating` vencida, ou `active` | Passa a `aborting` com token |

   - em T1, nova sessão `initiating`, com o ponteiro e as declarações do vídeo atualizados
2. Implementar o storage e o T2 (P1):
   - `CreateMultipartUpload` da nova chave e abort da sessão anterior, como na SI-03.17;
   - ativação condicionada ao token;
   - T2 com zero linhas → abort do próprio upload e `UPLOAD_SESSION_NOT_ACTIVE`;
   - falha do storage → nova sessão em `aborted` e `STORAGE_UNAVAILABLE`
3. Criar a rota no controller, com `@HttpCode(201)`, `@Throttle`, OpenAPI para 201, 400, 401, 404, 409, 413, 415 e 503, reutilizando o `UploadDeclarationDto`

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `UploadSessionsService.restartSession` | Unit: cada estado da sessão vigente e do vídeo | `src/videos/upload-sessions.restart.spec.ts` |
| `UploadSessionsService.restartSession` | Integration com intercalação controlada (T-03): o teste envolve a chamada real de `StorageService.createMultipartUpload` com uma barreira (`jest.spyOn` que aguarda um sinal e repassa à implementação real), retendo o primeiro reinício depois de T1, com a sessão em `initiating`. Cobre: o segundo reinício durante a retenção; um reinício depois da ativação do primeiro; reinício e conclusão com o claim de cada um feito primeiro; rascunho com sessão expirada (Q-04) | `src/videos/upload-sessions.restart.integration-spec.ts` |

Os cenários HTTP (E2E), inclusive o fluxo completo do T-06, ficam no spec gerado por `/plan-test-specs`.

**Dependencies:** SI-03.15, SI-03.16, SI-03.17

**Acceptance criteria:**

- O reinício de um vídeo `draft` com sessão `active` retorna `201` com nova sessão e nova chave do original, e a sessão anterior termina `aborted`
- Com o primeiro reinício retido depois de T1 (nova sessão em `initiating`, claim no prazo), o segundo recebe `409` `UPLOAD_SESSION_INITIATING`; liberado, o primeiro retorna `201`, e só existe uma sessão `active`
- Um segundo reinício feito depois da ativação do primeiro é legítimo: retorna `201` com outra sessão, e a sessão criada pelo primeiro termina `aborted`
- Num reinício simultâneo com conclusão, exatamente um vence; o outro recebe `409` `UPLOAD_SESSION_COMPLETING` ou `409` `UPLOAD_SESSION_NOT_ACTIVE`
- Para um vídeo em `processing`, a rota retorna `409` `VIDEO_INVALID_STATE`
- Para um rascunho cuja sessão expirou, a rota retorna `201`
- Um rascunho deixado por uma ativação que perdeu a posse (sessão vigente em `aborting` ou `aborted`, P1) aceita reinício com `201`
- Depois de uma conferência reprovada (T-06), a conclusão continua bloqueada com `409` `UPLOAD_FILE_MISMATCH`, e o reinício explícito retorna `201` com uma nova sessão sem `file_mismatch_at`

---

### SI-03.19 — Endpoint GET /videos/:publicId (estado e metadados)

**Route:** GET /videos/:publicId
**Test Specs:** see `nestjs-project/specs/videos-get.plan.md`
**Authorization:** Owner

**Description:** Expõe o estado do vídeo, os metadados e a sessão vigente, para o acompanhamento por polling (Q-09).

**Technical actions:**

1. Criar `src/videos/videos.service.ts` com `getOwnVideo`: dono resolvido pelo canal do `sub`, com 404 para quem não é dono e para `publicId` malformado (per `phase-03-videos/TD-04`, `phase-03-videos/TD-05`; Q-02)
2. Criar o DTO de resposta do vídeo com os campos de "API Contracts → GET /videos/:publicId", inclusive `hasThumbnail` e a `uploadSession` vigente (per `phase-03-videos/TD-04`)
3. Criar a rota `GET /videos/:publicId` no `VideosController`, com `@Throttle` de 60 requisições a cada 60 s e OpenAPI para 200, 401 e 404

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideosService.getOwnVideo` | Integration: dono, não dono, `publicId` malformado e vídeo com sessão vigente | `src/videos/videos.service.integration-spec.ts` |

Os cenários HTTP (E2E) ficam no spec gerado por `/plan-test-specs`, com o vídeo em `error` preparado por fixture. O processamento real até `error` fica no spec da SI-03.28.

**Dependencies:** SI-03.12

**Acceptance criteria:**

- `GET /videos/{publicId}` feito pelo dono retorna `200` com `status`, metadados e a `uploadSession` vigente
- Feito por quem não é dono, ou com `publicId` malformado, retorna `404` `VIDEO_NOT_FOUND`
- Um vídeo em `error` vem com `errorCode` e `errorMessage` preenchidos
- 30 requisições do mesmo IP em 60 s não recebem `429`

---

### SI-03.20 — Worker: entrypoint, módulo e serviço video-worker

**Description:** Cria o processo do worker no mesmo código NestJS, com entrypoint próprio, serviço próprio no Compose e parada graciosa.

**Technical actions:**

1. Criar `src/worker.ts`, com `NestFactory.createApplicationContext(WorkerModule)` e `enableShutdownHooks`, e `src/worker/worker.module.ts`, com Config, TypeORM, `StorageModule`, `VideosModule`, `BullModule.forRootAsync` e `registerQueue('video-maintenance')` (per `phase-03-videos/TD-10`)
2. Criar os scripts `start:worker` e `start:worker:dev`, com saída de compilação separada em `dist-worker/`, para não disputar o `dist/` do `nestjs-api` em modo watch
3. Criar o serviço `video-worker` no `compose.yaml`, que sobe com `docker compose up` (Q-07, D-11):
   - mesma imagem do `nestjs-api`, com `init: true`;
   - `stop_grace_period` maior que o timeout de um job;
   - dependências saudáveis de `db`, `storage` e `redis`;
   - comando `start:worker:dev`
4. Implementar a parada graciosa: `worker.close()` no SIGTERM pelos hooks do Nest, e encerramento dos processos filhos do FFmpeg (per `phase-03-videos/TD-10`; `library-refs.md` → `bullmq`, "Parada graciosa")

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `WorkerModule` | Unit: compilation test | `src/worker/worker.module.spec.ts` |

**Dependencies:** SI-03.11, SI-03.6, SI-03.7

**Acceptance criteria:**

- `docker compose up -d` sobe o `video-worker` junto com a infraestrutura, e `docker compose ps` o mostra em execução
- `docker compose stop video-worker` termina dentro do `stop_grace_period`, sem deixar processos FFmpeg vivos
- O `nestjs-api` em modo watch e o `video-worker` não sobrescrevem a saída de compilação um do outro

---

### SI-03.21 — MediaProbeService: sondagem, validação de mídia e frame

**Description:** Encapsula o ffprobe e o ffmpeg sobre URL pré-assinada interna, com timeout garantido e a validação real de contêiner e codecs.

**Technical actions:**

1. Criar `src/worker/media/media-probe.service.ts`, que roda `ffprobe -print_format json -show_format -show_streams` sobre URL pré-assinada interna, com `-rw_timeout`, as opções de reconexão e um timeout por chamada que mata o processo, nos valores definidos pela V-04 (per `phase-03-videos/TD-10`, `phase-03-videos/TD-11`; G-09)
2. Validar a mídia (per `phase-03-videos/TD-11`, `phase-03-videos/TD-13`; Q-03):
   - o contêiner contra o `content_type`; um MP4 com `major_brand` `qt  ` é `MEDIA_CONTAINER_MISMATCH`;
   - os codecs contra a lista do "Error Catalog";
   - stream de vídeo obrigatório
3. Extrair um frame com `-ss` antes de `-i`, para um buffer JPEG (per `phase-03-videos/TD-11`)
4. Classificar os erros como permanentes (`MEDIA_INVALID`, `MEDIA_CONTAINER_MISMATCH` e `MEDIA_UNSUPPORTED_CODEC`) ou transitórios (timeout e storage)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `MediaProbeService` | Unit: leitura do JSON do ffprobe e regras de contêiner e codec | `src/worker/media/media-probe.service.spec.ts` |
| `MediaProbeService` | Integration, com FFmpeg, storage e as fixtures da SI-03.6: MP4 com `moov` no início e no fim, WebM, MOV recusado, arquivo inválido e MP4 truncado; uma URL que não entrega bytes termina por timeout (T-13) | `src/worker/media/media-probe.service.integration-spec.ts` |

**Dependencies:** SI-03.20

**Acceptance criteria:**

- A fixture MP4 com `moov` no fim é aceita, com duração, dimensões e codecs extraídos
- A fixture MOV é classificada como `MEDIA_CONTAINER_MISMATCH`, e a inválida como `MEDIA_INVALID`
- Uma URL que aceita a conexão e não envia bytes termina como erro transitório dentro do timeout configurado, sem deixar processo FFmpeg
- O frame extraído é um JPEG válido

---

### SI-03.22 — Processor de vídeo com tentativa vigente (P3)

**Description:** Processa o job `process-video`: assume a vigência pela cerca, extrai metadados e thumbnail e publica `ready` ou `error` só se continuar vigente.

**Technical actions:**

1. Criar `src/worker/processing/processing-state.service.ts` (per `phase-03-videos/TD-12`):
   - assume a vigência pela cerca de P3, com `dispatch` lido do `jobId` e `seq = job.attemptsStarted`;
   - publica `ready` com metadados e `thumbnail_key`, e grava `error`, sempre com a guarda de publicação de P3
2. Criar `src/worker/processing/video-processing.processor.ts` (`@Processor('video-processing', { concurrency })`) (per `phase-03-videos/TD-10`, `phase-03-videos/TD-11`, `phase-03-videos/TD-12`):
   - relê o vídeo e assume a vigência, ou termina sem efeitos (G-08);
   - sonda e extrai o frame pela SI-03.21;
   - grava `thumbnails/{videoId}/{attemptId}.jpg` e publica
3. Tratar os erros (P3; `library-refs.md` → `bullmq`, "Contadores, retenção e remoção"):
   - permanentes gravam `error` e lançam `UnrecoverableError`;
   - transitórios são relançados;
   - na última tentativa (`job.attemptsMade + 1 >= attempts`), grava antes `PROCESSING_FAILED`
4. Registrar `@OnWorkerEvent('stalled')` e `@OnWorkerEvent('failed')` com log estruturado

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `ProcessingStateService` | Unit: predicados de assunção e de publicação | `src/worker/processing/processing-state.service.spec.ts` |
| `VideoProcessingProcessor` | Integration: job para vídeo `ready` ou `error` sem FFmpeg e sem gravação (T-10); erro transitório seguido de sucesso, e erro permanente sem retentativa (T-14) | `src/worker/processing/video-processing.processor.integration-spec.ts` |
| `VideoProcessingProcessor` | Integration (T-11): duas execuções concorrentes da mesma execução; tentativa antiga terminando depois da atual; entrega de geração antiga, que não assume nem publica; banco e artefato referenciado conferidos | `src/worker/processing/video-processing.concurrency.integration-spec.ts` |

**Dependencies:** SI-03.21, SI-03.16

**Acceptance criteria:**

- Um vídeo em `processing` com job da geração corrente termina em `ready`, com `duration_seconds`, dimensões, codecs e `thumbnail_key` `thumbnails/{videoId}/{attemptId}.jpg` apontando para um objeto existente
- Com duas entregas concorrentes, só a tentativa vigente publica, e `thumbnail_key` aponta para o artefato dela
- Uma entrega de geração anterior a `processing_dispatch` não altera o banco
- Mídia inválida termina em `error` `MEDIA_INVALID`, sem retentativa
- Um erro transitório na primeira tentativa seguido de sucesso na segunda termina em `ready`
- Um job para vídeo já em `ready` termina sem executar o FFmpeg e sem gravar no storage

---

### SI-03.23 — Manutenção: fila e Job Schedulers

**Description:** Registra os Job Schedulers de manutenção com ids estáveis e o processor que despacha cada job para seu serviço, numa fila e com concorrência próprias.

**Technical actions:**

1. Criar `src/worker/maintenance/maintenance-scheduler.registrar.ts`, que faz `upsertJobScheduler` no bootstrap com os ids estáveis `upload-session-sweep`, `processing-reconciliation` e `storage-cleanup`, com `every` e lotes vindos da configuração (per `phase-03-videos/TD-12`; `library-refs.md` → `bullmq`, "Job Schedulers")
2. Criar `src/worker/maintenance/maintenance.processor.ts` (`@Processor('video-maintenance', { concurrency: 1 })`), que despacha por nome de job (`sweep-upload-sessions`, `reconcile-processing` e `cleanup-storage`) para os serviços das SIs 03.24 a 03.26 (per `phase-03-videos/TD-10`)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `MaintenanceSchedulerRegistrar` | Integration (Redis real): duas instâncias registrando os mesmos ids deixam um scheduler por id; o reinício reaproveita os schedulers | `src/worker/maintenance/maintenance-scheduler.registrar.integration-spec.ts` |
| `MaintenanceProcessor` | Unit: despacho por nome e nome desconhecido | `src/worker/maintenance/maintenance.processor.spec.ts` |

**Dependencies:** SI-03.20

**Acceptance criteria:**

- Depois do bootstrap de duas instâncias, a fila `video-maintenance` tem exatamente três schedulers, um por id
- Os jobs de manutenção rodam com concorrência 1, na fila `video-maintenance`, separada da `video-processing`
- Um job de manutenção com nome desconhecido é registrado como erro, sem efeito no banco

---

### SI-03.24 — Varredura de sessões de upload

**Description:** Aborta sessões vencidas e retoma claims vencidos de criação, conclusão e abort, com predicados complementares aos das rotas.

**Technical actions:**

1. Criar `src/worker/maintenance/upload-session-sweeper.service.ts`, que processa em lotes, sob o `VideoLockService`: claim de `active` vencida (`expires_at <= now()`) para `aborting`, seguido de abort repetido até `NoSuchUpload` e `aborted` pelo token (G-10, F-08, F-09)
2. Retomar `initiating` e `aborting` com claim vencido: nova posse, abort dos uploads com prefixo `object_key` e `aborted` (P1)
3. Retomar `completing` vencido pela SI-03.16 a partir do passo 2 de P2, com a releitura do passo 5 (G-02, F-01)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `UploadSessionSweeper` | Integration: conclusão concorrente com a varredura no limite da expiração (T-03); claim `completing` vencido retomado pela varredura (T-04); abort com parte em trânsito confirmado depois (T-05); sessão `initiating` órfã com multipart sem registro (P1) | `src/worker/maintenance/upload-session-sweeper.integration-spec.ts` |

**Dependencies:** SI-03.23, SI-03.16, SI-03.17, SI-03.18

**Acceptance criteria:**

- Uma sessão `active` com `expires_at` vencido termina `aborted`, e o `ListParts` responde `NoSuchUpload`
- Uma sessão `initiating` com claim vencido e multipart criado termina `aborted`, sem upload restante no prefixo da chave
- Com conclusão e varredura concorrentes no limite da expiração, só uma vence
- Rodar o mesmo lote duas vezes não muda o resultado

---

### SI-03.25 — Reconciliação do processamento e coleta de jobs (P5)

**Description:** Garante que todo vídeo em `processing` tenha um job vivo ou termine em `error` em tempo limitado, com recuperações por geração contadas e retomáveis.

**Technical actions:**

1. Criar `src/worker/maintenance/processing-reconciler.service.ts`, que segue a ordem de leituras de P5 (retrato → identidade do job → fila → escrita com G_R ou G_P), em lotes de vídeos em `processing` além da carência ou com ação pendente vencida (per `phase-03-videos/TD-12`)
2. Implementar R1: geração nova e recuperação contada para job ausente ou `completed` sem transição, até `PROCESSING_MAX_RECOVERIES`, com encerramento `PROCESSING_INCONSISTENT` no limite. R2 e R3 passam pelo `VideoJobDispatcher` (P5)
3. Implementar a retomada de ação pendente pela tabela de evidências de P5, reutilizando a geração reservada e sem nova contagem
4. Tratar os demais estados (G-05):
   - job `failed` → `error` `PROCESSING_STALLED` ou `PROCESSING_FAILED`, com G_R e a guarda de cerca;
   - `waiting`, `delayed` ou `prioritized` acima de `PROCESSING_STUCK_ALERT_MS` → alerta de log
5. Coletar jobs `completed` e `failed` só depois de confirmar no banco a execução terminal ou a geração superada (P5)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `ProcessingReconciler` | Unit: decisão por estado do job e por evidência de retomada | `src/worker/maintenance/processing-reconciler.service.spec.ts` |
| `ProcessingReconciler` | Integration: vídeo em `processing` sem job (T-08) e conduta por estado do job (T-09, cenário 1) | `src/worker/maintenance/processing-reconciler.states.integration-spec.ts` |
| `ProcessingReconciler` | Integration (T-09, cenários 2 a 7): concorrência, limite, ordem das leituras, falha entre banco e fila, retomada, executor atrasado e job removido de fora | `src/worker/maintenance/processing-reconciler.recovery.integration-spec.ts` |
| `ProcessingReconciler` | Integration: coleta de jobs (T-09, cenário 8); worker encerrado à força com `lockDuration` curto até `maxStalledCount`, terminando em `error` `PROCESSING_STALLED` (T-12) | `src/worker/maintenance/processing-reconciler.collect.integration-spec.ts` |

**Dependencies:** SI-03.23, SI-03.22

**Acceptance criteria:**

- Um vídeo em `processing` sem o job da geração corrente recebe uma geração nova, `processing_recoveries` sobe 1, e o job `video-{videoId}-{run}-{dispatch}` passa a existir
- Duas reconciliações concorrentes sobre o mesmo vídeo produzem uma única geração nova e um único job
- Com `processing_recoveries` igual a `PROCESSING_MAX_RECOVERIES`, o vídeo termina em `error` `PROCESSING_INCONSISTENT`, sem novo job
- Um job `failed` por stall termina o vídeo em `error` `PROCESSING_STALLED`, e o job só é removido depois que o banco mostra a execução terminal
- Na retomada de uma ação pendente cujo job já existe, só há confirmação: nenhum novo `add` e nenhuma recuperação contada
- O job da geração vigente de um vídeo em `processing` nunca é removido pela coleta

---

### SI-03.26 — Limpeza de objetos abandonados (P4)

**Description:** Remove originais, multiparts e derivados abandonados somente quando a elegibilidade é estável, sem tocar em objetos referenciados ou válidos.

**Technical actions:**

1. Criar `src/worker/maintenance/storage-cleaner.service.ts` para originais e multiparts em `originals/`, pelas regras de P4 (per `phase-03-videos/TD-06`):
   - sessão `aborted` não referenciada;
   - chave sem registro;
   - sessões `initiating` ou `aborting` vencidas, só depois da posse por token
2. Tratar os derivados em `thumbnails/{videoId}/` pelas regras de P4 (per `phase-03-videos/TD-06`, `phase-03-videos/TD-12`):

   | Estado do vídeo | Chaves elegíveis |
   |-----------------|------------------|
   | `ready` | As diferentes de `thumbnail_key` |
   | `error` | Todas |
   | `processing` | Só as de tentativas diferentes da vigente |
   | Sem tentativa vigente | Nenhuma |

3. Aplicar a carência `STORAGE_CLEANUP_GRACE_MS` e a releitura imediatamente antes de excluir, como margem adicional, em lotes de `MAINTENANCE_BATCH_SIZE`

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `StorageCleaner` | Unit: tabela de elegibilidade de P4 | `src/worker/maintenance/storage-cleaner.service.spec.ts` |
| `StorageCleaner` | Integration: objetos referenciados nunca removidos; thumbnails de tentativa obsoleta e de vídeo em `error` removidas; multipart sem registro abortado; repetição sem efeito | `src/worker/maintenance/storage-cleaner.integration-spec.ts` |

**Dependencies:** SI-03.23, SI-03.22, SI-03.18

**Acceptance criteria:**

- Um objeto referenciado por `original_key` ou por `thumbnail_key` nunca é removido
- A thumbnail de uma tentativa obsoleta de um vídeo `ready` é removida depois da carência
- O original de uma sessão `aborted` é removido; o de uma sessão `active`, não
- Um multipart em `originals/` sem linha de sessão é abortado
- Duas execuções seguidas da limpeza não removem nada a mais na segunda

---

### SI-03.27 — Endpoint GET playback-url (streaming)

**Route:** GET /videos/:publicId/playback-url
**Test Specs:** see `nestjs-project/specs/videos-playback-url.plan.md`
**Authorization:** Owner (vídeo em `ready`)

**Description:** Emite uma URL pré-assinada de curta duração para reprodução por download progressivo com requisições parciais.

**Technical actions:**

1. Implementar `VideosService.getPlaybackUrl` (per `phase-03-videos/TD-13`, `phase-03-videos/TD-14`):
   - dono, com 404 para quem não é;
   - vídeo em `ready`, senão `VIDEO_NOT_READY`;
   - `presignGet` do `original_key` no endpoint público, com `ResponseContentType` e `PLAYBACK_URL_TTL_SECONDS`
2. Criar o DTO de resposta (`url`, `contentType` e `expiresAt`) e a rota no `VideosController`, com `@Throttle` e OpenAPI para 200, 401, 404 e 409

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideosService.getPlaybackUrl` | Integration (storage real, vídeo válido da SI-03.6): dono, não dono e vídeo não pronto; a URL responde `206` com `Content-Range` a uma requisição `Range` (AMB-1) | `src/videos/videos.playback.integration-spec.ts` |

Os cenários HTTP (E2E) ficam no spec gerado por `/plan-test-specs`, inclusive o estado `processing` com a fila pausada e o processamento real até `ready`.

**Dependencies:** SI-03.19, SI-03.22

**Acceptance criteria:**

- Para um vídeo `ready`, a rota retorna `200` com `contentType` igual ao do vídeo e `expiresAt` dentro do prazo configurado
- A URL devolvida responde `206 Partial Content` com `Content-Range` a `Range: bytes=0-1023`
- Um vídeo em `processing` retorna `409` `VIDEO_NOT_READY`, e quem não é dono recebe `404`
- A reprodução e o seek em navegador (V-05) ficam para a Fase 05 e não são critério de aceite desta SI

---

### SI-03.28 — Endpoint GET download-url

**Route:** GET /videos/:publicId/download-url
**Test Specs:** see `nestjs-project/specs/videos-download-url.plan.md`
**Authorization:** Owner (vídeo em `ready`)

**Description:** Emite uma URL pré-assinada para baixar o original como anexo.

**Technical actions:**

1. Implementar `VideosService.getDownloadUrl` com as mesmas regras de dono e de estado, usando `presignGet` com `ResponseContentDisposition` `attachment`, `filename*` em UTF-8 derivado de `original_filename` (RFC 6266) e `DOWNLOAD_URL_TTL_SECONDS` (per `phase-03-videos/TD-14`)
2. Criar o DTO de resposta e a rota, com `@Throttle` e OpenAPI para 200, 401, 404 e 409

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideosService.getDownloadUrl` | Integration: o download completo pela URL traz os mesmos bytes do original e `Content-Disposition: attachment`; nome de arquivo com caracteres não ASCII | `src/videos/videos.download.integration-spec.ts` |

Os cenários HTTP (E2E) ficam no spec gerado por `/plan-test-specs`, inclusive o processamento real até `ready` e até `error`.

**Dependencies:** SI-03.27

**Acceptance criteria:**

- Para um vídeo `ready`, a rota retorna `200` com `url` e `expiresAt`
- O download pela URL devolve exatamente os bytes do original, com o mesmo SHA-256, e `Content-Disposition: attachment`
- Um nome de arquivo com acentos chega preservado em `filename*`
- Um vídeo fora de `ready` retorna `409` `VIDEO_NOT_READY`

---

### SI-03.29 — Contrato OpenAPI e sincronização com o next-frontend

**Description:** Regenera o contrato exportado do backend e sincroniza a cópia e os tipos do frontend como manutenção do contrato, sem funcionalidade de frontend (IC-4).

**Technical actions:**

1. Regenerar `nestjs-project/openapi.json` com `docker compose exec nestjs-api npm run openapi:export` e conferir os endpoints de vídeo, os DTOs e uma resposta para cada status (`openapi-docs-nestjs/TD-02`)
2. Rodar `scripts/sync-openapi.sh` no host e, em seguida, `docker compose exec next-frontend npm run openapi:types`, para regenerar `next-frontend/lib/api/types.gen.ts` (`next-frontend-openapi-typing/TD-02`, `next-frontend-openapi-typing/TD-03`)
3. Verificar `npx tsc --noEmit` e `npm run lint` no container `next-frontend`, sem alterar nenhum outro arquivo do frontend

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| Export do `openapi.json` | Integration: o export contém as rotas de vídeo e os esquemas de erro | `src/openapi-export.integration-spec.ts` |

**Dependencies:** SI-03.12, SI-03.13, SI-03.14, SI-03.15, SI-03.16, SI-03.17, SI-03.18, SI-03.19, SI-03.27, SI-03.28

**Acceptance criteria:**

- `nestjs-project/openapi.json` e `next-frontend/openapi.json` ficam idênticos depois da sincronização
- O `types.gen.ts` regenerado contém os caminhos `/videos` e `/videos/{publicId}/upload-sessions/{sessionId}/part-urls`
- O type-check e o lint do `next-frontend` passam, e apenas `next-frontend/openapi.json` e `types.gen.ts` mudam no frontend
- A verificação de atualização do contrato do CI (`.github/workflows/openapi-freshness.yml`) passa

---

### SI-03.30 — Documentação da fase

**Description:** Atualiza diagrama, guias de agente e READMEs conforme os entregáveis de documentação da fase.

**Technical actions:**

1. Atualizar `docs/diagrams/software-arch.mermaid` (D-09; per `phase-03-videos/TD-09`):
   - fila definida como BullMQ + Redis;
   - `frontend → storage` como "envia partes / faz streaming";
   - `api → storage` como "orquestra e assina"
2. Atualizar o `CLAUDE.md` raiz (D-01 a D-03 e serviços novos) e o `nestjs-project/CLAUDE.md` (D-04; Q-07, D-11):
   - serviços `storage`, `redis` e `video-worker`;
   - verificações de prontidão de storage e Redis;
   - a exceção de que o `video-worker` sobe com `docker compose up`
3. Atualizar o `nestjs-project/README.md`:
   - como subir o ambiente e rodar as provas de `proofs/` e onde ficam os relatórios;
   - a verificação manual do T-12 com `docker compose kill video-worker`;
   - como rodar as provas grandes da TD-15
4. Registrar no `nestjs-project/README.md` as versões efetivamente validadas de Node, FFmpeg e ffprobe e a regra de repetir a V-04 e a prova do fluxo completo quando a imagem mudar (DG-1)

**Tests:** _(empty — documentação)_

**Dependencies:** SI-03.20, SI-03.29

**Acceptance criteria:**

- O diagrama C4 nomeia a fila como BullMQ + Redis e mostra os bytes indo do frontend direto ao storage
- O `nestjs-project/CLAUDE.md` traz os comandos de prontidão de `storage` e de `redis` e registra a exceção do `video-worker`
- O README descreve como rodar cada prova e onde ficam os relatórios
- O guia de testes (`testing-guide-nestjs-project`) não é alterado (IC-3)

---

### SI-03.31 — Prova V-07: tempo e disco das provas grandes, com cliente e sonda de prova

**Description:** Cria o cliente de prova e a sonda de latência e mede tempo e disco num upload real de 1.000.000.000 bytes, para agendar a prova grande. É passo bloqueante só para esse agendamento.

**Technical actions:**

1. Criar `proofs/phase-03/upload-client.ts`, um cliente de prova que reproduz o contrato do futuro cliente (per `phase-03-videos/TD-01`, `phase-03-videos/TD-02`):
   - fatias de `expectedSize` com SHA-256 por parte;
   - `part-urls` em lotes e PUT com 4 partes em paralelo;
   - registro de ETags;
   - interrupção por sinal e retomada com o GET da sessão e `file-verifications`;
   - conclusão e polling;
   - renovação do access token por `POST /auth/refresh` antes de expirar (o token vale 15 min, menos que um upload grande)
2. Criar `proofs/phase-03/responsiveness-probe.ts`, a sonda de latência definida na SI-03.33, que grava um CSV com instante, status e latência de cada requisição
3. Medir no WSL2 um upload real de 1.000.000.000 bytes pelo fluxo completo:
   - throughput, tempo de cálculo dos checksums e tempo do Complete;
   - pico de disco no volume do storage, inclusive durante o Complete;
   - espaço livre no host.

   Projetar os números para 10.000.000.000 bytes, com margem de 30%
4. Registrar `docs/phases/phase-03-videos/proofs/V-07.md` com as medidas, a projeção, a janela recomendada e o espaço livre exigido. Registrar também que o CI do repositório não executa provas grandes; ele só verifica o contrato OpenAPI

**Tests:** _(empty — prova de viabilidade; o relatório é o entregável)_

**Dependencies:** SI-03.15, SI-03.16, SI-03.19, SI-03.22

**Acceptance criteria:**

- `V-07.md` registra o throughput, os tempos e o pico de disco medidos com 1.000.000.000 bytes
- O relatório projeta tempo e disco para 10.000.000.000 bytes e diz se o ambiente atual comporta a prova grande
- O cliente de prova, interrompido no meio, retoma e conclui sem reenviar partes `confirmed`

---

### SI-03.32 — Prova documentada do fluxo completo com vídeo válido até ready

**Description:** Prova, com um vídeo válido sem preenchimento artificial, o caminho inteiro: upload, processamento, thumbnail, reprodução por requisição parcial e download.

**Technical actions:**

1. Gerar com o FFmpeg da imagem um MP4 H.264/AAC válido, com alguns minutos de duração e sem preenchimento artificial, e registrar o tamanho e o SHA-256 dele (per `phase-03-videos/TD-15`, AMB-2)
2. Enviar o vídeo pelo cliente de prova até `202`, acompanhar por polling até `ready` e conferir duração, dimensões, codecs e a existência do objeto em `thumbnail_key`
3. Obter a `playback-url` e conferir a resposta `206` com `Content-Range`; obter a `download-url` e conferir o SHA-256 do download (AMB-1)
4. Registrar `docs/phases/phase-03-videos/proofs/P-fluxo-completo.md` com versões, tempos e evidências

**Tests:** _(empty — prova documentada; o relatório é o entregável)_

**Dependencies:** SI-03.27, SI-03.28, SI-03.31

**Acceptance criteria:**

- O vídeo enviado chega a `ready` com metadados preenchidos e thumbnail existente no storage
- A URL de reprodução responde `206` a uma requisição parcial, e o download tem o mesmo SHA-256 do arquivo enviado
- O relatório registra o resultado (`aprovada` ou `reprovada`) e as versões usadas

---

### SI-03.33 — Prova documentada de 10 GB com medição de responsividade da API

**Description:** Prova o upload real de 10.000.000.000 bytes, com interrupção e retomada, medindo a responsividade da API com critérios numéricos fixados antes da execução (R-02, R-03).

**Technical actions:**

1. Fixar no relatório, antes de executar, o cenário de medição:
   - **sonda:** `GET /videos/:publicId` de um vídeo de controle em `draft`, autenticada como o dono desse vídeo, um usuário de prova distinto do usuário que faz o upload.
     - Cada instância da sonda roda num container próprio, com IP distinto do cliente de upload, a cada 2 s (0,5 req/s, dentro do limite da rota por IP) e com timeout de 5 s.
     - O access token é renovado por `POST /auth/refresh` antes de expirar; as renovações não entram nas amostras;
   - **fase de base:** 10 min sem upload, com o mesmo número de instâncias da fase de carga;
   - **fase de carga:** só os intervalos com o cliente de upload ativo, do primeiro `part-urls` à interrupção e da retomada à resposta `202`. O intervalo entre a interrupção e o reinício do cliente fica fora dos percentis;
   - **amostras:** no mínimo 300 por fase;
   - **dimensionamento prévio:** com a duração `D`, em segundos, que a V-07 projeta para a fase de carga, usar `N = ceil(600 / D)` instâncias da sonda, já que 300 amostras a cada 2 s somam 600 segundos de sonda. O ritmo de cada instância não aumenta;
   - **carga mais curta que o previsto:** se a fase de carga ainda produzir menos de 300 amostras, o veredito dos critérios (a) e (b) é `inconclusivo`, nunca `aprovada`, e a prova é repetida com `N` recalculado pela duração medida. Períodos ociosos nunca entram nos percentis de carga. O critério (c) vale para todas as amostras coletadas, inclusive numa execução inconclusiva
2. Fixar no relatório, também antes de executar, os critérios de aprovação:
   - (a) p95 de carga ≤ max(1,5 × p95 de base; p95 de base + 50 ms);
   - (b) p95 de carga ≤ 250 ms e p99 de carga ≤ 500 ms;
   - (c) zero respostas fora de 2xx, zero `429` e zero timeouts.

   Os critérios não são ajustados depois de ver os números. Justificativa:
   - a API não transporta bytes (R-02, TD-01), então as rotas de controle não podem degradar além do ruído do ambiente;
   - a margem de 1,5× ou +50 ms absorve o ruído de agendamento do WSL2 e do Docker;
   - 250 ms no p95 fica bem abaixo de 1 s, o limite para resposta interativa, e do intervalo de 2 s do polling;
   - qualquer 5xx ou timeout indica bloqueio
3. Executar a prova na janela e com o disco definidos pela V-07:
   - arquivo sintético de exatamente 10.000.000.000 bytes, declarado `video/mp4`;
   - 4 partes em paralelo;
   - interrupção do cliente por volta de 50% e retomada com o GET da sessão e `file-verifications` de todas as partes recebidas, até `202`
4. Registrar `docs/phases/phase-03-videos/proofs/P-10GB.md`:
   - por fase: p50, p95, p99, máximo, erros e `429`;
   - throughput, tempos e pico de disco;
   - o processamento do conteúdo sintético termina em `error` `MEDIA_INVALID`, o resultado esperado;
   - ao final, remoção do objeto e das linhas da prova pelo procedimento documentado

**Tests:** _(empty — prova documentada; o relatório é o entregável)_

**Dependencies:** SI-03.31, SI-03.32

**Acceptance criteria:**

- O upload de 10.000.000.000 bytes é aceito em 150 partes, a última com 779.264 bytes, e concluído com `202` depois da retomada
- A retomada não reenvia partes `confirmed`, e a conferência cobre todas as partes recebidas
- O relatório traz as métricas das duas fases e o veredito de cada critério, fixados antes da execução
- A sonda autentica como o dono do vídeo de controle, um usuário distinto do que faz o upload, e nenhuma amostra de carga vem de intervalo sem upload ativo
- Com menos de 300 amostras de carga, o veredito de latência é `inconclusivo`, e o critério (c) continua valendo para as amostras coletadas
- Com resultado `reprovada`, o relatório registra o critério violado e o requisito afetado (R-02), sem flexibilizar o critério
- O disco usado pela prova é liberado ao final

---

## Technical Specifications

### Data Model

_Fontes: `phase-03-videos/TD-02`, `TD-04`, `TD-05`, `TD-06` e `TD-12` (decisões e revisões vigentes) e a seção "Consequências → Persistência, configuração e migrations" do documento de decisões. Convenções herdadas: PK UUID (`uuid_generate_v4()`), Data Mapper, migrations imutáveis geradas pelo CLI, `synchronize: false`. Colunas `bigint` usam transformer para `number`, porque o TypeORM as devolve como string e todos os valores desta fase ficam abaixo de 2^53. As transições de estado seguem os protocolos P1 a P5 de "Coordenação e fencing", no fim desta subseção._

#### Video

Tabela `videos`.

| Field | Type | Constraints |
|-------|------|-------------|
| id | uuid | PK, `uuid_generate_v4()`. Identidade interna; compõe as chaves do storage (TD-05, TD-06) |
| public_id | varchar(11) | unique, not null. 8 bytes de `node:crypto` em base64url, com retentativa em colisão (TD-05) |
| channel_id | uuid | not null, FK → `channels.id` (ON DELETE RESTRICT; a exclusão de vídeos fica para a Fase 04) |
| status | enum `videos_status_enum` (`draft`, `processing`, `ready`, `error`) | not null, default `draft` (TD-04) |
| original_filename | varchar(255) | not null. Nome do arquivo declarado ao iniciar ou reiniciar o upload |
| content_type | varchar(32) | not null. `video/mp4` ou `video/webm` (Q-03); outros valores são recusados no service com 415 |
| size_bytes | bigint | not null, check `size_bytes > 0`. Tamanho declarado, ≤ `VIDEO_MAX_SIZE_BYTES` (TD-03) |
| current_upload_session_id | uuid | nullable, FK → `upload_sessions.id` (ON DELETE SET NULL). Sessão vigente do vídeo; só muda no passo T1 de P1 |
| original_key | varchar(255) | nullable. Chave do original confirmado, gravada só na finalização de P2; imutável depois (TD-02, TD-12) |
| processing_run | integer | not null, default 0. Incrementado em cada `draft → processing` (TD-12) |
| processing_started_at | timestamptz | nullable. Início da execução corrente; base da carência da reconciliação |
| processing_dispatch | integer | not null, default 0. Geração do job da execução corrente: 1 na finalização de P2 e +1 a cada reserva de recuperação (R1 de P5, por job ausente ou `completed` sem transição). Compõe o `jobId` e o token de ordem de P3 |
| current_attempt_id | uuid | nullable. Tentativa que detém a vigência agora (P3). Volta a `NULL` quando uma recuperação a revoga (P5). Só é válida enquanto `status = 'processing'`, na mesma execução e geração; em `ready` ou `error` é residual e não protege nenhum objeto (P4) |
| attempt_fence_dispatch | integer | nullable. Geração do maior token de tentativa já aceito na execução corrente (P3); só avança. Volta a `NULL` só a cada nova execução |
| attempt_fence_seq | integer | nullable. `job.attemptsStarted` do maior token já aceito (P3); só avança dentro da mesma geração. Volta a `NULL` só a cada nova execução |
| processing_recoveries | integer | not null, default 0. Recuperações da execução corrente, cada uma com geração nova reservada por R1 de P5, limitadas por `PROCESSING_MAX_RECOVERIES`. Retomadas de ação pendente não contam. Volta a 0 a cada nova execução |
| pending_job_action | enum `videos_pending_job_action_enum` (`publish`, `republish`) | nullable. Ação de fila registrada no banco e ainda não confirmada (P2, P5). Não existe ação de `retry` (revisão de 2026-11-17 da TD-12) |
| pending_job_dispatch | integer | nullable. Geração reservada pela ação pendente. O executor e a retomada usam esta geração, nunca a `processing_dispatch` relida (P5) |
| pending_job_token | uuid | nullable. Token de posse da ação pendente |
| pending_job_expires_at | timestamptz | nullable. Prazo da posse: momento do claim + `PROCESSING_JOB_ACTION_TTL_SECONDS`; vencido, a reconciliação assume |
| thumbnail_key | varchar(255) | nullable. Thumbnail publicada, gravada no mesmo `UPDATE` que confirma `ready` (TD-06, TD-12) |
| duration_seconds | numeric(12,3) | nullable |
| width | integer | nullable |
| height | integer | nullable |
| media_format | varchar(100) | nullable. `format_name` do ffprobe |
| video_codec | varchar(32) | nullable |
| audio_codec | varchar(32) | nullable. Null quando não há stream de áudio |
| error_code | varchar(64) | nullable. Código persistido (ver "Error Catalog → Códigos persistidos") |
| error_message | text | nullable |
| created_at | timestamptz | default now() |
| updated_at | timestamptz | default now(), atualizado a cada escrita |

**Relations:** `Channel` has many `Video` (one-to-many; o lado inverso é adicionado em `Channel` sem mudar a tabela `channels`). `Video` has many `UploadSession` (one-to-many). `Video` belongs to its current `UploadSession` (many-to-one opcional via `current_upload_session_id`).
**Indexes:** unique em `public_id`; índice em `channel_id`; índice em (`status`, `processing_started_at`) para a reconciliação; índice parcial em `pending_job_expires_at` `WHERE pending_job_action IS NOT NULL`.

#### UploadSession

Tabela `upload_sessions`.

| Field | Type | Constraints |
|-------|------|-------------|
| id | uuid | PK. `sessionId`, gerado no servidor no passo T1 de P1, antes de qualquer chamada ao storage |
| video_id | uuid | not null, FK → `videos.id` (ON DELETE CASCADE) |
| object_key | varchar(255) | not null, unique. `originals/{videoId}/{sessionId}`, gravada em T1, antes do `CreateMultipartUpload`; nunca reutilizada entre sessões (TD-02, TD-06) |
| upload_id | text | nullable. `UploadId` devolvido pelo `CreateMultipartUpload`; nulo enquanto a sessão está em `initiating` |
| status | enum `upload_sessions_status_enum` (`initiating`, `active`, `completing`, `completed`, `aborting`, `aborted`) | not null, default `initiating`. O estado `initiating` refina a proposta da TD-02, cujos nomes a própria TD deixa para o planejamento |
| size_bytes | bigint | not null. Tamanho declarado para esta sessão |
| part_size | integer | not null. `UPLOAD_PART_SIZE_BYTES` vigente na criação (67108864) |
| part_count | integer | not null. `ceil(size_bytes / part_size)`, sempre ≥ 1; 150 para 10.000.000.000 bytes |
| checksum_algorithm | varchar(16) | not null, default `SHA256` (V-09) |
| expires_at | timestamptz | not null. Em `initiating`, igual a `claim_expires_at`. Na ativação (T2 de P1), passa a ativação + `UPLOAD_SESSION_TTL` (24h; Q-08, condicionado à V-01) |
| claim_token | uuid | nullable. Token de fencing do claim corrente (`initiating`, `completing` ou `aborting`); um novo token é gerado a cada tomada de posse |
| claim_expires_at | timestamptz | nullable. Prazo do claim: momento do claim + `UPLOAD_SESSION_CLAIM_TTL_SECONDS` (G-02) |
| file_mismatch_at | timestamptz | nullable. A conferência de arquivo falhou, ou uma parte foi reassinada com outro checksum (F-11); a sessão deixa de assinar partes e não pode ser concluída |
| created_at | timestamptz | default now() |
| updated_at | timestamptz | default now(). Base da carência da limpeza de sessões terminais |

**Relations:** `UploadSession` belongs to `Video` (many-to-one); `UploadSession` has many `UploadPart` (one-to-many).
**Indexes:** unique em `object_key`; índice em (`status`, `expires_at`) para a varredura; índice em (`status`, `claim_expires_at`) para a retomada de claims; unique parcial em (`video_id`) `WHERE status = 'active'`. Este último é só defesa adicional contra bugs: não coordena reinícios nem conclusões concorrentes, porque uma sessão em `initiating`, `completing` ou `aborting` fica fora dele. A exclusão mútua real vem de P1 e P2.

#### UploadPart

Tabela `upload_parts`.

| Field | Type | Constraints |
|-------|------|-------------|
| id | uuid | PK, `uuid_generate_v4()` |
| upload_session_id | uuid | not null, FK → `upload_sessions.id` (ON DELETE CASCADE) |
| part_number | integer | not null, check `part_number >= 1`; ≤ `part_count` validado no service |
| expected_size | integer | not null. `min(part_size, size_bytes - (part_number - 1) * part_size)` |
| checksum_sha256 | char(44) | not null, imutável depois de gravado. SHA-256 declarado da parte, em base64 com padding (formato de `x-amz-checksum-sha256`; V-09) |
| etag | varchar(255) | nullable. ETag informado pelo cliente depois do PUT |
| etag_registered_at | timestamptz | nullable |
| created_at | timestamptz | default now() |
| updated_at | timestamptz | default now() |

**Relations:** `UploadPart` belongs to `UploadSession` (many-to-one).
**Indexes:** unique em (`upload_session_id`, `part_number`).
**Tamanho esperado:** como `part_count = ceil(size_bytes / part_size)`, toda parte tem pelo menos 1 byte. Um arquivo múltiplo exato de `part_size` termina numa parte de `part_size` bytes, nunca numa parte vazia. Por exemplo, 134217728 bytes geram 2 partes de 67108864. Já 10.000.000.000 bytes geram 150 partes, e a última tem 779.264 bytes.
**Registro:** a linha nasce no pedido de assinatura, com o checksum declarado. Um novo pedido para a mesma parte com outro checksum é recusado com `UPLOAD_FILE_MISMATCH` e bloqueia a sessão (`file_mismatch_at`), como a conferência reprovada (F-11). O ETag é gravado no registro em lote e pode ser substituído por um reenvio da mesma parte; a conferência da conclusão compara o registro com o `ListParts` (G-04).

#### Coordenação e fencing

Regras comuns a P1–P5:
- **Ponto de serialização:** a linha do vídeo. Toda operação que cria, troca, reivindica, finaliza ou aborta uma sessão abre uma transação curta com `SELECT … FROM videos WHERE id = :id FOR UPDATE`, aplica transições condicionais e faz commit.
- **Storage fora do banco:** nenhuma chamada ao storage acontece com transação aberta (G-01). Cada operação alterna transação curta, chamada ao storage e nova transação curta.
- **Transições:** toda transição é um `UPDATE … WHERE` com o estado de origem e o token esperado. Zero linhas afetadas significa que outra operação venceu; é um desfecho previsto, não um erro interno.
- **Tokens de fencing:** `upload_sessions.claim_token`, para os claims de criação, conclusão e abort; o par (`processing_dispatch`, `job.attemptsStarted`) com a cerca `attempt_fence_*`, para as tentativas do worker (P3); e `videos.pending_job_token`, para as ações de fila (P2, P5).
- **Leituras sem bloqueio:** assinatura de partes, registro de ETags e consultas leem sem bloqueio. Uma assinatura que corre junto com um reinício só produz URLs para uma sessão já em `aborting`; as partes enviadas a ela são descartadas pelo abort repetido (F-09) e nunca entram num Complete.

##### P1 — Criação e reinício de sessão

A intenção é registrada no banco antes do storage. Vale para `POST /videos` (sem sessão anterior) e `POST /videos/:publicId/upload-sessions` (reinício).

1. **T1 — intenção (transação curta, com o vídeo bloqueado).**
   - `POST /videos`: insere o vídeo em `draft` no canal do usuário.
   - Reinício: exige o vídeo em `draft` (senão 409 `VIDEO_INVALID_STATE`) e examina a sessão vigente `C`:
     - `completing`, com qualquer prazo → 409 `UPLOAD_SESSION_COMPLETING` (F-07);
     - `initiating` com claim no prazo → 409 `UPLOAD_SESSION_INITIATING`;
     - `initiating` com claim vencido, ou `active` → `C` passa a `aborting`, com novo `claim_token` e novo prazo;
     - `aborting`, `aborted` ou nula → segue.
   - Nos dois casos, insere a sessão `S` em `initiating`, com `id` e `object_key` gerados no servidor, `claim_token` e `claim_expires_at`, e com `upload_id` nulo. Aponta `videos.current_upload_session_id` para `S`, grava nome, tamanho e tipo declarados e faz commit.
2. **Storage (sem transação).**
   - `CreateMultipartUpload` em `S.object_key`, com `ChecksumAlgorithm` `SHA256`.
   - Para a `C` reivindicada em T1: `AbortMultipartUpload` repetido até o `ListParts` responder `NoSuchUpload`. Se `C.upload_id` for nulo, os uploads são localizados por `ListMultipartUploads` com prefixo `C.object_key`. Depois, `C` passa de `aborting` a `aborted`, condicionado ao token. Se uma parte em trânsito impedir a confirmação (F-09), `C` fica em `aborting` para a varredura.
3. **T2 — ativação.** `UPDATE upload_sessions SET status = 'active', upload_id = :uploadId, expires_at = now() + UPLOAD_SESSION_TTL, claim_token = NULL, claim_expires_at = NULL WHERE id = :S AND status = 'initiating' AND claim_token = :token`.
   - Uma linha → commit e resposta 201.
   - Zero linhas: a varredura ou outro reinício assumiu `S` depois do prazo. O processo aborta o próprio `uploadId` e responde 409 `UPLOAD_SESSION_NOT_ACTIVE` no reinício, ou 503 `STORAGE_UNAVAILABLE` em `POST /videos`. Neste último caso, o vídeo criado fica em `draft`, sem sessão utilizável e reiniciável.

Concorrência:
- **Dois reinícios simultâneos:** o segundo espera o bloqueio do vídeo. Depois do commit de T1 do primeiro, ele encontra `S1` em `initiating` com claim no prazo e recebe 409 `UPLOAD_SESSION_INITIATING`. Se chegar depois da ativação de `S1`, é um reinício legítimo de `S1`. O ponteiro muda só em T1, sob o bloqueio, então duas sessões nunca são criadas em paralelo para o mesmo vídeo.
- **Reinício e conclusão simultâneos:** os dois fazem o claim sob o mesmo bloqueio. A conclusão só reivindica a sessão vigente em `active`, e o reinício recusa `completing`. Se a conclusão chega primeiro, o reinício recebe 409 `UPLOAD_SESSION_COMPLETING`; se o reinício chega primeiro, a conclusão recebe 409 `UPLOAD_SESSION_NOT_ACTIVE`, porque `C` já está em `aborting`.

Recuperação quando o multipart existe e o registro falha:
- **`CreateMultipartUpload` falha ou excede o tempo:**
  - Em `POST /videos`, uma transação de compensação apaga a sessão e o vídeo, se `S` ainda estiver em `initiating` com o mesmo token, e a resposta é 503. Se o multipart chegou a ser criado e a resposta se perdeu, sua chave fica sem linha no banco e P4 o remove.
  - No reinício, `S` passa de `initiating` a `aborted`, condicionado ao token. O vídeo continua em `draft`, reiniciável (Q-04), e a resposta é 503.
- **T2 falha depois de o multipart existir, ou o processo morre entre os passos:**
  - O processo tenta abortar o `uploadId`, sem garantia. `S` fica em `initiating`.
  - Vencido o claim, a varredura assume `S` (`initiating → aborting` com novo token), aborta os uploads de `ListMultipartUploads` com prefixo `S.object_key` e marca `aborted`.
  - Um T2 atrasado do criador falha pelo token, e ele aborta o próprio upload.
- **Por que não sobra upload sem registro:** como a linha da sessão, com a chave, é gravada antes do storage, um upload no storage sem linha correspondente só existe depois da compensação, quando o criador já desistiu.

##### P2 — Conclusão

1. **T1 — claim (vídeo bloqueado).** Exige que a sessão seja a vigente do vídeo.
   - `active → completing` com novo `claim_token` e prazo, condicionado a `expires_at > now()` e a `file_mismatch_at IS NULL`.
   - `completing` com claim vencido → nova posse, com novo token, para retomar (G-02).
   - `completing` com claim no prazo → 409 `UPLOAD_SESSION_COMPLETING` (F-06).
   - `completed`, com o vídeo apontando para a sessão → 200 com o estado atual do vídeo (G-03).
   - `active` vencida → 410 `UPLOAD_SESSION_EXPIRED`. A varredura reivindica com o predicado complementar `expires_at <= now()`, então a conclusão e a varredura nunca vencem juntas (F-08).
2. **Storage (sem transação).**
   - Conferência: o `ListParts` paginado é comparado com o registro. Toda parte do plano precisa ter ETag registrado e ETag, checksum e tamanho iguais aos do storage, sem partes extras (G-04). Se falhar, a sessão volta de `completing` a `active`, condicionada ao token, com 409 `UPLOAD_INCOMPLETE` ou `UPLOAD_PART_MISMATCH`. Se a reversão afetar zero linhas, vale o passo 5.
   - `CompleteMultipartUpload` montado pelo registro (PartNumber, ETag e ChecksumSHA256). Não leva os guardas `If-None-Match: *` nem `x-amz-mp-object-size` nesta fase (V-10 e revisão de 2026-11-18): o Silo ignora o `x-amz-mp-object-size`, e o `If-None-Match` trocaria o `NoSuchUpload` da repetição por 412, sem ganho com chaves exclusivas por sessão.
   - `NoSuchUpload` → `HeadObject` na chave da própria sessão. Objeto com o tamanho declarado → segue para T2. Objeto ausente → `completing → aborted`, condicionado ao token, e 410 `UPLOAD_SESSION_EXPIRED`. Se essa marcação afetar zero linhas, vale o passo 5.
3. **T2 — finalização (vídeo bloqueado).** Numa transação, as duas transições abaixo precisam afetar uma linha. Senão, a transação é revertida e vale o passo 5.
   - `S: completing → completed WHERE id = :S AND status = 'completing' AND claim_token = :token`.
   - Vídeo `draft → processing WHERE id = :id AND status = 'draft' AND current_upload_session_id = :S`, gravando:
     - `original_key = S.object_key`, `processing_run + 1` e `processing_started_at`;
     - `processing_dispatch = 1`;
     - `current_attempt_id`, `attempt_fence_dispatch` e `attempt_fence_seq` nulos, e `processing_recoveries = 0`;
     - a ação pendente `pending_job_action = 'publish'`, com `pending_job_dispatch = 1`, novo `pending_job_token` e prazo.
4. **Depois do commit:** R2 de P5 com a geração 1 (`add` do job `video-{videoId}-{run}-1`) e, em seguida, R3 com o token. Se o `add` falhar, a resposta é 202 mesmo assim. A ação continua registrada, e a reconciliação a retoma pela tabela de P5 quando o prazo vence, reutilizando a geração 1, sem contar recuperação (F-02).
5. **Releitura depois de zero linhas.** Quando T2, a reversão para `active` ou a marcação `aborted` do passo 2 afetam zero linhas, a operação relê sessão e vídeo e responde pelo estado encontrado. Perder o token, sozinho, nunca produz resposta de sucesso.

   | Estado relido | Resposta |
   |---------------|----------|
   | Sessão `completed`, com o vídeo apontando para `S` (`current_upload_session_id = S`) e `original_key = S.object_key` | 200 com o estado atual do vídeo: outro processo concluiu |
   | Sessão `completing` (claim de outro processo) | 409 `UPLOAD_SESSION_COMPLETING`: a conclusão continua em andamento |
   | Sessão `active`: outra retomada reverteu a conclusão depois de uma conferência reprovada | 409 `UPLOAD_COMPLETION_INTERRUPTED` |
   | Sessão `aborting` ou `aborted` com `expires_at` vencido | 410 `UPLOAD_SESSION_EXPIRED` |
   | Sessão `aborting` ou `aborted` dentro do prazo, ou vídeo apontando para outra sessão | 409 `UPLOAD_SESSION_NOT_ACTIVE`: a sessão foi abortada ou substituída |
   | Sessão `completed` sem o vídeo apontando para ela | Não ocorre pelo protocolo, porque T2 é atômico. Registra a inconsistência e responde 409 `UPLOAD_SESSION_NOT_ACTIVE` |

Um concluidor lento cujo claim venceu e foi assumido por outro falha em T2 pelo token e cai na releitura. O Complete que ele já tiver enviado é inofensivo: mesma chave e mesmas partes, e quem retomar recebe `NoSuchUpload` e confirma pelo `HeadObject`.

##### P3 — Tentativa vigente

- **Token de ordem:** o par (`dispatch`, `seq`), comparado em ordem lexicográfica.
  - `dispatch` é a geração do job, lida do `jobId` `video-{videoId}-{run}-{dispatch}`. Só muda quando P5 reserva uma geração nova (R1), e o banco a guarda em `processing_dispatch`.
  - `seq` é o `job.attemptsStarted` do BullMQ. Ele cresce a cada passagem do job para `active`: entrega inicial, retentativa automática por `attempts` e `backoff`, e reentrega após stall. A reconciliação nunca chama `job.retry()` (P5).
  - Um job de geração nova começa o próprio `seq` de novo, e a ordem lexicográfica continua válida sem zerar a cerca do banco. Uma geração que já teve entrega aceita nunca é recriada (P5, retomada).
- **Cerca:**
  - `attempt_fence_dispatch` e `attempt_fence_seq` guardam o maior token já aceito na execução e só avançam.
  - `current_attempt_id` indica qual tentativa detém a vigência agora. Uma recuperação de P5 pode revogá-la (`NULL`) sem recuar a cerca.
- **Assumir:**

  ```sql
  UPDATE videos
     SET current_attempt_id = :attemptId,
         attempt_fence_dispatch = :dispatch,
         attempt_fence_seq = :seq
   WHERE id = :id
     AND status = 'processing'
     AND processing_run = :run
     AND processing_dispatch = :dispatch
     AND (attempt_fence_dispatch IS NULL
          OR attempt_fence_dispatch < :dispatch
          OR (attempt_fence_dispatch = :dispatch AND attempt_fence_seq < :seq))
  ```

  - Uma linha → a tentativa é a vigente.
  - Zero linhas → entrega obsoleta (geração antiga, ou `seq` não maior que a cerca), vídeo terminal ou outra execução. O processor termina sem FFmpeg e sem gravação, e retorna sem erro (G-08).
- **Por que uma entrega antiga não reassume:**
  - Depois que P5 reserva uma geração nova, as entregas de gerações anteriores, inclusive as de um job removido ou criado por um executor atrasado, têm `dispatch` menor que `processing_dispatch`, e o predicado `processing_dispatch = :dispatch` as exclui.
  - Dentro da mesma geração, a cerca exige `seq` estritamente maior que o maior já aceito. Registrar depois, sozinho, não basta.
  - Uma tentativa revogada por P5 tem token igual à cerca e também não reassume.
- **Perder a vigência:** acontece quando um token maior assume, quando P5 revoga a vigência, ou quando o vídeo sai de `processing` ou muda de execução ou de geração.
- **Efeitos:** a thumbnail só é gravada depois de assumir, em `thumbnails/{videoId}/{attemptId}.jpg`.
- **Publicação e erro pela tentativa:** `ready` e `error` exigem `status = 'processing' AND processing_run = :run AND processing_dispatch = :dispatch AND current_attempt_id = :attemptId`.
- **Tentativa válida:** o vídeo está em `processing`, na mesma execução e geração, com `current_attempt_id` igual a ela. Em `ready` ou `error`, o `current_attempt_id` é residual, guardado só para auditoria.

##### P4 — Elegibilidade estável para exclusão

- **Princípio:** um objeto só é excluído quando um fato do banco que nunca regride prova que nenhuma transição futura pode referenciá-lo.
  - Esses fatos são três: um estado terminal, um token de fencing que só avança, ou uma chave sem registro depois da compensação.
  - Atendida essa condição, a elegibilidade é estável, e a exclusão dispensa bloqueio.
  - A carência (`STORAGE_CLEANUP_GRACE_MS`) e a releitura imediatamente antes de excluir continuam, mas só como margem adicional. Com a carência, uma gravação atrasada de tentativa obsoleta ainda não vira lixo; se cair depois da exclusão, vira lixo de novo no ciclo seguinte.
- **Originais e multiparts**, em `originals/`:

  | Situação | Elegível? |
  |----------|-----------|
  | Sessão `aborted` cuja `object_key` não é `original_key` de nenhum vídeo | Sim. A conclusão exige `completing`, e nenhuma transição sai de `aborted` |
  | Sessão `initiating` ou `aborting` com claim vencido | Primeiro a limpeza assume a posse (novo token). Só então aborta os uploads com prefixo `object_key` e marca `aborted`. A ativação (T2 de P1) ou o claimant anterior falham pelo token |
  | Chave sem nenhuma linha de sessão | Sim. As linhas sempre precedem os objetos, então só resta o caso da compensação, em que o criador já desistiu |
  | Sessão `completed` (objeto referenciado por `original_key`), `active`, `completing`, ou `initiating`/`aborting` com claim no prazo | Nunca |

- **Derivados**, em `thumbnails/{videoId}/`:

  | Situação do vídeo | Elegível? |
  |-------------------|-----------|
  | `ready` | Toda chave diferente de `thumbnail_key`. Nesta fase, nenhuma transição sai de `ready` |
  | `error` | Toda chave. O `current_attempt_id` residual não protege nada, porque a tentativa deixou de ser válida (P3) |
  | `processing` com `current_attempt_id` não nulo | As chaves de tentativas diferentes da vigente. A cerca de P3 só avança, então uma tentativa que perdeu a vigência, por token maior ou por revogação de P5, nunca volta a publicar. A chave da tentativa vigente é protegida |
  | `processing` sem tentativa vigente (nenhuma assumiu, ou P5 revogou a vigente) | Nenhuma chave; espera o próximo ciclo |

##### P5 — Recuperações e encerramento pela reconciliação

_Conforme a revisão de 2026-11-17 da `phase-03-videos/TD-12` (recuperações por geração, sem `job.retry()`)._

**Ordem das leituras.** Cada decisão da reconciliação usa um único retrato, `R`:
1. Lê o retrato do vídeo no banco: `status`, `processing_run`, `processing_dispatch`, `processing_recoveries`, `current_attempt_id`, `attempt_fence_dispatch`, `attempt_fence_seq` e os campos `pending_job_*`.
2. Deriva de `R` a identidade do job: `video-{videoId}-{run}-{g}`, com `g = pending_job_dispatch` se houver ação pendente e `g = processing_dispatch` caso contrário.
3. Consulta a fila sobre esse job: estado, `attemptsStarted` e `failedReason`.
4. Escreve com a guarda do mesmo `R`.

Se a escrita afetar zero linhas, a reconciliação descarta juntos o retrato e a observação da fila, e o próximo ciclo recomeça do passo 1. Ela nunca combina um retrato mais novo com uma observação da fila feita para um retrato anterior.

**Guardas.** A guarda só por `processing_run` não é usada.

```sql
-- G_R: retrato sem ação pendente
WHERE id = :id
  AND status = 'processing'
  AND processing_run = :run
  AND processing_dispatch = :dispatch
  AND processing_recoveries = :recoveries
  AND pending_job_action IS NULL
  AND current_attempt_id IS NOT DISTINCT FROM :attemptId
  AND attempt_fence_dispatch IS NOT DISTINCT FROM :fenceDispatch
  AND attempt_fence_seq IS NOT DISTINCT FROM :fenceSeq

-- G_P: retrato com ação pendente
WHERE id = :id
  AND status = 'processing'
  AND processing_run = :run
  AND pending_job_token = :token
  AND pending_job_dispatch = :pendingDispatch
  AND attempt_fence_dispatch IS NOT DISTINCT FROM :fenceDispatch
  AND attempt_fence_seq IS NOT DISTINCT FROM :fenceSeq
```

Qualquer recuperação, ação pendente, nova vigência ou avanço da cerca posterior ao retrato faz a escrita afetar zero linhas.

> **Cenário de ordem.** A reconciliação A lê `R` (geração `g`) e encontra o job `g` em `completed`. B, com o mesmo retrato, reserva a geração `g+1` (R1) e publica, e uma tentativa de `g+1` assume. Quando A tenta R1 ou o encerramento em `error` com a G_R de `R`, a escrita afeta zero linhas, porque `processing_dispatch`, `processing_recoveries` e a cerca mudaram. A descarta a observação.

**Reserva de geração (R1).** Para job ausente ou `completed` sem transição, uma única escrita reserva a geração nova, conta a recuperação, revoga a tentativa vigente e registra a ação pendente:

```sql
UPDATE videos
   SET processing_recoveries = processing_recoveries + 1,
       processing_dispatch = processing_dispatch + 1,
       current_attempt_id = NULL,
       pending_job_action = 'republish',
       pending_job_dispatch = processing_dispatch + 1,  -- no SET, usa o valor anterior da linha
       pending_job_token = :token,
       pending_job_expires_at = now() + :actionTtl
 <G_R>
   AND processing_recoveries < :maxRecoveries
RETURNING pending_job_dispatch
```

- Só uma reconciliação vence sobre o mesmo retrato, e o limite é verificado na própria escrita.
- Com o limite atingido, a escrita é o encerramento `PROCESSING_INCONSISTENT` com G_R.
- O T2 de P2 registra do mesmo modo a ação `publish`, com `pending_job_dispatch = 1`, sem contar recuperação.

**Execução (R2).** O dono da ação usa a geração da própria reserva (devolvida pelo `RETURNING`, ou lida de `pending_job_dispatch` no retrato da retomada), nunca uma `processing_dispatch` relida depois:

`add('process-video', { videoId, run }, { jobId: 'video-{videoId}-{run}-{g}', attempts, backoff, removeOnComplete: false, removeOnFail: false })`

Cada dono emite no máximo um `add` por ação. Não há `job.retry()` na reconciliação. As retentativas automáticas por `attempts` e `backoff`, e as reentregas após stall, continuam dentro da geração.

**Confirmação (R3).**

```sql
UPDATE videos
   SET pending_job_action = NULL,
       pending_job_dispatch = NULL,
       pending_job_token = NULL,
       pending_job_expires_at = NULL
 WHERE id = :id
   AND pending_job_token = :token
   AND pending_job_dispatch = :g
```

**Retomada de ação pendente.** Quando `pending_job_expires_at` está vencido no retrato `R`:
1. A identidade do job vem da geração reservada (`g = pending_job_dispatch`), e a fila é consultada.
2. A reconciliação toma a posse: `UPDATE videos SET pending_job_token = :newToken, pending_job_expires_at = now() + :actionTtl <G_P com o token antigo> AND pending_job_expires_at < now()`.
3. Decide pela evidência, sem nova reserva e sem contar recuperação:

| Evidência (observação da fila e cerca de `R`) | Conduta |
|---|---|
| O job `g` existe, em qualquer estado | O `add` já aconteceu, então só faz R3. Se o job estiver `completed` sem transição, é uma anomalia nova, tratada no ciclo seguinte por R1 (geração `g+1`, com recuperação contada) |
| O job `g` está ausente e a cerca não tem `g` (`attempt_fence_dispatch` nulo ou menor que `g`) | Nenhuma entrega de `g` foi aceita. Como jobs da geração vigente não são removidos automaticamente, o `add` não aconteceu, ou o job sumiu antes de qualquer entrega aceita. Faz R2 com a mesma geração `g` e depois R3. Recomeçar o contador não viola a ordem, porque a cerca não tem nenhum token de `g` |
| O job `g` está ausente e `attempt_fence_dispatch = g` | O job existiu, teve entrega aceita e foi perdido fora do protocolo (remoção externa ou perda do Redis). Repetir o `add` recriaria `g` com o contador abaixo da cerca, então não há `add`: R3 fecha a ação e registra a anomalia. O ciclo seguinte trata como job ausente, e R1 reserva `g+1` com recuperação contada |

**Executor atrasado.** Um executor que perdeu o token só pode emitir o `add` da geração que ele mesmo reservou.
- Se essa geração ainda é a vigente e o job existe, o `add` é ignorado pelo `jobId`.
- Se a geração já foi superada, o job criado é de geração antiga: não assume a tentativa nem publica (P3), e a coleta o remove.
- Se o vídeo já está terminal, a entrega termina sem efeitos.

O R3 desse executor é recusado pelo token, e nenhum desses caminhos produz recuperação sem contabilização.

> **Cenário de retomada.** R2 adiciona o job `g` com sucesso, e o processo falha antes de R3. O job roda e volta a `completed` sem transição. Outra reconciliação retoma a ação, encontra o job `g` existente e só confirma (R3). A anomalia do `completed` vira, no ciclo seguinte, uma recuperação nova e contada (R1, geração `g+1`), dentro do limite.

**Encerramento em `error` pela reconciliação.**
- A escrita é `UPDATE videos SET status = 'error', error_code = :code, error_message = :message <G_R> RETURNING status, processing_run`.
- Para job `failed`, o predicado ganha `AND (attempt_fence_dispatch IS NULL OR (attempt_fence_dispatch, attempt_fence_seq) <= (:dispatch, :jobAttemptsStarted))`.
- Vale para `PROCESSING_FAILED`, `PROCESSING_STALLED` e `PROCESSING_INCONSISTENT`.
- Com ação pendente não há encerramento, porque G_R exige `pending_job_action IS NULL`.

**Retenção e coleta de jobs.** `removeOnComplete` e `removeOnFail` ficam desligados. A coleta, feita pela reconciliação, só remove um job `completed` ou `failed` depois de ler no banco uma destas confirmações:
- **Execução terminal:** o vídeo está em `ready` ou `error` com `processing_run` igual à execução do job.
- **Geração superada:** a geração do job é menor que `processing_dispatch` na mesma execução, ou a execução do job é anterior a `processing_run`.

O `RETURNING` do encerramento também conta como confirmação; zero linhas afetadas não confirma nada. A coleta nunca remove o job da geração vigente de um vídeo em `processing`, nem jobs `waiting`, `delayed` ou `active`.

**Caso em que nenhum worker iniciou.** Com `current_attempt_id` e a cerca nulos no retrato, as guardas valem do mesmo modo: job ausente leva a R1, e job `failed` antes de qualquer tentativa leva ao encerramento em `error`.

### API Contracts

_Backend tier apenas. A interface está adiada; o BFF `/api/videos/**` é contrato futuro e não é implementado nesta fase. Todas as rotas exigem `Authorization: Bearer <access_token>` (JWT global herdado de `phase-02-auth/TD-02`). Os erros usam o envelope `{ statusCode, error, message }` com códigos de domínio (`phase-02-auth/TD-07`), e cada status previsível tem `@ApiResponse` (`openapi-docs-nestjs/TD-01`). O vídeo é endereçado pelo `publicId` (TD-05); o UUID interno nunca é exposto. O throttler global de 10 requisições a cada 60 s por IP continua ativo (Revision de 2026-11-17 em `phase-02-auth/TD-08`), e cada rota declara o limite explícito indicado em **Throttle** com `@Throttle()` (revisão da TD-02). Os protocolos P1–P5 citados abaixo estão em "Data Model → Coordenação e fencing"._

#### POST /videos (SI-03.12)

**Request headers:**
- Authorization: Bearer <access_token>
- Content-Type: application/json

**Request body** (validação estrutural no DTO; violações → 400):
- fileName: string, required — 1 a 255 caracteres, sem `/`, `\` ou caracteres de controle
- sizeBytes: integer, required — inteiro seguro com 1 ≤ `sizeBytes` ≤ 2^53 − 1. O teto de 10.000.000.000 é regra de domínio (413), não do DTO
- contentType: string, required — formato `tipo/subtipo` (até 100 caracteres). A lista aceita é regra de domínio (415), não do DTO

**Comportamento:** P1 sem sessão anterior. O service aplica o teto de tamanho (413) e a lista de tipos (415) depois da validação estrutural e antes de T1. A resposta só é enviada depois da ativação (T2).

**Response 201:**
- publicId: string — 11 caracteres base64url
- status: `"draft"`
- uploadSession: object
  - id: string (uuid)
  - status: `"active"`
  - partSize: integer — 67108864
  - partCount: integer
  - checksumAlgorithm: `"SHA256"`
  - expiresAt: string (ISO-8601)

**Error responses:**
- 400 validation error: corpo fora das regras estruturais acima
- 401: sem token válido
- 404 CHANNEL_NOT_FOUND: o usuário não tem canal
- 413 VIDEO_TOO_LARGE: `sizeBytes` acima de `VIDEO_MAX_SIZE_BYTES`; a mensagem informa o limite em bytes
- 415 UNSUPPORTED_VIDEO_TYPE: `contentType` estruturalmente válido, mas fora de `video/mp4` e `video/webm`
- 503 STORAGE_UNAVAILABLE: o `CreateMultipartUpload` falhou, e a compensação de P1 remove o vídeo e a sessão `initiating`; ou a ativação perdeu a posse para a varredura depois do prazo do claim, e o vídeo fica em `draft`, sem sessão utilizável e reiniciável

**Throttle:** 10 requisições a cada 60 s.

---

#### POST /videos/:publicId/upload-sessions/:sessionId/part-urls (SI-03.13)

**Request headers:**
- Authorization: Bearer <access_token>
- Content-Type: application/json

**Request body:**
- parts: array, optional, até 50 itens — partes a assinar
  - partNumber: integer, required — ≥ 1; sem repetição no lote. O limite superior `partCount` é verificado no service (400 `INVALID_PART_NUMBER`)
  - checksumSha256: string, required — SHA-256 da parte em base64 com padding (44 caracteres)
- completedParts: array, optional, até 150 itens — partes já enviadas
  - partNumber: integer, required — parte com checksum já registrado
  - etag: string, required — ETag lido da resposta do PUT, 1 a 255 caracteres
- Pelo menos um dos dois arrays precisa ter itens.

**Response 200:**
- parts: array
  - partNumber: integer
  - url: string — URL pré-assinada de `UploadPart` no `S3_PUBLIC_ENDPOINT`
  - method: `"PUT"`
  - expectedSize: integer — `expected_size` da parte. O cliente envia como corpo um `Blob` ou `ArrayBuffer` com exatamente esse número de bytes
  - headers: object — só os headers que o JavaScript define no PUT: `{ "x-amz-checksum-sha256": "<checksum declarado>" }`
  - expiresAt: string (ISO-8601) — criação + `UPLOAD_PART_URL_TTL_SECONDS`
- registeredParts: integer[] — partes cujo ETag foi registrado neste pedido

**`Content-Length`:** não aparece em `headers`. É um header proibido para scripts, e o navegador o define a partir do tamanho do corpo. Ele continua assinado na URL (`signableHeaders`, com o valor de `expectedSize`), então um corpo de outro tamanho é recusado pelo storage (V-02). A prova de que o navegador envia exatamente esse valor quando o corpo é `Blob` ou `ArrayBuffer`, e de que um corpo em stream falha, é a V-08. V-02 e V-08 continuam bloqueantes para a TD-03.

**Error responses:**
- 400 validation error: corpo fora das regras acima
- 400 INVALID_PART_NUMBER: `partNumber` acima de `partCount` ou repetido no lote
- 401: sem token válido
- 404 VIDEO_NOT_FOUND: vídeo inexistente ou de outro canal
- 404 UPLOAD_SESSION_NOT_FOUND: sessão inexistente ou de outro vídeo
- 409 UPLOAD_SESSION_NOT_ACTIVE: a sessão não é a vigente do vídeo ou não está `active` (inclui `initiating`)
- 409 UPLOAD_FILE_MISMATCH: checksum diferente do já registrado para a parte, o que bloqueia a sessão, ou sessão já bloqueada (F-11)
- 409 UPLOAD_PART_NOT_SIGNED: ETag informado para parte sem checksum registrado
- 410 UPLOAD_SESSION_EXPIRED: `expires_at` vencido

**Throttle:** 60 requisições a cada 60 s.

---

#### GET /videos/:publicId/upload-sessions/:sessionId (SI-03.14)

**Request headers:**
- Authorization: Bearer <access_token>

**Response 200:**
- id: string (uuid)
- status: `"initiating"` | `"active"` | `"completing"` | `"completed"` | `"aborting"` | `"aborted"`
- expired: boolean — `true` quando `active` e `expires_at` vencido
- fileMismatch: boolean
- partSize: integer
- partCount: integer
- checksumAlgorithm: `"SHA256"`
- expiresAt: string (ISO-8601)
- parts: array — uma entrada por parte do plano, de 1 a `partCount`, só para sessão `active`; vazio nos demais estados
  - partNumber: integer
  - state: `"confirmed"` | `"missing"` | `"divergent"` | `"unregistered"`
  - checksumSha256: string | null — checksum registrado; `null` se a parte nunca foi assinada
  - etag: string | null — ETag registrado

Classificação a partir do registro e do `ListParts` paginado (até 1.000 partes por página):
- `confirmed`: presente no storage, com ETag registrado igual e checksum e tamanho iguais aos registrados.
- `missing`: ausente no storage, tenha sido assinada ou não.
- `divergent`: presente, mas ETag, checksum ou tamanho diferem do registro.
- `unregistered`: presente, sem ETag registrado.

**Retomada sem partes recebidas:** quando nenhuma parte chegou ao storage, todas as entradas vêm como `missing`. A conferência (`file-verifications`) é chamada com `parts: []` e devolve `match` com `verifiedParts: 0`. O cliente então assina normalmente. Uma parte já assinada antes exige o mesmo checksum na nova assinatura; com outro checksum, a sessão é bloqueada (409 `UPLOAD_FILE_MISMATCH`), porque isso indica outro arquivo.

**Error responses:**
- 401: sem token válido
- 404 VIDEO_NOT_FOUND: vídeo inexistente ou de outro canal
- 404 UPLOAD_SESSION_NOT_FOUND: sessão inexistente ou de outro vídeo
- 410 UPLOAD_SESSION_EXPIRED: o storage não reconhece mais o upload de uma sessão `active` (`NoSuchUpload`, F-10). A sessão é reivindicada para abort sob o bloqueio do vídeo e marcada `aborted`
- 503 STORAGE_UNAVAILABLE: o `ListParts` falhou por erro transitório

**Throttle:** 30 requisições a cada 60 s.

---

#### POST /videos/:publicId/upload-sessions/:sessionId/file-verifications (SI-03.15)

**Request headers:**
- Authorization: Bearer <access_token>
- Content-Type: application/json

**Request body:**
- parts: array, required, 0 a 150 itens — checksums recalculados a partir do arquivo selecionado de novo
  - partNumber: integer, required — ≥ 1, sem repetição
  - checksumSha256: string, required — SHA-256 em base64 com padding (44 caracteres)

**Regras de cobertura** (Q-10):
- O conjunto obrigatório é o das partes `confirmed` e `unregistered` no momento da chamada. Todas elas precisam estar no corpo.
- Partes `missing` que já têm checksum registrado podem ser incluídas e também são conferidas.
- Uma parte sem checksum registrado é recusada com 400 `INVALID_PART_NUMBER`.
- Se o conjunto obrigatório estiver vazio, porque nenhuma parte chegou ao storage, `parts: []` é válido.

**Response 200:**
- result: `"match"`
- verifiedParts: integer — 0 quando nenhuma parte foi recebida

**Error responses:**
- 400 validation error: corpo fora das regras acima
- 400 INVALID_PART_NUMBER: parte fora do plano ou sem checksum registrado
- 400 UPLOAD_VERIFICATION_INCOMPLETE: falta alguma parte do conjunto obrigatório
- 401: sem token válido
- 404 VIDEO_NOT_FOUND: vídeo inexistente ou de outro canal
- 404 UPLOAD_SESSION_NOT_FOUND: sessão inexistente ou de outro vídeo
- 409 UPLOAD_SESSION_NOT_ACTIVE: a sessão não é a vigente ou não está `active`
- 409 UPLOAD_FILE_MISMATCH: algum checksum difere do registrado. A operação grava `file_mismatch_at`, e a sessão deixa de assinar partes e de poder ser concluída até um reinício explícito (F-11, G-11)
- 410 UPLOAD_SESSION_EXPIRED: `expires_at` vencido
- 503 STORAGE_UNAVAILABLE: o `ListParts` usado para classificar as partes falhou

**Throttle:** 10 requisições a cada 60 s.

---

#### POST /videos/:publicId/upload-sessions/:sessionId/completion (SI-03.16)

**Request headers:**
- Authorization: Bearer <access_token>

**Request body:** vazio.

**Comportamento:** P2.

**Response 202:** a conclusão mudou o vídeo para `processing` nesta chamada.
- publicId: string
- status: `"processing"`

**Response 200:** a sessão está `completed` como a vigente do vídeo, confirmada no claim (passo 1 de P2) ou na releitura depois de zero linhas (passo 5); repetição sem novo efeito (G-03). Perder o token, sozinho, nunca produz 200.
- publicId: string
- status: `"processing"` | `"ready"` | `"error"` — estado atual do vídeo

**Error responses:**
- 401: sem token válido
- 404 VIDEO_NOT_FOUND: vídeo inexistente ou de outro canal
- 404 UPLOAD_SESSION_NOT_FOUND: sessão inexistente ou de outro vídeo
- 409 UPLOAD_SESSION_COMPLETING: outra conclusão tem claim no prazo (F-06), detectada no claim ou na releitura do passo 5 de P2
- 409 UPLOAD_COMPLETION_INTERRUPTED: esta chamada perdeu a posse, e a releitura encontrou a sessão de volta em `active`, revertida por outra retomada depois de uma conferência reprovada; o cliente consulta a sessão e conclui de novo
- 409 UPLOAD_INCOMPLETE: há parte do plano sem ETag registrado ou ausente no storage
- 409 UPLOAD_PART_MISMATCH: ETag, checksum ou tamanho no storage diverge do registro, ou há parte presente sem registro (G-04)
- 409 UPLOAD_FILE_MISMATCH: sessão bloqueada por checksum divergente
- 409 UPLOAD_SESSION_NOT_ACTIVE: sessão em `initiating`, `aborting` ou `aborted`, ou que deixou de ser a vigente do vídeo (AMB-4)
- 410 UPLOAD_SESSION_EXPIRED: `expires_at` vencido antes do claim, ou `NoSuchUpload` sem objeto com o tamanho declarado na chave da própria sessão
- 503 STORAGE_UNAVAILABLE: falha transitória no storage. O claim expira e a próxima chamada ou a varredura retoma (G-02)

**Throttle:** 20 requisições a cada 60 s.

---

#### DELETE /videos/:publicId/upload-sessions/:sessionId (SI-03.17)

**Request headers:**
- Authorization: Bearer <access_token>

**Comportamento:** usa o claim de abort de P1, sob o bloqueio do vídeo.
- `active`, ou `initiating`/`aborting` com claim vencido → `aborting` com novo token. Depois, fora da transação, abort repetido até `NoSuchUpload` e `aborted` condicionado ao token.
- `aborting` com claim no prazo, ou `aborted` → nada a fazer.

**Response 204:** sessão `aborted`. Também vale para sessão em `aborting` quando uma parte em trânsito impede confirmar `NoSuchUpload`; a varredura conclui (F-09). Repetir sobre sessão `aborted` também devolve 204.

**Error responses:**
- 401: sem token válido
- 404 VIDEO_NOT_FOUND: vídeo inexistente ou de outro canal
- 404 UPLOAD_SESSION_NOT_FOUND: sessão inexistente ou de outro vídeo
- 409 UPLOAD_SESSION_COMPLETING: a sessão está em `completing` (F-07)
- 409 UPLOAD_SESSION_INITIATING: a sessão está em `initiating` com claim no prazo
- 409 UPLOAD_SESSION_NOT_ACTIVE: a sessão está `completed`

**Throttle:** 10 requisições a cada 60 s.

---

#### POST /videos/:publicId/upload-sessions (SI-03.18)

**Request headers:**
- Authorization: Bearer <access_token>
- Content-Type: application/json

**Request body:** mesmas regras estruturais de `POST /videos` (`fileName`, `sizeBytes`, `contentType`), com as mesmas regras de domínio 413 e 415. O vídeo passa a declarar os novos valores.

**Comportamento:** P1 com sessão anterior. Reinícios simultâneos e reinício simultâneo com conclusão seguem as regras de concorrência de P1.

**Response 201:**
- publicId: string
- status: `"draft"`
- uploadSession: object — mesmo formato de `POST /videos`, com novo `id` e nova chave do original

**Error responses:**
- 400 validation error: corpo fora das regras estruturais
- 401: sem token válido
- 404 VIDEO_NOT_FOUND: vídeo inexistente ou de outro canal
- 409 VIDEO_INVALID_STATE: o vídeo não está em `draft`
- 409 UPLOAD_SESSION_COMPLETING: a sessão vigente está em `completing` (F-07)
- 409 UPLOAD_SESSION_INITIATING: outra criação ou reinício está em andamento (`initiating` com claim no prazo)
- 409 UPLOAD_SESSION_NOT_ACTIVE: a ativação (T2) perdeu a posse da nova sessão para outro reinício depois do prazo do claim
- 413 VIDEO_TOO_LARGE: `sizeBytes` acima do limite
- 415 UNSUPPORTED_VIDEO_TYPE: tipo não aceito
- 503 STORAGE_UNAVAILABLE: falha transitória no storage. A nova sessão termina `aborted`, e o vídeo continua em `draft`, reiniciável (Q-04)

**Throttle:** 10 requisições a cada 60 s.

---

#### GET /videos/:publicId (SI-03.19)

**Request headers:**
- Authorization: Bearer <access_token>

**Response 200:**
- publicId: string
- status: `"draft"` | `"processing"` | `"ready"` | `"error"`
- originalFilename: string
- contentType: string
- sizeBytes: integer
- durationSeconds: number | null
- width: integer | null
- height: integer | null
- videoCodec: string | null
- audioCodec: string | null
- hasThumbnail: boolean
- errorCode: string | null
- errorMessage: string | null
- uploadSession: object | null — sessão vigente
  - id: string (uuid)
  - status: string
  - expiresAt: string (ISO-8601)
- createdAt: string (ISO-8601)
- updatedAt: string (ISO-8601)

**Error responses:**
- 401: sem token válido
- 404 VIDEO_NOT_FOUND: vídeo inexistente ou de outro canal

**Throttle:** 60 requisições a cada 60 s (polling a cada 2 s, Q-09, com folga).

---

#### GET /videos/:publicId/playback-url (SI-03.27)

**Request headers:**
- Authorization: Bearer <access_token>

**Response 200:**
- url: string — `GetObject` pré-assinado do `original_key` no `S3_PUBLIC_ENDPOINT`, com `ResponseContentType` igual ao `content_type`; o storage responde `206 Partial Content` com `Content-Range` a requisições `Range` (TD-13, TD-14)
- contentType: string
- expiresAt: string (ISO-8601) — criação + `PLAYBACK_URL_TTL_SECONDS`

**Error responses:**
- 401: sem token válido
- 404 VIDEO_NOT_FOUND: vídeo inexistente ou de outro canal
- 409 VIDEO_NOT_READY: o vídeo não está em `ready`

**Throttle:** 30 requisições a cada 60 s.

---

#### GET /videos/:publicId/download-url (SI-03.28)

**Request headers:**
- Authorization: Bearer <access_token>

**Response 200:**
- url: string — `GetObject` pré-assinado do `original_key`, com `ResponseContentDisposition` `attachment` (nome derivado de `original_filename`, com `filename*` em UTF-8; RFC 6266)
- expiresAt: string (ISO-8601) — criação + `DOWNLOAD_URL_TTL_SECONDS`

**Error responses:**
- 401: sem token válido
- 404 VIDEO_NOT_FOUND: vídeo inexistente ou de outro canal
- 409 VIDEO_NOT_READY: o vídeo não está em `ready`

**Throttle:** 30 requisições a cada 60 s.

---

#### Validation Rules — upload e checksums

- **Estrutural × domínio:**
  - O DTO valida só a forma: tipos, obrigatoriedade, comprimentos, inteiro seguro, formato `tipo/subtipo`, tamanhos de array e formato do checksum. Violação → 400 validation error.
  - O teto de tamanho (`VIDEO_MAX_SIZE_BYTES` → 413 `VIDEO_TOO_LARGE`) e a lista de tipos aceitos (`video/mp4`, `video/webm` → 415 `UNSUPPORTED_VIDEO_TYPE`) são regras de domínio aplicadas no service. O DTO não usa `@Max` nem `@IsIn` para esses campos, senão os códigos 413 e 415 ficariam inalcançáveis.
  - Pelo mesmo motivo, os limites que dependem da sessão (`partCount`, checksum registrado) são do service.
- **`publicId`** (path): exatamente 11 caracteres `[A-Za-z0-9_-]`. Formato inválido devolve 404 `VIDEO_NOT_FOUND`, sem revelar a regra.
- **`sessionId`** (path): UUID. Formato inválido devolve 404 `UPLOAD_SESSION_NOT_FOUND`.
- **`checksumSha256`:**
  - O algoritmo é SHA-256, fixado pela V-09. O valor é o digest de 32 bytes dos bytes exatos da parte, em base64 padrão com padding (RFC 4648), regex `^[A-Za-z0-9+/]{43}=$`.
  - É o mesmo valor que o cliente envia no header `x-amz-checksum-sha256` do PUT. Esse header é assinado (`unhoistableHeaders`) e verificado pelo storage, que recusa um corpo divergente com HTTP 400 (`BadDigest` na AWS; `XAmzContentChecksumMismatch` no Silo fixado, V-09).
  - Nenhum outro algoritmo é aceito; se a V-09 falhar, a TD-02 é reaberta.
- **Tamanho da parte:**
  - `expected_size = min(part_size, size_bytes - (part_number - 1) * part_size)`, com `part_count = ceil(size_bytes / part_size)`. A última parte nunca tem zero bytes; quando `size_bytes` é múltiplo exato de `part_size`, ela tem `part_size` bytes.
  - O valor é devolvido em `expectedSize`, e o `content-length` assinado usa esse mesmo valor.
  - O limite de 10.000.000.000 bytes gera 150 partes, abaixo do teto de 10.000 da S3.
- **Limites de lote:**
  - `parts` vai até 50 itens, então três pedidos assinam as 150 partes. `completedParts` vai até 150 itens, então um pedido pode registrar todos os ETags.
  - Com o polling a cada 2 s, esses tamanhos cabem nos limites de **Throttle** das rotas.

### Authorization Matrix

_JWT global com opt-out por `@Public()` (`phase-02-auth/TD-02`); nenhuma rota de vídeo é pública nesta fase. A verificação de dono fica no service, pelo canal do `sub` do token (`channels.user_id` é 1:1). Quem não é dono recebe 404, sem distinguir de vídeo inexistente (Q-02, revisão da `phase-03-videos/TD-14`). Acesso anônimo e vídeos unlisted chegam na Fase 05 sem mudar estes contratos._

| Endpoint | Anonymous | Authenticated (não dono) | Owner |
|----------|-----------|--------------------------|-------|
| POST /videos | ✗ (401) | ✓ (cria no próprio canal) | — |
| POST /videos/:publicId/upload-sessions/:sessionId/part-urls | ✗ (401) | ✗ (404) | ✓ (sessão `active` e vigente) |
| GET /videos/:publicId/upload-sessions/:sessionId | ✗ (401) | ✗ (404) | ✓ |
| POST /videos/:publicId/upload-sessions/:sessionId/file-verifications | ✗ (401) | ✗ (404) | ✓ (sessão `active` e vigente) |
| POST /videos/:publicId/upload-sessions/:sessionId/completion | ✗ (401) | ✗ (404) | ✓ (sessão vigente) |
| DELETE /videos/:publicId/upload-sessions/:sessionId | ✗ (401) | ✗ (404) | ✓ |
| POST /videos/:publicId/upload-sessions | ✗ (401) | ✗ (404) | ✓ (vídeo em `draft`) |
| GET /videos/:publicId | ✗ (401) | ✗ (404) | ✓ |
| GET /videos/:publicId/playback-url | ✗ (401) | ✗ (404) | ✓ (vídeo em `ready`) |
| GET /videos/:publicId/download-url | ✗ (401) | ✗ (404) | ✓ (vídeo em `ready`) |

**URLs delegadas:** as URLs pré-assinadas autorizam só a operação e a chave assinadas, pelo prazo do TTL. O bucket é privado, e uma requisição anônima sem assinatura recebe 403 do storage (TD-06). A API orquestra o multipart e assina URLs sem transportar bytes de vídeo; o worker lê originais e grava derivados. Ambos usam a credencial da aplicação criada na inicialização do storage, restrita ao bucket `S3_BUCKET`.

### Error Catalog

_Subclasses de `DomainException` (`errorCode`, `httpStatus`, `message`) mapeadas pelo `DomainExceptionFilter` para o envelope herdado de `phase-02-auth/TD-07`. Erros de validação estrutural do DTO seguem o `ValidationExceptionFilter` existente (400). Teto de tamanho (413) e tipo não suportado (415) são regras de domínio do service, aplicadas depois da validação estrutural. O 429 do throttler mantém o comportamento herdado._

| errorCode | HTTP | Trigger |
|-----------|------|---------|
| CHANNEL_NOT_FOUND | 404 | Usuário autenticado sem canal ao iniciar o upload |
| VIDEO_NOT_FOUND | 404 | `publicId` inexistente, malformado ou de vídeo de outro canal |
| UPLOAD_SESSION_NOT_FOUND | 404 | `sessionId` inexistente, malformado ou de outro vídeo |
| VIDEO_TOO_LARGE | 413 | `sizeBytes` estruturalmente válido, mas acima de `VIDEO_MAX_SIZE_BYTES`; a mensagem informa o limite em bytes (`10000000000`) |
| UNSUPPORTED_VIDEO_TYPE | 415 | `contentType` no formato `tipo/subtipo`, mas diferente de `video/mp4` e `video/webm` (MOV fora da fase) |
| VIDEO_INVALID_STATE | 409 | Nova sessão pedida para vídeo fora de `draft` |
| UPLOAD_SESSION_NOT_ACTIVE | 409 | Sessão que não é a vigente do vídeo, ou em estado incompatível com a operação (`initiating`, `completed`, `aborting`, `aborted`); também quando a ativação de um reinício perde a posse da nova sessão (P1, T2) |
| UPLOAD_SESSION_COMPLETING | 409 | Conclusão em andamento (F-06), ou abort e reinício contra sessão em `completing` (F-07) |
| UPLOAD_SESSION_INITIATING | 409 | Criação ou reinício em andamento (`initiating` com claim no prazo): segundo reinício simultâneo, ou abort contra sessão em criação (P1) |
| UPLOAD_COMPLETION_INTERRUPTED | 409 | A conclusão perdeu a posse, e a releitura encontrou a sessão em `active`, revertida por outra retomada (P2, passo 5) |
| UPLOAD_FILE_MISMATCH | 409 | Checksum diferente do registrado para a parte, na assinatura ou na conferência, o que grava `file_mismatch_at`; ou sessão já bloqueada (F-11) |
| UPLOAD_PART_NOT_SIGNED | 409 | ETag informado para parte sem checksum registrado |
| UPLOAD_INCOMPLETE | 409 | Conclusão com parte do plano sem ETag registrado ou ausente no storage |
| UPLOAD_PART_MISMATCH | 409 | ETag, checksum ou tamanho no storage diverge do registro, ou há parte presente sem registro (G-04) |
| VIDEO_NOT_READY | 409 | URL de reprodução ou download pedida para vídeo fora de `ready` |
| UPLOAD_SESSION_EXPIRED | 410 | `expires_at` vencido, ou `NoSuchUpload` sem objeto válido na chave da própria sessão (F-10) |
| INVALID_PART_NUMBER | 400 | `partNumber` acima de `partCount`, repetido no lote, ou sem checksum registrado na conferência |
| UPLOAD_VERIFICATION_INCOMPLETE | 400 | Conferência sem alguma parte `confirmed` ou `unregistered` |
| STORAGE_UNAVAILABLE | 503 | Falha transitória do storage (rede, timeout ou 5xx) numa operação síncrona da API, ou ativação da sessão de `POST /videos` fora do prazo do claim |

**Códigos persistidos em `videos.error_code`** (não são respostas HTTP; aparecem em `GET /videos/:publicId`):

| errorCode | Classe | Trigger |
|-----------|--------|---------|
| MEDIA_INVALID | permanente (`UnrecoverableError`) | O ffprobe não reconhece a mídia, ou não há stream de vídeo |
| MEDIA_CONTAINER_MISMATCH | permanente | O contêiner detectado não corresponde ao `content_type` declarado; MP4 com `major_brand` `qt  ` (MOV) é recusado |
| MEDIA_UNSUPPORTED_CODEC | permanente | Codec fora da lista aceita: MP4 com vídeo `h264` e áudio `aac` ou sem áudio; WebM com vídeo `vp8`, `vp9` ou `av1` e áudio `vorbis`, `opus` ou sem áudio |
| PROCESSING_FAILED | final | Última tentativa falhou por erro transitório (storage, timeout do FFmpeg), gravado pela tentativa vigente; ou job `failed` sem stall encontrado pela reconciliação |
| PROCESSING_STALLED | final | A reconciliação encontrou o job `failed` por stall acima de `maxStalledCount` |
| PROCESSING_INCONSISTENT | final | Job da geração ausente, ou `completed` sem transição, com `processing_recoveries` já em `PROCESSING_MAX_RECOVERIES`; gravado por P5 com G_R |

_A lista de codecs reúne os que Chrome e Firefox reproduzem nativamente por download progressivo (TD-13). A confirmação em navegador é a V-05, adiada para a Fase 05._

### Events/Messages

_BullMQ + Redis via `@nestjs/bullmq` (`phase-03-videos/TD-09`), com fila e worker reais no Compose (R-10). A entrega é at-least-once: reentregas, duplicatas e stalls podem repetir o trabalho. A convergência vem das guardas no banco, da tentativa vigente (P3), das recuperações por geração (P5, revisão de 2026-11-17 da TD-12) e das chaves por tentativa (TD-12, AMB-3). Não há eventos de retorno para a API; o worker grava direto no banco e no storage (diagrama C4)._

**Roteiro previsto da V-11** (BullMQ 6.7.7 e Redis reais; comportamento da biblioteca). Se algum cenário mostrar outro comportamento, a TD-12 é reaberta, sem troca automática de mecanismo.
1. `attemptsStarted` cresce estritamente dentro do mesmo job, na entrega inicial, na retentativa automática por `attempts` e `backoff` e na reentrega após stall.
2. Com `removeOnComplete: false` e `removeOnFail: false`, os jobs `completed` e `failed` permanecem até a remoção explícita. `job.remove()` funciona para `completed` e `failed` e é recusado para job `active` com lock.
3. `add` com o `jobId` de um job existente é ignorado em cada estado (`waiting`, `delayed`, `active`, `completed` e `failed` retidos).
4. Um job removido e adicionado de novo com o mesmo `jobId` recomeça `attemptsStarted`. Isso documenta por que P5 nunca recria uma geração que já teve entrega aceita. Um job com outro `jobId` (geração nova) também começa do início.
5. Uma entrega ainda em execução de um job removido mantém os valores antigos e não consegue concluir nem falhar o job, por falta de lock.
6. `job.attemptsMade` identifica a última tentativa, e `failedReason` distingue o stall acima de `maxStalledCount`.

**Roteiro previsto do T-09** (integração com Postgres, Redis e worker reais; protocolo da aplicação):
1. Conduta por estado do job da geração: ausente, `waiting`, `delayed`, `active`, `failed` e `completed` sem transição.
2. **Duas reconciliações concorrentes sobre o mesmo retrato:** exatamente uma reserva de geração, uma recuperação contada e um `add`. Com `processing_recoveries` em `max - 1`, o contador nunca passa do limite; no limite, o desfecho é `PROCESSING_INCONSISTENT`.
3. **Ordem das leituras:** A lê o retrato e vê `completed`; B reserva `g+1` e uma tentativa nova assume; o R1 e o `error` de A, com o retrato antigo, afetam zero linhas.
4. **Falha entre o banco e a fila:**
   - processo encerrado depois de R1 e antes do `add` → a retomada adiciona a mesma geração, sem contar de novo;
   - encerrado depois do `add` e antes de R3 → a retomada só confirma.
5. **Retomada após nova anomalia:** depois do `add`, falha antes de R3, e o job roda e volta a `completed` sem transição. A retomada só confirma; o ciclo seguinte conta uma recuperação nova, em geração nova.
6. **Executor atrasado com token perdido:** o `add` tardio da própria geração é ignorado (mesma geração) ou cria job de geração antiga, que não assume nem publica; o R3 dele é recusado.
7. **Job da geração vigente removido de fora depois de uma entrega aceita:** a retomada não repete o `add`, fecha a ação e o ciclo seguinte conta uma recuperação nova.
8. **Coleta:** um job `failed` só sai depois da confirmação terminal; uma escrita com zero linhas deixa o job retido; jobs de gerações superadas e de execuções terminais saem; o job da geração vigente de vídeo em `processing` nunca sai.

A extensão correspondente do T-11 é que uma entrega de geração antiga não assume a tentativa nem publica `ready` ou `error`.

#### process-video

**Payload:**

```json
{ "videoId": "uuid", "run": 1 }
```

**Queue:** `video-processing`
**Job options:**
- `jobId` = `video-{videoId}-{run}-{dispatch}`: sem `:`, determinístico por execução e geração (P3, P5). O payload continua `{ videoId, run }`, e o processor lê a geração do `jobId` e confere a execução com o payload.
- `attempts` = `VIDEO_PROCESSING_ATTEMPTS`; `backoff` exponencial a partir de `VIDEO_PROCESSING_BACKOFF_MS`. Essas retentativas automáticas acontecem dentro da mesma geração.
- `removeOnComplete: false` e `removeOnFail: false`. Os jobs são a evidência usada na deduplicação e na retomada. Só a coleta de P5 os remove, depois de confirmar no banco que a execução terminou ou que a geração foi superada.

**Producer:** `VideoProcessingProducer`, que executa o R2 das ações pendentes de P5: `publish` (geração 1, registrada no T2 de P2) e `republish` (geração reservada por R1), sempre com a geração da própria ação (per `phase-03-videos/TD-12`)
**Consumer:** `VideoProcessingProcessor` no serviço `video-worker` (`@Processor('video-processing', { concurrency })`), per `phase-03-videos/TD-10`, `TD-11`, `TD-12`:
1. Assume a vigência por P3, com o token (`dispatch` do `jobId`, `job.attemptsStarted`). Sem vigência, termina sem efeitos e sem erro.
2. Faz a sondagem e a thumbnail e grava `thumbnails/{videoId}/{attemptId}.jpg`.
3. Publica `ready`, com metadados e `thumbnail_key` no mesmo `UPDATE`, com a guarda de publicação de P3.
4. Em falha permanente (mídia ou codec), grava `error` com a mesma guarda e lança `UnrecoverableError`.
5. Em falha transitória, relança para a retentativa. Na última tentativa (`job.attemptsMade + 1 >= attempts`), grava antes `error` `PROCESSING_FAILED`, com a mesma guarda.

**Trigger:** ações pendentes `publish` e `republish` (P2 e P5)
**Delivery semantics:** at-least-once (per `phase-03-videos/TD-12`).
- Um `add` com `jobId` existente é ignorado (F-03).
- Mídia inválida ou codec não suportado não é retentado (T-14).
- Entregas de geração antiga, ou com `seq` não maior que a cerca, nunca assumem nem publicam (P3).
- Com o vídeo terminal, a entrega termina sem efeitos (G-08).

#### sweep-upload-sessions

**Payload:**

```json
{ "batchSize": 100 }
```

**Queue:** `video-maintenance`
**Scheduler:** `upload-session-sweep` (id estável), `every` = `MAINTENANCE_SWEEP_INTERVAL_MS`
**Producer:** `MaintenanceSchedulerRegistrar`, via `upsertJobScheduler` no bootstrap do `video-worker`; várias instâncias registram o mesmo id sem duplicar (per `phase-03-videos/TD-12`)
**Consumer:** `MaintenanceProcessor` (`@Processor('video-maintenance', { concurrency: 1 })`), com concorrência própria, separada da fila de vídeos (per `phase-03-videos/TD-10`)
**Trigger:** periódico. Sob o bloqueio do vídeo, faz claims com predicados complementares aos de P1 e P2:
- **`active` vencida** (`expires_at <= now()`) → `aborting` com novo token. Depois, abort repetido até `NoSuchUpload` e `aborted` condicionado ao token (G-10, F-09).
- **`initiating` ou `aborting` com claim vencido** → nova posse com novo token, abort dos uploads com prefixo `object_key` e `aborted` (P1, recuperação).
- **`completing` com claim vencido** → nova posse e retomada de P2 a partir do passo 2, incluindo a releitura do passo 5 quando uma transição afeta zero linhas (G-02, F-01).

**Delivery semantics:** at-least-once, sem pontualidade garantida. Repetir o lote não tem efeito adicional, porque cada passo é uma transição condicionada a estado e token (G-01).

#### reconcile-processing

**Payload:**

```json
{ "batchSize": 100 }
```

**Queue:** `video-maintenance`
**Scheduler:** `processing-reconciliation` (id estável), `every` = `MAINTENANCE_RECONCILE_INTERVAL_MS`
**Producer:** `MaintenanceSchedulerRegistrar` (per `phase-03-videos/TD-12`)
**Consumer:** `MaintenanceProcessor`
**Trigger:** periódico, sobre vídeos em `processing` além de `PROCESSING_RECONCILE_GRACE_MS` ou com `pending_job_expires_at` vencido. Segue a ordem de P5 (retrato → identidade do job → fila → escrita com a guarda do retrato) e aplica a conduta (G-05):

| Situação no retrato e na fila | Conduta |
|-------------------------------|---------|
| Ação pendente com prazo vencido | Retomada de P5: posse por G_P e decisão pela tabela de evidências, reutilizando a geração reservada, sem contar recuperação |
| Ação pendente dentro do prazo | Nada; o dono da ação está atuando |
| Job da geração ausente (inclui F-02 e o caso em que nenhum worker iniciou) | R1 (geração nova, recuperação contada) se `processing_recoveries < PROCESSING_MAX_RECOVERIES`; senão, `error` `PROCESSING_INCONSISTENT` com G_R |
| `waiting`, `delayed` ou `prioritized` | Nada no banco. Acima de `PROCESSING_STUCK_ALERT_MS`, registra alerta de fila sem consumidor; a única ação segura é esperar um worker |
| `active` | Nada; o verificador de stall do BullMQ cuida da perda de lock |
| `failed` | `error` com G_R e a guarda de cerca de P5: `PROCESSING_STALLED` se o `failedReason` indica stall acima de `maxStalledCount`, senão `PROCESSING_FAILED`. Nenhuma recuperação automática; o job sai só pela coleta de P5 |
| `completed` sem transição no banco | R1 (geração nova, recuperação contada) se `processing_recoveries < PROCESSING_MAX_RECOVERIES`; senão, `error` `PROCESSING_INCONSISTENT` com G_R. Nunca `job.retry()` |

Notas:
- **Limite de recuperações:** `PROCESSING_MAX_RECOVERIES` vale 2 por execução e soma as reservas de geração por job ausente e por job `completed` sem transição. A publicação inicial (`publish`) e as retomadas de ações pendentes não contam.
- **Coleta de jobs:** na mesma passagem, em lotes, a reconciliação remove jobs `completed` e `failed` conforme as confirmações de P5.

**Delivery semantics:** at-least-once. Cada conduta é condicionada ao retrato (G_R ou G_P) ou ao token da ação pendente, então reconciliações concorrentes ou repetidas não duplicam efeito nem excedem o limite.

#### cleanup-storage

**Payload:**

```json
{ "batchSize": 100 }
```

**Queue:** `video-maintenance`
**Scheduler:** `storage-cleanup` (id estável), `every` = `MAINTENANCE_CLEANUP_INTERVAL_MS`
**Producer:** `MaintenanceSchedulerRegistrar` (per `phase-03-videos/TD-06`, `TD-12`)
**Consumer:** `MaintenanceProcessor`
**Trigger:** periódico. Percorre `ListMultipartUploads` e `ListObjectsV2` em `originals/` e `thumbnails/` e aplica as tabelas de elegibilidade de P4.
- **Janela da criação:** a janela entre o `CreateMultipartUpload` e a ativação da sessão está coberta pela linha `initiating` gravada antes do storage. Um upload dessa sessão só é abortado depois que a limpeza assume a posse por token.
- **Proteção real:** só fatos estáveis tornam um objeto elegível (G-10). Carência e releitura são margem adicional, não a proteção.

**Delivery semantics:** at-least-once. A elegibilidade é estável, então repetir ou rodar em várias instâncias é seguro. A posse das sessões `initiating` e `aborting` vencidas é disputada por token, e só uma instância vence.

---

## Dependency Map

```
SI-03.1 (root — infraestrutura mínima para as provas)
SI-03.2 (root — bibliotecas e modelo de relatório de prova)
├── SI-03.3 — depende de SI-03.1 e SI-03.2 (V-01 e V-03)
│   ├── SI-03.4 — depende de SI-03.3 (V-02, V-09 no servidor e V-10)
│   │   └── SI-03.5 — depende de SI-03.4 (V-08 e V-09 no navegador)
│   └── SI-03.6 — depende de SI-03.3 (V-04)
└── SI-03.7 — depende de SI-03.1 e SI-03.2 (V-06 e V-11)

Portão das provas: SI-03.8 só começa com SI-03.3 a SI-03.7 aprovadas e com a tarefa separada D-08 concluída.

SI-03.8 — configuração (depende das provas aprovadas)
├── SI-03.9 — storage
└── SI-03.10 — entidades e migration
    └── SI-03.11 — base do módulo de vídeos (depende também de SI-03.9)
        ├── SI-03.12 — POST /videos
        │   ├── SI-03.13 — part-urls
        │   │   └── SI-03.14 — GET da sessão
        │   │       ├── SI-03.15 — file-verifications
        │   │       └── SI-03.16 — completion (depende também de SI-03.11)
        │   ├── SI-03.17 — DELETE da sessão
        │   │   └── SI-03.18 — reinício (depende também de SI-03.15 e SI-03.16)
        │   └── SI-03.19 — GET /videos/:publicId
        └── SI-03.20 — worker (depende também de SI-03.6 e SI-03.7)
            ├── SI-03.21 — MediaProbeService
            │   └── SI-03.22 — processor de vídeo (depende também de SI-03.16)
            └── SI-03.23 — manutenção e Job Schedulers
                ├── SI-03.24 — varredura de sessões (depende também de SI-03.16, SI-03.17 e SI-03.18)
                ├── SI-03.25 — reconciliação e coleta de jobs (depende também de SI-03.22)
                └── SI-03.26 — limpeza de objetos (depende também de SI-03.22 e SI-03.18)

SI-03.27 — playback-url (depende de SI-03.19 e SI-03.22)
└── SI-03.28 — download-url

SI-03.29 — contrato OpenAPI e sincronização (depende de SI-03.12 a SI-03.19, SI-03.27 e SI-03.28)
└── SI-03.30 — documentação (depende também de SI-03.20)

SI-03.31 — V-07 e cliente de prova (depende de SI-03.15, SI-03.16, SI-03.19 e SI-03.22)
└── SI-03.32 — prova do fluxo completo (depende também de SI-03.27 e SI-03.28)
    └── SI-03.33 — prova de 10 GB com medição de responsividade
```

---

## Deliverables

- [ ] SI-03.1 — Infra: storage, inicialização do bucket, Redis e FFmpeg no ambiente
- [ ] SI-03.2 — Infra: bibliotecas da fase e estrutura das provas
- [ ] SI-03.3 — Prova V-01 e V-03: configuração do Silo e URLs do AWS SDK
- [ ] SI-03.4 — Prova V-02, V-09 (servidor) e V-10: tamanho assinado, checksum e Complete
- [ ] SI-03.5 — Prova V-08 e V-09 (navegador): PUT em navegador real e custo do SHA-256
- [ ] SI-03.6 — Prova V-04: FFmpeg 5.1 sobre URL assinada, formatos e timeouts
- [ ] SI-03.7 — Prova V-06 e V-11: BullMQ no stack real
- [ ] SI-03.8 — Configuração de storage, fila, vídeo e manutenção
- [ ] SI-03.9 — Módulo de storage
- [ ] SI-03.10 — Entidades e migration de vídeos, sessões e partes
- [ ] SI-03.11 — Base do módulo de vídeos: exceções, publicId, bloqueio e dispatch de jobs
- [ ] SI-03.12 — Endpoint POST /videos
- [ ] SI-03.13 — Endpoint POST part-urls (assinatura e registro em lote)
- [ ] SI-03.14 — Endpoint GET da sessão (retomada)
- [ ] SI-03.15 — Endpoint file-verifications (conferência na retomada)
- [ ] SI-03.16 — Endpoint completion (conclusão do upload, P2)
- [ ] SI-03.17 — Endpoint DELETE da sessão (abort)
- [ ] SI-03.18 — Endpoint POST upload-sessions (reinício)
- [ ] SI-03.19 — Endpoint GET /videos/:publicId (estado e metadados)
- [ ] SI-03.20 — Worker: entrypoint, módulo e serviço video-worker
- [ ] SI-03.21 — MediaProbeService: sondagem, validação de mídia e frame
- [ ] SI-03.22 — Processor de vídeo com tentativa vigente (P3)
- [ ] SI-03.23 — Manutenção: fila e Job Schedulers
- [ ] SI-03.24 — Varredura de sessões de upload
- [ ] SI-03.25 — Reconciliação do processamento e coleta de jobs (P5)
- [ ] SI-03.26 — Limpeza de objetos abandonados (P4)
- [ ] SI-03.27 — Endpoint GET playback-url (streaming)
- [ ] SI-03.28 — Endpoint GET download-url
- [ ] SI-03.29 — Contrato OpenAPI e sincronização com o next-frontend
- [ ] SI-03.30 — Documentação da fase
- [ ] SI-03.31 — Prova V-07: tempo e disco das provas grandes, com cliente e sonda de prova
- [ ] SI-03.32 — Prova documentada do fluxo completo com vídeo válido até ready
- [ ] SI-03.33 — Prova documentada de 10 GB com medição de responsividade da API

**Pré-requisitos e itens fora da fase:**

- [x] Tarefa separada D-08 concluída antes da SI-03.8: `createTestDataSource` passa a ler `DB_NAME` em vez de `DB_DATABASE`. Concluída em 2026-11-20, com o teste de regressão `src/test/create-test-data-source.spec.ts`
- [ ] V-05 (reprodução e seek em navegador) registrada como adiada para a Fase 05. Não é entregável desta fase
- [ ] Nenhuma tela, componente, player ou rota BFF de vídeo implementado. No `next-frontend`, só `openapi.json` e `types.gen.ts` mudam

**Cobertura de requisitos, cenários, garantias e testes:**

Requisitos:

- [ ] R-01 (storage S3/MinIO) — SI-03.1, SI-03.3, SI-03.9
- [ ] R-02 (até 10GB sem passar pela API e sem bloquear o atendimento) — SI-03.12 a SI-03.16, SI-03.33
- [ ] R-03 (retomada após falha de conexão) — SI-03.14, SI-03.15, SI-03.31, SI-03.33
- [ ] R-04 (pré-cadastro como rascunho no canal do usuário) — SI-03.12
- [ ] R-05 (processamento assíncrono com metadados e thumbnail) — SI-03.20, SI-03.21, SI-03.22
- [ ] R-06 (estados `draft`, `processing`, `ready` e `error`) — SI-03.10, SI-03.16, SI-03.22
- [ ] R-07 (URL única por vídeo) — SI-03.10, SI-03.11, SI-03.12
- [ ] R-08 (streaming por requisições parciais) — SI-03.27, SI-03.32
- [ ] R-09 (download) — SI-03.28, SI-03.32
- [ ] R-10 (storage, fila e worker reais no Compose e nos testes) — SI-03.1, SI-03.20 e as suítes de integração das SIs 03.9 a 03.28
- [ ] R-11 (reuso de autenticação, erros, persistência e migrations) — SI-03.10, SI-03.11, SI-03.12 a SI-03.19, SI-03.27 a SI-03.29

Cenários de falha:

- [ ] F-01 — SI-03.16, SI-03.24
- [ ] F-02 — SI-03.16, SI-03.25
- [ ] F-03 — SI-03.11, SI-03.25
- [ ] F-04 — SI-03.22, SI-03.26
- [ ] F-05 — SI-03.22
- [ ] F-06 — SI-03.16
- [ ] F-07 — SI-03.17, SI-03.18
- [ ] F-08 — SI-03.16, SI-03.24
- [ ] F-09 — SI-03.17, SI-03.24
- [ ] F-10 — SI-03.1, SI-03.14, SI-03.16
- [ ] F-11 — SI-03.13, SI-03.15
- [ ] F-12 — SI-03.20, SI-03.21, SI-03.25

Garantias:

- [ ] G-01 — SI-03.11, SI-03.12, SI-03.16, SI-03.17, SI-03.18, SI-03.24
- [ ] G-02 — SI-03.16, SI-03.24
- [ ] G-03 — SI-03.16
- [ ] G-04 — SI-03.13, SI-03.14, SI-03.16
- [ ] G-05 — SI-03.25
- [ ] G-06 — SI-03.22
- [ ] G-07 — SI-03.22, SI-03.26
- [ ] G-08 — SI-03.22
- [ ] G-09 — SI-03.6, SI-03.21
- [ ] G-10 — SI-03.1, SI-03.24, SI-03.26
- [ ] G-11 — SI-03.15

Testes:

- [ ] T-01 — SI-03.16
- [ ] T-02 — SI-03.16 (spec E2E de `/plan-test-specs`)
- [ ] T-03 — SI-03.18, SI-03.24
- [ ] T-04 — SI-03.16, SI-03.24
- [ ] T-05 — SI-03.12, SI-03.17, SI-03.24, SI-03.26
- [ ] T-06 — SI-03.15 (detecção e bloqueio da assinatura) e SI-03.18 (fluxo E2E completo, com a conclusão bloqueada e o reinício explícito)
- [ ] T-07 — SI-03.14, SI-03.16
- [ ] T-08 — SI-03.25
- [ ] T-09 — SI-03.25 (os 8 cenários do roteiro previsto)
- [ ] T-10 — SI-03.22
- [ ] T-11 — SI-03.22, inclusive a entrega de geração antiga
- [ ] T-12 — SI-03.25, com a verificação manual documentada na SI-03.30
- [ ] T-13 — SI-03.21
- [ ] T-14 — SI-03.22

**Provas** (nenhuma executada no planejamento; cada uma bloqueia as SIs que dependem dela):

- [ ] V-01 e V-03 — SI-03.3
- [ ] V-02, V-09 no servidor e V-10 — SI-03.4
- [ ] V-08 e V-09 no navegador — SI-03.5
- [ ] V-04 — SI-03.6
- [ ] V-06 e V-11 — SI-03.7
- [ ] V-07 — SI-03.31, que bloqueia só o agendamento da SI-03.33
- [ ] Prova do fluxo completo com vídeo válido até `ready` — SI-03.32
- [ ] Prova real de 10.000.000.000 bytes com medição de responsividade — SI-03.33

**Full test suites:**

- [ ] Unit and integration tests pass with storage, Redis and video-worker running (`cd nestjs-project && docker compose exec nestjs-api npm test -- --runInBand`)
- [ ] E2E tests pass with the real infrastructure, R-10 (`cd nestjs-project && docker compose exec nestjs-api npm run test:e2e`)
- [ ] Backend type check passes (`cd nestjs-project && docker compose exec nestjs-api npx tsc --noEmit`)
- [ ] Backend lint passes (`cd nestjs-project && docker compose exec nestjs-api npm run lint`)
- [ ] Project builds successfully (`cd nestjs-project && docker compose exec nestjs-api npm run build`)
- [ ] Frontend type check and lint pass after the contract sync (`cd next-frontend && docker compose exec next-frontend npx tsc --noEmit && docker compose exec next-frontend npm run lint`)

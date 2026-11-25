---
subproject: backend
runner: jest+supertest
scope: phase-03-videos
si: SI-03.13
target_file: test/videos-upload-part-urls.e2e-spec.ts
---

# POST /videos/:publicId/upload-sessions/:sessionId/part-urls — Test Plan

## Application Overview

O endpoint assina partes em lote e registra, no mesmo pedido, os ETags das partes já enviadas. A API não transporta bytes.

Para cada parte assinada, a resposta traz:
- **`expectedSize`:** `min(part_size, size_bytes - (part_number - 1) * part_size)`.
- **`headers`:** só `x-amz-checksum-sha256`, o único header definido pelo JavaScript.
- **URL pré-assinada de `UploadPart`:** assina o `content-length`, que o navegador define a partir do corpo.

Regras de checksum e ETag:
- **Checksum gravado uma vez:** o checksum SHA-256 de cada parte é gravado uma única vez.
- **Bloqueio:** reassinar uma parte com outro checksum bloqueia a sessão (`file_mismatch_at`).
- **Registro de ETag:** só vale para partes com checksum registrado.
- **Acesso:** só o dono usa a sessão; quem não é dono recebe 404.

## Test Scenarios

### 1. Assinatura em lote

**Setup:**
- **Aplicação:** `beforeAll` sobe a aplicação com `Test.createTestingModule({ imports: [AppModule] })`, aplicando o `ValidationPipe` e os filtros globais de `main.ts`.
- **Infraestrutura:** Postgres, storage e Redis reais do Compose (R-10), com a configuração padrão de partes (`UPLOAD_PART_SIZE_BYTES=67108864`).
- **Filas:** `beforeAll` pausa `video-processing` e `video-maintenance` com `test/helpers/queues.ts` (SI-03.11).
- **Antes de cada cenário:** `beforeEach` executa `cleanAllTables`, limpa o throttler, garante as filas pausadas e limpa os jobs da `video-processing`.
- **Encerramento:** `afterAll` retoma as duas filas e fecha a aplicação.
- **Usuários:** o dono e um segundo usuário são registrados, confirmados e autenticados pelos endpoints de auth.
- **Dados de cada cenário:** cada cenário cria o próprio vídeo e a própria sessão por POST /videos.
- **Checksums:** calculados com `crypto.createHash('sha256').digest('base64')` sobre os bytes da parte.

#### 1.1. assina-a-ultima-parte-com-tamanho-e-header-separados

**Covers AC:** #1
**Source:** auto
**Last sync:** 2026-11-21T02:43:13Z

**Steps:**
  1. POST /videos com `sizeBytes: 10000000000` e `contentType: "video/mp4"`
    - expect: status `201` com `partCount: 150`
  2. POST part-urls com `parts: [{ "partNumber": 150, "checksumSha256": <checksum de 779264 bytes> }]`
    - expect: status `200`
    - expect: `parts[0].expectedSize` é `779264`, `method` é `"PUT"`, e `url` usa o host de `S3_PUBLIC_ENDPOINT`
    - expect: as chaves de `parts[0].headers` são exatamente `["x-amz-checksum-sha256"]`, com o checksum enviado
    - expect: `expiresAt` cai `UPLOAD_PART_URL_TTL_SECONDS` depois da requisição
    - expect: `upload_parts` tem a parte 150 com `expected_size = 779264` e o checksum declarado

#### 1.2. tamanho-esperado-em-arquivo-multiplo-exato

**Covers AC:** #2
**Source:** auto
**Last sync:** 2026-11-21T02:43:13Z

**Steps:**
  1. POST /videos com `sizeBytes: 134217728`
    - expect: status `201` com `partCount: 2`
  2. POST part-urls com as partes 1 e 2
    - expect: status `200`
    - expect: as duas partes vêm com `expectedSize: 67108864`, e nenhuma tem tamanho zero

### 2. Validação e conflitos

**Setup:** o mesmo do grupo 1. Cada cenário cria o próprio vídeo, com `sizeBytes: 10000000000` (150 partes).

#### 2.1. numero-de-parte-fora-do-plano-retorna-400

**Covers AC:** #3
**Source:** auto
**Last sync:** 2026-11-21T02:43:13Z

**Steps:**
  1. POST part-urls com `parts: [{ "partNumber": 151, "checksumSha256": <checksum válido> }]`
    - expect: status `400` com `error: "INVALID_PART_NUMBER"`
    - expect: nenhuma linha nova em `upload_parts`
  2. POST part-urls com `parts: []` e `completedParts: []`
    - expect: status `400`, pelo envelope de validação

#### 2.2. checksum-divergente-bloqueia-a-sessao

**Covers AC:** #4
**Source:** auto
**Last sync:** 2026-11-21T02:43:13Z

**Steps:**
  1. POST part-urls com a parte 3 e o checksum A
    - expect: status `200`
  2. POST part-urls com a parte 3 e o checksum B, diferente de A
    - expect: status `409` com `error: "UPLOAD_FILE_MISMATCH"`
    - expect: a sessão passa a ter `file_mismatch_at` preenchido, e o checksum da parte 3 continua A
  3. POST part-urls com a parte 4 e um checksum novo
    - expect: status `409` com `error: "UPLOAD_FILE_MISMATCH"`

#### 2.3. etag-de-parte-nao-assinada-retorna-409

**Covers AC:** #5
**Source:** auto
**Last sync:** 2026-11-21T02:43:13Z

**Steps:**
  1. POST part-urls com `completedParts: [{ "partNumber": 10, "etag": "\"abc\"" }]`, sem que a parte 10 tenha sido assinada
    - expect: status `409` com `error: "UPLOAD_PART_NOT_SIGNED"`
  2. Assinar a parte 1 e, em seguida, fazer POST part-urls com `completedParts: [{ "partNumber": 1, "etag": "\"abc\"" }]`
    - expect: status `200` com `registeredParts: [1]`
    - expect: `upload_parts` grava o ETag e o `etag_registered_at` da parte 1

### 3. Autorização

**Setup:** o mesmo do grupo 1.

#### 3.1. usuario-que-nao-e-dono-recebe-404

**Covers AC:** #6
**Source:** auto
**Last sync:** 2026-11-21T02:43:13Z

**Steps:**
  1. Com o token do dono, POST /videos com body válido
    - expect: status `201`
  2. Com o token do segundo usuário, POST part-urls no `publicId` e no `sessionId` do dono
    - expect: status `404` com `error: "VIDEO_NOT_FOUND"`
    - expect: nenhuma linha nova em `upload_parts`
  3. Sem token, POST part-urls nos mesmos identificadores
    - expect: status `401`

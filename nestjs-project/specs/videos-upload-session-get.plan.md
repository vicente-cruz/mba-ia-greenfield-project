---
subproject: backend
runner: jest+supertest
scope: phase-03-videos
si: SI-03.14
target_file: test/videos-upload-session-get.e2e-spec.ts
---

# GET /videos/:publicId/upload-sessions/:sessionId — Test Plan

## Application Overview

O endpoint devolve o estado da sessão de upload. Numa sessão `active`, ele também classifica cada parte do plano, comparando o `ListParts` paginado com o registro da API:

| Classe | Situação da parte |
|--------|-------------------|
| `confirmed` | Presente, com ETag, checksum e tamanho iguais aos registrados |
| `missing` | Ausente |
| `divergent` | Presente, mas diferente do registro |
| `unregistered` | Presente, sem ETag registrado |

A classificação é a base da retomada e da conferência na conclusão. Para os demais estados:
- **Sessão fora de `active`:** a resposta traz `parts: []`.
- **`NoSuchUpload` numa sessão `active`:** a sessão é abortada, e a resposta é `410`.
- **Quem não é dono:** recebe `404`.

## Test Scenarios

### 1. Classificação das partes

**Setup:**
- **Aplicação:** `beforeAll` sobe a aplicação com `Test.createTestingModule({ imports: [AppModule] })`, aplicando o `ValidationPipe` e os filtros globais de `main.ts`.
- **Infraestrutura:** Postgres, storage e Redis reais do Compose (R-10).
- **Filas:** `beforeAll` pausa `video-processing` e `video-maintenance` com `test/helpers/queues.ts` (SI-03.11).
- **Antes de cada cenário:** `beforeEach` executa `cleanAllTables`, limpa o throttler, garante as filas pausadas e limpa os jobs da `video-processing`.
- **Encerramento:** `afterAll` retoma as duas filas e fecha a aplicação.
- **Tamanho das partes:** a suíte usa `UPLOAD_PART_SIZE_BYTES=5242880` (5 MiB, o mínimo da S3), pelos limites configuráveis da TD-15. Assim, cada arquivo tem poucas partes.
- **Usuários:** o dono e um segundo usuário são autenticados pelos endpoints de auth.
- **Dados de cada cenário:** cada cenário cria os próprios dados. Quando um cenário envia partes, usa as URLs devolvidas pelo próprio pedido de `part-urls`, com corpo de exatamente `expectedSize` bytes e o header devolvido.
- **Requisições às URLs assinadas:** saem do container de testes. Elas se conectam ao serviço `storage` do Compose e mantêm o header `Host` igual ao host de `S3_PUBLIC_ENDPOINT`, que faz parte da assinatura SigV4. A assinatura não é refeita.

#### 1.1. sessao-sem-partes-enviadas-tem-todas-missing

**Covers AC:** #1
**Source:** auto
**Last sync:** 2026-11-21T02:43:13Z

**Steps:**
  1. POST /videos com `sizeBytes` de 3 partes de 5 MiB, sem enviar nenhuma parte
  2. GET /videos/{publicId}/upload-sessions/{sessionId}
    - expect: status `200` com `status: "active"`, `expired: false` e `fileMismatch: false`
    - expect: `parts` tem 3 entradas, todas com `state: "missing"`, `checksumSha256: null` e `etag: null`

#### 1.2. partes-confirmed-unregistered-e-divergent

**Covers AC:** #2
**Source:** auto
**Last sync:** 2026-11-21T02:43:13Z

**Steps:**
  1. POST /videos com `sizeBytes` de 3 partes de 5 MiB
  2. Assinar as partes 1, 2 e 3, enviar as três pelas URLs assinadas e registrar os ETags das partes 1 e 3
  3. Reenviar a parte 3 com outro conteúdo diretamente pelo cliente S3 interno (`UploadPart` no mesmo `upload_id`), simulando uma gravação concorrente na infraestrutura real
  4. GET da sessão
    - expect: status `200`
    - expect: a parte 1 vem como `"confirmed"`, a parte 2 como `"unregistered"` e a parte 3 como `"divergent"`
    - expect: cada entrada traz o `checksumSha256` registrado

#### 1.3. sessao-concluida-devolve-partes-vazias

**Covers AC:** #3
**Source:** auto
**Last sync:** 2026-11-21T02:43:13Z

**Steps:**
  1. Preparar, com `test/helpers/video-fixtures.ts`, um vídeo do dono no estado que a finalização de P2 deixa:
     - vídeo em `processing`, com `processing_run = 1`, `processing_dispatch = 1` e `original_key` igual à `object_key` da sessão;
     - sessão vigente `completed`;
     - original gravado no storage nessa chave, com o tamanho declarado
  2. GET da sessão
    - expect: status `200` com `status: "completed"` e `parts: []`

#### 1.4. upload-desconhecido-pelo-storage-retorna-410

**Covers AC:** #4
**Source:** auto
**Last sync:** 2026-11-21T02:43:13Z

**Steps:**
  1. POST /videos com `sizeBytes` de 1 parte de 5 MiB
  2. Abortar o multipart da sessão diretamente pelo cliente S3 interno, simulando a limpeza automática do storage (F-10)
  3. GET da sessão
    - expect: status `410` com `error: "UPLOAD_SESSION_EXPIRED"`
    - expect: no banco, a sessão passa a `aborted`, e o vídeo continua em `draft`

### 2. Autorização

**Setup:** o mesmo do grupo 1.

#### 2.1. usuario-que-nao-e-dono-recebe-404

**Covers AC:** #5
**Source:** auto
**Last sync:** 2026-11-21T02:43:13Z

**Steps:**
  1. Com o token do dono, POST /videos com body válido
    - expect: status `201`
  2. Com o token do segundo usuário, GET da sessão do dono
    - expect: status `404` com `error: "VIDEO_NOT_FOUND"`
  3. Com o token do dono, GET com um `sessionId` inexistente
    - expect: status `404` com `error: "UPLOAD_SESSION_NOT_FOUND"`

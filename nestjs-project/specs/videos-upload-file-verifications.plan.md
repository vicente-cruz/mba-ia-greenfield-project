---
subproject: backend
runner: jest+supertest
scope: phase-03-videos
si: SI-03.15
target_file: test/videos-upload-file-verifications.e2e-spec.ts
---

# POST /videos/:publicId/upload-sessions/:sessionId/file-verifications — Test Plan

## Application Overview

Na retomada, o cliente seleciona o arquivo de novo e recalcula o SHA-256 das partes que o storage já recebeu. Depois, envia esses checksums para conferência. O conjunto obrigatório são as partes `confirmed` e `unregistered`, e a conferência cobre todas elas (Q-10).

| Situação | Resposta |
|----------|----------|
| Nenhuma parte recebida | Lista vazia aceita: `match` com 0 partes |
| Falta alguma parte obrigatória | `400 UPLOAD_VERIFICATION_INCOMPLETE` |
| Algum checksum diferente do registrado | `409 UPLOAD_FILE_MISMATCH`, e a sessão fica bloqueada (`file_mismatch_at`) |

Com a sessão bloqueada, assinar novas partes também falha (F-11, G-11). Este spec cobre a detecção e o bloqueio da assinatura. O fluxo T-06 completo fica no spec da SI-03.18, que já tem a conclusão e o reinício disponíveis: lá se verifica que a conclusão continua bloqueada e que só um reinício explícito retoma o upload.

## Test Scenarios

### 1. Conferência do arquivo na retomada

**Setup:**
- **Aplicação:** `beforeAll` sobe a aplicação com `Test.createTestingModule({ imports: [AppModule] })`, aplicando o `ValidationPipe` e os filtros globais de `main.ts`.
- **Infraestrutura:** Postgres, storage e Redis reais do Compose (R-10).
- **Filas:** `beforeAll` pausa `video-processing` e `video-maintenance` com `test/helpers/queues.ts` (SI-03.11).
- **Antes de cada cenário:** `beforeEach` executa `cleanAllTables`, limpa o throttler, garante as filas pausadas e limpa os jobs da `video-processing`.
- **Encerramento:** `afterAll` retoma as duas filas e fecha a aplicação.
- **Tamanho das partes:** a suíte usa `UPLOAD_PART_SIZE_BYTES=5242880`.
- **Usuário:** o dono é autenticado pelos endpoints de auth.
- **Arquivo de teste:** o arquivo A é gerado em memória, com 3 partes: duas de 5 MiB e um resto.
- **Dados de cada cenário:** cada cenário cria o próprio vídeo por POST /videos, declarando o tamanho de A. Ele envia só as partes que o próprio cenário indica, pelas URLs que ele mesmo obtém em `part-urls`. Nenhuma parte é enviada pelo setup.
- **Requisições às URLs assinadas:** saem do container de testes. Elas se conectam ao serviço `storage` do Compose e mantêm o header `Host` igual ao host de `S3_PUBLIC_ENDPOINT`, que faz parte da assinatura SigV4. A assinatura não é refeita.

#### 1.1. retomada-sem-partes-recebidas-aceita-lista-vazia

**Covers AC:** #1
**Source:** auto
**Last sync:** 2026-11-21T02:43:13Z

**Steps:**
  1. POST /videos com o tamanho de A, sem assinar nem enviar nenhuma parte
    - expect: status `201`
  2. POST file-verifications com `parts: []`
    - expect: status `200` com `{ "result": "match", "verifiedParts": 0 }`
    - expect: a sessão continua `active`, sem `file_mismatch_at`
  3. POST part-urls com a parte 1 e o checksum de A
    - expect: status `200`, mostrando que a sessão não foi bloqueada

#### 1.2. checksums-iguais-confirmam-o-mesmo-arquivo

**Covers AC:** #2
**Source:** auto
**Last sync:** 2026-11-21T02:43:13Z

**Steps:**
  1. POST /videos com o tamanho de A
  2. Assinar e enviar as partes 1 e 2 de A e registrar só o ETag da parte 1
    - expect: o GET da sessão mostra a parte 1 `confirmed`, a parte 2 `unregistered` e a parte 3 `missing`
  3. POST file-verifications com os checksums de A para as partes 1 e 2
    - expect: status `200` com `{ "result": "match", "verifiedParts": 2 }`

#### 1.3. parte-confirmada-faltando-retorna-400

**Covers AC:** #3
**Source:** auto
**Last sync:** 2026-11-21T02:43:13Z

**Steps:**
  1. POST /videos com o tamanho de A
  2. Assinar, enviar e registrar as partes 1 e 2 de A
  3. POST file-verifications só com a parte 1
    - expect: status `400` com `error: "UPLOAD_VERIFICATION_INCOMPLETE"`
    - expect: a sessão continua sem `file_mismatch_at`

### 2. Arquivo trocado na retomada (T-06, detecção)

**Setup:** o mesmo do grupo 1. O arquivo A' é igual a A, exceto por 1 byte alterado dentro da parte 1.

#### 2.1. arquivo-com-um-byte-alterado-bloqueia-a-sessao

**Covers AC:** #4
**Source:** auto
**Last sync:** 2026-11-21T02:43:13Z

**Steps:**
  1. POST /videos com o tamanho de A
  2. Assinar, enviar e registrar as partes 1 e 2 de A
    - expect: o GET da sessão mostra as duas partes `confirmed`
  3. Simular a retomada com A': recalcular os checksums das partes 1 e 2 a partir de A' e fazer POST file-verifications
    - expect: status `409` com `error: "UPLOAD_FILE_MISMATCH"`
    - expect: a sessão tem `file_mismatch_at` preenchido, e os checksums registrados continuam os de A
    - expect: o GET da sessão devolve `fileMismatch: true`
  4. POST part-urls com a parte 3 e o checksum de A'
    - expect: status `409` com `error: "UPLOAD_FILE_MISMATCH"`
    - expect: nenhuma linha nova em `upload_parts`

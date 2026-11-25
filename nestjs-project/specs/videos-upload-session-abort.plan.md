---
subproject: backend
runner: jest+supertest
scope: phase-03-videos
si: SI-03.17
target_file: test/videos-upload-session-abort.e2e-spec.ts
---

# DELETE /videos/:publicId/upload-sessions/:sessionId — Test Plan

## Application Overview

O endpoint aborta a sessão de upload em duas etapas:
1. **Claim:** com o vídeo bloqueado, a sessão passa a `aborting`, com novo token.
2. **Abort no storage:** fora de transação, o `AbortMultipartUpload` é repetido até o `ListParts` responder `NoSuchUpload`. Depois, a sessão é marcada `aborted`, condicionada ao token.

| Situação | Resposta |
|----------|----------|
| Abort concluído | `204`; o vídeo continua em `draft` |
| Repetição sobre sessão `aborted` | `204` |
| Sessão `completing` | `409 UPLOAD_SESSION_COMPLETING` (F-07) |

## Test Scenarios

### 1. Abort da sessão

**Setup:**
- **Aplicação:** `beforeAll` sobe a aplicação com `Test.createTestingModule({ imports: [AppModule] })`, aplicando o `ValidationPipe` e os filtros globais de `main.ts`.
- **Infraestrutura:** Postgres, storage e Redis reais do Compose (R-10).
- **Filas:** `beforeAll` pausa `video-processing` e `video-maintenance` com `test/helpers/queues.ts` (SI-03.11). Assim, a varredura de sessões não age sobre os estados preparados pelos cenários.
- **Antes de cada cenário:** `beforeEach` executa `cleanAllTables`, limpa o throttler, garante as filas pausadas e limpa os jobs da `video-processing`.
- **Encerramento:** `afterAll` retoma as duas filas e fecha a aplicação.
- **Tamanho das partes:** a suíte usa `UPLOAD_PART_SIZE_BYTES=5242880`.
- **Usuário:** o dono é autenticado pelos endpoints de auth.
- **Dados de cada cenário:** cada cenário cria o próprio vídeo por POST /videos. Quando envia partes, usa as URLs que ele mesmo obtém em `part-urls`.
- **Requisições às URLs assinadas:** saem do container de testes. Elas se conectam ao serviço `storage` do Compose e mantêm o header `Host` igual ao host de `S3_PUBLIC_ENDPOINT`, que faz parte da assinatura SigV4. A assinatura não é refeita.

#### 1.1. abort-de-sessao-ativa-retorna-204-e-mantem-o-rascunho

**Covers AC:** #1, #4
**Source:** auto
**Last sync:** 2026-11-21T02:43:13Z

**Steps:**
  1. Criar o vídeo e enviar a parte 1 pela URL assinada
  2. DELETE /videos/{publicId}/upload-sessions/{sessionId}
    - expect: status `204`, sem corpo
  3. Consultar o storage e o banco
    - expect: o `ListParts` do `upload_id` da sessão responde `NoSuchUpload`
    - expect: a sessão está `aborted`, e o vídeo continua em `draft`, com `current_upload_session_id` apontando para ela

#### 1.2. abort-repetido-retorna-204

**Covers AC:** #2
**Source:** auto
**Last sync:** 2026-11-21T02:43:13Z

**Steps:**
  1. Criar o vídeo e fazer DELETE da sessão
    - expect: status `204`
  2. DELETE da mesma sessão de novo
    - expect: status `204`, com a sessão ainda `aborted` e sem outra mudança no banco

#### 1.3. abort-de-sessao-em-conclusao-retorna-409

**Covers AC:** #3
**Source:** auto
**Last sync:** 2026-11-21T02:43:13Z

**Steps:**
  1. Criar o vídeo e colocar a sessão em `completing` com `test/helpers/video-fixtures.ts`, com `claim_token` e `claim_expires_at` no futuro, simulando uma conclusão em andamento
  2. DELETE da sessão
    - expect: status `409` com `error: "UPLOAD_SESSION_COMPLETING"`
    - expect: a sessão continua `completing`, e o multipart continua existindo no storage

---
subproject: backend
runner: jest+supertest
scope: phase-03-videos
si: SI-03.18
target_file: test/videos-upload-session-restart.e2e-spec.ts
---

# POST /videos/:publicId/upload-sessions — Test Plan

## Application Overview

O endpoint reinicia o upload de um rascunho pelo protocolo P1, havendo sessão anterior:
1. **Intenção (T1):** com o vídeo bloqueado, a sessão vigente é examinada:

   | Sessão vigente | Conduta |
   |----------------|---------|
   | `completing` | 409 `UPLOAD_SESSION_COMPLETING` |
   | `initiating` com claim no prazo | 409 `UPLOAD_SESSION_INITIATING` |
   | `initiating` vencida, ou `active` | Passa a `aborting`, com token |
   | `aborting`, `aborted` ou nenhuma | Segue |

   Depois, uma nova sessão `initiating` é gravada, com nova chave, e o ponteiro do vídeo passa a ela.
2. **Storage:** fora da transação, o `CreateMultipartUpload` da nova chave e o abort da sessão anterior.
3. **Ativação (T2):** a nova sessão vira `active`, condicionada ao token.

Concorrência:
- **Reinícios:** são serializados pela linha do vídeo. O segundo só recebe `409 UPLOAD_SESSION_INITIATING` enquanto o primeiro está com a sessão em `initiating`.
- **Reinício e conclusão:** resolvem-se pelo claim que vence primeiro.

Este spec também traz o fluxo T-06 completo, com a conferência, a conclusão bloqueada e o reinício explícito, porque as três rotas existem nesta SI.

## Test Scenarios

### 1. Reinício de rascunho

**Setup:**
- **Aplicação:** `beforeAll` sobe a aplicação com `Test.createTestingModule({ imports: [AppModule] })`, aplicando o `ValidationPipe` e os filtros globais de `main.ts`.
- **Infraestrutura:** Postgres, storage e Redis reais do Compose (R-10).
- **Filas:** `beforeAll` pausa `video-processing` e `video-maintenance` com `test/helpers/queues.ts` (SI-03.11). Assim, nem o worker nem a varredura de sessões agem sobre os estados preparados pelos cenários.
- **Antes de cada cenário:** `beforeEach` executa `cleanAllTables`, limpa o throttler, garante as filas pausadas e limpa os jobs da `video-processing`.
- **Encerramento:** `afterAll` limpa os jobs da suíte, retoma as duas filas e fecha a aplicação.
- **Tamanho das partes:** a suíte usa `UPLOAD_PART_SIZE_BYTES=5242880`.
- **Usuário:** o dono é autenticado pelos endpoints de auth.
- **Dados de cada cenário:** cada cenário cria o próprio vídeo e obtém as próprias URLs.
- **Requisições às URLs assinadas:** saem do container de testes. Elas se conectam ao serviço `storage` do Compose e mantêm o header `Host` igual ao host de `S3_PUBLIC_ENDPOINT`, que faz parte da assinatura SigV4. A assinatura não é refeita.

#### 1.1. reinicio-com-sessao-ativa-cria-nova-sessao-e-aborta-a-anterior

**Covers AC:** #1
**Source:** auto
**Last sync:** 2026-11-21T02:43:13Z

**Steps:**
  1. POST /videos e enviar a parte 1 na sessão S1
  2. POST /videos/{publicId}/upload-sessions com body válido
    - expect: status `201`, com `uploadSession.id` diferente de S1 e `uploadSession.status: "active"`
  3. Consultar o banco e o storage
    - expect: a nova sessão tem `object_key` diferente da de S1, e o vídeo aponta para ela
    - expect: S1 está `aborted`, e o `ListParts` do upload de S1 responde `NoSuchUpload`

#### 1.2. rascunho-com-sessao-expirada-reinicia

**Covers AC:** #6
**Source:** auto
**Last sync:** 2026-11-21T02:43:13Z

**Steps:**
  1. POST /videos e vencer S1 no banco (`expires_at` no passado). Com a `video-maintenance` pausada, a varredura não altera S1 antes da chamada
  2. POST upload-sessions
    - expect: status `201`, com nova sessão `active`
    - expect: o vídeo continua em `draft`, e S1 termina `aborted`

#### 1.3. video-fora-de-rascunho-retorna-409

**Covers AC:** #5
**Source:** auto
**Last sync:** 2026-11-21T02:43:13Z

**Steps:**
  1. Preparar com `test/helpers/video-fixtures.ts` um vídeo do dono em `processing`, com a sessão vigente `completed`, `original_key` igual à `object_key` dela e o original gravado no storage
  2. POST upload-sessions
    - expect: status `409` com `error: "VIDEO_INVALID_STATE"`
    - expect: nenhuma sessão nova é criada, e o vídeo continua em `processing`

#### 1.4. rascunho-deixado-por-ativacao-que-perdeu-a-posse-aceita-reinicio

**Covers AC:** #7
**Source:** auto
**Last sync:** 2026-11-21T02:43:13Z

**Steps:**
  1. Envolver `StorageService.createMultipartUpload` com uma barreira, disparar POST /videos e, com a requisição retida, simular no banco a tomada de posse da varredura sobre a sessão S1: `status = 'aborting'`, novo `claim_token` e `claim_expires_at` no futuro
  2. Liberar a barreira
    - expect: POST /videos responde `503` com `error: "STORAGE_UNAVAILABLE"`, e o vídeo, lido do banco, continua em `draft` com S1 em `aborting`
  3. Remover a barreira e fazer POST /videos/{publicId}/upload-sessions com body válido
    - expect: status `201`, com uma nova sessão `active` diferente de S1, e o vídeo aponta para ela
  4. Repetir os passos 1 e 2 num vídeo novo e marcar a sessão como `aborted` no banco, como a varredura faria ao concluir. Em seguida, fazer POST upload-sessions
    - expect: status `201`, com nova sessão `active`

### 2. Reinícios e conclusão concorrentes (intercalação controlada)

**Setup:** o mesmo do grupo 1. Para a intercalação controlada, o teste envolve as implementações reais de `StorageService.createMultipartUpload` e de `StorageService.completeMultipartUpload` com barreiras. Cada barreira é um `jest.spyOn` que espera um sinal do teste e só então chama a implementação real. A barreira de `createMultipartUpload` retém um reinício depois de T1, com a nova sessão em `initiating` e o claim no prazo. Os testes não dependem de `Promise.all` para criar a sobreposição.

#### 2.1. segundo-reinicio-durante-a-retencao-recebe-409-initiating

**Covers AC:** #2
**Source:** auto
**Last sync:** 2026-11-21T02:43:13Z

**Steps:**
  1. POST /videos, ativar a barreira de `createMultipartUpload` e disparar o reinício R1, sem aguardar a resposta
    - expect: o banco mostra uma sessão S2 em `initiating`, com o claim no prazo, e o vídeo apontando para S2
  2. Disparar o reinício R2 enquanto R1 continua retido
    - expect: R2 responde `409` com `error: "UPLOAD_SESSION_INITIATING"`
  3. Liberar R1
    - expect: R1 responde `201`, com `uploadSession.id` igual a S2
    - expect: só existe uma sessão `active` para o vídeo

#### 2.2. reinicio-depois-da-ativacao-e-legitimo

**Covers AC:** #3
**Source:** auto
**Last sync:** 2026-11-21T02:43:13Z

**Steps:**
  1. POST /videos e fazer o reinício R1 sem barreira
    - expect: status `201`, com a sessão S2 `active`
  2. Fazer o reinício R2 em seguida
    - expect: status `201`, com uma sessão S3 diferente de S2
    - expect: S2 termina `aborted`, e S3 é a única `active`

#### 2.3. reinicio-e-conclusao-concorrentes-tem-um-unico-vencedor

**Covers AC:** #4
**Source:** auto
**Last sync:** 2026-11-21T02:43:13Z

**Steps:**
  1. Ordem A, com a conclusão chegando primeiro:
     - num vídeo com todas as partes enviadas e registradas, disparar POST completion, retida na barreira de `completeMultipartUpload` depois do claim;
     - em seguida, disparar o reinício
    - expect: o reinício responde `409` com `error: "UPLOAD_SESSION_COMPLETING"`
    - expect: liberada, a conclusão responde `202`
  2. Ordem B, com o reinício chegando primeiro, num vídeo novo também com todas as partes registradas:
     - disparar o reinício, retido na barreira de `createMultipartUpload` depois de T1, com a sessão anterior em `aborting`;
     - em seguida, fazer POST completion na sessão anterior
    - expect: a conclusão responde `409` com `error: "UPLOAD_SESSION_NOT_ACTIVE"`
    - expect: liberado, o reinício responde `201`
    - expect: nas duas ordens, as duas operações nunca vencem juntas

### 3. Arquivo trocado na retomada (T-06, fluxo completo)

**Setup:** o mesmo do grupo 1. O arquivo A é gerado em memória com 3 partes, duas de 5 MiB e um resto. O arquivo A' é igual a A, exceto por 1 byte alterado dentro da parte 1.

#### 3.1. conferencia-reprovada-bloqueia-a-conclusao-ate-o-reinicio-explicito

**Covers AC:** #8
**Source:** auto
**Last sync:** 2026-11-21T02:43:13Z

**Steps:**
  1. POST /videos com o tamanho de A, depois assinar, enviar e registrar as partes 1 e 2 de A
  2. Simular a retomada com A': fazer POST file-verifications com os checksums das partes 1 e 2 calculados a partir de A'
    - expect: status `409` com `error: "UPLOAD_FILE_MISMATCH"`, e a sessão S1 com `file_mismatch_at` preenchido
  3. POST completion em S1
    - expect: status `409` com `error: "UPLOAD_FILE_MISMATCH"`
    - expect: o vídeo continua em `draft`, e nenhum job é criado
  4. POST /videos/{publicId}/upload-sessions com a declaração de A'
    - expect: status `201`, com uma nova sessão `active`
    - expect: o GET da nova sessão devolve `fileMismatch: false`, e S1 termina `aborted`
  5. POST part-urls na nova sessão, com a parte 1 e o checksum de A'
    - expect: status `200`, mostrando que só o reinício explícito continua o upload

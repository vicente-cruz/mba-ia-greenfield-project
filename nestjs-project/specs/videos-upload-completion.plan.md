---
subproject: backend
runner: jest+supertest
scope: phase-03-videos
si: SI-03.16
target_file: test/videos-upload-completion.e2e-spec.ts
---

# POST /videos/:publicId/upload-sessions/:sessionId/completion — Test Plan

## Application Overview

O endpoint conclui o upload pelo protocolo P2:
1. **Claim:** com o vídeo bloqueado, a sessão passa de `active` a `completing`, com token e prazo. O claim exige `file_mismatch_at` nulo.
2. **Conferência e Complete:** fora de transação, as partes registradas são conferidas com o `ListParts`, e o `CompleteMultipartUpload` é montado pelo registro. Um `NoSuchUpload` é resolvido por `HeadObject` na chave da própria sessão.
3. **Finalização (T2):** numa única transação, a sessão vai para `completed` pelo token. No mesmo passo, o vídeo vai de `draft` a `processing`, com `original_key`, a geração 1 e a ação `publish` pendente.
4. **Publicação:** depois do commit, o job `video-{videoId}-{run}-1` é publicado.

| Situação | Resposta |
|----------|----------|
| Transição feita nesta chamada | `202` |
| Sessão já `completed` e vigente | `200` |
| Perda de posse, com outro concluidor | `409 UPLOAD_SESSION_COMPLETING`, nunca `200` |
| Sessão bloqueada | `409 UPLOAD_FILE_MISMATCH` |
| Falha na publicação | `202` mesmo assim; a ação fica pendente para a reconciliação |

## Test Scenarios

### 1. Conclusão bem-sucedida

**Setup:**
- **Aplicação:** `beforeAll` sobe a aplicação com `Test.createTestingModule({ imports: [AppModule] })`, aplicando o `ValidationPipe` e os filtros globais de `main.ts`.
- **Infraestrutura:** Postgres, storage e Redis reais do Compose (R-10).
- **Usuário:** o dono é autenticado pelos endpoints de auth.
- **Filas:** `beforeAll` pausa `video-processing` e `video-maintenance` com `test/helpers/queues.ts` (SI-03.11) e espera os jobs ativos terminarem. Com isso, o `video-worker` (serviço da SI-03.20 em diante) não consome os jobs criados pelos cenários. As asserções sobre o vídeo em `processing` e sobre o job não dependem de chegar antes do worker.
- **Antes de cada cenário:** `beforeEach` executa `cleanAllTables`, limpa o throttler, garante as filas pausadas e limpa os jobs da `video-processing`.
- **Encerramento:** `afterAll` limpa os jobs da suíte, retoma as duas filas e fecha a aplicação.
- **Inspeção da fila:** uma `Queue('video-processing')` do BullMQ, no mesmo Redis, é usada para inspecionar os jobs.
- **Tamanho das partes:** a suíte usa `UPLOAD_PART_SIZE_BYTES=5242880`.
- **Dados de cada cenário:** cada cenário cria o próprio vídeo com 2 partes (5 MiB e um resto), por POST /videos. Ele envia e registra só as partes que o próprio cenário indica, pelas URLs que ele mesmo obtém em `part-urls`.
- **Requisições às URLs assinadas:** saem do container de testes. Elas se conectam ao serviço `storage` do Compose e mantêm o header `Host` igual ao host de `S3_PUBLIC_ENDPOINT`, que faz parte da assinatura SigV4. A assinatura não é refeita.

#### 1.1. conclusao-publica-a-geracao-1-e-grava-o-original

**Covers AC:** #1, #7
**Source:** auto
**Last sync:** 2026-11-21T02:43:13Z

**Steps:**
  1. Criar o vídeo e enviar e registrar as partes 1 e 2
  2. POST completion
    - expect: status `202` com `status: "processing"`
  3. Consultar o banco
    - expect: a sessão está `completed`, e o vídeo está em `processing`, com `processing_run = 1`, `processing_dispatch = 1` e `pending_job_action` nulo
    - expect: `original_key` é igual à `object_key` da sessão concluída
  4. Consultar a fila e o storage
    - expect: o job `video-{videoId}-1-1` existe na fila `video-processing`, com `removeOnComplete` e `removeOnFail` desligados
    - expect: o job não está `active`, `completed` nem `failed`, porque a fila está pausada
    - expect: `HeadObject` em `original_key` devolve o tamanho declarado

#### 1.2. repeticao-depois-do-sucesso-retorna-200-sem-novo-job

**Covers AC:** #2
**Source:** auto
**Last sync:** 2026-11-21T02:43:13Z

**Steps:**
  1. Criar o vídeo, enviar e registrar as partes 1 e 2, e fazer POST completion
    - expect: status `202`
  2. POST completion de novo
    - expect: status `200` com `status: "processing"`, que é o estado atual do vídeo com a fila pausada
    - expect: `processing_run` continua 1, e a fila tem um único job com prefixo `video-{videoId}-1-`

#### 1.3. complete-ja-feito-no-storage-conclui-com-202

**Covers AC:** #4
**Source:** auto
**Last sync:** 2026-11-21T02:43:13Z

**Steps:**
  1. Criar o vídeo e enviar e registrar as partes 1 e 2
  2. Executar o `CompleteMultipartUpload` da sessão diretamente pelo cliente S3 interno, montado com as partes registradas (T-01)
  3. POST completion
    - expect: status `202` com `status: "processing"`
    - expect: `original_key` é a `object_key` da sessão, e o objeto tem o tamanho declarado

### 2. Conclusões concorrentes

**Setup:** o mesmo do grupo 1. Para a intercalação controlada, o teste envolve a implementação real de `StorageService.completeMultipartUpload` com uma barreira: um `jest.spyOn` que espera um sinal do teste e só então chama a implementação real.

#### 2.1. duas-conclusoes-em-paralelo-fazem-uma-unica-transicao

**Covers AC:** #1, #5
**Source:** auto
**Last sync:** 2026-11-21T02:43:13Z

**Steps:**
  1. Criar o vídeo e enviar e registrar as partes 1 e 2
  2. Disparar duas POST completion ao mesmo tempo (`Promise.all`), sem barreira (T-02)
    - expect: exatamente uma resposta é `202`
    - expect: a outra resposta é `409` com `error: "UPLOAD_SESSION_COMPLETING"`, se as chamadas se sobrepuseram, ou `200`, se ela chegou depois da finalização
    - expect: nunca há duas respostas `202`
    - expect: o vídeo tem `processing_run = 1`, e a fila tem um único job, `video-{videoId}-1-1`

#### 2.2. chamada-que-perde-a-posse-retorna-409-e-nunca-200

**Covers AC:** #5
**Source:** auto
**Last sync:** 2026-11-21T02:43:13Z

**Steps:**
  1. Criar o vídeo e enviar e registrar as partes 1 e 2
  2. Disparar a chamada A de POST completion e retê-la na barreira, depois do claim
    - expect: o banco mostra a sessão em `completing`, com o token de A
  3. Vencer o claim de A no banco (`claim_expires_at` no passado) e disparar a chamada B, também retida na barreira
    - expect: o banco mostra a sessão em `completing`, com um token diferente, o de B
  4. Liberar A
    - expect: A responde `409` com `error: "UPLOAD_SESSION_COMPLETING"`, nunca `200`: perdeu o token, e a releitura encontrou B concluindo
  5. Liberar B
    - expect: B responde `202`
    - expect: há uma única transição (`processing_run = 1`) e um único job

### 3. Falhas, bloqueio e publicação

**Setup:** o mesmo do grupo 1.

#### 3.1. parte-sem-etag-registrado-retorna-409-incomplete

**Covers AC:** #3
**Source:** auto
**Last sync:** 2026-11-21T02:43:13Z

**Steps:**
  1. Criar o vídeo e enviar as partes 1 e 2, registrando só o ETag da parte 1
    - expect: o GET da sessão mostra a parte 2 `unregistered`
  2. POST completion
    - expect: status `409` com `error: "UPLOAD_INCOMPLETE"`
    - expect: a sessão volta a `active`, o vídeo continua em `draft`, e nenhum job é criado

#### 3.2. falha-na-publicacao-deixa-a-acao-pendente

**Covers AC:** #6
**Source:** auto
**Last sync:** 2026-11-21T02:43:13Z

**Steps:**
  1. Criar o vídeo e enviar e registrar as partes 1 e 2
  2. Fazer o `add` do `VideoJobDispatcher` rejeitar uma vez, simulando o Redis indisponível na publicação
  3. POST completion
    - expect: status `202` com `status: "processing"`
    - expect: o vídeo fica em `processing`, com `pending_job_action = 'publish'`, `pending_job_dispatch = 1` e `pending_job_token` preenchido
    - expect: o job `video-{videoId}-1-1` não existe na fila

#### 3.3. sessao-bloqueada-por-conferencia-reprovada-retorna-409

**Covers AC:** #8
**Source:** auto
**Last sync:** 2026-11-21T02:43:13Z

**Steps:**
  1. Criar o vídeo e enviar e registrar as partes 1 e 2
  2. Gravar `file_mismatch_at` na sessão com `test/helpers/video-fixtures.ts`, no mesmo estado que uma conferência reprovada deixa
  3. POST completion
    - expect: status `409` com `error: "UPLOAD_FILE_MISMATCH"`
    - expect: a sessão continua `active`, com `file_mismatch_at` preenchido, e o vídeo continua em `draft`
    - expect: nenhum job é criado, e o multipart continua aberto no storage

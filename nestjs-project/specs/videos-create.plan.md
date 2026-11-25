---
subproject: backend
runner: jest+supertest
scope: phase-03-videos
si: SI-03.12
target_file: test/videos-create.e2e-spec.ts
---

# POST /videos — Test Plan

## Application Overview

`POST /videos` pré-cadastra um vídeo como rascunho no canal do usuário autenticado e cria a primeira sessão de upload pelo protocolo P1:
1. **Intenção (T1):** grava o vídeo em `draft` e a sessão em `initiating`, com chave `originals/{videoId}/{sessionId}` e token de claim, antes de qualquer chamada ao storage.
2. **Storage:** fora da transação, executa `CreateMultipartUpload`.
3. **Ativação (T2):** passa a sessão a `active`, condicionada ao token.

Regras de entrada:
- **Validação estrutural (400):** feita pelo DTO.
- **Limite de tamanho (413) e tipo não suportado (415):** regras de domínio, aplicadas pelo service.

Falhas do storage:
- **Falha do `CreateMultipartUpload`:** é compensada com a remoção do vídeo e da sessão.
- **Ativação que perde a posse para a varredura:** aborta o próprio upload, sem compensação. O rascunho fica na condição de reinício de P1; o reinício em si é verificado no spec da SI-03.18.

O `publicId` (11 caracteres base64url) é a única identidade exposta.

## Test Scenarios

### 1. Pré-cadastro do vídeo e primeira sessão

**Setup:**
- **Aplicação:** `beforeAll` sobe a aplicação com `Test.createTestingModule({ imports: [AppModule] })`, aplicando o `ValidationPipe`, o `DomainExceptionFilter` e o `ValidationExceptionFilter` de `main.ts`.
- **Infraestrutura:** Postgres, storage e Redis reais do Compose (R-10). A configuração é a padrão: `UPLOAD_PART_SIZE_BYTES=67108864` e `VIDEO_MAX_SIZE_BYTES=10000000000`.
- **Filas:** `beforeAll` pausa `video-processing` e `video-maintenance` com `test/helpers/queues.ts` (SI-03.11). Assim, o `video-worker` (serviço da SI-03.20 em diante) não processa jobs nem roda manutenção sobre os dados da suíte.
- **Antes de cada cenário:** `beforeEach` executa `cleanAllTables`, limpa o throttler, garante as filas pausadas e limpa os jobs da `video-processing`.
- **Usuário:** é registrado, confirmado e autenticado pelos endpoints de auth, como em `test/auth.e2e-spec.ts`.
- **Encerramento:** `afterAll` aborta os multiparts criados pela suíte, retoma as duas filas e fecha a aplicação.

#### 1.1. criar-video-de-10gb-retorna-rascunho-e-sessao-ativa

**Covers AC:** #1, #7
**Source:** auto
**Last sync:** 2026-11-21T02:43:13Z

**Steps:**
  1. POST /videos com `Authorization: Bearer <token>` e body `{ "fileName": "a.mp4", "sizeBytes": 10000000000, "contentType": "video/mp4" }`
    - expect: status `201`
    - expect: `publicId` casa com `^[A-Za-z0-9_-]{11}$`, e `status` é `"draft"`
    - expect: `uploadSession.status` é `"active"`, `partSize` é `67108864`, `partCount` é `150` e `checksumAlgorithm` é `"SHA256"`
    - expect: `expiresAt` cai cerca de 24 h depois da requisição
  2. Consultar o banco pelo `publicId` devolvido
    - expect: existe um vídeo em `draft` no canal do usuário, com `current_upload_session_id` igual a `uploadSession.id`
    - expect: a sessão está `active`, com `object_key` igual a `originals/{videoId}/{sessionId}` e `upload_id` preenchido
    - expect: `ListMultipartUploads` com prefixo `object_key` encontra exatamente um upload
  3. Percorrer o corpo da resposta
    - expect: o UUID interno do vídeo (`videos.id`) não aparece em nenhum campo

#### 1.2. tamanho-acima-do-limite-retorna-413

**Covers AC:** #2
**Source:** auto
**Last sync:** 2026-11-21T02:43:13Z

**Steps:**
  1. POST /videos com `sizeBytes: 10000000001` e `contentType: "video/mp4"`
    - expect: status `413` com `error: "VIDEO_TOO_LARGE"`
    - expect: `message` contém `10000000000`
    - expect: nenhum vídeo é criado e nenhum multipart é iniciado

#### 1.3. tipo-nao-suportado-415-e-forma-invalida-400

**Covers AC:** #3
**Source:** auto
**Last sync:** 2026-11-21T02:43:13Z

**Steps:**
  1. POST /videos com `contentType: "video/quicktime"` e os demais campos válidos
    - expect: status `415` com `error: "UNSUPPORTED_VIDEO_TYPE"`
  2. POST /videos com `contentType: "abc"`
    - expect: status `400`, pelo envelope de validação
  3. POST /videos sem `sizeBytes`, e outra vez com `sizeBytes: 1.5`
    - expect: status `400` nos dois casos
    - expect: nenhum vídeo é criado em nenhum dos casos

#### 1.4. sem-token-retorna-401

**Covers AC:** #4
**Source:** auto
**Last sync:** 2026-11-21T02:43:13Z

**Steps:**
  1. POST /videos com body válido e sem `Authorization`
    - expect: status `401`
    - expect: nenhum vídeo é criado

### 2. Falhas do storage na criação (P1)

**Setup:** o mesmo do grupo 1. Para controlar a falha ou a intercalação, o teste envolve a implementação real de `StorageService.createMultipartUpload` com `jest.spyOn`, como descrito em cada cenário. As demais chamadas ao storage são reais. Com a `video-maintenance` pausada, a varredura real não roda; quando um cenário precisa dela, a tomada de posse é simulada no banco.

#### 2.1. falha-no-create-multipart-compensa-e-retorna-503

**Covers AC:** #5
**Source:** auto
**Last sync:** 2026-11-21T02:43:13Z

**Steps:**
  1. Fazer `StorageService.createMultipartUpload` rejeitar uma vez, com erro transitório do storage
  2. POST /videos com body válido
    - expect: status `503` com `error: "STORAGE_UNAVAILABLE"`
  3. Consultar o banco
    - expect: nenhum vídeo no canal do usuário e nenhuma linha em `upload_sessions`

#### 2.2. ativacao-que-perde-a-posse-deixa-o-rascunho-na-condicao-de-reinicio

**Covers AC:** #6
**Source:** auto
**Last sync:** 2026-11-21T02:43:13Z

**Steps:**
  1. Envolver `StorageService.createMultipartUpload` com uma barreira: o spy espera um sinal do teste e só então chama a implementação real
  2. Disparar POST /videos com body válido, sem aguardar a resposta
    - expect: com a requisição retida, o banco mostra o vídeo em `draft` e a sessão em `initiating`
  3. Simular no banco a tomada de posse que a varredura faria depois do prazo do claim: `status = 'aborting'`, novo `claim_token` e `claim_expires_at` no futuro
  4. Liberar a barreira e aguardar a resposta
    - expect: status `503` com `error: "STORAGE_UNAVAILABLE"`
    - expect: `ListMultipartUploads` com o prefixo da sessão não encontra nenhum upload, porque o próprio upload foi abortado
  5. Consultar o banco
    - expect: o vídeo continua em `draft`, com `current_upload_session_id` apontando para a sessão
    - expect: a sessão está em `aborting`, com o `claim_token` simulado, e o vídeo não tem nenhuma sessão `active` ou `initiating` no prazo: é a condição de reinício de P1

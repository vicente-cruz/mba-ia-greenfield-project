---
subproject: backend
runner: jest+supertest
scope: phase-03-videos
si: SI-03.19
target_file: test/videos-get.e2e-spec.ts
---

# GET /videos/:publicId — Test Plan

## Application Overview

O endpoint expõe ao dono os dados do vídeo:
- o estado (`draft`, `processing`, `ready` ou `error`);
- os metadados extraídos e `hasThumbnail`;
- o código e a mensagem de erro;
- a sessão de upload vigente.

É a rota de acompanhamento do processamento por polling (Q-09), com limite de 60 requisições a cada 60 s por IP. Quem não é dono, ou usa um `publicId` malformado, recebe `404`, sem distinção de um vídeo inexistente (Q-02).

Os estados que só o processamento produz são preparados por fixture. O processamento real até `error` fica no spec da SI-03.28, porque o processor só existe a partir da SI-03.22.

## Test Scenarios

### 1. Estado e metadados do vídeo

**Setup:**
- **Aplicação:** `beforeAll` sobe a aplicação com `Test.createTestingModule({ imports: [AppModule] })`, aplicando o `ValidationPipe` e os filtros globais de `main.ts`.
- **Infraestrutura:** Postgres, storage e Redis reais do Compose (R-10).
- **Filas:** `beforeAll` pausa `video-processing` e `video-maintenance` com `test/helpers/queues.ts` (SI-03.11). Assim, nem o worker nem a manutenção alteram os estados preparados.
- **Antes de cada cenário:** `beforeEach` executa `cleanAllTables`, limpa o throttler, garante as filas pausadas e limpa os jobs da `video-processing`.
- **Encerramento:** `afterAll` retoma as duas filas e fecha a aplicação.
- **Usuários:** o dono e um segundo usuário são autenticados pelos endpoints de auth.
- **Dados de cada cenário:** cada cenário cria o próprio vídeo.

#### 1.1. dono-recebe-estado-metadados-e-sessao-vigente

**Covers AC:** #1
**Source:** auto
**Last sync:** 2026-11-21T02:43:13Z

**Steps:**
  1. POST /videos com `fileName: "clip.mp4"`, `contentType: "video/mp4"` e `sizeBytes: 1048576`
  2. GET /videos/{publicId} com o token do dono
    - expect: status `200` com `status: "draft"`, `originalFilename: "clip.mp4"`, `contentType: "video/mp4"`, `sizeBytes: 1048576` e `hasThumbnail: false`
    - expect: `uploadSession.id` é igual ao da sessão criada, com `status: "active"` e `expiresAt` preenchido
    - expect: `durationSeconds`, `width`, `height`, `videoCodec`, `audioCodec`, `errorCode` e `errorMessage` vêm `null`

#### 1.2. nao-dono-e-publicid-malformado-recebem-404

**Covers AC:** #2
**Source:** auto
**Last sync:** 2026-11-21T02:43:13Z

**Steps:**
  1. Com o token do dono, POST /videos com body válido
  2. Com o token do segundo usuário, GET /videos/{publicId} do vídeo do dono
    - expect: status `404` com `error: "VIDEO_NOT_FOUND"`
  3. Com o token do dono, GET /videos/abc
    - expect: status `404` com `error: "VIDEO_NOT_FOUND"`, sem mensagem que revele a regra de formato
  4. GET /videos/{publicId} sem token
    - expect: status `401`

#### 1.3. video-em-error-expoe-codigo-e-mensagem

**Covers AC:** #3
**Source:** auto
**Last sync:** 2026-11-21T02:43:13Z

**Steps:**
  1. Preparar com `test/helpers/video-fixtures.ts` um vídeo do dono em `error`, no estado que o processor deixa para mídia inválida:
     - `processing_run = 1` e `original_key` igual à `object_key` da sessão `completed`;
     - o original gravado no storage;
     - `error_code = 'MEDIA_INVALID'`, `error_message` preenchida e `thumbnail_key` nulo
  2. GET /videos/{publicId}
    - expect: status `200` com `status: "error"`, `errorCode: "MEDIA_INVALID"` e `errorMessage` igual à gravada
    - expect: `hasThumbnail: false`

#### 1.4. polling-de-30-requisicoes-em-60s-nao-recebe-429

**Covers AC:** #4
**Source:** auto
**Last sync:** 2026-11-21T02:43:13Z

**Steps:**
  1. POST /videos com body válido
  2. Fazer 30 GET /videos/{publicId} seguidos, do mesmo cliente, dentro de 60 s
    - expect: todas as respostas são `200`, e nenhuma é `429`

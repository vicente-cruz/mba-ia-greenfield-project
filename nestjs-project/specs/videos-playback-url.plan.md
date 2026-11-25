---
subproject: backend
runner: jest+supertest
scope: phase-03-videos
si: SI-03.27
target_file: test/videos-playback-url.e2e-spec.ts
---

# GET /videos/:publicId/playback-url — Test Plan

## Application Overview

Para o dono de um vídeo em `ready`, o endpoint emite uma URL pré-assinada de curta duração (`PLAYBACK_URL_TTL_SECONDS`) para o original:
- **Endpoint:** a URL aponta para o endpoint público do storage.
- **Tipo:** `ResponseContentType` é igual ao `content_type` do vídeo.
- **Reprodução:** é por download progressivo. O storage responde `206 Partial Content`, com `Content-Range`, a requisições `Range`, sem que os bytes passem pela API (TD-13, TD-14).

Casos de recusa e limite de escopo:
- **Vídeo fora de `ready`, como em `processing`:** recebe `409 VIDEO_NOT_READY`.
- **Quem não é dono:** recebe `404`.
- **Fora do escopo:** a reprodução e o seek em navegador (V-05) ficam para a Fase 05.

## Test Scenarios

### 1. URL de reprodução sobre estados preparados

**Setup:**
- **Aplicação:** `beforeAll` sobe a aplicação com `Test.createTestingModule({ imports: [AppModule] })`, aplicando o `ValidationPipe` e os filtros globais de `main.ts`.
- **Infraestrutura:** Postgres, storage, Redis e `video-worker` reais do Compose (R-10).
- **Filas:** `beforeAll` pausa `video-processing` e `video-maintenance` com `test/helpers/queues.ts` (SI-03.11) e espera os jobs ativos terminarem.
- **Antes de cada cenário:** `beforeEach` executa `cleanAllTables`, limpa o throttler, garante as duas filas pausadas e limpa os jobs da `video-processing`.
- **Encerramento:** `afterAll` limpa os jobs da suíte, retoma as duas filas e fecha a aplicação.
- **Tamanho das partes:** a suíte usa `UPLOAD_PART_SIZE_BYTES=5242880`.
- **Usuários:** o dono e um segundo usuário são autenticados pelos endpoints de auth.
- **Dados de cada cenário:** cada cenário prepara o próprio vídeo e obtém a própria URL.
- **Fixtures do grupo:**
  - o vídeo pronto vem de `test/helpers/video-fixtures.ts`: vídeo `ready` com metadados e sessão `completed`;
  - o original é a fixture MP4 H.264/AAC válida de `test/fixtures/videos/` (SI-03.6), gravada em `original_key`, e uma thumbnail é gravada em `thumbnail_key`.
- **Requisições às URLs assinadas:** saem do container de testes. Elas se conectam ao serviço `storage` do Compose e mantêm o header `Host` igual ao host de `S3_PUBLIC_ENDPOINT`, que faz parte da assinatura SigV4. A assinatura não é refeita.

#### 1.1. video-pronto-recebe-url-com-tipo-e-prazo

**Covers AC:** #1
**Source:** auto
**Last sync:** 2026-11-21T02:43:13Z

**Steps:**
  1. Preparar um vídeo pronto do dono, com `content_type: "video/mp4"`
  2. GET /videos/{publicId}/playback-url com o token do dono
    - expect: status `200` com `url`, `contentType: "video/mp4"` e `expiresAt`
    - expect: `expiresAt` cai `PLAYBACK_URL_TTL_SECONDS` depois da requisição, com tolerância de poucos segundos
    - expect: `url` usa o host de `S3_PUBLIC_ENDPOINT` e referencia a `original_key` do vídeo

#### 1.2. url-responde-206-com-content-range

**Covers AC:** #2
**Source:** auto
**Last sync:** 2026-11-21T02:43:13Z

**Steps:**
  1. Preparar um vídeo pronto do dono e obter a URL com GET playback-url
    - expect: status `200`
  2. Fazer um GET HTTP nessa URL com `Range: bytes=0-1023`
    - expect: status `206 Partial Content`, com `Content-Range: bytes 0-1023/<tamanho da fixture>` e `Content-Type: video/mp4`
    - expect: o corpo tem exatamente 1024 bytes, iguais aos primeiros 1024 bytes da fixture

#### 1.3. video-em-processing-retorna-409

**Covers AC:** #3
**Source:** auto
**Last sync:** 2026-11-21T02:43:13Z

**Steps:**
  1. Preparar com `test/helpers/video-fixtures.ts` um vídeo do dono em `processing`, com `processing_run = 1`, `original_key` igual à `object_key` da sessão `completed` e o original gravado no storage
  2. GET playback-url com o token do dono
    - expect: status `409` com `error: "VIDEO_NOT_READY"`

#### 1.4. nao-dono-recebe-404

**Covers AC:** #3
**Source:** auto
**Last sync:** 2026-11-21T02:43:13Z

**Steps:**
  1. Preparar um vídeo pronto do dono
  2. GET playback-url com o token do segundo usuário
    - expect: status `404` com `error: "VIDEO_NOT_FOUND"`
  3. GET playback-url sem token
    - expect: status `401`

### 2. Processamento real até ready

**Setup:**
- **Base:** o mesmo do grupo 1; o `video-worker` real (SI-03.20 a SI-03.22) processa o job.
- **Fila de processamento:** fica pausada até o cenário conferir o estado `processing` e depois é retomada pelo helper. O `beforeEach` do cenário seguinte volta a pausá-la e espera o job ativo terminar.
- **Fila de manutenção:** continua pausada.
- **Polling:** GET /videos/{publicId} a cada 1 s, com timeout de 60 s. O timeout do teste é ajustado a esse prazo.

#### 2.1. upload-real-passa-por-processing-e-chega-a-ready-com-url-funcional

**Covers AC:** #1, #2, #3
**Source:** auto
**Last sync:** 2026-11-21T02:43:13Z

**Steps:**
  1. POST /videos com o tamanho da fixture MP4 válida e `contentType: "video/mp4"`; assinar, enviar e registrar as partes; fazer POST completion
    - expect: status `202`
  2. Com a `video-processing` pausada, GET /videos/{publicId} e GET playback-url
    - expect: o vídeo está em `processing`, e o job `video-{videoId}-1-1` existe sem ter sido consumido
    - expect: playback-url responde `409` com `error: "VIDEO_NOT_READY"`
  3. Retomar a `video-processing` e consultar GET /videos/{publicId} até sair de `processing`
    - expect: o vídeo termina em `ready`, com `durationSeconds`, `width`, `height` e `videoCodec` preenchidos e `hasThumbnail: true`
  4. GET playback-url e fazer um GET HTTP na URL com `Range: bytes=0-1023`
    - expect: playback-url responde `200` com `contentType: "video/mp4"`
    - expect: a URL responde `206` com `Content-Range` e os primeiros 1024 bytes da fixture enviada

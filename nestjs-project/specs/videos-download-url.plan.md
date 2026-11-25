---
subproject: backend
runner: jest+supertest
scope: phase-03-videos
si: SI-03.28
target_file: test/videos-download-url.e2e-spec.ts
---

# GET /videos/:publicId/download-url — Test Plan

## Application Overview

Para o dono de um vídeo em `ready`, o endpoint emite uma URL pré-assinada (`DOWNLOAD_URL_TTL_SECONDS`) para baixar o original como anexo:
- **Assinatura:** inclui `ResponseContentDisposition: attachment`, com `filename*` em UTF-8 derivado de `original_filename` (RFC 6266).
- **Caminho dos bytes:** o download vai direto do storage, sem passar pela API (TD-14).
- **Vídeo fora de `ready`:** recebe `409 VIDEO_NOT_READY`.

Este spec também traz o processamento real até `ready` e até `error`, com o worker real.

## Test Scenarios

### 1. URL de download sobre estados preparados

**Setup:**
- **Aplicação:** `beforeAll` sobe a aplicação com `Test.createTestingModule({ imports: [AppModule] })`, aplicando o `ValidationPipe` e os filtros globais de `main.ts`.
- **Infraestrutura:** Postgres, storage, Redis e `video-worker` reais do Compose (R-10).
- **Filas:** `beforeAll` pausa `video-processing` e `video-maintenance` com `test/helpers/queues.ts` (SI-03.11) e espera os jobs ativos terminarem.
- **Antes de cada cenário:** `beforeEach` executa `cleanAllTables`, limpa o throttler, garante as duas filas pausadas e limpa os jobs da `video-processing`.
- **Encerramento:** `afterAll` limpa os jobs da suíte, retoma as duas filas e fecha a aplicação.
- **Tamanho das partes:** a suíte usa `UPLOAD_PART_SIZE_BYTES=5242880`.
- **Usuário:** o dono é autenticado pelos endpoints de auth.
- **Dados de cada cenário:** cada cenário prepara o próprio vídeo, obtém a própria URL e faz o próprio download.
- **Fixtures do grupo:**
  - o vídeo pronto vem de `test/helpers/video-fixtures.ts`: vídeo `ready` com `original_filename: "vídeo de ação.mp4"`, metadados e sessão `completed`;
  - o original é a fixture MP4 válida de `test/fixtures/videos/` (SI-03.6), gravada em `original_key`, e uma thumbnail é gravada em `thumbnail_key`.
- **Requisições às URLs assinadas:** saem do container de testes. Elas se conectam ao serviço `storage` do Compose e mantêm o header `Host` igual ao host de `S3_PUBLIC_ENDPOINT`, que faz parte da assinatura SigV4. A assinatura não é refeita.

#### 1.1. video-pronto-recebe-url-e-prazo

**Covers AC:** #1
**Source:** auto
**Last sync:** 2026-11-21T02:43:13Z

**Steps:**
  1. Preparar um vídeo pronto do dono
  2. GET /videos/{publicId}/download-url com o token do dono
    - expect: status `200` com `url` e `expiresAt`
    - expect: `expiresAt` cai `DOWNLOAD_URL_TTL_SECONDS` depois da requisição, com tolerância de poucos segundos

#### 1.2. download-completo-tem-os-bytes-do-original-e-attachment

**Covers AC:** #2
**Source:** auto
**Last sync:** 2026-11-21T02:43:13Z

**Steps:**
  1. Preparar um vídeo pronto do dono e obter a URL com GET download-url
  2. Fazer um GET HTTP na URL, sem `Range`
    - expect: status `200`, com `Content-Disposition` começando por `attachment`
    - expect: o SHA-256 do corpo recebido é igual ao SHA-256 da fixture gravada como original

#### 1.3. nome-com-acentos-chega-preservado-em-filename-star

**Covers AC:** #3
**Source:** auto
**Last sync:** 2026-11-21T02:43:13Z

**Steps:**
  1. Preparar um vídeo pronto do dono com `original_filename: "vídeo de ação.mp4"` e obter a URL com GET download-url
  2. Fazer um GET HTTP na URL e ler o header `Content-Disposition`
    - expect: o header contém `filename*=UTF-8''`, com o nome codificado em percent-encoding
    - expect: decodificado, o nome é exatamente `vídeo de ação.mp4`

#### 1.4. video-fora-de-ready-retorna-409

**Covers AC:** #4
**Source:** auto
**Last sync:** 2026-11-21T02:43:13Z

**Steps:**
  1. POST /videos com body válido, deixando o vídeo em `draft`; GET download-url
    - expect: status `409` com `error: "VIDEO_NOT_READY"`
  2. Preparar com `test/helpers/video-fixtures.ts` um vídeo do dono em `error` (`error_code = 'MEDIA_INVALID'`, original gravado); GET download-url
    - expect: status `409` com `error: "VIDEO_NOT_READY"`

### 2. Processamento real até ready e até error

**Setup:**
- **Base:** o mesmo do grupo 1; o `video-worker` real (SI-03.20 a SI-03.22) processa os jobs.
- **Fila de processamento:** cada cenário a retoma pelo helper depois de conferir o vídeo em `processing`. O `beforeEach` do cenário seguinte volta a pausá-la e espera o job ativo terminar.
- **Fila de manutenção:** continua pausada.
- **Polling:** GET /videos/{publicId} a cada 1 s, com timeout de 60 s. O timeout do teste é ajustado a esse prazo.

#### 2.1. original-enviado-e-processado-e-baixado-com-os-mesmos-bytes

**Covers AC:** #1, #2, #3
**Source:** auto
**Last sync:** 2026-11-21T02:43:13Z

**Steps:**
  1. POST /videos com `fileName: "vídeo de ação.mp4"`, `contentType: "video/mp4"` e o tamanho da fixture MP4 válida; assinar, enviar e registrar as partes; fazer POST completion
    - expect: status `202`, e o vídeo em `processing` com a fila ainda pausada
  2. Retomar a `video-processing` e consultar GET /videos/{publicId} até sair de `processing`
    - expect: o vídeo termina em `ready`
  3. GET download-url e fazer um GET HTTP na URL
    - expect: download-url responde `200` com `url` e `expiresAt`
    - expect: o SHA-256 do corpo é igual ao SHA-256 do arquivo enviado
    - expect: `Content-Disposition` é `attachment`, com `filename*` que decodifica para `vídeo de ação.mp4`

#### 2.2. midia-invalida-termina-em-error-e-nao-recebe-url

**Covers AC:** #4
**Source:** auto
**Last sync:** 2026-11-21T02:43:13Z

**Steps:**
  1. POST /videos com a fixture de arquivo inválido de `test/fixtures/videos/` declarada como `video/mp4`; assinar, enviar e registrar as partes; fazer POST completion
    - expect: status `202`, e o vídeo em `processing` com a fila ainda pausada
  2. Retomar a `video-processing` e consultar GET /videos/{publicId} até sair de `processing`
    - expect: o vídeo termina em `status: "error"`, com `errorCode: "MEDIA_INVALID"` e `errorMessage` preenchida
    - expect: `hasThumbnail: false`
  3. GET download-url
    - expect: status `409` com `error: "VIDEO_NOT_READY"`

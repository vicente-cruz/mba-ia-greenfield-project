// Cliente de prova do upload direto e retomável (SI-03.31; phase-03-videos/TD-01, TD-02). Não faz
// parte da aplicação. Reproduz o "Contrato do futuro cliente de upload" do documento de decisões:
// - fatia o arquivo pelo plano do servidor e envia cada parte com exatamente `expectedSize` bytes e
//   com os headers devolvidos pela API (só `x-amz-checksum-sha256`);
// - calcula o SHA-256 de cada parte antes de pedir a assinatura, lendo uma parte por vez em blocos
//   de 1 MiB (memória limitada a um bloco, nunca ao arquivo);
// - pede as URLs em lotes (`part-urls`) e envia até 4 partes ao mesmo tempo; os checksums são
//   calculados à frente da assinatura, por uma tarefa própria;
// - informa os ETags das partes enviadas à API em lote: num pedido só de registro a cada
//   `--register-every` PUTs concluídos, com prioridade sobre a próxima assinatura, ou junto com ela;
// - para com SIGINT ou SIGTERM: aborta os PUTs em andamento e sai com 130 ou 143, sem novas
//   chamadas à API;
// - retoma pelo GET da sessão: recalcula o checksum das partes `confirmed` e `unregistered`, confere
//   o arquivo por `file-verifications` e reenvia só as partes `missing`, `divergent` e
//   `unregistered`;
// - conclui (`completion`) e acompanha o vídeo por polling até `ready` ou `error`;
// - renova o access token por `POST /auth/refresh` antes de expirar.
//
// Roda num container da rede do Compose (`docker compose exec nestjs-api npx ts-node …`). As URLs
// assinadas apontam para o S3_PUBLIC_ENDPOINT, a origem do navegador (`localhost:9000`), que dentro
// de um container é o próprio container. Com `--storage-connect localhost:9000=storage:9000`, a
// conexão TCP vai ao serviço `storage` e a requisição mantém o `Host` assinado, como o
// `curl --connect-to`; os bytes enviados são os mesmos.
//
// Tokens, senhas e URLs assinadas nunca são impressos nem gravados nos eventos. As credenciais ficam
// num JSON com modo 0600 (criado por `upload-proof-support.ts account`), atualizado a cada renovação.
//
// Uso:
//   generate --file <caminho> --size <bytes> --seed <texto> [--events <jsonl>]
//   start    --file <caminho> --credentials <json> --state <json> --events <jsonl> [opções]
//   resume   --credentials <json> --state <json> --events <jsonl> [opções]
//   complete --credentials <json> --state <json> --events <jsonl> [opções]
// Opções:
//   --api <url>                   API Nest (padrão: http://nestjs-api:3000)
//   --file-name <nome>            nome declarado no POST /videos (padrão: o nome do arquivo)
//   --content-type <tipo>         tipo declarado (padrão: video/mp4)
//   --concurrency <n>             PUTs simultâneos (padrão: 4)
//   --sign-batch <n>              partes por pedido de assinatura, até 50 (padrão: 10)
//   --register-every <n>          ETags pendentes que disparam um pedido de registro (padrão: 4)
//   --part-urls-interval-ms <n>   intervalo mínimo entre dois part-urls (padrão: 1100, até 54/min)
//   --storage-connect <a=b>       conecta em b as URLs cujo host é a (host:porta=host:porta)
//   --refresh-margin-seconds <n>  renova o access token quando faltam n segundos (padrão: 120)
//   --progress <json>             progresso (pid, partes enviadas e registradas), para o roteiro
//   --hold-before-completion <p>  antes do completion, cria <p>.ready e espera <p> existir
//   --no-complete                 para depois de enviar e registrar todas as partes
//   --poll-interval-ms <n>        intervalo do polling (padrão: 2000)
//   --poll-timeout-seconds <n>    prazo do polling até ready ou error (padrão: 900)
// Código de saída: 0 com sucesso, 1 com falha (API, storage, arquivo ou estado), 64 com uso
// inválido, 130 ou 143 quando interrompido por SIGINT ou SIGTERM.
import { createCipheriv, createHash } from 'node:crypto';
import { once } from 'node:events';
import {
  appendFileSync,
  createReadStream,
  createWriteStream,
  existsSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { mkdir, stat } from 'node:fs/promises';
import { request as httpRequest, type OutgoingHttpHeaders } from 'node:http';
import { basename, dirname } from 'node:path';
import { performance } from 'node:perf_hooks';
import { finished } from 'node:stream/promises';
import { parseArgs } from 'node:util';
import {
  ApiError,
  type Credentials,
  DEFAULT_API_URL,
  errorCode,
  type HttpResponse,
  httpJson,
  retryAfterSeconds,
  sleepMs,
  TokenSession,
  writePrivateJson,
} from './proof-api';

const MIB = 1024 * 1024;
/** Bloco de leitura do arquivo, para o checksum e para o corpo do PUT. */
const READ_CHUNK_BYTES = MIB;
const API_MAX_ATTEMPTS = 4;
const PUT_MAX_ATTEMPTS = 4;
/** Sem nenhum byte trafegando por esse tempo, o PUT é abortado e retentado. */
const PUT_IDLE_TIMEOUT_MS = 120_000;
/** Uma URL com menos que isso de validade é assinada de novo antes do PUT. */
const URL_RENEWAL_MARGIN_MS = 60_000;
/** O Complete pode levar minutos (TD-02). */
const COMPLETION_TIMEOUT_MS = 30 * 60_000;
/** Recusa do corpo divergente do checksum assinado (V-09: Silo `XAmzContentChecksumMismatch`, AWS `BadDigest`). */
const CHECKSUM_REFUSALS: ReadonlySet<string> = new Set([
  'XAmzContentChecksumMismatch',
  'BadDigest',
]);
const TERMINAL_VIDEO_STATES: ReadonlySet<string> = new Set(['ready', 'error']);
const EXIT = { OK: 0, FAILED: 1, USAGE: 64 } as const;
const SIGNAL_EXIT_CODES = { SIGINT: 130, SIGTERM: 143 } as const;
type HandledSignal = keyof typeof SIGNAL_EXIT_CODES;

// Corpos da API usados pelo cliente (contrato do openapi.json).
interface CreatedVideo {
  publicId: string;
  status: string;
  uploadSession: {
    id: string;
    status: string;
    partSize: number;
    partCount: number;
    checksumAlgorithm: string;
    expiresAt: string;
  };
}
interface SignedPart {
  partNumber: number;
  url: string;
  method: string;
  expectedSize: number;
  headers: Record<string, string>;
  expiresAt: string;
}
interface PartUrlsResponse {
  parts: SignedPart[];
  registeredParts: number[];
}
type PartState = 'confirmed' | 'missing' | 'divergent' | 'unregistered';
interface SessionResponse {
  id: string;
  status: string;
  expired: boolean;
  fileMismatch: boolean;
  partSize: number;
  partCount: number;
  checksumAlgorithm: string;
  expiresAt: string;
  parts: { partNumber: number; state: PartState }[];
}
interface VideoResponse {
  publicId: string;
  status: string;
  sizeBytes: number;
  errorCode: string | null;
  errorMessage: string | null;
  uploadSession: { id: string; status: string; expiresAt: string } | null;
}
interface CompletionResponse {
  publicId: string;
  status: string;
}
interface FileVerificationResponse {
  result: string;
  verifiedParts: number;
}

/** O que o cliente guarda para retomar: só identificadores e o plano, nunca segredos. */
interface UploadState {
  publicId: string;
  sessionId: string;
  file: string;
  fileName: string;
  contentType: string;
  sizeBytes: number;
  partSize: number;
  partCount: number;
  createdAt: string;
}

interface StorageConnect {
  from: string;
  hostname: string;
  port: number;
}

interface ClientOptions {
  apiUrl: string;
  concurrency: number;
  signBatch: number;
  registerEvery: number;
  partUrlsIntervalMs: number;
  storageConnect: StorageConnect | null;
  refreshMarginSeconds: number;
  progressPath: string | null;
  holdBeforeCompletion: string | null;
  complete: boolean;
  pollIntervalMs: number;
  pollTimeoutSeconds: number;
}

type Segment = 'generate' | 'start' | 'resume' | 'complete';

class UsageError extends Error {}

/** A operação parou porque o sinal de interrupção (ou de parada do envio) foi acionado. */
class AbortedError extends Error {
  constructor() {
    super('operação abortada');
    this.name = 'AbortedError';
  }
}

const round = (value: number, digits = 1): number =>
  Number(value.toFixed(digits));

const errorName = (error: unknown): string =>
  error instanceof Error ? `${error.name}: ${error.message}` : String(error);

function partRange(
  plan: Pick<UploadState, 'sizeBytes' | 'partSize'>,
  partNumber: number,
): { start: number; size: number } {
  const start = (partNumber - 1) * plan.partSize;
  return { start, size: Math.min(plan.partSize, plan.sizeBytes - start) };
}

/** SHA-256 em base64 de um trecho do arquivo, lido em blocos de 1 MiB. */
async function sha256OfRange(
  file: string,
  start: number,
  size: number,
): Promise<string> {
  const hash = createHash('sha256');
  let read = 0;
  const stream = createReadStream(file, {
    start,
    end: start + size - 1,
    highWaterMark: READ_CHUNK_BYTES,
  });
  for await (const chunk of stream) {
    const buffer = chunk as Buffer;
    hash.update(buffer);
    read += buffer.length;
  }
  if (read !== size) {
    throw new Error(
      `leitura de ${read} bytes no lugar de ${size} a partir de ${start}`,
    );
  }
  return hash.digest('base64');
}

/** Acorda quem espera uma mudança de estado; acorda também quando o sinal é abortado. */
class Changes {
  private readonly waiters = new Set<() => void>();

  wait(signal: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      if (signal.aborted) {
        resolve();
        return;
      }
      const done = (): void => {
        this.waiters.delete(done);
        signal.removeEventListener('abort', done);
        resolve();
      };
      this.waiters.add(done);
      signal.addEventListener('abort', done, { once: true });
    });
  }

  notify(): void {
    for (const waiter of [...this.waiters]) {
      waiter();
    }
  }
}

/** Eventos com instante em ms (`t`), um JSON por linha, gravados de forma síncrona. */
class EventLog {
  constructor(
    private readonly path: string,
    private readonly segment: Segment,
  ) {}

  write(event: string, fields: Record<string, unknown> = {}): void {
    appendFileSync(
      this.path,
      `${JSON.stringify({ t: Date.now(), seg: this.segment, ev: event, ...fields })}\n`,
    );
  }
}

/** Progresso para o roteiro: pid, partes com PUT concluído, registradas e em andamento. */
class Progress {
  readonly putDone = new Set<number>();
  readonly registered = new Set<number>();
  readonly inFlight = new Set<number>();
  phase = 'starting';

  constructor(
    private readonly path: string | null,
    private readonly segment: Segment,
    public partCount = 0,
  ) {}

  update(phase?: string): void {
    if (phase) {
      this.phase = phase;
    }
    if (!this.path) {
      return;
    }
    const sorted = (set: Set<number>) => [...set].sort((a, b) => a - b);
    writePrivateJson(this.path, {
      pid: process.pid,
      segment: this.segment,
      phase: this.phase,
      partCount: this.partCount,
      putDone: sorted(this.putDone),
      registered: sorted(this.registered),
      inFlight: sorted(this.inFlight),
      at: new Date().toISOString(),
    });
  }

  snapshot(): Record<string, number[]> {
    const sorted = (set: Set<number>) => [...set].sort((a, b) => a - b);
    return {
      putDone: sorted(this.putDone),
      registered: sorted(this.registered),
      inFlight: sorted(this.inFlight),
    };
  }
}

interface PutResult {
  status: number;
  etag: string;
  errorCode: string;
  networkError: string;
  durationMs: number;
}

class UploadClient {
  readonly interruption = new AbortController();
  readonly events: EventLog;
  readonly progress: Progress;
  readonly tokens: TokenSession;
  state: UploadState | null = null;
  /** Primeiro sinal recebido, que define o código de saída. */
  interruptedBy: HandledSignal | null = null;
  private loadActive = false;
  private renewalTimer: NodeJS.Timeout | null = null;

  constructor(
    readonly segment: Segment,
    readonly options: ClientOptions,
    credentialsPath: string,
    private readonly statePath: string,
    eventsPath: string,
  ) {
    this.events = new EventLog(eventsPath, segment);
    this.progress = new Progress(options.progressPath, segment);
    const credentials = JSON.parse(
      readFileSync(credentialsPath, 'utf8'),
    ) as Credentials;
    this.tokens = new TokenSession(
      options.apiUrl,
      credentials,
      options.refreshMarginSeconds,
      (updated) => writePrivateJson(credentialsPath, updated),
      (renewal) => {
        this.events.write('token_renewal', { ...renewal });
        console.log(
          `TOKEN | renovado por ${renewal.kind === 'refresh' ? 'POST /auth/refresh' : 'novo login'} em ${round(renewal.durationMs)} ms | expirava ${renewal.previousExpiresAt} | agora expira ${renewal.expiresAt}`,
        );
      },
    );
  }

  get plan(): UploadState {
    if (!this.state) {
      throw new Error('estado do upload ainda não carregado');
    }
    return this.state;
  }

  private get sessionPath(): string {
    return `/videos/${this.plan.publicId}/upload-sessions/${this.plan.sessionId}`;
  }

  loadState(): void {
    this.state = JSON.parse(
      readFileSync(this.statePath, 'utf8'),
    ) as UploadState;
    this.progress.partCount = this.state.partCount;
  }

  /** SIGINT/SIGTERM interrompem o envio; um segundo sinal encerra na hora. */
  installSignalHandlers(): void {
    for (const name of Object.keys(SIGNAL_EXIT_CODES) as HandledSignal[]) {
      process.on(name, () => {
        if (this.interruption.signal.aborted) {
          process.exit(SIGNAL_EXIT_CODES[name]);
        }
        this.interruptedBy = name;
        const snapshot = this.progress.snapshot();
        this.events.write('interrupted', { signal: name, ...snapshot });
        this.markLoadEnd('interrupted');
        console.log(
          `INTERRUPÇÃO | ${name} | PUT concluído: [${snapshot.putDone.join(',')}] | registradas: [${snapshot.registered.join(',')}] | em andamento: [${snapshot.inFlight.join(',')}]`,
        );
        this.progress.update('interrupted');
        this.interruption.abort();
      });
    }
  }

  /** Renovação proativa a cada 15 s, além da conferência antes de cada chamada. */
  startTokenRenewal(): void {
    this.renewalTimer = setInterval(() => {
      this.tokens.renewIfNeeded().catch((error: unknown) => {
        // Tarefa de fundo: registra e segue; a próxima chamada à API confere o token de novo.
        this.events.write('token_error', { error: errorName(error) });
      });
    }, 15_000);
    this.renewalTimer.unref();
  }

  stopTokenRenewal(): void {
    if (this.renewalTimer) {
      clearInterval(this.renewalTimer);
    }
  }

  /** Intervalos de upload ativo: delimitam a fase de carga da sonda (SI-03.33). */
  markLoadStart(reason: string): void {
    if (!this.loadActive) {
      this.loadActive = true;
      this.events.write('load_start', { reason });
    }
  }

  markLoadEnd(reason: string): void {
    if (this.loadActive) {
      this.loadActive = false;
      this.events.write('load_end', { reason });
    }
  }

  /**
   * Chamada à API com o access token vigente. Retenta erro de rede, 5xx e 429 (respeitando o
   * `Retry-After`) quando a operação é idempotente.
   */
  async callApi<T>(
    operation: string,
    method: string,
    path: string,
    body: unknown,
    expected: readonly number[],
    options: {
      retryable?: boolean;
      timeoutMs?: number;
      signal?: AbortSignal;
    } = {},
  ): Promise<HttpResponse<T>> {
    const signal = options.signal ?? this.interruption.signal;
    const retryable = options.retryable ?? true;
    for (let attempt = 1; ; attempt += 1) {
      const token = await this.tokens.accessToken();
      let response: HttpResponse<T> | null = null;
      let failure: unknown = null;
      try {
        response = await httpJson<T>(method, `${this.options.apiUrl}${path}`, {
          token,
          body,
          timeoutMs: options.timeoutMs,
          signal,
        });
      } catch (error) {
        failure = error;
      }
      if (signal.aborted) {
        throw new AbortedError();
      }
      this.events.write('api', {
        op: operation,
        attempt,
        status: response?.status ?? 0,
        ms: response ? round(response.durationMs) : null,
        code: response ? errorCode(response.body) || undefined : undefined,
        error: failure ? errorName(failure) : undefined,
      });
      if (response && expected.includes(response.status)) {
        return response;
      }
      const transient =
        failure !== null ||
        (response !== null &&
          (response.status >= 500 || response.status === 429));
      if (!retryable || !transient || attempt >= API_MAX_ATTEMPTS) {
        if (response) {
          throw new ApiError(
            operation,
            response.status,
            errorCode(response.body),
            retryAfterSeconds(response.headers),
          );
        }
        throw failure;
      }
      const waitMs =
        response?.status === 429
          ? (retryAfterSeconds(response.headers) ?? 5) * 1000
          : 1000 * 2 ** (attempt - 1);
      console.log(
        `API | ${operation} | tentativa ${attempt} falhou (${response ? `HTTP ${response.status}` : errorName(failure)}); nova tentativa em ${waitMs} ms`,
      );
      await sleepMs(waitMs, signal);
    }
  }

  /** SHA-256 de uma parte, medido. `purpose`: `sign` (antes da assinatura) ou `verify` (retomada). */
  async measureChecksum(
    partNumber: number,
    purpose: 'sign' | 'verify',
  ): Promise<string> {
    const { start, size } = partRange(this.plan, partNumber);
    const started = performance.now();
    const checksum = await sha256OfRange(this.plan.file, start, size);
    const ms = performance.now() - started;
    this.events.write('checksum', {
      part: partNumber,
      bytes: size,
      ms: round(ms),
      purpose,
    });
    console.log(
      `CHECKSUM | parte ${partNumber} | ${size} bytes | ${round(ms)} ms | ${purpose === 'sign' ? 'antes da assinatura' : 'conferência da retomada'}`,
    );
    return checksum;
  }

  /** PUT da parte direto no storage, com o corpo lido do arquivo em stream e o tamanho assinado. */
  putPart(signed: SignedPart, signal: AbortSignal): Promise<PutResult> {
    return new Promise((resolve) => {
      const url = new URL(signed.url);
      if (url.protocol !== 'http:') {
        throw new Error(
          `protocolo não suportado pelo cliente: ${url.protocol}`,
        );
      }
      const { start, size } = partRange(this.plan, signed.partNumber);
      const connect = this.options.storageConnect;
      const redirect = connect !== null && url.host === connect.from;
      const headers: OutgoingHttpHeaders = {
        ...signed.headers,
        host: url.host,
        'content-length': size,
      };
      const started = performance.now();
      let settled = false;
      const finish = (result: Omit<PutResult, 'durationMs'>): void => {
        if (!settled) {
          settled = true;
          resolve({ ...result, durationMs: performance.now() - started });
        }
      };
      const body = createReadStream(this.plan.file, {
        start,
        end: start + size - 1,
        highWaterMark: READ_CHUNK_BYTES,
      });
      const req = httpRequest({
        hostname: redirect ? connect.hostname : url.hostname,
        port: redirect ? connect.port : Number(url.port || 80),
        path: `${url.pathname}${url.search}`,
        method: 'PUT',
        headers,
        signal,
      });
      req.setTimeout(PUT_IDLE_TIMEOUT_MS, () =>
        req.destroy(new Error(`sem atividade por ${PUT_IDLE_TIMEOUT_MS} ms`)),
      );
      body.on('error', (error) => req.destroy(error));
      req.on('response', (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('error', (error) =>
          finish({
            status: 0,
            etag: '',
            errorCode: '',
            networkError: errorName(error),
          }),
        );
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          finish({
            status: res.statusCode ?? 0,
            etag: typeof res.headers.etag === 'string' ? res.headers.etag : '',
            errorCode: /<Code>([^<]*)<\/Code>/.exec(text)?.[1] ?? '',
            networkError: '',
          });
        });
      });
      req.on('error', (error) => {
        body.destroy();
        finish({
          status: 0,
          etag: '',
          errorCode: '',
          networkError: errorName(error),
        });
      });
      body.pipe(req);
    });
  }

  /** Conclusão (P2) e polling até `ready` ou `error`. */
  async completeAndPoll(): Promise<VideoResponse> {
    const hold = this.options.holdBeforeCompletion;
    if (hold) {
      this.markLoadEnd('hold');
      this.events.write('hold_start', {});
      this.progress.update('holding');
      writeFileSync(`${hold}.ready`, '');
      console.log(
        'ESPERA | todas as partes registradas; aguardando liberação do completion',
      );
      while (!existsSync(hold)) {
        await sleepMs(200, this.interruption.signal);
        if (this.interruption.signal.aborted) {
          throw new AbortedError();
        }
      }
      this.events.write('hold_end', {});
      this.markLoadStart('hold-released');
    }
    this.progress.update('completing');
    this.events.write('completion_start', {});
    const completion = await this.callApi<CompletionResponse>(
      'POST completion',
      'POST',
      `${this.sessionPath}/completion`,
      undefined,
      [200, 202],
      { timeoutMs: COMPLETION_TIMEOUT_MS },
    );
    this.events.write('completion', {
      status: completion.status,
      ms: round(completion.durationMs),
      videoStatus: completion.body.status,
    });
    this.markLoadEnd('completion');
    console.log(
      `COMPLETION | HTTP ${completion.status} em ${round(completion.durationMs)} ms | vídeo ${completion.body.status}`,
    );
    this.progress.update('polling');
    const deadline = Date.now() + this.options.pollTimeoutSeconds * 1000;
    let lastStatus = '';
    let polls = 0;
    for (;;) {
      const { body: video } = await this.callApi<VideoResponse>(
        'GET /videos/:publicId (polling)',
        'GET',
        `/videos/${this.plan.publicId}`,
        undefined,
        [200],
      );
      polls += 1;
      if (video.status !== lastStatus) {
        lastStatus = video.status;
        this.events.write('poll_state', {
          status: video.status,
          errorCode: video.errorCode,
          polls,
        });
        console.log(
          `POLLING | ${video.status}${video.errorCode ? ` ${video.errorCode}` : ''} | consulta ${polls}`,
        );
      }
      if (TERMINAL_VIDEO_STATES.has(video.status)) {
        this.events.write('final', {
          status: video.status,
          errorCode: video.errorCode,
          errorMessage: video.errorMessage,
          polls,
        });
        this.progress.update('done');
        return video;
      }
      if (Date.now() > deadline) {
        throw new Error(
          `o vídeo continua ${video.status} depois de ${this.options.pollTimeoutSeconds} s de polling`,
        );
      }
      await sleepMs(this.options.pollIntervalMs, this.interruption.signal);
      if (this.interruption.signal.aborted) {
        throw new AbortedError();
      }
    }
  }

  /** Início: POST /videos, envio de todas as partes do plano e, sem --no-complete, a conclusão. */
  async start(
    file: string,
    fileName: string,
    contentType: string,
  ): Promise<void> {
    const { size } = await stat(file);
    const created = await this.callApi<CreatedVideo>(
      'POST /videos',
      'POST',
      '/videos',
      { fileName, sizeBytes: size, contentType },
      [201],
      { retryable: false },
    );
    const session = created.body.uploadSession;
    this.state = {
      publicId: created.body.publicId,
      sessionId: session.id,
      file,
      fileName,
      contentType,
      sizeBytes: size,
      partSize: session.partSize,
      partCount: session.partCount,
      createdAt: new Date().toISOString(),
    };
    writePrivateJson(this.statePath, this.state);
    if (session.partCount !== Math.ceil(size / session.partSize)) {
      throw new Error(
        `plano inesperado: ${session.partCount} partes de ${session.partSize} bytes para ${size} bytes`,
      );
    }
    this.progress.partCount = session.partCount;
    const lastPart = partRange(this.state, session.partCount).size;
    this.events.write('plan', {
      publicId: this.state.publicId,
      sessionId: session.id,
      sizeBytes: size,
      partSize: session.partSize,
      partCount: session.partCount,
      lastPartSize: lastPart,
      checksumAlgorithm: session.checksumAlgorithm,
      sessionExpiresAt: session.expiresAt,
    });
    console.log(
      `INÍCIO | vídeo ${this.state.publicId} (${created.body.status}) | sessão ${session.id} | ${size} bytes em ${session.partCount} partes de ${session.partSize} (última com ${lastPart}) | ${session.checksumAlgorithm}`,
    );
    const all = Array.from({ length: session.partCount }, (_, i) => i + 1);
    await new PartUploader(this, all, new Map()).run();
    console.log(`ENVIO | ${all.length} partes enviadas e registradas`);
    if (this.options.complete) {
      await this.completeAndPoll();
    }
  }

  /**
   * Retomada (TD-02): GET do vídeo e da sessão, conferência do arquivo por checksum das partes
   * que o storage já tem e reenvio só das partes que não estão `confirmed`.
   */
  async resume(): Promise<void> {
    this.markLoadStart('resume');
    const plan = this.plan;
    const { body: video } = await this.callApi<VideoResponse>(
      'GET /videos/:publicId',
      'GET',
      `/videos/${plan.publicId}`,
      undefined,
      [200],
    );
    if (
      video.status !== 'draft' ||
      video.uploadSession?.id !== plan.sessionId
    ) {
      throw new Error(
        `não há o que retomar: vídeo ${video.status}, sessão atual ${video.uploadSession?.id ?? 'nenhuma'} (${video.uploadSession?.status ?? '—'})`,
      );
    }
    const { body: session } = await this.callApi<SessionResponse>(
      'GET upload-session',
      'GET',
      this.sessionPath,
      undefined,
      [200],
    );
    if (
      session.status !== 'active' ||
      session.expired ||
      session.fileMismatch
    ) {
      throw new Error(
        `sessão ${session.status} (expirada: ${session.expired}; arquivo divergente: ${session.fileMismatch}); a retomada exige reiniciar a sessão`,
      );
    }
    if (
      session.partSize !== plan.partSize ||
      session.partCount !== plan.partCount
    ) {
      throw new Error('o plano da sessão difere do estado local');
    }
    // Pré-checagem, como nome, tamanho e lastModified no navegador: só recusa cedo.
    const { size } = await stat(plan.file);
    if (size !== plan.sizeBytes) {
      throw new Error(
        `o arquivo tem ${size} bytes; a sessão espera ${plan.sizeBytes}`,
      );
    }
    const byState: Record<PartState, number[]> = {
      confirmed: [],
      missing: [],
      divergent: [],
      unregistered: [],
    };
    for (const part of session.parts) {
      byState[part.state].push(part.partNumber);
    }
    this.events.write('resume_classification', { ...byState });
    console.log(
      `RETOMADA | sessão ${session.id} active | confirmed: [${byState.confirmed.join(',')}] | unregistered: [${byState.unregistered.join(',')}] | missing: [${byState.missing.join(',')}] | divergent: [${byState.divergent.join(',')}]`,
    );
    for (const partNumber of byState.confirmed) {
      this.progress.registered.add(partNumber);
      this.progress.putDone.add(partNumber);
    }
    this.progress.update('verifying');

    const toVerify = [...byState.confirmed, ...byState.unregistered].sort(
      (a, b) => a - b,
    );
    const checksums = new Map<number, string>();
    const verifyStarted = performance.now();
    for (const partNumber of toVerify) {
      checksums.set(
        partNumber,
        await this.measureChecksum(partNumber, 'verify'),
      );
      if (this.interruption.signal.aborted) {
        throw new AbortedError();
      }
    }
    const verifyBytes = toVerify.reduce(
      (sum, n) => sum + partRange(plan, n).size,
      0,
    );
    const verifyMs = performance.now() - verifyStarted;
    const verification = await this.callApi<FileVerificationResponse>(
      'POST file-verifications',
      'POST',
      `${this.sessionPath}/file-verifications`,
      {
        parts: toVerify.map((partNumber) => ({
          partNumber,
          checksumSha256: checksums.get(partNumber),
        })),
      },
      [200],
    );
    if (
      verification.body.result !== 'match' ||
      verification.body.verifiedParts !== toVerify.length
    ) {
      throw new Error(
        `conferência inesperada: ${verification.body.result}, ${verification.body.verifiedParts} partes`,
      );
    }
    this.events.write('file_verification', {
      parts: toVerify,
      bytes: verifyBytes,
      checksumMs: round(verifyMs),
      requestMs: round(verification.durationMs),
      verifiedParts: verification.body.verifiedParts,
    });
    console.log(
      `CONFERÊNCIA | ${toVerify.length} partes (${verifyBytes} bytes) recalculadas em ${round(verifyMs)} ms | file-verifications HTTP ${verification.status} ${verification.body.result} em ${round(verification.durationMs)} ms`,
    );

    const toSend = [
      ...byState.missing,
      ...byState.divergent,
      ...byState.unregistered,
    ].sort((a, b) => a - b);
    this.events.write('resend_plan', { parts: toSend });
    console.log(
      `REENVIO | partes [${toSend.join(',')}]; nenhuma parte confirmed é reenviada`,
    );
    await new PartUploader(this, toSend, checksums).run();
    console.log(`ENVIO | ${toSend.length} partes reenviadas e registradas`);
    if (this.options.complete) {
      await this.completeAndPoll();
    }
  }
}

/**
 * Envio de um conjunto de partes, com três papéis que não se bloqueiam:
 * - o calculador lê o arquivo em ordem, uma parte por vez, e deixa até `signBatch` checksums
 *   prontos à frente da assinatura;
 * - o controlador registra os ETags pendentes (a cada `registerEvery` PUTs concluídos) e assina
 *   lotes de até `signBatch` partes já calculadas, no mesmo pedido quando os dois são devidos e
 *   com um intervalo mínimo entre pedidos. Um lote incompleto só é assinado quando há trabalhador
 *   ocioso, sem PUT e sem URL pronta;
 * - `concurrency` trabalhadores fazem os PUTs.
 * Assim o registro de uma parte enviada nunca espera o checksum de outra.
 */
class PartUploader {
  /** Partes ainda sem checksum, na ordem do arquivo. */
  private readonly toHash: number[] = [];
  /** Partes com checksum, ainda não assinadas. */
  private readonly hashed: number[] = [];
  private readonly ready: SignedPart[] = [];
  private readonly pendingEtags: { partNumber: number; etag: string }[] = [];
  private signing = 0;
  private activePuts = 0;
  private readonly total: number;
  private readonly changes = new Changes();
  private readonly stop = new AbortController();
  private readonly signal: AbortSignal;
  private failure: Error | null = null;
  private lastPartUrlsAt = 0;

  constructor(
    private readonly client: UploadClient,
    partNumbers: number[],
    private readonly checksums: Map<number, string>,
  ) {
    for (const partNumber of [...partNumbers].sort((a, b) => a - b)) {
      (checksums.has(partNumber) ? this.hashed : this.toHash).push(partNumber);
    }
    this.total = partNumbers.length;
    this.signal = AbortSignal.any([
      client.interruption.signal,
      this.stop.signal,
    ]);
  }

  async run(): Promise<void> {
    if (this.total === 0) {
      return;
    }
    this.client.progress.update('uploading');
    const guard = (task: Promise<void>): Promise<void> =>
      task.catch((error: unknown) => this.fail(error));
    await Promise.all([
      guard(this.hash()),
      guard(this.control()),
      ...Array.from({ length: this.client.options.concurrency }, () =>
        guard(this.work()),
      ),
    ]);
    if (this.client.interruption.signal.aborted) {
      throw new AbortedError();
    }
    if (this.failure !== null) {
      throw this.failure;
    }
  }

  private fail(error: unknown): void {
    if (error instanceof AbortedError && this.signal.aborted) {
      return;
    }
    this.failure ??= error instanceof Error ? error : new Error(String(error));
    this.stop.abort();
  }

  /** Nenhuma parte falta assinar (todas assinadas ou em assinatura). */
  private nothingToSign(): boolean {
    return (
      this.toHash.length === 0 && this.hashed.length === 0 && this.signing === 0
    );
  }

  private allSent(): boolean {
    return (
      this.nothingToSign() && this.ready.length === 0 && this.activePuts === 0
    );
  }

  /** Calculador: SHA-256 das partes em ordem, até `signBatch` à frente da assinatura. */
  private async hash(): Promise<void> {
    const { signBatch } = this.client.options;
    while (this.toHash.length > 0) {
      while (this.hashed.length >= signBatch) {
        if (this.signal.aborted) {
          return;
        }
        await this.changes.wait(this.signal);
      }
      if (this.signal.aborted) {
        return;
      }
      const partNumber = this.toHash[0];
      this.checksums.set(
        partNumber,
        await this.client.measureChecksum(partNumber, 'sign'),
      );
      this.toHash.shift();
      this.hashed.push(partNumber);
      this.changes.notify();
    }
  }

  private async checksum(partNumber: number): Promise<string> {
    const cached = this.checksums.get(partNumber);
    if (cached) {
      return cached;
    }
    const value = await this.client.measureChecksum(partNumber, 'sign');
    this.checksums.set(partNumber, value);
    return value;
  }

  private async partUrls(
    operation: string,
    parts: { partNumber: number; checksumSha256: string }[],
    completedParts: { partNumber: number; etag: string }[],
  ): Promise<PartUrlsResponse> {
    this.client.markLoadStart('part-urls');
    this.lastPartUrlsAt = Date.now();
    const { body } = await this.client.callApi<PartUrlsResponse>(
      operation,
      'POST',
      `/videos/${this.client.plan.publicId}/upload-sessions/${this.client.plan.sessionId}/part-urls`,
      {
        ...(parts.length > 0 ? { parts } : {}),
        ...(completedParts.length > 0 ? { completedParts } : {}),
      },
      [200],
      { signal: this.signal },
    );
    const missing = completedParts.filter(
      (part) => !body.registeredParts.includes(part.partNumber),
    );
    if (missing.length > 0) {
      throw new Error(
        `a API não registrou os ETags das partes ${missing.map((p) => p.partNumber).join(',')}`,
      );
    }
    for (const signed of body.parts) {
      const expected = partRange(this.client.plan, signed.partNumber).size;
      if (signed.method !== 'PUT' || signed.expectedSize !== expected) {
        throw new Error(
          `parte ${signed.partNumber} assinada com ${signed.method} e ${signed.expectedSize} bytes; o plano prevê PUT e ${expected}`,
        );
      }
    }
    for (const partNumber of body.registeredParts) {
      this.client.progress.registered.add(partNumber);
    }
    this.client.events.write('part_urls', {
      signed: body.parts.map((part) => part.partNumber),
      registered: body.registeredParts,
    });
    this.client.progress.update();
    return body;
  }

  /** Assina `batch` (pode ser vazio: só registro), levando todos os ETags pendentes. */
  private async signAndRegister(batch: number[]): Promise<void> {
    const completedParts = this.pendingEtags.splice(0);
    this.signing = batch.length;
    try {
      const parts = batch.map((partNumber) => ({
        partNumber,
        checksumSha256: this.checksums.get(partNumber) ?? '',
      }));
      const response = await this.partUrls(
        parts.length > 0 ? 'POST part-urls' : 'POST part-urls (só registro)',
        parts,
        completedParts,
      );
      this.ready.push(...response.parts);
    } catch (error) {
      this.pendingEtags.unshift(...completedParts);
      this.hashed.unshift(...batch);
      throw error;
    } finally {
      this.signing = 0;
      this.changes.notify();
    }
  }

  /**
   * Controlador: decide o próximo `part-urls`. O registro dos ETags pendentes tem prioridade e vai
   * junto com a assinatura quando as duas são devidas. Entre dois pedidos há pelo menos
   * `--part-urls-interval-ms` (o limite da rota é de 60 por minuto por IP); enquanto espera, o
   * lote seguinte cresce.
   */
  private async control(): Promise<void> {
    const { concurrency, signBatch, registerEvery, partUrlsIntervalMs } =
      this.client.options;
    for (;;) {
      if (this.signal.aborted) {
        return;
      }
      const done = this.allSent();
      const register =
        this.pendingEtags.length >= registerEvery ||
        (done && this.pendingEtags.length > 0);
      if (done && !register) {
        return;
      }
      const fullBatch = Math.min(
        signBatch,
        this.hashed.length + this.toHash.length,
      );
      // Trabalhador ocioso: nem PUT em andamento nem URL pronta para ele.
      const idleWorkers = concurrency - this.activePuts - this.ready.length;
      const sign =
        this.hashed.length > 0 &&
        ((this.ready.length < concurrency && this.hashed.length >= fullBatch) ||
          idleWorkers > 0);
      if (!register && !sign) {
        await this.changes.wait(this.signal);
        continue;
      }
      const pace = this.lastPartUrlsAt + partUrlsIntervalMs - Date.now();
      if (pace > 0) {
        await sleepMs(pace, this.signal);
        continue;
      }
      await this.signAndRegister(sign ? this.hashed.splice(0, signBatch) : []);
    }
  }

  private async work(): Promise<void> {
    for (;;) {
      if (this.signal.aborted) {
        return;
      }
      const next = this.ready.shift();
      if (!next) {
        if (this.nothingToSign()) {
          return;
        }
        await this.changes.wait(this.signal);
        continue;
      }
      this.activePuts += 1;
      this.changes.notify();
      try {
        const etag = await this.send(next);
        this.pendingEtags.push({ partNumber: next.partNumber, etag });
        this.client.progress.putDone.add(next.partNumber);
        this.client.progress.update();
      } finally {
        this.activePuts -= 1;
        this.changes.notify();
      }
    }
  }

  private async resign(partNumber: number): Promise<SignedPart> {
    const response = await this.partUrls(
      'POST part-urls (nova URL)',
      [{ partNumber, checksumSha256: await this.checksum(partNumber) }],
      [],
    );
    const signed = response.parts.find(
      (part) => part.partNumber === partNumber,
    );
    if (!signed) {
      throw new Error(`a API não devolveu a URL da parte ${partNumber}`);
    }
    return signed;
  }

  /** PUT de uma parte, com retentativas; uma URL perto de expirar ou recusada com 403 é assinada de novo. */
  private async send(first: SignedPart): Promise<string> {
    const { partNumber } = first;
    const { size } = partRange(this.client.plan, partNumber);
    let signed = first;
    for (let attempt = 1; ; attempt += 1) {
      if (Date.parse(signed.expiresAt) - Date.now() < URL_RENEWAL_MARGIN_MS) {
        signed = await this.resign(partNumber);
      }
      this.client.progress.inFlight.add(partNumber);
      this.client.progress.update();
      const result = await this.client.putPart(signed, this.signal);
      this.client.progress.inFlight.delete(partNumber);
      if (this.signal.aborted) {
        this.client.events.write('put', {
          part: partNumber,
          bytes: size,
          ms: round(result.durationMs),
          attempt,
          outcome: 'aborted',
        });
        console.log(
          `PUT | parte ${partNumber} | abortado depois de ${round(result.durationMs)} ms`,
        );
        throw new AbortedError();
      }
      const ok = result.status === 200 && result.etag !== '';
      this.client.events.write('put', {
        part: partNumber,
        bytes: size,
        ms: round(result.durationMs),
        attempt,
        status: result.status,
        outcome: ok ? 'ok' : 'failed',
        etag: ok ? result.etag : undefined,
        code: result.errorCode || undefined,
        error: result.networkError || undefined,
      });
      console.log(
        `PUT | parte ${partNumber} | ${size} bytes | ${round(result.durationMs)} ms | ${result.networkError || `HTTP ${result.status}${result.errorCode ? ` ${result.errorCode}` : ''}`} | tentativa ${attempt}`,
      );
      if (ok) {
        return result.etag;
      }
      if (result.status === 400 && CHECKSUM_REFUSALS.has(result.errorCode)) {
        throw new Error(
          `parte ${partNumber}: o storage recusou o corpo pelo checksum (${result.errorCode}); o arquivo mudou depois do cálculo`,
        );
      }
      if (attempt >= PUT_MAX_ATTEMPTS) {
        throw new Error(
          `parte ${partNumber}: PUT falhou em ${attempt} tentativas`,
        );
      }
      if (result.status === 403) {
        signed = await this.resign(partNumber);
      } else {
        await sleepMs(1000 * 2 ** (attempt - 1), this.signal);
      }
    }
  }
}

/** Arquivo sintético determinístico: fluxo de chave AES-256-CTR derivado da semente, incompressível. */
async function generate(
  file: string,
  size: number,
  seed: string,
  events: EventLog | null,
): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  const key = createHash('sha256').update(seed).digest();
  const cipher = createCipheriv('aes-256-ctr', key, Buffer.alloc(16, 0));
  const zeros = Buffer.alloc(8 * MIB);
  const hash = createHash('sha256');
  const out = createWriteStream(file, { flags: 'wx', mode: 0o600 });
  const started = performance.now();
  let written = 0;
  while (written < size) {
    const length = Math.min(zeros.length, size - written);
    const data = cipher.update(zeros.subarray(0, length));
    hash.update(data);
    if (!out.write(data)) {
      await once(out, 'drain');
    }
    written += length;
  }
  out.end();
  await finished(out);
  const ms = performance.now() - started;
  const { size: onDisk } = await stat(file);
  if (onDisk !== size) {
    throw new Error(`arquivo com ${onDisk} bytes no lugar de ${size}`);
  }
  const sha256 = hash.digest('hex');
  events?.write('generate', { bytes: onDisk, ms: round(ms), sha256 });
  console.log(
    `ARQUIVO | ${basename(file)} | ${onDisk} bytes | sha256 ${sha256} | gerado em ${round(ms)} ms (${round(size / MIB / (ms / 1000))} MiB/s)`,
  );
}

function positiveInteger(
  name: string,
  value: string | undefined,
  fallback: number,
  max = Number.MAX_SAFE_INTEGER,
): number {
  if (value === undefined) {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > max) {
    throw new UsageError(`--${name} precisa ser um inteiro entre 1 e ${max}`);
  }
  return parsed;
}

function parseStorageConnect(value: string | undefined): StorageConnect | null {
  if (value === undefined) {
    return null;
  }
  const match = /^([^=]+)=([^:=]+):(\d+)$/.exec(value);
  if (!match) {
    throw new UsageError(
      '--storage-connect precisa ter a forma host:porta=host:porta',
    );
  }
  return { from: match[1], hostname: match[2], port: Number(match[3]) };
}

function required(name: string, value: string | undefined): string {
  if (!value) {
    throw new UsageError(`--${name} é obrigatório`);
  }
  return value;
}

async function main(): Promise<number> {
  const [command, ...rest] = process.argv.slice(2);
  const { values } = parseArgs({
    args: rest,
    strict: true,
    options: {
      file: { type: 'string' },
      size: { type: 'string' },
      seed: { type: 'string' },
      credentials: { type: 'string' },
      state: { type: 'string' },
      events: { type: 'string' },
      api: { type: 'string' },
      'file-name': { type: 'string' },
      'content-type': { type: 'string' },
      concurrency: { type: 'string' },
      'sign-batch': { type: 'string' },
      'register-every': { type: 'string' },
      'part-urls-interval-ms': { type: 'string' },
      'storage-connect': { type: 'string' },
      'refresh-margin-seconds': { type: 'string' },
      progress: { type: 'string' },
      'hold-before-completion': { type: 'string' },
      'no-complete': { type: 'boolean' },
      'poll-interval-ms': { type: 'string' },
      'poll-timeout-seconds': { type: 'string' },
    },
  });
  if (command === 'generate') {
    await generate(
      required('file', values.file),
      positiveInteger('size', required('size', values.size), 0),
      required('seed', values.seed),
      values.events ? new EventLog(values.events, 'generate') : null,
    );
    return EXIT.OK;
  }
  if (command !== 'start' && command !== 'resume' && command !== 'complete') {
    throw new UsageError(
      'uso: generate | start | resume | complete (ver o cabeçalho do script)',
    );
  }
  const options: ClientOptions = {
    apiUrl: values.api ?? DEFAULT_API_URL,
    concurrency: positiveInteger('concurrency', values.concurrency, 4, 16),
    signBatch: positiveInteger('sign-batch', values['sign-batch'], 10, 50),
    registerEvery: positiveInteger(
      'register-every',
      values['register-every'],
      4,
      150,
    ),
    partUrlsIntervalMs: positiveInteger(
      'part-urls-interval-ms',
      values['part-urls-interval-ms'],
      1100,
      60_000,
    ),
    storageConnect: parseStorageConnect(values['storage-connect']),
    refreshMarginSeconds: positiveInteger(
      'refresh-margin-seconds',
      values['refresh-margin-seconds'],
      120,
    ),
    progressPath: values.progress ?? null,
    holdBeforeCompletion: values['hold-before-completion'] ?? null,
    complete: values['no-complete'] !== true,
    pollIntervalMs: positiveInteger(
      'poll-interval-ms',
      values['poll-interval-ms'],
      2000,
    ),
    pollTimeoutSeconds: positiveInteger(
      'poll-timeout-seconds',
      values['poll-timeout-seconds'],
      900,
    ),
  };
  const client = new UploadClient(
    command,
    options,
    required('credentials', values.credentials),
    required('state', values.state),
    required('events', values.events),
  );
  client.installSignalHandlers();
  client.startTokenRenewal();
  client.events.write('segment_start', {
    pid: process.pid,
    concurrency: options.concurrency,
    signBatch: options.signBatch,
    registerEvery: options.registerEvery,
    partUrlsIntervalMs: options.partUrlsIntervalMs,
    storageConnect: options.storageConnect !== null,
    tokenExpiresAt: new Date(client.tokens.expiresAtMs()).toISOString(),
  });
  client.progress.update('starting');
  try {
    if (command === 'start') {
      const file = required('file', values.file);
      await client.start(
        file,
        values['file-name'] ?? basename(file),
        values['content-type'] ?? 'video/mp4',
      );
    } else {
      client.loadState();
      if (command === 'resume') {
        await client.resume();
      } else {
        await client.completeAndPoll();
      }
    }
    client.markLoadEnd('segment-end');
    client.progress.update('done');
    client.events.write('segment_end', { outcome: 'ok' });
    return EXIT.OK;
  } catch (error) {
    if (error instanceof AbortedError && client.interruption.signal.aborted) {
      client.events.write('segment_end', { outcome: 'interrupted' });
      const signal = client.interruptedBy ?? 'SIGINT';
      console.log(`FIM | interrompido por ${signal}`);
      return SIGNAL_EXIT_CODES[signal];
    }
    client.markLoadEnd('failure');
    client.events.write('segment_end', {
      outcome: 'failed',
      error: errorName(error),
    });
    client.progress.update('failed');
    throw error;
  } finally {
    client.stopTokenRenewal();
  }
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    if (error instanceof UsageError) {
      console.error(error.message);
      process.exitCode = EXIT.USAGE;
      return;
    }
    console.error(`FALHA | ${errorName(error)}`);
    process.exitCode = EXIT.FAILED;
  });

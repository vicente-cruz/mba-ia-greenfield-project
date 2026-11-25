// Apoio das provas que usam o cliente de upload (SI-03.31, SI-03.32 e SI-03.33). Não faz parte da aplicação. Roda dentro do container `nestjs-api`.
// Prepara os recursos de prova pela API real, coleta evidências só de leitura, resume as medidas e
// remove apenas os recursos dos usuários de prova informados. Lê o `.env` sem imprimir valores;
// senhas, tokens e URLs assinadas nunca são impressos.
//
// Subcomandos:
//   api-check [--api <url>]
//       GET / da API, que precisa estar no ar.
//   account --email <e-mail> --credentials <json> [--api <url>]
//       registra um usuário de prova com senha aleatória, confirma pelo e-mail capturado no
//       Mailpit, faz login e grava as credenciais (modo 0600).
//   control-video --credentials <json> --state <json> --file-name <nome> [--api <url>]
//       cria o vídeo de controle em draft que a sonda consulta.
//   parts-snapshot --state <json> --out <json>
//       registro de partes da API (banco) e ListParts do storage da sessão, só leitura.
//   compare-parts --before <json> --after <json> --events <jsonl>
//       confere que as partes confirmed na retomada não foram reenviadas.
//   interrupt-when --progress <json> [--fraction 0.5] [--signal SIGINT]
//       vigia o progresso do cliente e envia o sinal quando essa fração das partes teve o PUT concluído.
//   summarize --events <jsonl> --out <json> [--disk <txt>] [--disk-fast <txt>] [--probe <csv> ...]
//       medidas do upload, do disco e da sonda, e a projeção para 10.000.000.000 bytes.
//   latency-verdict --events <jsonl> --probe <csv> ... --baseline-start <ms> --baseline-end <ms>
//                   --out <json>
//       fases da sonda (base, carga só com upload ativo, aquecimento e fora) e vereditos dos
//       critérios (a), (b) e (c) da SI-03.33, com o mínimo de 300 amostras por fase.
//   flow-check --credentials <json> --state <json> --events <jsonl> --source <arquivo> --out <json>
//              --thumbnail <jpg> [--storage-connect host:porta=host:porta] [--api <url>]
//       fluxo completo de um vídeo válido (SI-03.32): o arquivo enviado (ffprobe, caixas de topo do
//       MP4 e SHA-256), o 202 e o ready dos eventos do cliente, os metadados da API, o objeto da
//       thumbnail, três requisições Range na playback-url e o SHA-256 do download.
//   snapshot
//       retrato do banco (contagens), do bucket, da fila de processamento e do Mailpit.
//   cleanup --emails <e-mail,e-mail>
//       remove os vídeos, sessões, partes, objetos, multiparts, jobs, linhas e e-mails desses usuários.
// Código de saída: 0 com sucesso, 1 com item obrigatório reprovado ou falha, 64 com uso inválido.
import { execFile } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { createReadStream, readFileSync, writeFileSync } from 'node:fs';
import { open, stat } from 'node:fs/promises';
import {
  request as httpRequest,
  type IncomingHttpHeaders,
  type OutgoingHttpHeaders,
} from 'node:http';
import { performance } from 'node:perf_hooks';
import { parseArgs, promisify } from 'node:util';
import {
  AbortMultipartUploadCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListMultipartUploadsCommand,
  ListPartsCommand,
  type Part,
} from '@aws-sdk/client-s3';
import { Queue } from 'bullmq';
import Redis from 'ioredis';
import { DataSource } from 'typeorm';
import { VIDEO_QUEUES } from '../../src/videos/videos.constants';
import {
  type Credentials,
  DEFAULT_API_URL,
  expectStatus,
  type HttpResponse,
  httpJson,
  login,
  percentile,
  sleepMs,
  TokenSession,
  writePrivateJson,
} from './proof-api';
import {
  appClient,
  Checks,
  cleanupPrefix,
  type EnvSource,
  readProjectEnv,
  requireKey,
  sdkError,
  snapshotBucket,
} from './proof-support';

class UsageError extends Error {}

const TEN_GB = 10_000_000_000;
/** Margem das projeções (plano da SI-03.31). */
const PROJECTION_MARGIN = 1.3;
/** Fase de base da SI-03.33: 10 min sem upload. */
const BASELINE_SECONDS = 600;
/** Amostras mínimas por fase da SI-03.33, a uma requisição a cada 2 s por instância. */
const MIN_SAMPLES_SECONDS = 600;
/**
 * Endereço dos usuários de prova: `<prova>-<runId>-<papel>@proofs.streamtube.test`, com o runId dos
 * roteiros (AAAAMMDDhhmmss-xxxxxx). A criação e a limpeza recusam qualquer outro endereço.
 */
const PROOF_EMAIL =
  /^[a-z0-9]+-\d{14}-[0-9a-f]{6}-[a-z]+@proofs\.streamtube\.test$/;
const DB_TABLES = [
  'users',
  'channels',
  'videos',
  'upload_sessions',
  'upload_parts',
  'refresh_tokens',
  'verification_tokens',
] as const;

const round = (value: number, digits = 1): number =>
  Number(value.toFixed(digits));

function assertProofEmail(email: string): string {
  if (!PROOF_EMAIL.test(email)) {
    throw new UsageError(`não é um e-mail de usuário de prova: ${email}`);
  }
  return email;
}

function required(name: string, value: string | undefined): string {
  if (!value) {
    throw new UsageError(`--${name} é obrigatório`);
  }
  return value;
}

const readJson = <T>(path: string): T =>
  JSON.parse(readFileSync(path, 'utf8')) as T;

function mailpitApi(env: EnvSource): string {
  return `http://${requireKey(env, 'MAIL_HOST')}:8025/api/v1`;
}

async function withDatabase<T>(
  env: EnvSource,
  work: (db: DataSource) => Promise<T>,
): Promise<T> {
  const db = new DataSource({
    type: 'postgres',
    host: requireKey(env, 'DB_HOST'),
    port: Number(requireKey(env, 'DB_PORT')),
    username: requireKey(env, 'DB_USERNAME'),
    password: requireKey(env, 'DB_PASSWORD'),
    database: requireKey(env, 'DB_NAME'),
    entities: [],
    synchronize: false,
  });
  await db.initialize();
  try {
    return await work(db);
  } finally {
    await db.destroy();
  }
}

function processingQueue(env: EnvSource): Queue {
  return new Queue(VIDEO_QUEUES.PROCESSING, {
    connection: {
      host: requireKey(env, 'REDIS_HOST'),
      port: Number(requireKey(env, 'REDIS_PORT')),
    },
  });
}

const toIso = (value: unknown): string | null =>
  value instanceof Date
    ? value.toISOString()
    : typeof value === 'string'
      ? value
      : null;

// ---------------------------------------------------------------- api-check, account, control-video

async function apiCheck(apiUrl: string): Promise<boolean> {
  const response = await httpJson('GET', `${apiUrl}/`);
  console.log(
    `API | GET ${apiUrl}/ | HTTP ${response.status} em ${round(response.durationMs)} ms`,
  );
  return response.status === 200;
}

interface MailpitSearch {
  messages: { ID: string }[];
}

async function searchMail(env: EnvSource, email: string): Promise<string[]> {
  const query = encodeURIComponent(`to:"${email}"`);
  const response = await httpJson<MailpitSearch>(
    'GET',
    `${mailpitApi(env)}/search?query=${query}`,
  );
  expectStatus('GET Mailpit search', response, [200]);
  return response.body.messages.map((message) => message.ID);
}

async function confirmationToken(
  env: EnvSource,
  email: string,
): Promise<string> {
  for (let attempt = 1; attempt <= 30; attempt += 1) {
    const [id] = await searchMail(env, email);
    if (id) {
      const message = await httpJson<{ Text: string }>(
        'GET',
        `${mailpitApi(env)}/message/${id}`,
      );
      expectStatus('GET Mailpit message', message, [200]);
      const token = /confirm-email\?token=([A-Za-z0-9._~%-]+)/.exec(
        message.body.Text,
      )?.[1];
      if (!token) {
        throw new Error('e-mail de confirmação sem o link esperado');
      }
      return decodeURIComponent(token);
    }
    await sleepMs(500);
  }
  throw new Error(`nenhum e-mail de confirmação para ${email} no Mailpit`);
}

async function account(
  apiUrl: string,
  email: string,
  credentialsPath: string,
): Promise<boolean> {
  const env = readProjectEnv();
  const password = randomBytes(18).toString('base64url');
  const registered = await httpJson('POST', `${apiUrl}/auth/register`, {
    body: { email, password },
  });
  expectStatus('POST /auth/register', registered, [201]);
  const token = await confirmationToken(env, email);
  const confirmed = await httpJson(
    'GET',
    `${apiUrl}/auth/confirm-email?token=${encodeURIComponent(token)}`,
  );
  expectStatus('GET /auth/confirm-email', confirmed, [204]);
  const pair = await login(apiUrl, email, password);
  const credentials: Credentials = {
    email,
    password,
    accessToken: pair.access_token,
    refreshToken: pair.refresh_token,
  };
  writePrivateJson(credentialsPath, credentials);
  console.log(
    `CONTA | ${email} | register 201, confirm-email 204 (link do Mailpit), login 200 | credenciais em ${credentialsPath} (0600)`,
  );
  return true;
}

async function controlVideo(
  apiUrl: string,
  credentialsPath: string,
  statePath: string,
  fileName: string,
): Promise<boolean> {
  const { accessToken } = readJson<Credentials>(credentialsPath);
  const response = await httpJson<{
    publicId: string;
    status: string;
    uploadSession: { id: string };
  }>('POST', `${apiUrl}/videos`, {
    token: accessToken,
    body: { fileName, sizeBytes: 1_000_000, contentType: 'video/mp4' },
  });
  const { body } = expectStatus('POST /videos (controle)', response, [201]);
  writePrivateJson(statePath, {
    publicId: body.publicId,
    sessionId: body.uploadSession.id,
  });
  console.log(
    `CONTROLE | vídeo ${body.publicId} em ${body.status}, sessão ${body.uploadSession.id}, nenhuma parte enviada`,
  );
  return body.status === 'draft';
}

// ---------------------------------------------------------------- parts-snapshot, compare-parts

interface RegistryRow {
  partNumber: number;
  etag: string | null;
  checksumSha256: string;
  expectedSize: number;
  etagRegisteredAt: string | null;
}

interface StoragePartRow {
  partNumber: number;
  etag: string;
  size: number;
  lastModified: string | null;
  checksumSha256: string | null;
}

interface PartsSnapshot {
  at: string;
  publicId: string;
  videoStatus: string;
  sessionId: string;
  sessionStatus: string;
  partCount: number;
  registry: RegistryRow[];
  /** `null` quando o storage não conhece mais o upload (concluído ou abortado). */
  storage: StoragePartRow[] | null;
}

async function partsSnapshot(
  statePath: string,
  outPath: string,
): Promise<boolean> {
  const env = readProjectEnv();
  const { publicId } = readJson<{ publicId: string }>(statePath);
  const snapshot = await withDatabase(env, async (db) => {
    const [row] = await db.query<
      {
        video_status: string;
        session_id: string;
        session_status: string;
        object_key: string;
        upload_id: string | null;
        part_count: number;
      }[]
    >(
      `SELECT v.status AS video_status, s.id AS session_id, s.status AS session_status,
              s.object_key, s.upload_id, s.part_count
         FROM videos v JOIN upload_sessions s ON s.id = v.current_upload_session_id
        WHERE v.public_id = $1`,
      [publicId],
    );
    if (!row) {
      throw new Error(`vídeo ${publicId} sem sessão atual`);
    }
    const parts = await db.query<
      {
        part_number: number;
        etag: string | null;
        checksum_sha256: string;
        expected_size: number;
        etag_registered_at: unknown;
      }[]
    >(
      `SELECT part_number, etag, checksum_sha256, expected_size, etag_registered_at
         FROM upload_parts WHERE upload_session_id = $1 ORDER BY part_number`,
      [row.session_id],
    );
    let storage: StoragePartRow[] | null = null;
    if (row.upload_id) {
      try {
        storage = await listAllParts(env, row.object_key, row.upload_id);
      } catch (error) {
        if (sdkError(error).name !== 'NoSuchUpload') {
          throw error;
        }
      }
    }
    return {
      at: new Date().toISOString(),
      publicId,
      videoStatus: row.video_status,
      sessionId: row.session_id,
      sessionStatus: row.session_status,
      partCount: row.part_count,
      registry: parts.map((part) => ({
        partNumber: part.part_number,
        etag: part.etag,
        checksumSha256: part.checksum_sha256,
        expectedSize: part.expected_size,
        etagRegisteredAt: toIso(part.etag_registered_at),
      })),
      storage,
    } satisfies PartsSnapshot;
  });
  writeFileSync(outPath, `${JSON.stringify(snapshot, null, 2)}\n`);
  console.log(
    `PARTES | vídeo ${publicId} ${snapshot.videoStatus} | sessão ${snapshot.sessionStatus} | ${snapshot.registry.length} partes no registro da API, ${snapshot.registry.filter((p) => p.etag).length} com ETag | ${snapshot.storage === null ? 'upload desconhecido no storage' : `${snapshot.storage.length} partes no ListParts`}`,
  );
  const registry = new Map(
    snapshot.registry.map((part) => [part.partNumber, part]),
  );
  for (const part of snapshot.storage ?? []) {
    const record = registry.get(part.partNumber);
    console.log(
      `PARTE ${part.partNumber} | storage: ETag ${part.etag}, ${part.size} bytes, LastModified ${part.lastModified} | registro: ${record?.etag ? `ETag ${record.etag} desde ${record.etagRegisteredAt}` : 'sem ETag'}`,
    );
  }
  return true;
}

async function listAllParts(
  env: EnvSource,
  key: string,
  uploadId: string,
): Promise<StoragePartRow[]> {
  const client = appClient(env, 'S3_ENDPOINT');
  const parts: Part[] = [];
  let marker: string | undefined;
  do {
    const page = await client.send(
      new ListPartsCommand({
        Bucket: requireKey(env, 'S3_BUCKET'),
        Key: key,
        UploadId: uploadId,
        PartNumberMarker: marker,
      }),
    );
    parts.push(...(page.Parts ?? []));
    marker = page.IsTruncated ? page.NextPartNumberMarker : undefined;
  } while (marker);
  return parts.map((part) => ({
    partNumber: part.PartNumber ?? 0,
    etag: part.ETag ?? '',
    size: part.Size ?? 0,
    lastModified: part.LastModified ? part.LastModified.toISOString() : null,
    checksumSha256: part.ChecksumSHA256 ?? null,
  }));
}

interface ClientEvent {
  t: number;
  seg: string;
  ev: string;
  [field: string]: unknown;
}

function readEvents(path: string): ClientEvent[] {
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as ClientEvent);
}

const numbers = (value: unknown): number[] =>
  Array.isArray(value)
    ? value.filter((n): n is number => typeof n === 'number')
    : [];

function compareParts(
  beforePath: string,
  afterPath: string,
  eventsPath: string,
): boolean {
  const before = readJson<PartsSnapshot>(beforePath);
  const after = readJson<PartsSnapshot>(afterPath);
  const events = readEvents(eventsPath);
  const classification = events
    .filter((e) => e.ev === 'resume_classification')
    .at(-1);
  if (!classification || !before.storage || !after.storage) {
    throw new Error(
      'faltam a classificação da retomada ou as listagens do storage',
    );
  }
  const confirmed = numbers(classification.confirmed);
  const resent = new Set(
    events
      .filter((e) => e.seg === 'resume' && e.ev === 'put' && e.outcome === 'ok')
      .map((e) => e.part as number),
  );
  const checks = new Checks();
  checks.info('partes confirmed na retomada', `[${confirmed.join(',')}]`);
  checks.info(
    'partes com PUT na retomada',
    `[${[...resent].sort((a, b) => a - b).join(',')}]`,
  );
  const resentConfirmed = confirmed.filter((n) => resent.has(n));
  checks.add(
    'cliente: nenhum PUT de parte confirmed na retomada',
    'nenhuma',
    resentConfirmed.length === 0 ? 'nenhuma' : `[${resentConfirmed.join(',')}]`,
    resentConfirmed.length === 0 && confirmed.length > 0,
  );
  const storageBefore = new Map(before.storage.map((p) => [p.partNumber, p]));
  const storageAfter = new Map(after.storage.map((p) => [p.partNumber, p]));
  const sameStored = (n: number): boolean => {
    const a = storageBefore.get(n);
    const b = storageAfter.get(n);
    return (
      a !== undefined &&
      b !== undefined &&
      a.etag === b.etag &&
      a.size === b.size &&
      a.lastModified === b.lastModified
    );
  };
  const changedConfirmed = confirmed.filter((n) => !sameStored(n));
  checks.add(
    'storage: partes confirmed com o mesmo ETag, tamanho e LastModified antes e depois da retomada',
    `${confirmed.length} de ${confirmed.length} iguais`,
    `${confirmed.length - changedConfirmed.length} de ${confirmed.length} iguais${changedConfirmed.length ? `; diferentes: [${changedConfirmed.join(',')}]` : ''}`,
    changedConfirmed.length === 0,
  );
  const registryBefore = new Map(before.registry.map((p) => [p.partNumber, p]));
  const registryAfter = new Map(after.registry.map((p) => [p.partNumber, p]));
  const changedRegistry = confirmed.filter((n) => {
    const a = registryBefore.get(n);
    const b = registryAfter.get(n);
    return (
      !a || !b || a.etag !== b.etag || a.etagRegisteredAt !== b.etagRegisteredAt
    );
  });
  checks.add(
    'registro da API: ETag e etag_registered_at das partes confirmed inalterados',
    `${confirmed.length} de ${confirmed.length} inalterados`,
    `${confirmed.length - changedRegistry.length} de ${confirmed.length} inalterados${changedRegistry.length ? `; alterados: [${changedRegistry.join(',')}]` : ''}`,
    changedRegistry.length === 0,
  );
  const resentWithNewTime = [...resent].filter(
    (n) =>
      storageAfter.has(n) &&
      storageBefore.get(n)?.lastModified !== storageAfter.get(n)?.lastModified,
  );
  checks.add(
    'controle: cada parte reenviada aparece no storage com LastModified novo',
    `${resent.size} de ${resent.size}`,
    `${resentWithNewTime.length} de ${resent.size}`,
    resentWithNewTime.length === resent.size,
  );
  const complete = Array.from(
    { length: after.partCount },
    (_, i) => i + 1,
  ).filter((n) => {
    const stored = storageAfter.get(n);
    const record = registryAfter.get(n);
    return stored && record?.etag && stored.etag === record.etag;
  });
  checks.add(
    'antes do completion: todas as partes no storage, registradas com o mesmo ETag',
    `${after.partCount} de ${after.partCount}`,
    `${complete.length} de ${after.partCount}`,
    complete.length === after.partCount,
  );
  console.log(`COMPARAÇÃO | ${checks.summary()}`);
  return checks.allPassed;
}

// ---------------------------------------------------------------- interrupt-when

interface ClientProgress {
  pid: number;
  phase: string;
  partCount: number;
  putDone: number[];
  registered: number[];
  inFlight: number[];
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Vigia externo da interrupção: lê o progresso do cliente a cada 50 ms e, quando a fração pedida
 * das partes do plano já teve o PUT concluído, envia o sinal ao processo do cliente. Roda no mesmo
 * container do cliente, como outro processo.
 */
async function interruptWhen(
  progressPath: string,
  fraction: number,
  signal: NodeJS.Signals,
): Promise<boolean> {
  const deadline = Date.now() + 30 * 60_000;
  let seenClient = false;
  for (;;) {
    let progress: ClientProgress | null = null;
    try {
      progress = readJson<ClientProgress>(progressPath);
    } catch {
      // O cliente ainda não gravou o progresso.
    }
    if (progress) {
      seenClient = true;
      const threshold = Math.ceil(progress.partCount * fraction);
      if (
        !processAlive(progress.pid) ||
        progress.phase === 'done' ||
        progress.phase === 'failed'
      ) {
        console.log(
          `VIGIA | o cliente terminou (${progress.phase}) com ${progress.putDone.length} de ${progress.partCount} partes antes do limite de ${threshold}`,
        );
        return false;
      }
      if (progress.partCount > 0 && progress.putDone.length >= threshold) {
        process.kill(progress.pid, signal);
        console.log(
          `VIGIA | ${signal} enviado ao cliente (pid ${progress.pid}) com ${progress.putDone.length} de ${progress.partCount} partes com PUT concluído (limite: ${threshold}) | PUT concluído: [${progress.putDone.join(',')}] | registradas: [${progress.registered.join(',')}] | em andamento: [${progress.inFlight.join(',')}]`,
        );
        return true;
      }
    }
    if (Date.now() > deadline) {
      throw new Error(
        seenClient
          ? 'o limite não foi atingido em 30 min'
          : 'nenhum progresso do cliente em 30 min',
      );
    }
    await sleepMs(50);
  }
}

// ---------------------------------------------------------------- summarize

interface Interval {
  start: number;
  end: number;
}

function mergedMs(intervals: Interval[]): number {
  const sorted = [...intervals].sort((a, b) => a.start - b.start);
  let total = 0;
  let current: Interval | null = null;
  for (const interval of sorted) {
    if (current && interval.start <= current.end) {
      current.end = Math.max(current.end, interval.end);
    } else {
      if (current) {
        total += current.end - current.start;
      }
      current = { ...interval };
    }
  }
  return current ? total + current.end - current.start : total;
}

/**
 * Intervalos de upload ativo, de `load_start` a `load_end`. Um intervalo ainda aberto fecha no fim
 * do segmento (`segment_end`) ou no último evento antes de outro segmento, para que a falha de um
 * processo nunca estenda o intervalo até o processo seguinte.
 */
function loadIntervals(events: ClientEvent[]): Interval[] {
  const intervals: Interval[] = [];
  let open: { start: number; seg: string } | null = null;
  let last: ClientEvent | null = null;
  for (const event of events) {
    if (open && event.seg !== open.seg && last) {
      intervals.push({ start: open.start, end: last.t });
      open = null;
    }
    if (event.ev === 'load_start' && open === null) {
      open = { start: event.t, seg: event.seg };
    } else if (
      (event.ev === 'load_end' || event.ev === 'segment_end') &&
      open
    ) {
      intervals.push({ start: open.start, end: event.t });
      open = null;
    }
    last = event;
  }
  if (open && last) {
    intervals.push({ start: open.start, end: last.t });
  }
  return intervals;
}

interface SegmentMetrics {
  puts: number;
  putBytes: number;
  putActiveMs: number;
  putMiBps: number;
  abortedPuts: number;
  failedPuts: number;
  checksumParts: number;
  checksumBytes: number;
  checksumMs: number;
  checksumMiBps: number;
}

const MIB = 1024 * 1024;
const mibps = (bytes: number, ms: number): number =>
  ms > 0 ? round(bytes / MIB / (ms / 1000)) : 0;

function segmentMetrics(
  events: ClientEvent[],
  segment: string,
  purpose: 'sign' | 'verify',
): SegmentMetrics {
  const puts = events.filter((e) => e.seg === segment && e.ev === 'put');
  const ok = puts.filter((e) => e.outcome === 'ok');
  const putBytes = ok.reduce((sum, e) => sum + (e.bytes as number), 0);
  const putActiveMs = mergedMs(
    puts.map((e) => ({ start: e.t - (e.ms as number), end: e.t })),
  );
  const checksums = events.filter(
    (e) => e.seg === segment && e.ev === 'checksum' && e.purpose === purpose,
  );
  const checksumBytes = checksums.reduce(
    (sum, e) => sum + (e.bytes as number),
    0,
  );
  const checksumMs = checksums.reduce((sum, e) => sum + (e.ms as number), 0);
  return {
    puts: ok.length,
    putBytes,
    putActiveMs: round(putActiveMs),
    putMiBps: mibps(putBytes, putActiveMs),
    abortedPuts: puts.filter((e) => e.outcome === 'aborted').length,
    failedPuts: puts.filter((e) => e.outcome === 'failed').length,
    checksumParts: checksums.length,
    checksumBytes,
    checksumMs: round(checksumMs),
    checksumMiBps: mibps(checksumBytes, checksumMs),
  };
}

/** Uma amostra do volume do storage, em KiB (ver `STORAGE_DU` no roteiro). */
interface DiskSample {
  t: number;
  totalKiB: number;
  bucketKiB: number;
  multipartKiB: number;
  tmpKiB: number;
  trashKiB: number;
  usedKiB: number;
  availKiB: number;
}

function readDisk(path: string): DiskSample[] {
  return readFileSync(path, 'utf8')
    .split('\n')
    .map((line) => line.trim().split(/\s+/).map(Number))
    .filter((fields) => fields.length === 8 && fields.every(Number.isFinite))
    .map(
      ([
        t,
        totalKiB,
        bucketKiB,
        multipartKiB,
        tmpKiB,
        trashKiB,
        usedKiB,
        availKiB,
      ]) => ({
        t,
        totalKiB,
        bucketKiB,
        multipartKiB,
        tmpKiB,
        trashKiB,
        usedKiB,
        availKiB,
      }),
    );
}

/** `df` sem pausa em volta do completion: instante em ms e KiB usados no disco do storage. */
function readFastDisk(path: string): { t: number; usedKiB: number }[] {
  return readFileSync(path, 'utf8')
    .split('\n')
    .map((line) => line.trim().split(/\s+/).map(Number))
    .filter((fields) => fields.length === 2 && fields.every(Number.isFinite))
    .map(([t, usedKiB]) => ({ t, usedKiB }));
}

interface ProbeRow {
  instance: string;
  epochMs: number;
  status: number | null;
  latencyMs: number;
  outcome: string;
}

function readProbe(path: string): ProbeRow[] {
  const [header, ...lines] = readFileSync(path, 'utf8').trim().split('\n');
  if (header !== 'instance,seq,instant,epoch_ms,status,latency_ms,outcome') {
    throw new Error(`cabeçalho inesperado no CSV da sonda: ${header}`);
  }
  return lines.map((line) => {
    const [instance, , , epochMs, status, latencyMs, outcome] = line.split(',');
    return {
      instance,
      epochMs: Number(epochMs),
      status: status === '' ? null : Number(status),
      latencyMs: Number(latencyMs),
      outcome,
    };
  });
}

function probeStats(rows: ProbeRow[]): Record<string, number> {
  const latencies = rows
    .filter((row) => row.outcome === 'ok')
    .map((row) => row.latencyMs)
    .sort((a, b) => a - b);
  return {
    samples: rows.length,
    ok: latencies.length,
    non2xx: rows.filter(
      (row) => row.status !== null && (row.status < 200 || row.status >= 300),
    ).length,
    status429: rows.filter((row) => row.status === 429).length,
    timeouts: rows.filter((row) => row.outcome === 'timeout').length,
    networkErrors: rows.filter((row) => row.outcome === 'network_error').length,
    unexpectedBody: rows.filter((row) => row.outcome === 'unexpected_body')
      .length,
    p50: round(percentile(latencies, 50), 2),
    p95: round(percentile(latencies, 95), 2),
    p99: round(percentile(latencies, 99), 2),
    max: latencies.length
      ? round(latencies[latencies.length - 1], 2)
      : Number.NaN,
  };
}

function summarize(
  eventsPath: string,
  outPath: string,
  diskPath: string | undefined,
  fastDiskPath: string | undefined,
  probePaths: string[],
): boolean {
  const events = readEvents(eventsPath);
  const find = (ev: string, seg?: string): ClientEvent | undefined =>
    events.find((e) => e.ev === ev && (seg === undefined || e.seg === seg));
  const plan = find('plan');
  if (!plan) {
    throw new Error('eventos sem o plano do upload');
  }
  const sizeBytes = plan.sizeBytes as number;
  const factor = TEN_GB / sizeBytes;
  const generation = find('generate');
  const interrupted = find('interrupted', 'start');
  const classification = find('resume_classification', 'resume');
  const verification = find('file_verification', 'resume');
  const completionStart = find('completion_start');
  const completion = find('completion');
  const final = find('final');
  const holds = events.filter(
    (e) => e.ev === 'hold_start' || e.ev === 'hold_end',
  );
  const intervals = loadIntervals(events);
  const loadMs = intervals.reduce((sum, i) => sum + (i.end - i.start), 0);
  const start = segmentMetrics(events, 'start', 'sign');
  const resume = segmentMetrics(events, 'resume', 'sign');
  const resumeVerify = segmentMetrics(events, 'resume', 'verify');
  // Só os PUTs concluídos com sucesso: os bytes parciais dos PUTs abortados não são medidos.
  const wireBytes = start.putBytes + resume.putBytes;
  const allPutMs = start.putActiveMs + resume.putActiveMs;
  const signChecksumMs = start.checksumMs + resume.checksumMs;
  const signChecksumBytes = start.checksumBytes + resume.checksumBytes;
  const resumeStart = events.find(
    (e) => e.seg === 'resume' && e.ev === 'load_start',
  );
  const gapMs =
    interrupted && resumeStart ? resumeStart.t - interrupted.t : null;
  const interruptedBytes = interrupted
    ? numbers(interrupted.putDone).length * (plan.partSize as number)
    : 0;
  const processingMs = completion && final ? final.t - completion.t : null;
  const apiCalls = events.filter((e) => e.ev === 'api');
  const tokenRenewals = events.filter((e) => e.ev === 'token_renewal').length;

  const summary: Record<string, unknown> = {
    plan: {
      sizeBytes,
      partSize: plan.partSize,
      partCount: plan.partCount,
      lastPartSize: plan.lastPartSize,
    },
    generation: generation
      ? { bytes: generation.bytes, ms: generation.ms }
      : null,
    loadIntervals: intervals.map((i) => ({
      start: new Date(i.start).toISOString(),
      end: new Date(i.end).toISOString(),
      seconds: round((i.end - i.start) / 1000, 3),
    })),
    loadSeconds: round(loadMs / 1000, 3),
    segments: { start, resume, resumeVerify },
    interruption: interrupted
      ? {
          signal: interrupted.signal,
          putDone: interrupted.putDone,
          registered: interrupted.registered,
          inFlight: interrupted.inFlight,
          putDonePercent: round(
            (100 * Math.min(interruptedBytes, sizeBytes)) / sizeBytes,
          ),
        }
      : null,
    gapSeconds: gapMs === null ? null : round(gapMs / 1000, 3),
    resume: classification
      ? {
          confirmed: classification.confirmed,
          unregistered: classification.unregistered,
          missing: classification.missing,
          divergent: classification.divergent,
          verification: verification
            ? {
                parts: numbers(verification.parts).length,
                bytes: verification.bytes,
                checksumMs: verification.checksumMs,
                requestMs: verification.requestMs,
              }
            : null,
        }
      : null,
    wire: {
      bytes: wireBytes,
      resentFraction: round(wireBytes / sizeBytes - 1, 4),
      putActiveMs: round(allPutMs),
      putMiBps: mibps(wireBytes, allPutMs),
    },
    checksums: {
      signBytes: signChecksumBytes,
      signMs: round(signChecksumMs),
      signMiBps: mibps(signChecksumBytes, signChecksumMs),
      verifyBytes: resumeVerify.checksumBytes,
      verifyMs: resumeVerify.checksumMs,
      verifyMiBps: resumeVerify.checksumMiBps,
    },
    completion: completion
      ? {
          status: completion.status,
          ms: completion.ms,
          startedAt: completionStart
            ? new Date(completionStart.t).toISOString()
            : null,
          endedAt: new Date(completion.t).toISOString(),
        }
      : null,
    processing: final
      ? {
          status: final.status,
          errorCode: final.errorCode,
          seconds: processingMs === null ? null : round(processingMs / 1000, 3),
        }
      : null,
    holds: holds.map((e) => ({ ev: e.ev, at: new Date(e.t).toISOString() })),
    apiCalls: apiCalls.length,
    tokenRenewals,
  };

  if (diskPath) {
    const samples = readDisk(diskPath);
    if (samples.length > 0) {
      const maxBy = (list: DiskSample[], value: (s: DiskSample) => number) =>
        list.reduce((best, s) => (value(s) > value(best) ? s : best), list[0]);
      const baseline = samples[0];
      const last = samples[samples.length - 1];
      const overall = maxBy(samples, (s) => s.totalKiB);
      const upload = maxBy(samples, (s) => s.bucketKiB + s.multipartKiB);
      const window =
        completionStart && completion
          ? samples.filter(
              (s) =>
                s.t >= completionStart.t - 1000 && s.t <= completion.t + 1000,
            )
          : [];
      const before = completionStart
        ? samples.filter((s) => s.t < completionStart.t).at(-1)
        : undefined;
      const after = completion && samples.find((s) => s.t > completion.t);
      const intervalsMs = samples
        .slice(1)
        .map((s, i) => s.t - samples[i].t)
        .sort((a, b) => a - b);
      const components = (s: DiskSample | undefined) =>
        s && {
          at: new Date(s.t).toISOString(),
          totalKiB: s.totalKiB,
          bucketKiB: s.bucketKiB,
          multipartKiB: s.multipartKiB,
          tmpKiB: s.tmpKiB,
          trashKiB: s.trashKiB,
        };
      summary.disk = {
        samples: samples.length,
        medianIntervalMs: intervalsMs.length
          ? percentile(intervalsMs, 50)
          : null,
        baseline: components(baseline),
        peak: components(overall),
        peakGrowthBytes: (overall.totalKiB - baseline.totalKiB) * 1024,
        uploadDataPeakBytes:
          (upload.bucketKiB +
            upload.multipartKiB -
            baseline.bucketKiB -
            baseline.multipartKiB) *
          1024,
        tmpGrowthBytes:
          (last.tmpKiB -
            last.trashKiB -
            (baseline.tmpKiB - baseline.trashKiB)) *
          1024,
        trashMaxKiB: Math.max(...samples.map((s) => s.trashKiB)),
        completionWindowSamples: window.length,
        completionWindowPeakGrowthBytes: window.length
          ? (maxBy(window, (s) => s.totalKiB).totalKiB - baseline.totalKiB) *
            1024
          : null,
        beforeCompletion: components(before),
        afterCompletion: components(after || undefined),
        final: components(last),
        dockerDiskUsedBaselineKiB: baseline.usedKiB,
        dockerDiskUsedPeakKiB: Math.max(...samples.map((s) => s.usedKiB)),
        dockerDiskAvailMinKiB: Math.min(...samples.map((s) => s.availKiB)),
      };
    }
  }
  if (fastDiskPath && completionStart && completion) {
    const fast = readFastDisk(fastDiskPath);
    const before = fast.filter((s) => s.t < completionStart.t);
    const during = fast.filter(
      (s) => s.t >= completionStart.t && s.t <= completion.t,
    );
    const afterward = fast.filter((s) => s.t > completion.t);
    const reference = before.at(-1)?.usedKiB ?? null;
    const peakDuring = during.length
      ? Math.max(...during.map((s) => s.usedKiB))
      : null;
    summary.completionFastDisk = {
      samples: fast.length,
      samplesDuringCompletion: during.length,
      medianIntervalMs:
        fast.length > 1
          ? percentile(
              fast
                .slice(1)
                .map((s, i) => s.t - fast[i].t)
                .sort((a, b) => a - b),
              50,
            )
          : null,
      usedBeforeKiB: reference,
      usedPeakDuringKiB: peakDuring,
      usedPeakAfterKiB: afterward.length
        ? Math.max(...afterward.map((s) => s.usedKiB))
        : null,
      peakGrowthDuringBytes:
        reference !== null && peakDuring !== null
          ? (peakDuring - reference) * 1024
          : null,
    };
  }

  const probes = probePaths.flatMap(readProbe);
  if (probes.length > 0) {
    const firstLoad = intervals[0]?.start ?? Infinity;
    const inLoad = (t: number) =>
      intervals.some((i) => t >= i.start && t <= i.end);
    summary.probe = {
      instances: probePaths.length,
      all: probeStats(probes),
      baseline: probeStats(probes.filter((row) => row.epochMs < firstLoad)),
      load: probeStats(probes.filter((row) => inLoad(row.epochMs))),
      outside: probeStats(
        probes.filter(
          (row) => row.epochMs >= firstLoad && !inLoad(row.epochMs),
        ),
      ),
    };
  }

  // Projeção linear para 10.000.000.000 bytes: tempos e bytes proporcionais ao tamanho.
  const disk = summary.disk as { peakGrowthBytes: number } | undefined;
  const loadSeconds10 = (loadMs / 1000) * factor;
  const projection = {
    factor: round(factor, 3),
    margin: PROJECTION_MARGIN,
    generationSeconds: generation
      ? round(((generation.ms as number) / 1000) * factor, 1)
      : null,
    loadSeconds: round(loadSeconds10, 1),
    loadSecondsWithMargin: round(loadSeconds10 * PROJECTION_MARGIN, 1),
    putSeconds: round((allPutMs / 1000) * factor, 1),
    signChecksumSeconds: round((signChecksumMs / 1000) * factor, 1),
    verifyChecksumSeconds: round((resumeVerify.checksumMs / 1000) * factor, 1),
    completionSeconds: completion
      ? round(((completion.ms as number) / 1000) * factor, 1)
      : null,
    probeInstances:
      loadSeconds10 > 0 ? Math.ceil(MIN_SAMPLES_SECONDS / loadSeconds10) : null,
    storagePeakBytes: disk ? Math.round(disk.peakGrowthBytes * factor) : null,
    storagePeakBytesWithMargin: disk
      ? Math.round(disk.peakGrowthBytes * factor * PROJECTION_MARGIN)
      : null,
    sourceFileBytes: TEN_GB,
    requiredFreeBytesWithMargin: disk
      ? Math.round((disk.peakGrowthBytes * factor + TEN_GB) * PROJECTION_MARGIN)
      : null,
    baselineSeconds: BASELINE_SECONDS,
  };
  summary.projection = projection;
  writeFileSync(outPath, `${JSON.stringify(summary, null, 2)}\n`);

  const line = (label: string, value: unknown) =>
    console.log(
      `MEDIDA | ${label} | ${typeof value === 'string' ? value : JSON.stringify(value)}`,
    );
  line('plano', summary.plan);
  line('geração do arquivo', summary.generation);
  line('intervalos de upload ativo', summary.loadIntervals);
  line('upload ativo total (s)', summary.loadSeconds);
  line('segmento start', start);
  line('segmento resume (PUTs e checksums de assinatura)', resume);
  line('conferência da retomada (checksums)', resumeVerify);
  line('interrupção', summary.interruption);
  line('intervalo entre a interrupção e a retomada (s)', summary.gapSeconds);
  line('retomada', summary.resume);
  line('bytes dos PUTs concluídos (abortados fora da soma)', summary.wire);
  line('checksums', summary.checksums);
  line('completion', summary.completion);
  line('processamento até o estado final', summary.processing);
  line('chamadas à API e renovações de token', {
    apiCalls: apiCalls.length,
    tokenRenewals,
  });
  if (summary.disk) {
    line('disco do storage (du em KiB por componente)', summary.disk);
  }
  if (summary.completionFastDisk) {
    line('df sem pausa em volta do completion', summary.completionFastDisk);
  }
  if (summary.probe) {
    line('sonda (informativo)', summary.probe);
  }
  console.log(
    `PROJEÇÃO | 10.000.000.000 bytes, linear, margem de 30% onde indicado | ${JSON.stringify(projection)}`,
  );
  return true;
}

// ---------------------------------------------------------------- latency-verdict (SI-03.33)

/** Mínimo de amostras por fase (SI-03.33). */
const MIN_PHASE_SAMPLES = 300;

type CriterionVerdict = 'aprovado' | 'reprovado' | 'inconclusivo';

interface PhaseStats {
  samples: number;
  ok: number;
  non2xx: number;
  status429: number;
  timeouts: number;
  networkErrors: number;
  unexpectedBody: number;
  /** Percentis e máximo sobre todas as amostras da fase, com a latência até o desfecho. */
  p50: number;
  p95: number;
  p99: number;
  max: number;
  byInstance: Record<string, number>;
}

function phaseStats(rows: ProbeRow[]): PhaseStats {
  const latencies = rows.map((row) => row.latencyMs).sort((a, b) => a - b);
  const byInstance: Record<string, number> = {};
  for (const row of rows) {
    byInstance[row.instance] = (byInstance[row.instance] ?? 0) + 1;
  }
  return {
    samples: rows.length,
    ok: rows.filter((row) => row.outcome === 'ok').length,
    non2xx: rows.filter(
      (row) => row.status !== null && (row.status < 200 || row.status >= 300),
    ).length,
    status429: rows.filter((row) => row.status === 429).length,
    timeouts: rows.filter((row) => row.outcome === 'timeout').length,
    networkErrors: rows.filter((row) => row.outcome === 'network_error').length,
    unexpectedBody: rows.filter((row) => row.outcome === 'unexpected_body')
      .length,
    p50: percentile(latencies, 50),
    p95: percentile(latencies, 95),
    p99: percentile(latencies, 99),
    max: latencies.length ? latencies[latencies.length - 1] : Number.NaN,
    byInstance,
  };
}

const roundedStats = (stats: PhaseStats): PhaseStats => ({
  ...stats,
  p50: round(stats.p50, 2),
  p95: round(stats.p95, 2),
  p99: round(stats.p99, 2),
  max: round(stats.max, 2),
});

/**
 * Vereditos de latência da SI-03.33, com os critérios e as fases fixados antes da execução:
 * - base: amostras disparadas de `baselineStart` (todas as instâncias amostrando) até
 *   `baselineEnd` (lançamento do cliente de upload);
 * - carga: amostras disparadas dentro dos intervalos de upload ativo do cliente (do primeiro
 *   `part-urls` à interrupção, da retomada à espera do completion e da liberação ao `202`);
 * - aquecimento e fora: as demais, que só contam no critério (c);
 * - (a) p95 carga ≤ max(1,5 × p95 base; p95 base + 50 ms); (b) p95 carga ≤ 250 ms e p99 carga
 *   ≤ 500 ms; (c) nenhuma amostra sem 2xx válido (fora de 2xx, 429, timeout, erro de rede ou
 *   corpo inesperado), em todas as amostras coletadas;
 * - com menos de 300 amostras na base ou na carga, (a) e (b) são `inconclusivo`.
 */
function latencyVerdict(
  eventsPath: string,
  probePaths: string[],
  baselineStart: number,
  baselineEnd: number,
  outPath: string,
): boolean {
  const events = readEvents(eventsPath);
  const intervals = loadIntervals(events);
  if (intervals.length === 0) {
    throw new Error('eventos sem intervalo de upload ativo');
  }
  if (!(baselineStart < baselineEnd && baselineEnd <= intervals[0].start)) {
    throw new Error(
      'a base precisa terminar antes do primeiro intervalo de upload ativo',
    );
  }
  const rows = probePaths.flatMap(readProbe);
  const inLoad = (t: number) =>
    intervals.some((i) => t >= i.start && t <= i.end);
  const warmup = rows.filter((row) => row.epochMs < baselineStart);
  const baselineRows = rows.filter(
    (row) => row.epochMs >= baselineStart && row.epochMs < baselineEnd,
  );
  const loadRows = rows.filter((row) => inLoad(row.epochMs));
  const outsideRows = rows.filter(
    (row) => row.epochMs >= baselineEnd && !inLoad(row.epochMs),
  );
  const baseline = phaseStats(baselineRows);
  const load = phaseStats(loadRows);
  const all = phaseStats(rows);
  const loadMs = intervals.reduce((sum, i) => sum + (i.end - i.start), 0);
  const enough =
    baseline.samples >= MIN_PHASE_SAMPLES && load.samples >= MIN_PHASE_SAMPLES;
  const thresholdA = Math.max(1.5 * baseline.p95, baseline.p95 + 50);
  const a: CriterionVerdict = !enough
    ? 'inconclusivo'
    : load.p95 <= thresholdA
      ? 'aprovado'
      : 'reprovado';
  const b: CriterionVerdict = !enough
    ? 'inconclusivo'
    : load.p95 <= 250 && load.p99 <= 500
      ? 'aprovado'
      : 'reprovado';
  const failures = all.samples - all.ok;
  const c: CriterionVerdict =
    failures === 0 && all.non2xx === 0 && all.status429 === 0
      ? 'aprovado'
      : 'reprovado';
  const latency: CriterionVerdict = [a, b, c].includes('reprovado')
    ? 'reprovado'
    : [a, b].includes('inconclusivo')
      ? 'inconclusivo'
      : 'aprovado';
  const result = {
    phases: {
      baseline: {
        start: new Date(baselineStart).toISOString(),
        end: new Date(baselineEnd).toISOString(),
        seconds: round((baselineEnd - baselineStart) / 1000, 3),
        ...roundedStats(baseline),
      },
      load: {
        intervals: intervals.map((i) => ({
          start: new Date(i.start).toISOString(),
          end: new Date(i.end).toISOString(),
          seconds: round((i.end - i.start) / 1000, 3),
        })),
        seconds: round(loadMs / 1000, 3),
        ...roundedStats(load),
      },
      warmup: roundedStats(phaseStats(warmup)),
      outside: roundedStats(phaseStats(outsideRows)),
      all: roundedStats(all),
    },
    instances: probePaths.length,
    minPhaseSamples: MIN_PHASE_SAMPLES,
    enoughSamples: enough,
    criteria: {
      a: {
        verdict: a,
        thresholdMs: round(thresholdA, 2),
        loadP95Ms: round(load.p95, 2),
      },
      b: {
        verdict: b,
        loadP95Ms: round(load.p95, 2),
        loadP99Ms: round(load.p99, 2),
      },
      c: {
        verdict: c,
        samples: all.samples,
        failures,
        non2xx: all.non2xx,
        status429: all.status429,
        timeouts: all.timeouts,
        networkErrors: all.networkErrors,
        unexpectedBody: all.unexpectedBody,
      },
    },
    latency,
    /** `N = ceil(600 / D)` com a `D` medida, para a repetição de uma execução inconclusiva. */
    recalculatedInstances: Math.ceil(MIN_SAMPLES_SECONDS / (loadMs / 1000)),
  };
  writeFileSync(outPath, `${JSON.stringify(result, null, 2)}\n`);
  const describe = (name: string, stats: PhaseStats) => {
    const perInstance = Object.entries(stats.byInstance)
      .map(([instance, n]) => `instância ${instance}: ${n}`)
      .join(', ');
    console.log(
      `FASE | ${name} | ${stats.samples} amostras (${perInstance}) | p50 ${round(stats.p50, 2)} ms | p95 ${round(stats.p95, 2)} ms | p99 ${round(stats.p99, 2)} ms | máx ${round(stats.max, 2)} ms | fora de 2xx ${stats.non2xx} | 429 ${stats.status429} | timeout ${stats.timeouts} | erro de rede ${stats.networkErrors} | corpo inesperado ${stats.unexpectedBody}`,
    );
  };
  describe(
    `base (${round((baselineEnd - baselineStart) / 1000, 1)} s)`,
    baseline,
  );
  describe(`carga (${round(loadMs / 1000, 1)} s de upload ativo)`, load);
  describe('aquecimento', phaseStats(warmup));
  describe('fora da base e da carga', phaseStats(outsideRows));
  describe('todas as amostras', all);
  console.log(
    `AMOSTRAS | mínimo de ${MIN_PHASE_SAMPLES} por fase: ${enough ? 'atingido' : 'não atingido'} | N recalculado pela D medida: ${result.recalculatedInstances}`,
  );
  console.log(
    `VEREDITO | (a) p95 carga ${round(load.p95, 2)} ms ≤ ${round(thresholdA, 2)} ms (max(1,5 × p95 base; p95 base + 50 ms)) | ${a}`,
  );
  console.log(
    `VEREDITO | (b) p95 carga ${round(load.p95, 2)} ms ≤ 250 ms e p99 carga ${round(load.p99, 2)} ms ≤ 500 ms | ${b}`,
  );
  console.log(
    `VEREDITO | (c) ${failures} amostras sem 2xx válido em ${all.samples} (fora de 2xx ${all.non2xx}, 429 ${all.status429}, timeout ${all.timeouts}, erro de rede ${all.networkErrors}, corpo inesperado ${all.unexpectedBody}) | ${c}`,
  );
  console.log(`VEREDITO | latência | ${latency}`);
  return latency === 'aprovado';
}

// ---------------------------------------------------------------- flow-check (SI-03.32)

/** Conexão das URLs assinadas: o host assinado `from` é conectado em `hostname:port`. */
interface StorageConnect {
  from: string;
  hostname: string;
  port: number;
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

const execFileAsync = promisify(execFile);

interface FfprobeStream {
  codec_type?: string;
  codec_name?: string;
  profile?: string;
  width?: number;
  height?: number;
  pix_fmt?: string;
  r_frame_rate?: string;
  sample_rate?: string;
  channels?: number;
  bit_rate?: string;
  duration?: string;
}

interface FfprobeResult {
  streams?: FfprobeStream[];
  format?: {
    format_name?: string;
    duration?: string;
    size?: string;
    bit_rate?: string;
    tags?: Record<string, string>;
  };
}

/** ffprobe do arquivo local, com a imagem do worker (o mesmo FFmpeg do processamento). */
async function ffprobeFile(path: string): Promise<FfprobeResult> {
  const { stdout } = await execFileAsync('ffprobe', [
    '-v',
    'error',
    '-print_format',
    'json',
    '-show_format',
    '-show_streams',
    path,
  ]);
  return JSON.parse(stdout) as FfprobeResult;
}

interface Mp4Box {
  type: string;
  offset: number;
  size: number;
}

/** Caixas de topo do MP4 (ISO BMFF), para mostrar que não há preenchimento (`free`/`skip`). */
async function topLevelBoxes(path: string): Promise<Mp4Box[]> {
  const handle = await open(path, 'r');
  try {
    const { size: fileSize } = await handle.stat();
    const header = Buffer.alloc(16);
    const boxes: Mp4Box[] = [];
    let offset = 0;
    while (offset < fileSize) {
      const { bytesRead } = await handle.read(header, 0, 16, offset);
      if (bytesRead < 8) {
        throw new Error(`caixa truncada no byte ${offset}`);
      }
      const type = header.toString('latin1', 4, 8);
      let size = header.readUInt32BE(0);
      if (size === 1) {
        if (bytesRead < 16) {
          throw new Error(`caixa ${type} truncada no byte ${offset}`);
        }
        size = Number(header.readBigUInt64BE(8));
      } else if (size === 0) {
        size = fileSize - offset;
      }
      if (size < 8 || offset + size > fileSize) {
        throw new Error(`caixa ${type} com ${size} bytes no byte ${offset}`);
      }
      boxes.push({ type, offset, size });
      offset += size;
    }
    return boxes;
  } finally {
    await handle.close();
  }
}

/** SHA-256 de um arquivo ou de um intervalo dele (`end` inclusivo), lido em blocos de 1 MiB. */
async function fileSha256(
  path: string,
  start?: number,
  end?: number,
): Promise<{ sha256: string; bytes: number; ms: number }> {
  const hash = createHash('sha256');
  const started = performance.now();
  let bytes = 0;
  for await (const chunk of createReadStream(path, {
    start,
    end,
    highWaterMark: MIB,
  })) {
    const data = chunk as Buffer;
    hash.update(data);
    bytes += data.length;
  }
  return {
    sha256: hash.digest('hex'),
    bytes,
    ms: performance.now() - started,
  };
}

interface StorageGet {
  status: number;
  headers: IncomingHttpHeaders;
  bytes: number;
  sha256: string;
  firstByteMs: number;
  durationMs: number;
}

const STORAGE_IDLE_TIMEOUT_MS = 60_000;

/**
 * GET de uma URL assinada do storage, com o `Host` assinado e o corpo só em hash, nunca inteiro
 * na memória. A URL não entra em mensagens nem em erros.
 */
function storageGet(
  signedUrl: string,
  connect: StorageConnect | null,
  range?: string,
): Promise<StorageGet> {
  return new Promise((resolve, reject) => {
    const url = new URL(signedUrl);
    if (url.protocol !== 'http:') {
      reject(new Error(`protocolo não suportado: ${url.protocol}`));
      return;
    }
    const redirect = connect !== null && url.host === connect.from;
    const headers: OutgoingHttpHeaders = { host: url.host };
    if (range) {
      headers.range = range;
    }
    const started = performance.now();
    const req = httpRequest({
      hostname: redirect ? connect.hostname : url.hostname,
      port: redirect ? connect.port : Number(url.port || 80),
      path: `${url.pathname}${url.search}`,
      method: 'GET',
      headers,
    });
    req.setTimeout(STORAGE_IDLE_TIMEOUT_MS, () =>
      req.destroy(new Error(`sem atividade por ${STORAGE_IDLE_TIMEOUT_MS} ms`)),
    );
    req.on('response', (res) => {
      const firstByteMs = performance.now() - started;
      const hash = createHash('sha256');
      let bytes = 0;
      res.on('data', (chunk: Buffer) => {
        hash.update(chunk);
        bytes += chunk.length;
      });
      res.on('error', reject);
      res.on('end', () =>
        resolve({
          status: res.statusCode ?? 0,
          headers: res.headers,
          bytes,
          sha256: hash.digest('hex'),
          firstByteMs,
          durationMs: performance.now() - started,
        }),
      );
    });
    req.on('error', reject);
    req.end();
  });
}

interface FlowVideo {
  publicId: string;
  status: string;
  originalFilename: string;
  contentType: string;
  sizeBytes: number;
  durationSeconds: number | null;
  width: number | null;
  height: number | null;
  videoCodec: string | null;
  audioCodec: string | null;
  hasThumbnail: boolean;
  errorCode: string | null;
  errorMessage: string | null;
}

interface SignedUrlBody {
  url: string;
  contentType?: string;
  expiresAt: string;
}

/** Host e chave de uma URL assinada, sem a query (que leva a assinatura). */
function describeSignedUrl(signedUrl: string): {
  host: string;
  path: string;
  signed: boolean;
} {
  const url = new URL(signedUrl);
  return {
    host: url.host,
    path: url.pathname,
    signed: url.searchParams.has('X-Amz-Signature'),
  };
}

const header = (headers: IncomingHttpHeaders, name: string): string => {
  const value = headers[name];
  return Array.isArray(value) ? value.join(', ') : (value ?? '');
};

const isJpeg = (data: Buffer): boolean =>
  data.length >= 4 &&
  data[0] === 0xff &&
  data[1] === 0xd8 &&
  data[data.length - 2] === 0xff &&
  data[data.length - 1] === 0xd9;

async function flowCheck(
  apiUrl: string,
  credentialsPath: string,
  statePath: string,
  eventsPath: string,
  sourcePath: string,
  outPath: string,
  thumbnailPath: string,
  connect: StorageConnect | null,
): Promise<boolean> {
  const env = readProjectEnv();
  const bucket = requireKey(env, 'S3_BUCKET');
  const s3 = appClient(env, 'S3_ENDPOINT');
  const checks = new Checks();
  const state = readJson<{ publicId: string; fileName: string }>(statePath);
  const { publicId } = state;
  const tokens = new TokenSession(
    apiUrl,
    readJson<Credentials>(credentialsPath),
    120,
    (credentials) => writePrivateJson(credentialsPath, credentials),
    (renewal) =>
      console.log(
        `TOKEN | renovado por ${renewal.kind} em ${round(renewal.durationMs)} ms`,
      ),
  );
  const apiGet = async <T>(
    operation: string,
    path: string,
  ): Promise<HttpResponse<T>> =>
    expectStatus(
      operation,
      await httpJson<T>('GET', `${apiUrl}${path}`, {
        token: await tokens.accessToken(),
      }),
      [200],
    );

  // 1. O arquivo enviado: MP4 H.264/AAC de alguns minutos, sem preenchimento, e o SHA-256.
  const { size } = await stat(sourcePath);
  const source = await fileSha256(sourcePath);
  const probe = await ffprobeFile(sourcePath);
  const boxes = await topLevelBoxes(sourcePath);
  const streams = probe.streams ?? [];
  const videoStream = streams.find((s) => s.codec_type === 'video');
  const audioStream = streams.find((s) => s.codec_type === 'audio');
  const formatName = probe.format?.format_name ?? '';
  const duration = Number(probe.format?.duration);
  const width = videoStream?.width ?? 0;
  const height = videoStream?.height ?? 0;
  checks.info(
    'arquivo enviado',
    `${size} bytes, SHA-256 ${source.sha256} (${round(source.ms)} ms)`,
  );
  checks.add(
    'arquivo enviado: contêiner, codecs e duração (ffprobe)',
    'mp4 com um fluxo h264 e um aac, ao menos 120 s',
    `${formatName}; ${streams.length} fluxos; vídeo ${videoStream?.codec_name} ${videoStream?.profile} ${width}x${height} ${videoStream?.pix_fmt} ${videoStream?.r_frame_rate}; áudio ${audioStream?.codec_name} ${audioStream?.profile} ${audioStream?.sample_rate} Hz ${audioStream?.channels} canais; ${duration} s; ${probe.format?.bit_rate} bit/s`,
    formatName.split(',').includes('mp4') &&
      streams.length === 2 &&
      videoStream?.codec_name === 'h264' &&
      audioStream?.codec_name === 'aac' &&
      duration >= 120,
  );
  const padding = boxes
    .filter((box) => box.type === 'free' || box.type === 'skip')
    .reduce((sum, box) => sum + box.size, 0);
  const knownBoxes = boxes.every((box) =>
    ['ftyp', 'moov', 'mdat', 'free', 'skip'].includes(box.type),
  );
  const mdat = boxes
    .filter((box) => box.type === 'mdat')
    .reduce((sum, box) => sum + box.size, 0);
  checks.add(
    'sem preenchimento artificial (caixas de topo do MP4)',
    'só ftyp, moov e mdat, e no máximo 1 KiB em free ou skip',
    `${boxes.map((box) => `${box.type} ${box.size}`).join(', ')}; free/skip ${padding} bytes; mdat ${round((mdat / size) * 100, 2)}% do arquivo`,
    knownBoxes && padding <= 1024,
  );

  // 2. Upload: o 202 do completion e o ready do polling, pelos eventos do cliente.
  const events = readEvents(eventsPath);
  const find = (ev: string): ClientEvent | undefined =>
    events.find((e) => e.ev === ev);
  const plan = find('plan');
  const completionStart = find('completion_start');
  const completion = find('completion');
  const final = find('final');
  checks.add(
    'plano do upload',
    `${size} bytes em ${Math.ceil(size / 67_108_864)} partes de 67108864`,
    `${String(plan?.sizeBytes)} bytes em ${String(plan?.partCount)} partes de ${String(plan?.partSize)}, a última com ${String(plan?.lastPartSize)}`,
    plan?.sizeBytes === size &&
      plan.partCount === Math.ceil(size / 67_108_864) &&
      plan.partSize === 67_108_864,
  );
  checks.add(
    'completion',
    'HTTP 202',
    `HTTP ${String(completion?.status)} em ${String(completion?.ms)} ms, vídeo ${String(completion?.videoStatus)}`,
    completion?.status === 202,
  );
  const processingSeconds =
    completion && final ? round((final.t - completion.t) / 1000, 2) : null;
  checks.add(
    'polling até o estado final',
    'ready',
    `${String(final?.status)}${typeof final?.errorCode === 'string' ? ` ${final.errorCode}` : ''} em ${String(final?.polls)} consultas, ${String(processingSeconds)} s depois do 202`,
    final?.status === 'ready',
  );

  // 3. Metadados pela API, comparados ao ffprobe do arquivo enviado.
  const { body: video } = await apiGet<FlowVideo>(
    'GET /videos/:publicId',
    `/videos/${publicId}`,
  );
  const expectedDuration = Number(duration.toFixed(3));
  checks.add(
    'estado, tamanho e tipo pela API',
    `ready sem erro, ${size} bytes, video/mp4`,
    `${video.status}${video.errorCode ? ` ${video.errorCode}` : ' sem erro'}, ${video.sizeBytes} bytes, ${video.contentType}`,
    video.status === 'ready' &&
      video.errorCode === null &&
      video.sizeBytes === size &&
      video.contentType === 'video/mp4',
  );
  checks.add(
    'duração',
    `${expectedDuration} s (ffprobe do arquivo enviado, com 3 casas)`,
    `${String(video.durationSeconds)} s`,
    video.durationSeconds === expectedDuration,
  );
  checks.add(
    'dimensões',
    `${width}x${height}`,
    `${String(video.width)}x${String(video.height)}`,
    video.width === width && video.height === height,
  );
  checks.add(
    'codecs',
    'h264 e aac',
    `${String(video.videoCodec)} e ${String(video.audioCodec)}`,
    video.videoCodec === 'h264' && video.audioCodec === 'aac',
  );
  checks.add(
    'hasThumbnail',
    'true',
    String(video.hasThumbnail),
    video.hasThumbnail,
  );

  // 4. Banco e storage: `thumbnail_key`, o objeto da thumbnail e o original.
  const row = await withDatabase(env, async (db) => {
    const [found] = await db.query<
      {
        id: string;
        thumbnail_key: string | null;
        media_format: string | null;
        object_key: string;
      }[]
    >(
      `SELECT v.id, v.thumbnail_key, v.media_format, s.object_key
         FROM videos v JOIN upload_sessions s ON s.id = v.current_upload_session_id
        WHERE v.public_id = $1`,
      [publicId],
    );
    if (!found) {
      throw new Error(`vídeo ${publicId} sem sessão atual`);
    }
    return found;
  });
  const thumbnailKey = row.thumbnail_key ?? '';
  checks.add(
    'thumbnail_key no banco',
    'thumbnails/<videoId>/<attemptId>.jpg',
    thumbnailKey.replace(row.id, '<videoId>'),
    new RegExp(`^thumbnails/${row.id}/[0-9a-f-]{36}\\.jpg$`).test(thumbnailKey),
  );
  checks.add(
    'media_format no banco',
    formatName,
    String(row.media_format),
    row.media_format === formatName,
  );
  const originalHead = await s3.send(
    new HeadObjectCommand({ Bucket: bucket, Key: row.object_key }),
  );
  checks.add(
    'objeto original no storage (HeadObject)',
    `${size} bytes`,
    `${String(originalHead.ContentLength)} bytes, ${String(originalHead.ContentType)}`,
    originalHead.ContentLength === size,
  );
  let thumbnail: Record<string, unknown> = { key: thumbnailKey };
  if (thumbnailKey) {
    const head = await s3.send(
      new HeadObjectCommand({ Bucket: bucket, Key: thumbnailKey }),
    );
    const object = await s3.send(
      new GetObjectCommand({ Bucket: bucket, Key: thumbnailKey }),
    );
    const data = Buffer.from(
      (await object.Body?.transformToByteArray()) ?? new Uint8Array(),
    );
    writeFileSync(thumbnailPath, data);
    const thumbnailProbe = await ffprobeFile(thumbnailPath);
    const image = (thumbnailProbe.streams ?? [])[0];
    thumbnail = {
      key: thumbnailKey.replace(row.id, '<videoId>'),
      contentType: head.ContentType,
      contentLength: head.ContentLength,
      bytes: data.length,
      sha256: createHash('sha256').update(data).digest('hex'),
      jpeg: isJpeg(data),
      codec: image?.codec_name,
      width: image?.width,
      height: image?.height,
    };
    checks.add(
      'objeto da thumbnail no storage',
      `image/jpeg, JPEG com SOI e EOI, ${width}x${height}`,
      `${String(head.ContentType)}, ${String(head.ContentLength)} bytes, ${isJpeg(data) ? 'JPEG com SOI e EOI' : 'não é JPEG'}, ${String(image?.codec_name)} ${String(image?.width)}x${String(image?.height)}`,
      head.ContentType === 'image/jpeg' &&
        (head.ContentLength ?? 0) > 0 &&
        head.ContentLength === data.length &&
        isJpeg(data) &&
        image?.width === width &&
        image.height === height,
    );
  } else {
    checks.add(
      'objeto da thumbnail no storage',
      'image/jpeg',
      'sem thumbnail_key',
      false,
    );
  }

  // 5. Reprodução: playback-url e Range no início, no meio e no fim do objeto.
  const playbackRequestedAt = Date.now();
  const playback = await apiGet<SignedUrlBody>(
    'GET /videos/:publicId/playback-url',
    `/videos/${publicId}/playback-url`,
  );
  const playbackUrl = describeSignedUrl(playback.body.url);
  const playbackTtl = round(
    (Date.parse(playback.body.expiresAt) - playbackRequestedAt) / 1000,
    0,
  );
  checks.add(
    'playback-url',
    '200, URL assinada no endpoint público, video/mp4',
    `200 em ${round(playback.durationMs)} ms; host ${playbackUrl.host}; assinada ${playbackUrl.signed ? 'sim' : 'não'}; ${String(playback.body.contentType)}; expira em ${playbackTtl} s`,
    playbackUrl.signed && playback.body.contentType === 'video/mp4',
  );
  const middle = Math.floor(size / 2);
  const ranges = [
    { name: 'início', header: `bytes=0-${MIB - 1}`, start: 0, end: MIB - 1 },
    {
      name: 'meio',
      header: `bytes=${middle}-${middle + MIB - 1}`,
      start: middle,
      end: middle + MIB - 1,
    },
    {
      name: 'fim',
      header: `bytes=-${MIB}`,
      start: size - MIB,
      end: size - 1,
    },
  ];
  const rangeResults: Record<string, unknown>[] = [];
  for (const range of ranges) {
    const got = await storageGet(playback.body.url, connect, range.header);
    const expected = await fileSha256(sourcePath, range.start, range.end);
    const contentRange = header(got.headers, 'content-range');
    const expectedRange = `bytes ${range.start}-${range.end}/${size}`;
    const contentLength = header(got.headers, 'content-length');
    rangeResults.push({
      name: range.name,
      range: range.header,
      status: got.status,
      contentRange,
      contentLength,
      contentType: header(got.headers, 'content-type'),
      acceptRanges: header(got.headers, 'accept-ranges'),
      bytes: got.bytes,
      sha256: got.sha256,
      fileSha256: expected.sha256,
      firstByteMs: round(got.firstByteMs),
      ms: round(got.durationMs),
    });
    checks.add(
      `Range ${range.name} (${range.header})`,
      `206, Content-Range ${expectedRange}, ${MIB} bytes iguais aos do arquivo`,
      `${got.status}, Content-Range ${contentRange}, Content-Length ${contentLength}, ${got.bytes} bytes ${got.sha256 === expected.sha256 ? 'iguais' : 'diferentes'}, ${header(got.headers, 'content-type')}, ${round(got.durationMs)} ms`,
      got.status === 206 &&
        contentRange === expectedRange &&
        Number(contentLength) === MIB &&
        got.bytes === MIB &&
        got.sha256 === expected.sha256,
    );
  }

  // 6. Download: download-url e o SHA-256 do corpo inteiro.
  const downloadRequestedAt = Date.now();
  const download = await apiGet<SignedUrlBody>(
    'GET /videos/:publicId/download-url',
    `/videos/${publicId}/download-url`,
  );
  const downloadUrl = describeSignedUrl(download.body.url);
  const downloadTtl = round(
    (Date.parse(download.body.expiresAt) - downloadRequestedAt) / 1000,
    0,
  );
  checks.add(
    'download-url',
    '200, URL assinada no endpoint público',
    `200 em ${round(download.durationMs)} ms; host ${downloadUrl.host}; assinada ${downloadUrl.signed ? 'sim' : 'não'}; expira em ${downloadTtl} s`,
    downloadUrl.signed,
  );
  const downloaded = await storageGet(download.body.url, connect);
  const disposition = header(downloaded.headers, 'content-disposition');
  checks.add(
    'download completo',
    `200, ${size} bytes, SHA-256 igual ao do arquivo enviado (${source.sha256})`,
    `${downloaded.status}, Content-Length ${header(downloaded.headers, 'content-length')}, ${downloaded.bytes} bytes, SHA-256 ${downloaded.sha256}, ${round(downloaded.durationMs)} ms (${mibps(downloaded.bytes, downloaded.durationMs)} MiB/s)`,
    downloaded.status === 200 &&
      downloaded.bytes === size &&
      downloaded.sha256 === source.sha256,
  );
  checks.add(
    'Content-Disposition do download',
    `attachment com o nome original (${state.fileName})`,
    disposition,
    disposition.startsWith('attachment') &&
      disposition.includes(state.fileName),
  );

  const startMetrics = segmentMetrics(events, 'start', 'sign');
  writeFileSync(
    outPath,
    `${JSON.stringify(
      {
        at: new Date().toISOString(),
        publicId,
        source: {
          sizeBytes: size,
          sha256: source.sha256,
          sha256Ms: round(source.ms),
          boxes,
          ffprobe: probe,
        },
        upload: {
          plan,
          loadIntervals: loadIntervals(events),
          start: startMetrics,
          completionStartedAt: completionStart
            ? new Date(completionStart.t).toISOString()
            : null,
          completion,
          final,
          processingSeconds,
        },
        video,
        database: {
          thumbnailKey: thumbnailKey.replace(row.id, '<videoId>'),
          mediaFormat: row.media_format,
        },
        storage: {
          original: {
            contentLength: originalHead.ContentLength,
            contentType: originalHead.ContentType,
          },
          thumbnail,
        },
        playback: {
          requestMs: round(playback.durationMs),
          url: playbackUrl,
          contentType: playback.body.contentType,
          ttlSeconds: playbackTtl,
          ranges: rangeResults,
        },
        download: {
          requestMs: round(download.durationMs),
          url: downloadUrl,
          ttlSeconds: downloadTtl,
          status: downloaded.status,
          contentLength: header(downloaded.headers, 'content-length'),
          contentType: header(downloaded.headers, 'content-type'),
          contentDisposition: disposition,
          bytes: downloaded.bytes,
          sha256: downloaded.sha256,
          firstByteMs: round(downloaded.firstByteMs),
          bodyMs: round(downloaded.durationMs),
          mibps: mibps(downloaded.bytes, downloaded.durationMs),
        },
        checks: checks.results,
      },
      null,
      2,
    )}\n`,
  );
  console.log(`FLUXO | ${checks.summary()}`);
  return checks.allPassed;
}

// ---------------------------------------------------------------- snapshot, cleanup

function redisConnection(env: EnvSource): Redis {
  return new Redis({
    host: requireKey(env, 'REDIS_HOST'),
    port: Number(requireKey(env, 'REDIS_PORT')),
  });
}

/** Ids dos jobs de processamento (hashes `bull:video-processing:video-…`), de um vídeo ou de todos. */
async function processingJobIds(
  redis: Redis,
  videoId: string | null,
): Promise<string[]> {
  const prefix = `bull:${VIDEO_QUEUES.PROCESSING}:`;
  const pattern = `${prefix}video-${videoId ?? '*'}${videoId ? '-*' : ''}`;
  const ids = new Set<string>();
  let cursor = '0';
  do {
    const [next, keys] = await redis.scan(
      cursor,
      'MATCH',
      pattern,
      'COUNT',
      1000,
    );
    cursor = next;
    for (const key of keys) {
      const id = key.slice(prefix.length);
      if (!id.includes(':')) {
        ids.add(id);
      }
    }
  } while (cursor !== '0');
  return [...ids].sort();
}

async function snapshot(): Promise<boolean> {
  const env = readProjectEnv();
  const counts = await withDatabase(env, async (db) => {
    const result: string[] = [];
    for (const table of DB_TABLES) {
      const [{ count }] = await db.query<{ count: string }[]>(
        `SELECT count(*)::text AS count FROM "${table}"`,
      );
      result.push(`${table}=${count}`);
    }
    return result.join(' ');
  });
  const bucket = await snapshotBucket(
    appClient(env, 'S3_ENDPOINT'),
    requireKey(env, 'S3_BUCKET'),
  );
  const queue = processingQueue(env);
  const redis = redisConnection(env);
  let jobs: string;
  try {
    const jobCounts = await queue.getJobCounts(
      'wait',
      'active',
      'delayed',
      'prioritized',
      'waiting-children',
      'completed',
      'failed',
    );
    const ids = await processingJobIds(redis, null);
    jobs = `${Object.entries(jobCounts)
      .map(([state, n]) => `${state}=${n}`)
      .join(' ')} jobs=${ids.length}`;
  } finally {
    await queue.close();
    await redis.quit();
  }
  const mail = await httpJson<{ total: number }>(
    'GET',
    `${mailpitApi(env)}/messages?limit=1`,
  );
  expectStatus('GET Mailpit messages', mail, [200]);
  console.log(
    `SNAPSHOT banco ${counts} | bucket objetos=${bucket.objects} bytes=${bucket.bytes} sha256=${bucket.digest} | fila ${VIDEO_QUEUES.PROCESSING} ${jobs} | mailpit mensagens=${mail.body.total}`,
  );
  return true;
}

interface ProofSession {
  id: string;
  video_id: string;
  object_key: string;
  upload_id: string | null;
}

async function cleanup(emails: string[]): Promise<boolean> {
  const env = readProjectEnv();
  const bucket = requireKey(env, 'S3_BUCKET');
  const s3 = appClient(env, 'S3_ENDPOINT');
  const checks = new Checks();
  const { userIds, videoIds, sessions } = await withDatabase(
    env,
    async (db) => {
      const users = await db.query<{ id: string }[]>(
        'SELECT id FROM users WHERE email = ANY($1)',
        [emails],
      );
      const ids = users.map((user) => user.id);
      const videos = await db.query<{ id: string }[]>(
        `SELECT v.id FROM videos v JOIN channels c ON c.id = v.channel_id WHERE c.user_id = ANY($1)`,
        [ids],
      );
      const videoIdList = videos.map((video) => video.id);
      const sessionRows = await db.query<ProofSession[]>(
        'SELECT id, video_id, object_key, upload_id FROM upload_sessions WHERE video_id = ANY($1)',
        [videoIdList],
      );
      return { userIds: ids, videoIds: videoIdList, sessions: sessionRows };
    },
  );
  console.log(
    `LIMPEZA | ${emails.length} e-mails de prova | ${userIds.length} usuários, ${videoIds.length} vídeos, ${sessions.length} sessões`,
  );

  // 1. Multiparts das sessões de prova, abortados pela chave e pelo uploadId de cada uma.
  let aborted = 0;
  for (const session of sessions) {
    if (!session.upload_id) {
      continue;
    }
    try {
      await s3.send(
        new AbortMultipartUploadCommand({
          Bucket: bucket,
          Key: session.object_key,
          UploadId: session.upload_id,
        }),
      );
      aborted += 1;
    } catch (error) {
      if (sdkError(error).name !== 'NoSuchUpload') {
        throw error;
      }
    }
  }
  console.log(
    `LIMPEZA | multiparts abortados: ${aborted} (os demais já estavam concluídos ou abortados)`,
  );

  // 2. Linhas do banco: vídeos (com sessões e partes, em cascata), canais, tokens e usuários.
  await withDatabase(env, async (db) => {
    await db.transaction(async (manager) => {
      await manager.query('DELETE FROM videos WHERE id = ANY($1)', [videoIds]);
      await manager.query('DELETE FROM channels WHERE user_id = ANY($1)', [
        userIds,
      ]);
      await manager.query(
        'DELETE FROM refresh_tokens WHERE user_id = ANY($1)',
        [userIds],
      );
      await manager.query(
        'DELETE FROM verification_tokens WHERE user_id = ANY($1)',
        [userIds],
      );
      await manager.query('DELETE FROM users WHERE id = ANY($1)', [userIds]);
    });
  });

  // 3. Jobs de processamento dos vídeos de prova, quando não estão mais ativos.
  const queue = processingQueue(env);
  const redis = redisConnection(env);
  let removedJobs = 0;
  let leftJobs: string[] = [];
  try {
    for (const videoId of videoIds) {
      for (const jobId of await processingJobIds(redis, videoId)) {
        // `remove` devolve 0 enquanto o job está ativo (travado por um worker).
        for (let attempt = 1; ; attempt += 1) {
          if ((await queue.remove(jobId)) === 1) {
            removedJobs += 1;
            break;
          }
          if ((await queue.getJob(jobId)) === undefined) {
            break;
          }
          if (attempt >= 60) {
            throw new Error(`o job ${jobId} continua ativo depois de 120 s`);
          }
          await sleepMs(2000);
        }
      }
    }
    for (const videoId of videoIds) {
      leftJobs = leftJobs.concat(await processingJobIds(redis, videoId));
    }
  } finally {
    await queue.close();
    await redis.quit();
  }
  console.log(`LIMPEZA | jobs de processamento removidos: ${removedJobs}`);

  // 4. Objetos (originais e thumbnails) dos vídeos de prova e confirmação de nenhum multipart.
  let objectsOk = true;
  for (const videoId of videoIds) {
    const keys = sessions
      .filter((s) => s.video_id === videoId)
      .map((s) => s.object_key);
    objectsOk =
      (await cleanupPrefix(s3, bucket, `originals/${videoId}/`, keys)) &&
      objectsOk;
    objectsOk =
      (await cleanupPrefix(s3, bucket, `thumbnails/${videoId}/`, [])) &&
      objectsOk;
  }
  let uploadsLeft = 0;
  for (const session of sessions) {
    const listed = await s3.send(
      new ListMultipartUploadsCommand({
        Bucket: bucket,
        Prefix: session.object_key,
      }),
    );
    uploadsLeft += (listed.Uploads ?? []).length;
  }

  // 5. E-mails do Mailpit endereçados aos usuários de prova (nunca sem IDs: o corpo vazio apaga tudo).
  let removedMails = 0;
  for (const email of emails) {
    const ids = await searchMail(env, email);
    if (ids.length > 0) {
      const response = await httpJson('DELETE', `${mailpitApi(env)}/messages`, {
        body: { IDs: ids },
      });
      expectStatus('DELETE Mailpit messages', response, [200]);
      removedMails += ids.length;
    }
  }
  let mailsLeft = 0;
  for (const email of emails) {
    mailsLeft += (await searchMail(env, email)).length;
  }
  console.log(`LIMPEZA | e-mails removidos do Mailpit: ${removedMails}`);

  const rowsLeft = await withDatabase(env, async (db) => {
    const [{ count }] = await db.query<{ count: string }[]>(
      `SELECT ((SELECT count(*) FROM users WHERE email = ANY($1))
             + (SELECT count(*) FROM videos WHERE id = ANY($2))
             + (SELECT count(*) FROM upload_sessions WHERE video_id = ANY($2)))::text AS count`,
      [emails, videoIds],
    );
    return Number(count);
  });
  checks.add(
    'linhas de prova no banco (usuários, vídeos e sessões)',
    '0',
    String(rowsLeft),
    rowsLeft === 0,
  );
  checks.add(
    'objetos de prova no bucket',
    '0 restantes',
    objectsOk ? '0 restantes' : 'restam objetos ou multiparts',
    objectsOk,
  );
  checks.add(
    'multiparts das sessões de prova',
    '0',
    String(uploadsLeft),
    uploadsLeft === 0,
  );
  checks.add(
    'jobs de processamento dos vídeos de prova',
    '0',
    String(leftJobs.length),
    leftJobs.length === 0,
  );
  checks.add(
    'e-mails de prova no Mailpit',
    '0',
    String(mailsLeft),
    mailsLeft === 0,
  );
  console.log(`LIMPEZA | ${checks.summary()}`);
  return checks.allPassed;
}

// ---------------------------------------------------------------- CLI

async function main(): Promise<boolean> {
  const [command, ...rest] = process.argv.slice(2);
  const { values } = parseArgs({
    args: rest,
    strict: true,
    options: {
      api: { type: 'string' },
      email: { type: 'string' },
      emails: { type: 'string' },
      credentials: { type: 'string' },
      state: { type: 'string' },
      'file-name': { type: 'string' },
      out: { type: 'string' },
      before: { type: 'string' },
      after: { type: 'string' },
      events: { type: 'string' },
      disk: { type: 'string' },
      'disk-fast': { type: 'string' },
      probe: { type: 'string', multiple: true },
      progress: { type: 'string' },
      fraction: { type: 'string' },
      signal: { type: 'string' },
      source: { type: 'string' },
      thumbnail: { type: 'string' },
      'storage-connect': { type: 'string' },
      'baseline-start': { type: 'string' },
      'baseline-end': { type: 'string' },
    },
  });
  const apiUrl = values.api ?? DEFAULT_API_URL;
  switch (command) {
    case 'api-check':
      return apiCheck(apiUrl);
    case 'account':
      return account(
        apiUrl,
        assertProofEmail(required('email', values.email)),
        required('credentials', values.credentials),
      );
    case 'control-video':
      return controlVideo(
        apiUrl,
        required('credentials', values.credentials),
        required('state', values.state),
        required('file-name', values['file-name']),
      );
    case 'parts-snapshot':
      return partsSnapshot(
        required('state', values.state),
        required('out', values.out),
      );
    case 'compare-parts':
      return compareParts(
        required('before', values.before),
        required('after', values.after),
        required('events', values.events),
      );
    case 'interrupt-when': {
      const fraction = Number(values.fraction ?? '0.5');
      const signal = values.signal ?? 'SIGINT';
      if (
        !(fraction > 0 && fraction <= 1) ||
        (signal !== 'SIGINT' && signal !== 'SIGTERM')
      ) {
        throw new UsageError(
          '--fraction precisa estar em (0, 1] e --signal ser SIGINT ou SIGTERM',
        );
      }
      return interruptWhen(
        required('progress', values.progress),
        fraction,
        signal,
      );
    }
    case 'summarize':
      return summarize(
        required('events', values.events),
        required('out', values.out),
        values.disk,
        values['disk-fast'],
        values.probe ?? [],
      );
    case 'latency-verdict': {
      const baselineStart = Number(
        required('baseline-start', values['baseline-start']),
      );
      const baselineEnd = Number(
        required('baseline-end', values['baseline-end']),
      );
      const probes = values.probe ?? [];
      if (
        !Number.isSafeInteger(baselineStart) ||
        !Number.isSafeInteger(baselineEnd) ||
        probes.length === 0
      ) {
        throw new UsageError(
          '--baseline-start e --baseline-end precisam ser instantes em ms, com ao menos um --probe',
        );
      }
      return latencyVerdict(
        required('events', values.events),
        probes,
        baselineStart,
        baselineEnd,
        required('out', values.out),
      );
    }
    case 'flow-check':
      return flowCheck(
        apiUrl,
        required('credentials', values.credentials),
        required('state', values.state),
        required('events', values.events),
        required('source', values.source),
        required('out', values.out),
        required('thumbnail', values.thumbnail),
        parseStorageConnect(values['storage-connect']),
      );
    case 'snapshot':
      return snapshot();
    case 'cleanup': {
      const emails = required('emails', values.emails)
        .split(',')
        .map((email) => email.trim())
        .filter((email) => email !== '')
        .map(assertProofEmail);
      return cleanup(emails);
    }
    default:
      throw new UsageError(
        'uso: api-check | account | control-video | parts-snapshot | compare-parts | interrupt-when | summarize | latency-verdict | flow-check | snapshot | cleanup (ver o cabeçalho do script)',
      );
  }
}

main()
  .then((ok) => {
    process.exitCode = ok ? 0 : 1;
  })
  .catch((error: unknown) => {
    console.error(
      error instanceof Error
        ? `${error.name}: ${error.message}`
        : String(error),
    );
    process.exitCode = error instanceof UsageError ? 64 : 1;
  });

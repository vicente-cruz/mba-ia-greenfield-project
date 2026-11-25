// V-08 e V-09 (navegador) — lado da API: assina as URLs usadas pelo navegador real e confere o
// resultado no storage (phase-03-videos/TD-01, TD-02, TD-03, TD-07). O navegador roda no serviço
// `proof-browser` (perfil `proofs` do Compose); o roteiro é `browser-proof-roteiro.sh`.
//
// Subcomandos (no container `nestjs-api`):
//   presign <runId>  Abre um multipart por navegador e imprime o manifesto JSON com as URLs.
//   verify <runId>   Lê do stdin as linhas `MANIFEST <json>` e `RESULT <json>`, confere as
//                    observações do navegador e o ListParts, e imprime um item por linha.
//   cleanup <runId>  Aborta os multipart e remove os objetos do prefixo temporário.
//   snapshot         Retrato do bucket principal, só leitura.
//
// As URLs seguem a SI-03.9: `content-length` em `signableHeaders`, `x-amz-checksum-sha256` em
// `unhoistableHeaders` e cliente com WHEN_REQUIRED. Elas são assinadas para o endpoint interno
// (S3_ENDPOINT), que é o que o navegador alcança dentro da rede do Compose.
import { readFileSync } from 'node:fs';
import {
  CreateMultipartUploadCommand,
  ListPartsCommand,
  type Part,
  UploadPartCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import {
  appClient,
  Checks,
  cleanupPrefix,
  readProjectEnv,
  requireKey,
  sha256Base64,
  snapshotBucket,
  unquote,
} from './proof-support';

const PART_SIZE = 1024 * 1024;
const EXPIRES_IN = 1800;
const BROWSERS = ['chromium', 'firefox'] as const;
const CHECKSUM_HEADER = 'x-amz-checksum-sha256';
/** Tamanho da medição de SHA-256 no navegador (V-09): 1 GiB em partes de 64 MiB. */
export const HASH_TOTAL_BYTES = 1024 * 1024 * 1024;
export const HASH_PART_BYTES = 64 * 1024 * 1024;
/** Tamanho real da Fase 03 para a projeção: 10.000.000.000 bytes (150 partes de 64 MiB). */
const PROJECTION_BYTES = 10_000_000_000;
/** Rodadas da medição de SHA-256 por navegador; vai no manifesto para o navegador. */
export const HASH_RUNS = 2;

type CaseId =
  | 'exact'
  | 'larger'
  | 'smaller'
  | 'stream'
  | 'preflight'
  | 'control-origin';

/** Casos de cada navegador. `origin: 'control'` roda numa origem fora do CORS. */
const CASES: ReadonlyArray<{
  id: CaseId;
  part: number;
  sendSize: number;
  body: 'blob' | 'stream';
  origin: 'proof' | 'control';
}> = [
  { id: 'exact', part: 1, sendSize: PART_SIZE, body: 'blob', origin: 'proof' },
  {
    id: 'larger',
    part: 2,
    sendSize: PART_SIZE + 1,
    body: 'blob',
    origin: 'proof',
  },
  {
    id: 'smaller',
    part: 3,
    sendSize: PART_SIZE - 1,
    body: 'blob',
    origin: 'proof',
  },
  {
    id: 'stream',
    part: 4,
    sendSize: PART_SIZE,
    body: 'stream',
    origin: 'proof',
  },
  {
    id: 'preflight',
    part: 5,
    sendSize: PART_SIZE,
    body: 'blob',
    origin: 'proof',
  },
  {
    id: 'control-origin',
    part: 6,
    sendSize: PART_SIZE,
    body: 'blob',
    origin: 'control',
  },
];

/** Conteúdo determinístico da parte; a página gera exatamente os mesmos bytes (proof.js). */
export function pattern(seed: number, length: number): Buffer {
  const out = Buffer.alloc(length);
  for (let i = 0; i < length; i += 1) {
    out[i] = (seed * 131 + i * 31 + (i >>> 8) * 7) & 0xff;
  }
  return out;
}

function keys(runId: string) {
  const prefix = `proofs/v08-${runId}/`;
  return {
    prefix,
    browser: (name: string): string => `${prefix}${name}.bin`,
    all: BROWSERS.map((name) => `${prefix}${name}.bin`),
  };
}

function context() {
  const env = readProjectEnv();
  return {
    client: appClient(env, 'S3_ENDPOINT'),
    bucket: requireKey(env, 'S3_BUCKET'),
  };
}

interface ManifestCase {
  id: CaseId;
  part: number;
  seed: number;
  signedSize: number;
  sendSize: number;
  body: 'blob' | 'stream';
  origin: 'proof' | 'control';
  checksum: string;
  url: string;
}

interface Manifest {
  runId: string;
  partSize: number;
  hashTotalBytes: number;
  hashPartBytes: number;
  hashRuns: number;
  browsers: Record<
    string,
    { key: string; uploadId: string; cases: ManifestCase[] }
  >;
}

async function presign(runId: string): Promise<boolean> {
  const { client, bucket } = context();
  const k = keys(runId);
  const manifest: Manifest = {
    runId,
    partSize: PART_SIZE,
    hashTotalBytes: HASH_TOTAL_BYTES,
    hashPartBytes: HASH_PART_BYTES,
    hashRuns: HASH_RUNS,
    browsers: {},
  };
  for (const [index, name] of BROWSERS.entries()) {
    const key = k.browser(name);
    const created = await client.send(
      new CreateMultipartUploadCommand({
        Bucket: bucket,
        Key: key,
        ChecksumAlgorithm: 'SHA256',
      }),
    );
    const uploadId = created.UploadId ?? '';
    const cases: ManifestCase[] = [];
    for (const c of CASES) {
      const seed = index * 16 + c.part;
      const checksum = sha256Base64(pattern(seed, PART_SIZE));
      const url = await getSignedUrl(
        client,
        new UploadPartCommand({
          Bucket: bucket,
          Key: key,
          UploadId: uploadId,
          PartNumber: c.part,
          ContentLength: PART_SIZE,
          ChecksumSHA256: checksum,
        }),
        {
          expiresIn: EXPIRES_IN,
          signableHeaders: new Set(['content-length']),
          unhoistableHeaders: new Set([CHECKSUM_HEADER]),
        },
      );
      cases.push({ ...c, seed, signedSize: PART_SIZE, checksum, url });
    }
    manifest.browsers[name] = { key, uploadId, cases };
  }
  console.log(JSON.stringify(manifest));
  return true;
}

/** Evento de rede de um PUT, como o navegador o viu (run-browser.cjs). */
export interface NetworkEvent {
  method: string;
  event: 'request' | 'response' | 'requestfailed';
  detail: string;
  /** Requisição: os headers foram lidos? Só então `contentLength: null` significa header ausente. */
  headersRead?: boolean;
  contentLength?: string | null;
  transferEncoding?: string | null;
  bodyBytes?: number | null;
  /** Resposta: status HTTP. */
  status?: number;
  /** Falha: código de erro do navegador. */
  errorText?: string;
}

export interface CaseResult {
  id: CaseId;
  status: number;
  etag: string | null;
  errorCode: string;
  exception: string;
  responseReceived: boolean;
  network: NetworkEvent[];
}

interface BrowserResult {
  version: string;
  cases: CaseResult[];
  preflightEvents: string[];
  /** Medição da V-09; dado externo, validado por `assessHashMeasurement`. */
  hash: unknown;
}

interface RunnerResult {
  pageOrigin: string;
  controlOrigin: string;
  directPreflight: Array<{
    origin: string;
    status: number;
    allowOrigin: string | null;
    allowHeaders: string | null;
    allowMethods: string | null;
  }>;
  browsers: Record<string, BrowserResult>;
}

function readInput(): { manifest: Manifest; result: RunnerResult } {
  let manifest: Manifest | undefined;
  let result: RunnerResult | undefined;
  for (const line of readFileSync(0, 'utf8').split('\n')) {
    if (line.startsWith('MANIFEST '))
      manifest = JSON.parse(line.slice(9)) as Manifest;
    if (line.startsWith('RESULT '))
      result = JSON.parse(line.slice(7)) as RunnerResult;
  }
  if (!manifest || !result) {
    throw new Error('entrada sem MANIFEST ou sem RESULT');
  }
  return { manifest, result };
}

export interface Assessment {
  ok: boolean;
  observed: string;
}

const putEvents = (
  r: CaseResult,
  event: NetworkEvent['event'],
): NetworkEvent[] =>
  (Array.isArray(r.network) ? r.network : []).filter(
    (n) => n.method === 'PUT' && n.event === event,
  );

function describeCase(r: CaseResult): string {
  const network =
    (Array.isArray(r.network) ? r.network : [])
      .map((n) => `${n.method} ${n.event} ${n.detail}`)
      .join(', ') || 'nenhum evento';
  const reply = r.responseReceived
    ? `HTTP ${r.status}${r.errorCode ? ` ${r.errorCode}` : ''} lido pelo script`
    : `sem resposta lida pelo script (${r.exception || 'sem exceção'})`;
  return `${reply}; rede: ${network}`;
}

/** (a) e (d): PUT aceito pelo storage e parte gravada exatamente como assinada. */
export function assessAccepted(
  r: CaseResult | undefined,
  part: Part | undefined,
  signedSize: number,
  checksum: string,
): Assessment {
  if (!r) return { ok: false, observed: 'caso sem resultado' };
  const requests = putEvents(r, 'request');
  const responses = putEvents(r, 'response');
  const ok =
    r.responseReceived &&
    r.status === 200 &&
    r.exception === '' &&
    r.etag !== null &&
    unquote(r.etag) === unquote(part?.ETag) &&
    part?.Size === signedSize &&
    part.ChecksumSHA256 === checksum &&
    requests.length === 1 &&
    requests[0].headersRead === true &&
    requests[0].contentLength === String(signedSize) &&
    responses.length === 1 &&
    responses[0].status === 200 &&
    putEvents(r, 'requestfailed').length === 0;
  return {
    ok,
    observed: `${describeCase(r)}; ETag no script ${r.etag ?? '—'}; ${part ? `ListParts ${part.Size} bytes, ETag ${unquote(part.ETag)}, ${part.ChecksumSHA256 ?? '—'}` : 'parte ausente do ListParts'}`,
  };
}

/** (b): Blob de outro tamanho, recusado pelo storage pela assinatura do content-length. */
export function assessSizeRejection(
  r: CaseResult | undefined,
  sentSize: number,
  partPresent: boolean,
): Assessment {
  if (!r) return { ok: false, observed: 'caso sem resultado' };
  const requests = putEvents(r, 'request');
  const responses = putEvents(r, 'response');
  const ok =
    r.responseReceived &&
    r.status === 403 &&
    r.errorCode === 'SignatureDoesNotMatch' &&
    r.exception === '' &&
    requests.length === 1 &&
    requests[0].headersRead === true &&
    requests[0].contentLength === String(sentSize) &&
    responses.length === 1 &&
    responses[0].status === 403 &&
    putEvents(r, 'requestfailed').length === 0 &&
    !partPresent;
  return {
    ok,
    observed: `${describeCase(r)}; ListParts: ${partPresent ? 'PRESENTE' : 'ausente'}`,
  };
}

/** Erros do Chromium para corpo em stream sem HTTP/2 (o storage da prova é HTTP/1.1). */
export const CHROMIUM_STREAM_ERRORS = [
  'net::ERR_ALPN_NEGOTIATION_FAILED',
  'net::ERR_H2_OR_QUIC_REQUIRED',
];

/**
 * (c): corpo ReadableStream. No Chromium, a recusa é do navegador: o PUT sai sem Content-Length
 * e falha com um dos erros de CHROMIUM_STREAM_ERRORS, sem resposta do storage. No Firefox, o
 * stream não é enviado: o PUT sai com um Content-Length diferente do assinado e o storage o recusa
 * com 403 SignatureDoesNotMatch. HTTP 500, timeout ou outro erro de rede não comprovam nenhum dos dois.
 */
export function assessStreamRejection(
  browser: string,
  r: CaseResult | undefined,
  signedSize: number,
  partPresent: boolean,
): Assessment {
  if (!r) return { ok: false, observed: 'caso sem resultado' };
  const requests = putEvents(r, 'request');
  const responses = putEvents(r, 'response');
  const failures = putEvents(r, 'requestfailed');
  let ok = false;
  if (browser === 'chromium') {
    ok =
      !r.responseReceived &&
      r.status === 0 &&
      typeof r.exception === 'string' &&
      r.exception.startsWith('TypeError') &&
      requests.length === 1 &&
      requests[0].headersRead === true &&
      requests[0].contentLength === null &&
      responses.length === 0 &&
      failures.length === 1 &&
      CHROMIUM_STREAM_ERRORS.includes(failures[0].errorText ?? '');
  } else if (browser === 'firefox') {
    ok =
      r.responseReceived &&
      r.status === 403 &&
      r.errorCode === 'SignatureDoesNotMatch' &&
      r.exception === '' &&
      requests.length === 1 &&
      requests[0].headersRead === true &&
      typeof requests[0].contentLength === 'string' &&
      requests[0].contentLength !== String(signedSize) &&
      responses.length === 1 &&
      responses[0].status === 403 &&
      failures.length === 0;
  }
  return {
    ok: ok && !partPresent,
    observed: `${describeCase(r)}; ListParts: ${partPresent ? 'PRESENTE' : 'ausente'}`,
  };
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;
const BASE64_SHA256 = /^[A-Za-z0-9+/]{43}=$/;
const finiteNonNegative = (value: unknown): boolean =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0;

/**
 * V-09 (navegador): medição completa. Exige `requiredRuns` rodadas, `expectedParts` hashes
 * esperados no formato do SHA-256 em base64 e, em cada rodada, `expectedParts` partes com os
 * índices 0 a expectedParts-1 sem repetição, cada hash igual ao esperado daquela parte, execução
 * em Worker e tempo total finito e positivo. Dados ausentes, vazios ou incompletos reprovam.
 */
export function assessHashMeasurement(
  hash: unknown,
  expectedParts: number,
  requiredRuns: number,
): Assessment {
  const problems: string[] = [];
  const expected =
    isRecord(hash) && Array.isArray(hash.expected)
      ? (hash.expected as unknown[])
      : null;
  if (!expected) {
    problems.push('lista de hashes esperados ausente');
  } else {
    if (expected.length !== expectedParts) {
      problems.push(
        `${expected.length} hashes esperados (exigidos ${expectedParts})`,
      );
    }
    if (
      !expected.every((d) => typeof d === 'string' && BASE64_SHA256.test(d))
    ) {
      problems.push('hash esperado fora do formato SHA-256 em base64');
    }
  }
  const runs =
    isRecord(hash) && Array.isArray(hash.runs)
      ? (hash.runs as unknown[])
      : null;
  if (!runs) {
    problems.push('rodadas ausentes');
  } else {
    if (runs.length !== requiredRuns) {
      problems.push(`${runs.length} rodada(s) (exigidas ${requiredRuns})`);
    }
    runs.forEach((run, i) => {
      const label = `rodada ${i + 1}`;
      if (!isRecord(run)) {
        problems.push(`${label}: vazia`);
        return;
      }
      if (run.inWorker !== true) problems.push(`${label}: fora de Worker`);
      if (
        !(
          typeof run.totalMs === 'number' &&
          Number.isFinite(run.totalMs) &&
          run.totalMs > 0
        )
      ) {
        problems.push(
          `${label}: tempo total ausente, não finito ou não positivo`,
        );
      }
      const parts = Array.isArray(run.parts) ? (run.parts as unknown[]) : null;
      if (!parts) {
        problems.push(`${label}: partes ausentes`);
        return;
      }
      if (parts.length !== expectedParts) {
        problems.push(
          `${label}: ${parts.length} partes (exigidas ${expectedParts})`,
        );
      }
      const indices = parts.map((p) => (isRecord(p) ? p.index : undefined));
      const valid = indices.every(
        (ix) =>
          Number.isInteger(ix) &&
          (ix as number) >= 0 &&
          (ix as number) < expectedParts,
      );
      if (!valid || new Set(indices).size !== indices.length) {
        problems.push(
          `${label}: índices fora de 0 a ${expectedParts - 1} ou repetidos`,
        );
      }
      const wrong = parts.filter(
        (p) =>
          !(
            isRecord(p) &&
            typeof p.digest === 'string' &&
            Number.isInteger(p.index) &&
            expected !== null &&
            expected[p.index as number] === p.digest
          ),
      ).length;
      if (wrong > 0)
        problems.push(`${label}: ${wrong} hash(es) diferente(s) do esperado`);
      if (
        !parts.every(
          (p) =>
            isRecord(p) &&
            finiteNonNegative(p.readMs) &&
            finiteNonNegative(p.hashMs),
        )
      ) {
        problems.push(`${label}: tempo de leitura ou de hash inválido`);
      }
    });
  }
  return {
    ok: problems.length === 0,
    observed:
      problems.length === 0
        ? `${requiredRuns} rodadas completas: ${expectedParts} partes cada, índices 0 a ${expectedParts - 1} sem repetição, hashes iguais aos esperados, em Worker, tempos válidos`
        : problems.join('; '),
  };
}

/** Números de uma rodada já validada por `assessHashMeasurement`, para o relatório. */
function describeHashRun(run: unknown, totalBytes: number): string {
  if (!isRecord(run) || !Array.isArray(run.parts)) return 'rodada inválida';
  const parts = run.parts as Array<{ readMs: number; hashMs: number }>;
  const totalMs = run.totalMs as number;
  const bytesPerSecond = totalBytes / (totalMs / 1000);
  const readMs = parts.reduce((sum, p) => sum + p.readMs, 0);
  const hashMs = parts.reduce((sum, p) => sum + p.hashMs, 0);
  const lag =
    typeof run.mainThreadMaxLagMs === 'number' ? run.mainThreadMaxLagMs : NaN;
  return `total ${(totalMs / 1000).toFixed(2)} s (leitura ${(readMs / 1000).toFixed(2)} s, hash ${(hashMs / 1000).toFixed(2)} s); ${(bytesPerSecond / 1024 / 1024).toFixed(1)} MiB/s; projeção para 10.000.000.000 bytes: ${(PROJECTION_BYTES / bytesPerSecond).toFixed(1)} s; maior atraso da thread principal: ${lag.toFixed(0)} ms`;
}

const describeParts = (parts: Part[]): string =>
  parts.length === 0
    ? 'nenhuma parte'
    : parts
        .map(
          (p) =>
            `parte ${p.PartNumber}: ${p.Size} bytes, ChecksumSHA256 ${p.ChecksumSHA256 ?? '—'}`,
        )
        .join('; ');

async function verify(runId: string): Promise<boolean> {
  const { client, bucket } = context();
  const { manifest, result } = readInput();
  const checks = new Checks();
  if (manifest.runId !== runId) {
    throw new Error(`manifesto de outra execução: ${manifest.runId}`);
  }
  // Exigências fixas do script, não do manifesto: um manifesto com zero rodadas não pode aprovar.
  const expectedParts = HASH_TOTAL_BYTES / HASH_PART_BYTES;

  for (const p of result.directPreflight ?? []) {
    checks.info(
      `Preflight direto (OPTIONS de PUT com ${CHECKSUM_HEADER}) a partir de ${p.origin}`,
      `HTTP ${p.status}; Access-Control-Allow-Origin ${p.allowOrigin ?? '—'}; Allow-Methods ${p.allowMethods ?? '—'}; Allow-Headers ${p.allowHeaders ?? '—'}`,
    );
  }

  for (const name of BROWSERS) {
    const m = manifest.browsers[name];
    const b = result.browsers?.[name];
    if (!b) {
      checks.add(
        `[${name}] execução`,
        'resultado do navegador',
        'ausente',
        false,
      );
      continue;
    }
    checks.info(`[${name}] versão`, b.version);
    const listed =
      (
        await client.send(
          new ListPartsCommand({
            Bucket: bucket,
            Key: m.key,
            UploadId: m.uploadId,
          }),
        )
      ).Parts ?? [];
    checks.info(`[${name}] ListParts depois dos casos`, describeParts(listed));
    const part = (n: number): Part | undefined =>
      listed.find((p) => p.PartNumber === n);
    const res = (id: CaseId): CaseResult | undefined =>
      (Array.isArray(b.cases) ? b.cases : []).find((c) => c.id === id);
    const spec = (id: CaseId): ManifestCase => {
      const found = m.cases.find((c) => c.id === id);
      if (!found) throw new Error(`[${name}] caso ${id} fora do manifesto`);
      return found;
    };

    const a = assessAccepted(
      res('exact'),
      part(1),
      PART_SIZE,
      spec('exact').checksum,
    );
    checks.add(
      `[${name}] (a) PUT de Blob com o tamanho exato`,
      `200 lido pelo script, ETag legível e igual ao do ListParts; PUT com Content-Length ${PART_SIZE}; parte 1 com o tamanho e o checksum assinados`,
      a.observed,
      a.ok,
    );

    for (const [id, n, label] of [
      ['larger', 2, 'maior (N+1 bytes)'],
      ['smaller', 3, 'menor (N-1 bytes)'],
    ] as const) {
      const sent = spec(id).sendSize;
      const r = assessSizeRejection(res(id), sent, part(n) !== undefined);
      checks.add(
        `[${name}] (b) PUT de Blob ${label}`,
        `recusa no storage: 403 SignatureDoesNotMatch lido pelo script, PUT com Content-Length ${sent}, sem falha de rede; parte ${n} ausente do ListParts`,
        r.observed,
        r.ok,
      );
    }

    const c = assessStreamRejection(
      name,
      res('stream'),
      PART_SIZE,
      part(4) !== undefined,
    );
    checks.add(
      `[${name}] (c) PUT com corpo ReadableStream, sem Content-Length`,
      name === 'chromium'
        ? `recusa no navegador: TypeError, PUT sem Content-Length, falha ${CHROMIUM_STREAM_ERRORS.join(' ou ')} e nenhuma resposta do storage; parte 4 ausente`
        : `recusa no storage: 403 SignatureDoesNotMatch lido pelo script, PUT com Content-Length diferente de ${PART_SIZE} (o stream não é enviado), sem falha de rede; parte 4 ausente`,
      c.observed,
      c.ok,
    );

    const d = assessAccepted(
      res('preflight'),
      part(5),
      PART_SIZE,
      spec('preflight').checksum,
    );
    checks.add(
      `[${name}] (d) PUT com ${CHECKSUM_HEADER} (exige preflight aceito)`,
      `200 lido pelo script, ETag legível; PUT com Content-Length ${PART_SIZE}; parte 5 gravada com o checksum`,
      d.observed,
      d.ok,
    );
    checks.info(
      `[${name}] eventos de preflight vistos pelo navegador`,
      Array.isArray(b.preflightEvents) && b.preflightEvents.length > 0
        ? b.preflightEvents.join(' | ')
        : 'nenhum exposto por esta API',
    );
    const ctl = res('control-origin');
    checks.info(
      `[${name}] controle: o mesmo PUT a partir de ${result.controlOrigin}, fora do CORS`,
      `${ctl ? describeCase(ctl) : 'sem resultado'}; ListParts: ${part(6) ? 'PRESENTE' : 'ausente'}`,
    );

    // V-09 (navegador): medição completa obrigatória; os números só são relatados se válidos.
    const h = assessHashMeasurement(b.hash, expectedParts, HASH_RUNS);
    checks.add(
      `[${name}] V-09 medição completa do SHA-256 de 1 GiB`,
      `${HASH_RUNS} rodadas; ${expectedParts} hashes esperados; ${expectedParts} partes por rodada com índices 0 a ${expectedParts - 1} sem repetição; cada hash igual ao esperado; em Worker; tempo total finito e positivo`,
      h.observed,
      h.ok,
    );
    if (h.ok && isRecord(b.hash) && Array.isArray(b.hash.runs)) {
      (b.hash.runs as unknown[]).forEach((run, i) =>
        checks.info(
          `[${name}] V-09 rodada ${i + 1}`,
          describeHashRun(run, manifest.hashTotalBytes),
        ),
      );
    }
  }
  console.log(`RESUMO verify: ${checks.summary()}`);
  return checks.allPassed;
}

async function cleanup(runId: string): Promise<boolean> {
  const { client, bucket } = context();
  const k = keys(runId);
  return cleanupPrefix(client, bucket, k.prefix, k.all);
}

async function snapshot(): Promise<boolean> {
  const { client, bucket } = context();
  const r = await snapshotBucket(client, bucket);
  console.log(
    `SNAPSHOT objetos=${r.objects} bytes=${r.bytes} sha256=${r.digest}`,
  );
  return true;
}

async function main(): Promise<void> {
  const [command, runId] = process.argv.slice(2);
  const withRun =
    (fn: (id: string) => Promise<boolean>) => (): Promise<boolean> => {
      if (!runId) throw new Error(`uso: ${command} <runId>`);
      return fn(runId);
    };
  const commands: Record<string, () => Promise<boolean>> = {
    presign: withRun(presign),
    verify: withRun(verify),
    cleanup: withRun(cleanup),
    snapshot,
  };
  const run = commands[command ?? ''];
  if (!run) {
    throw new Error(
      `subcomando desconhecido: ${command}; use ${Object.keys(commands).join(', ')}`,
    );
  }
  process.exitCode = (await run()) ? 0 : 1;
}

if (require.main === module) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 2;
  });
}

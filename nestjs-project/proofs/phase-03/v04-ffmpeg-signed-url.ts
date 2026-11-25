// V-04 — ffprobe/ffmpeg 5.1 sobre URL pré-assinada interna, formatos de mídia e timeouts
// (phase-03-videos/TD-10, TD-11, TD-13; G-09). Roda dentro do container `nestjs-api`, chamado por
// `storage-proof-roteiro.sh v04`.
//
// Subcomandos: run <runId> | cleanup <runId> | snapshot (ver proof-support.ts).
// - Envia as fixtures de test/fixtures/videos (geradas por generate.sh) ao prefixo temporário
//   `proofs/v04-<runId>/`, com a credencial da aplicação, e lê cada uma por URL GET pré-assinada
//   interna (S3_ENDPOINT), como o worker fará.
// - Para cada fixture: ffprobe em JSON e extração de um frame JPEG (`-ss` antes de `-i`), primeiro
//   direto (o caminho de produção) e depois por um proxy HTTP transparente local (`-http_proxy`),
//   que só repassa e registra as requisições Range. Classifica pelas regras do Error Catalog.
// - Um objeto maior com `moov` no fim, gerado na hora (não versionado), prova a busca do `moov`
//   por Range sem baixar o arquivo inteiro.
// - Timeouts: um servidor local aceita a conexão e não envia bytes; mede `-rw_timeout`, as opções
//   `reconnect*` e o timeout por chamada que mata o processo, e confere que nenhum processo sobra.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import {
  createServer as createHttpServer,
  request as httpRequest,
  type IncomingHttpHeaders,
} from 'node:http';
import { createServer as createNetServer, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import {
  appClient,
  Checks,
  cleanupPrefix,
  readProjectEnv,
  requireKey,
  runProofCli,
} from './proof-support';

const FIXTURE_DIR = join(__dirname, '..', '..', 'test', 'fixtures', 'videos');
const FIXTURE_MAX_BYTES = 1_000_000;
const EXPIRES_IN = 900;

/** Valores adotados (G-09), verificados pela própria prova contra o servidor que não envia bytes. */
export const ADOPTED = {
  rwTimeoutUs: 10_000_000,
  reconnect: [
    '-reconnect',
    '1',
    '-reconnect_on_network_error',
    '1',
    '-reconnect_delay_max',
    '4',
  ],
  /** 4 tentativas × 10 s de rw_timeout + esperas de 0, 1 e 3 s = 44 s (medido 44,6 s). */
  expectedConnections: 4,
  stallMinMs: 40_000,
  stallBoundMs: 50_000,
  /** Timeout por chamada que mata o processo: acima do limite, como proteção final. */
  callTimeoutMs: 60_000,
};
const adoptedNetArgs = (): string[] => [
  '-rw_timeout',
  String(ADOPTED.rwTimeoutUs),
  ...ADOPTED.reconnect,
];

export type Classification =
  | 'aceita'
  | 'MEDIA_INVALID'
  | 'MEDIA_CONTAINER_MISMATCH'
  | 'MEDIA_UNSUPPORTED_CODEC'
  | 'TRANSITÓRIO'
  | 'NÃO CLASSIFICADO';

interface Fixture {
  file: string;
  contentType: 'video/mp4' | 'video/webm';
  expected: Classification;
  /** Causas que a recusa precisa mostrar (stderr do ffprobe ou campo do JSON). */
  causes?: RegExp[];
  moov?: 'start' | 'end';
  audio?: boolean;
}

const FIXTURES: Fixture[] = [
  {
    file: 'h264-aac-faststart.mp4',
    contentType: 'video/mp4',
    expected: 'aceita',
    moov: 'start',
    audio: true,
  },
  {
    file: 'h264-aac-moov-end.mp4',
    contentType: 'video/mp4',
    expected: 'aceita',
    moov: 'end',
    audio: true,
  },
  {
    file: 'h264-no-audio.mp4',
    contentType: 'video/mp4',
    expected: 'aceita',
    audio: false,
  },
  {
    file: 'vp9-opus.webm',
    contentType: 'video/webm',
    expected: 'aceita',
    audio: true,
  },
  {
    file: 'qt-brand.mov',
    contentType: 'video/mp4',
    expected: 'MEDIA_CONTAINER_MISMATCH',
    causes: [/major_brand qt {2}/],
  },
  {
    file: 'invalid.mp4',
    contentType: 'video/mp4',
    expected: 'MEDIA_INVALID',
    causes: [/Invalid data found when processing input/],
  },
  {
    file: 'truncated.mp4',
    contentType: 'video/mp4',
    expected: 'MEDIA_INVALID',
    causes: [/moov atom not found/, /Invalid data found when processing input/],
  },
];

const MEDIA_PARSE_ERRORS = [
  /Invalid data found when processing input/,
  /moov atom not found/,
];
/**
 * Evidências de falha de transporte. Prevalecem sobre as mensagens de parsing, que podem ser só
 * consequência de uma leitura interrompida (por exemplo, "moov atom not found" depois de um corpo
 * truncado). Os encerramentos antecipados legítimos das leituras por Range (o próprio FFmpeg fecha
 * a conexão) não geram nenhuma dessas mensagens.
 */
export const TRANSPORT_ERRORS = [
  /Connection timed out/,
  /Connection refused/,
  /Connection reset by peer/,
  /Broken pipe/,
  /Network is unreachable/,
  // O FFmpeg escreve o código ("Server returned 404 Not Found") ou a classe ("Server returned 5XX ...").
  /Server returned (?:[45]\d\d|[45]XX)/,
  /Input\/output error/,
  /Stream ends prematurely/,
];

interface ProbeJson {
  streams?: Array<{
    codec_type?: string;
    codec_name?: string;
    width?: number;
    height?: number;
  }>;
  format?: {
    format_name?: string;
    duration?: string;
    tags?: { major_brand?: string };
  };
}

/**
 * Regras do Error Catalog do plano: contêiner contra o content_type (MP4 com major_brand `qt  `
 * é MOV), codecs aceitos e stream de vídeo obrigatório. Falha do ffprobe por erro de leitura da
 * mídia é MEDIA_INVALID; por erro de rede ou timeout é TRANSITÓRIO; qualquer outra falha fica
 * "NÃO CLASSIFICADO" e nunca conta como validação da mídia.
 */
export function classify(
  probe: {
    code: number | null;
    stderr: string;
    json: ProbeJson | null;
    /** O processo foi morto pelo timeout por chamada. */
    killed?: boolean;
  },
  contentType: string,
): { classification: Classification; cause: string } {
  if (probe.killed) {
    return {
      classification: 'TRANSITÓRIO',
      cause: 'timeout por chamada: processo morto',
    };
  }
  if (TRANSPORT_ERRORS.some((r) => r.test(probe.stderr))) {
    return { classification: 'TRANSITÓRIO', cause: probe.stderr.trim() };
  }
  if (probe.code !== 0 || !probe.json) {
    if (MEDIA_PARSE_ERRORS.some((r) => r.test(probe.stderr)))
      return { classification: 'MEDIA_INVALID', cause: probe.stderr.trim() };
    return {
      classification: 'NÃO CLASSIFICADO',
      cause: probe.stderr.trim() || `código ${probe.code}`,
    };
  }
  const streams = probe.json.streams ?? [];
  const video = streams.filter((s) => s.codec_type === 'video');
  const audio = streams.filter((s) => s.codec_type === 'audio');
  if (video.length === 0)
    return { classification: 'MEDIA_INVALID', cause: 'sem stream de vídeo' };
  const formatName = probe.json.format?.format_name ?? '';
  const brand = probe.json.format?.tags?.major_brand ?? '';
  if (contentType === 'video/mp4') {
    if (!formatName.split(',').includes('mp4') || brand === 'qt  ') {
      return {
        classification: 'MEDIA_CONTAINER_MISMATCH',
        cause: `format_name ${formatName}; major_brand ${brand}`,
      };
    }
    const ok =
      video.every((s) => s.codec_name === 'h264') &&
      audio.every((s) => s.codec_name === 'aac');
    if (!ok)
      return {
        classification: 'MEDIA_UNSUPPORTED_CODEC',
        cause: streams.map((s) => s.codec_name).join(','),
      };
  } else if (contentType === 'video/webm') {
    if (!formatName.split(',').includes('webm')) {
      return {
        classification: 'MEDIA_CONTAINER_MISMATCH',
        cause: `format_name ${formatName}`,
      };
    }
    const ok =
      video.every((s) => ['vp8', 'vp9', 'av1'].includes(s.codec_name ?? '')) &&
      audio.every((s) => ['vorbis', 'opus'].includes(s.codec_name ?? ''));
    if (!ok)
      return {
        classification: 'MEDIA_UNSUPPORTED_CODEC',
        cause: streams.map((s) => s.codec_name).join(','),
      };
  } else {
    return {
      classification: 'MEDIA_CONTAINER_MISMATCH',
      cause: `content_type ${contentType}`,
    };
  }
  return { classification: 'aceita', cause: '' };
}

/**
 * Cenário com os valores adotados contra o servidor que não envia bytes: só aprova a saída
 * espontânea por "Connection timed out", com as conexões e a duração das tentativas medidas,
 * classificada como TRANSITÓRIO e sem processo restante. Connection refused imediato, HTTP 5xx
 * ou outro erro não aprovam.
 */
export function assessAdoptedStall(r: {
  killed: boolean;
  code: number | null;
  stderr: string;
  ms: number;
  connections: number;
  leftover: string[];
}): { ok: boolean; observed: string } {
  const other = TRANSPORT_ERRORS.filter(
    (e) => e.source !== 'Connection timed out',
  ).some((e) => e.test(r.stderr));
  const cls = classify(
    { code: r.code, stderr: r.stderr, json: null, killed: r.killed },
    'video/mp4',
  );
  const ok =
    !r.killed &&
    r.code !== null &&
    r.code !== 0 &&
    /Connection timed out/.test(r.stderr) &&
    !other &&
    r.connections === ADOPTED.expectedConnections &&
    r.ms >= ADOPTED.stallMinMs &&
    r.ms < ADOPTED.stallBoundMs &&
    cls.classification === 'TRANSITÓRIO' &&
    r.leftover.length === 0;
  return {
    ok,
    observed: `classificação ${cls.classification}; outra falha de transporte no stderr: ${other}; processos restantes: ${r.leftover.length}`,
  };
}

/**
 * Reprodução local: um servidor HTTP entrega uma fixture válida com o Content-Length completo,
 * mas fecha a conexão no meio do corpo. A leitura interrompida precisa ser TRANSITÓRIO, mesmo
 * que o demuxer também reclame do conteúdo incompleto.
 */
async function interruptedTransferCheck(checks: Checks): Promise<void> {
  const data = readFileSync(join(FIXTURE_DIR, 'h264-aac-moov-end.mp4'));
  const cut = 10_000;
  let connections = 0;
  const server = createHttpServer((_req, res) => {
    res.writeHead(200, {
      'Content-Type': 'video/mp4',
      'Content-Length': data.length,
    });
    res.write(data.subarray(0, cut));
    setTimeout(() => res.socket?.destroy(), 50);
  });
  server.on('connection', () => (connections += 1));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  try {
    const url = `http://127.0.0.1:${port}/h264-aac-moov-end.mp4`;
    const probe = await runProcess(
      'ffprobe',
      ffprobeArgs(url),
      ADOPTED.callTimeoutMs,
    );
    const result = classify(
      {
        code: probe.code,
        stderr: probe.stderr,
        json: parseJson(probe.stdout),
        killed: probe.killed,
      },
      'video/mp4',
    );
    const leftover = liveFfmpegProcesses();
    checks.add(
      `[transferência interrompida] ffprobe (valores adotados) de fixture válida cortada em ${cut} de ${data.length} bytes por um servidor HTTP local`,
      'TRANSITÓRIO, com "Stream ends prematurely" no stderr, saída espontânea e nenhum processo restante',
      `código ${probe.code}; ${probe.ms} ms; conexões ${connections}; classificação ${result.classification}; stderr: ${probe.stderr.trim().replace(/\s+/g, ' ')}`,
      result.classification === 'TRANSITÓRIO' &&
        /Stream ends prematurely/.test(probe.stderr) &&
        !probe.killed &&
        leftover.length === 0,
    );
  } finally {
    server.close();
  }
}

interface ProcResult {
  code: number | null;
  signal: string | null;
  stderr: string;
  stdout: Buffer;
  ms: number;
  killed: boolean;
}

/** Executa com timeout por chamada: ao vencer, mata o processo (SIGKILL) e espera o fim. */
function runProcess(
  cmd: string,
  args: string[],
  callTimeoutMs: number,
): Promise<ProcResult> {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const out: Buffer[] = [];
    let stderr = '';
    let killed = false;
    child.stdout.on('data', (c: Buffer) => out.push(c));
    child.stderr.on('data', (c: Buffer) => (stderr += c.toString()));
    const timer = setTimeout(() => {
      killed = true;
      child.kill('SIGKILL');
    }, callTimeoutMs);
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolve({
        code,
        signal,
        stderr,
        stdout: Buffer.concat(out),
        ms: Date.now() - started,
        killed,
      });
    });
  });
}

const ffprobeArgs = (url: string, extra: string[] = []): string[] => [
  '-v',
  'error',
  '-print_format',
  'json',
  '-show_format',
  '-show_streams',
  ...adoptedNetArgs(),
  ...extra,
  url,
];
const frameArgs = (
  url: string,
  seconds: number,
  extra: string[] = [],
): string[] => [
  '-hide_banner',
  '-v',
  'error',
  '-nostdin',
  ...adoptedNetArgs(),
  ...extra,
  '-ss',
  String(seconds),
  '-i',
  url,
  '-frames:v',
  '1',
  '-f',
  'image2pipe',
  '-c:v',
  'mjpeg',
  'pipe:1',
];

function parseJson(stdout: Buffer): ProbeJson | null {
  try {
    return JSON.parse(stdout.toString('utf8')) as ProbeJson;
  } catch {
    return null;
  }
}

/** JPEG válido: SOI/EOI e decodificável pelo ffprobe, com as dimensões do vídeo. */
async function jpegInfo(
  data: Buffer,
): Promise<{ valid: boolean; text: string }> {
  if (
    data.length < 4 ||
    data[0] !== 0xff ||
    data[1] !== 0xd8 ||
    data.at(-2) !== 0xff ||
    data.at(-1) !== 0xd9
  ) {
    return { valid: false, text: `${data.length} bytes, sem marcadores JPEG` };
  }
  const file = join(tmpdir(), `v04-frame-${process.pid}-${Date.now()}.jpg`);
  writeFileSync(file, data);
  try {
    const r = await runProcess(
      'ffprobe',
      ['-v', 'error', '-print_format', 'json', '-show_streams', file],
      10_000,
    );
    const s = parseJson(r.stdout)?.streams?.[0];
    const valid =
      r.code === 0 &&
      s?.codec_name === 'mjpeg' &&
      s.width === 320 &&
      s.height === 240;
    return {
      valid,
      text: `${data.length} bytes, ${s?.codec_name ?? '—'} ${s?.width ?? '?'}x${s?.height ?? '?'}`,
    };
  } finally {
    rmSync(file, { force: true });
  }
}

interface ProxyEntry {
  method: string;
  range: string | null;
  status: number;
  contentRange: string | null;
  bytes: number;
  error?: string;
}

/** Proxy HTTP transparente: repassa a requisição absoluta ao storage, com o mesmo Host, e registra. */
function startRecordingProxy(): Promise<{
  url: string;
  log: ProxyEntry[];
  close: () => void;
}> {
  const log: ProxyEntry[] = [];
  const server = createHttpServer((req, res) => {
    const target = new URL(req.url ?? '/');
    const entry: ProxyEntry = {
      method: req.method ?? '',
      range: req.headers.range ?? null,
      status: 0,
      contentRange: null,
      bytes: 0,
    };
    log.push(entry);
    const headers: IncomingHttpHeaders = { ...req.headers };
    delete headers['proxy-connection'];
    const upstream = httpRequest(
      {
        hostname: target.hostname,
        port: target.port,
        path: `${target.pathname}${target.search}`,
        method: req.method,
        headers,
      },
      (up) => {
        entry.status = up.statusCode ?? 0;
        entry.contentRange = up.headers['content-range'] ?? null;
        res.writeHead(entry.status, up.headers);
        up.on('data', (c: Buffer) => (entry.bytes += c.length));
        up.pipe(res);
      },
    );
    upstream.on('error', (e) => {
      entry.error = e.message;
      res.destroy();
    });
    res.on('close', () => upstream.destroy());
    req.pipe(upstream);
  });
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      resolve({
        url: `http://127.0.0.1:${port}`,
        log,
        close: () => server.close(),
      });
    }),
  );
}

const describeRequests = (log: ProxyEntry[]): string =>
  log
    .map(
      (e) =>
        `${e.method} Range ${e.range ?? '—'} → ${e.status}${e.contentRange ? ` (${e.contentRange})` : ''}, ${e.bytes} bytes${e.error ? `, erro ${e.error}` : ''}`,
    )
    .join('; ') || 'nenhuma requisição';

/** Processos ffmpeg/ffprobe vivos no container (o roteiro confere que nenhum sobra). */
export function liveFfmpegProcesses(): string[] {
  const found: string[] = [];
  for (const pid of readdirSync('/proc').filter((d) => /^\d+$/.test(d))) {
    try {
      const cmd = readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0');
      if (
        cmd[0] === 'ffmpeg' ||
        cmd[0] === 'ffprobe' ||
        /\/ff(mpeg|probe)$/.test(cmd[0])
      ) {
        found.push(`${pid} ${cmd[0]}`);
      }
    } catch {
      // processo terminou durante a leitura
    }
  }
  return found;
}

function keys(runId: string) {
  const prefix = `proofs/v04-${runId}/`;
  return { prefix, object: (name: string): string => `${prefix}${name}` };
}

function context() {
  const env = readProjectEnv();
  return {
    client: appClient(env, 'S3_ENDPOINT'),
    bucket: requireKey(env, 'S3_BUCKET'),
  };
}

async function presignedGet(
  client: S3Client,
  bucket: string,
  key: string,
): Promise<string> {
  return getSignedUrl(
    client,
    new GetObjectCommand({ Bucket: bucket, Key: key }),
    { expiresIn: EXPIRES_IN },
  );
}

async function fixtureChecks(
  checks: Checks,
  client: S3Client,
  bucket: string,
  runId: string,
): Promise<void> {
  const k = keys(runId);
  const proxy = await startRecordingProxy();
  try {
    for (const f of FIXTURES) {
      const data = readFileSync(join(FIXTURE_DIR, f.file));
      const sha = createHash('sha256').update(data).digest('hex');
      checks.add(
        `[${f.file}] fixture versionada`,
        `existe e tem menos de ${FIXTURE_MAX_BYTES} bytes`,
        `${data.length} bytes, SHA-256 ${sha.slice(0, 16)}…`,
        data.length > 0 && data.length < FIXTURE_MAX_BYTES,
      );
      if (f.moov) {
        const moov = data.indexOf('moov');
        const mdat = data.indexOf('mdat');
        checks.add(
          `[${f.file}] posição do moov`,
          f.moov === 'start' ? 'moov antes do mdat' : 'moov depois do mdat',
          `moov no byte ${moov}, mdat no byte ${mdat}`,
          moov >= 0 &&
            mdat >= 0 &&
            (f.moov === 'start' ? moov < mdat : moov > mdat),
        );
      }
      await client.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: k.object(f.file),
          Body: data,
          ContentType: f.contentType,
        }),
      );
      const url = await presignedGet(client, bucket, k.object(f.file));

      const probe = await runProcess(
        'ffprobe',
        ffprobeArgs(url),
        ADOPTED.callTimeoutMs,
      );
      const json = parseJson(probe.stdout);
      const result = classify(
        { code: probe.code, stderr: probe.stderr, json, killed: probe.killed },
        f.contentType,
      );
      const brand = json?.format?.tags?.major_brand;
      const causeText = `${result.cause}${brand !== undefined ? `; major_brand ${brand}` : ''}`;
      const causeOk = (f.causes ?? []).every((r) => r.test(causeText));
      proxy.log.length = 0;
      const proxied = await runProcess(
        'ffprobe',
        ffprobeArgs(url, ['-http_proxy', proxy.url]),
        ADOPTED.callTimeoutMs,
      );
      const probeRequests = [...proxy.log];
      const httpOk =
        probeRequests.length > 0 &&
        probeRequests.every((e) => e.status === 200 || e.status === 206);
      const proxiedSame =
        classify(
          {
            code: proxied.code,
            stderr: proxied.stderr,
            killed: proxied.killed,
            json: parseJson(proxied.stdout),
          },
          f.contentType,
        ).classification === result.classification;
      const streams = (json?.streams ?? [])
        .map(
          (s) =>
            `${s.codec_type}:${s.codec_name}${s.width ? ` ${s.width}x${s.height}` : ''}`,
        )
        .join(', ');
      checks.add(
        `[${f.file}] ffprobe por URL assinada (${f.contentType}) e classificação`,
        f.expected === 'aceita'
          ? 'aceita: duração, dimensões e codecs extraídos; leitura HTTP com 200/206'
          : `${f.expected}, com a causa esperada (${(f.causes ?? []).map((r) => r.source).join(' e ')}) e leitura HTTP bem-sucedida (200/206), não erro de rede`,
        `${result.classification}${result.cause ? ` (${result.cause.replace(/\s+/g, ' ')})` : ''}; código ${probe.code}; ${probe.ms} ms; duração ${json?.format?.duration ?? '—'}; streams ${streams || '—'}; major_brand ${brand ?? '—'}; requisições: ${describeRequests(probeRequests)}; mesma classificação pelo proxy: ${proxiedSame}`,
        result.classification === f.expected &&
          causeOk &&
          httpOk &&
          proxiedSame &&
          (f.expected !== 'aceita' ||
            (Number(json?.format?.duration) > 0 &&
              (json?.streams ?? []).some(
                (s) =>
                  s.codec_type === 'video' &&
                  s.width === 320 &&
                  s.height === 240,
              ) &&
              (json?.streams ?? []).some((s) => s.codec_type === 'audio') ===
                f.audio)),
      );

      const frame = await runProcess(
        'ffmpeg',
        frameArgs(url, 1),
        ADOPTED.callTimeoutMs,
      );
      const jpeg =
        frame.code === 0
          ? await jpegInfo(frame.stdout)
          : { valid: false, text: frame.stderr.trim().replace(/\s+/g, ' ') };
      proxy.log.length = 0;
      await runProcess(
        'ffmpeg',
        frameArgs(url, 1, ['-http_proxy', proxy.url]),
        ADOPTED.callTimeoutMs,
      );
      const frameRequests = [...proxy.log];
      if (f.expected === 'aceita') {
        checks.add(
          `[${f.file}] extração de frame (-ss 1 antes de -i) por URL assinada`,
          'JPEG válido, mjpeg 320x240; leitura HTTP com 200/206',
          `código ${frame.code}; ${frame.ms} ms; ${jpeg.text}; requisições: ${describeRequests(frameRequests)}`,
          frame.code === 0 &&
            jpeg.valid &&
            frameRequests.length > 0 &&
            frameRequests.every((e) => e.status === 200 || e.status === 206),
        );
      } else {
        checks.info(
          `[${f.file}] extração de frame (fixture recusada pela classificação)`,
          `código ${frame.code}; ${frame.ms} ms; ${jpeg.text}; requisições: ${describeRequests(frameRequests)}`,
        );
      }
    }
  } finally {
    proxy.close();
  }
}

/**
 * Objeto grande com moov no fim (cerca de 300 MB, gerado na hora, com ruído para não comprimir):
 * o moov é buscado por Range e os bytes transferidos ficam bem abaixo do objeto. Com um objeto
 * pequeno, a primeira requisição aberta (`bytes=0-`) cabe inteira nos buffers de rede e a medida
 * não distingue leitura parcial de download completo.
 */
async function largeMoovEndCheck(
  checks: Checks,
  client: S3Client,
  bucket: string,
  runId: string,
): Promise<void> {
  const file = join(tmpdir(), `v04-grande-moov-fim-${runId}.mp4`);
  try {
    const gen = await runProcess(
      'ffmpeg',
      [
        '-hide_banner',
        '-loglevel',
        'error',
        '-nostdin',
        '-y',
        '-f',
        'lavfi',
        '-i',
        'testsrc=size=640x360:rate=25:duration=60',
        '-vf',
        'noise=alls=40:allf=t',
        '-c:v',
        'libx264',
        '-preset',
        'ultrafast',
        '-b:v',
        '40M',
        '-maxrate',
        '40M',
        '-bufsize',
        '80M',
        '-pix_fmt',
        'yuv420p',
        file,
      ],
      120_000,
    );
    if (gen.code !== 0)
      throw new Error(`geração do objeto grande falhou: ${gen.stderr}`);
    const data = readFileSync(file);
    const key = keys(runId).object('grande-moov-fim.mp4');
    await client.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: data,
        ContentType: 'video/mp4',
      }),
    );
    const url = await presignedGet(client, bucket, key);
    const proxy = await startRecordingProxy();
    try {
      const probe = await runProcess(
        'ffprobe',
        ffprobeArgs(url, ['-http_proxy', proxy.url]),
        ADOPTED.callTimeoutMs,
      );
      const json = parseJson(probe.stdout);
      const total = proxy.log.reduce((sum, e) => sum + e.bytes, 0);
      const tailRange = proxy.log.some((e) => {
        const start = Number(/^bytes=(\d+)-/.exec(e.range ?? '')?.[1] ?? -1);
        return e.status === 206 && start > data.length / 2;
      });
      checks.add(
        `[grande-moov-fim.mp4, ${data.length} bytes, gerado na hora] ffprobe busca o moov por Range`,
        'aceita; uma requisição Range para o fim do objeto respondida com 206; bytes transferidos menores que 10% do objeto',
        `código ${probe.code}; ${probe.ms} ms; ${classify({ code: probe.code, stderr: probe.stderr, json, killed: probe.killed }, 'video/mp4').classification}; bytes lidos ${total} de ${data.length}; requisições: ${describeRequests(proxy.log)}`,
        probe.code === 0 &&
          classify(
            {
              code: probe.code,
              stderr: probe.stderr,
              json,
              killed: probe.killed,
            },
            'video/mp4',
          ).classification === 'aceita' &&
          tailRange &&
          total < data.length / 10,
      );
      proxy.log.length = 0;
      const frame = await runProcess(
        'ffmpeg',
        frameArgs(url, 30, ['-http_proxy', proxy.url]),
        ADOPTED.callTimeoutMs,
      );
      const total2 = proxy.log.reduce((sum, e) => sum + e.bytes, 0);
      checks.info(
        '[grande-moov-fim.mp4] extração de frame com -ss 30 antes de -i',
        `código ${frame.code}; ${frame.ms} ms; ${frame.stdout.length} bytes de JPEG; bytes lidos ${total2} de ${data.length}; requisições: ${describeRequests(proxy.log)}`,
      );
    } finally {
      proxy.close();
    }
  } finally {
    rmSync(file, { force: true });
  }
}

/** Servidor que aceita a conexão e nunca envia bytes. */
function startSilentServer(): Promise<{
  url: string;
  connections: () => number;
  reset: () => void;
  close: () => void;
}> {
  let count = 0;
  const sockets = new Set<Socket>();
  const server = createNetServer((socket) => {
    count += 1;
    sockets.add(socket);
    socket.on('error', () => undefined);
    socket.on('close', () => sockets.delete(socket));
  });
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      resolve({
        url: `http://127.0.0.1:${port}/parado.mp4`,
        connections: () => count,
        reset: () => {
          count = 0;
          sockets.forEach((s) => s.destroy());
        },
        close: () => {
          sockets.forEach((s) => s.destroy());
          server.close();
        },
      });
    }),
  );
}

async function timeoutChecks(checks: Checks): Promise<void> {
  const silent = await startSilentServer();
  try {
    for (const tool of ['ffprobe', 'ffmpeg'] as const) {
      const args = (net: string[]): string[] =>
        tool === 'ffprobe'
          ? ['-v', 'error', ...net, silent.url]
          : [
              '-hide_banner',
              '-v',
              'error',
              '-nostdin',
              ...net,
              '-i',
              silent.url,
              '-frames:v',
              '1',
              '-f',
              'null',
              '-',
            ];
      const scenario = async (net: string[], callTimeoutMs: number) => {
        silent.reset();
        const r = await runProcess(tool, args(net), callTimeoutMs);
        return {
          ...r,
          connections: silent.connections(),
          text: `${(r.ms / 1000).toFixed(1)} s; código ${r.code}; sinal ${r.signal ?? '—'}; conexões ${silent.connections()}; stderr: ${r.stderr.trim().replace(/\s+/g, ' ') || '—'}`,
        };
      };

      const none = await scenario([], 3_000);
      checks.add(
        `[${tool}] sem -rw_timeout, timeout por chamada de 3 s`,
        'o processo não termina sozinho e é morto pelo timeout por chamada (SIGKILL) em cerca de 3 s',
        none.text,
        none.killed && none.signal === 'SIGKILL' && none.ms < 5_000,
      );
      const rw = await scenario(['-rw_timeout', '2000000'], 20_000);
      checks.add(
        `[${tool}] -rw_timeout 2 s, sem reconexão`,
        'termina sozinho em 2 a 4 s, com "Connection timed out" (erro transitório), 1 conexão',
        rw.text,
        !rw.killed &&
          rw.code !== 0 &&
          /Connection timed out/.test(rw.stderr) &&
          rw.ms >= 2_000 &&
          rw.ms < 4_000 &&
          rw.connections === 1,
      );
      const rc = await scenario(
        ['-rw_timeout', '2000000', ...ADOPTED.reconnect],
        30_000,
      );
      checks.add(
        `[${tool}] -rw_timeout 2 s com ${ADOPTED.reconnect.join(' ')}`,
        'termina sozinho com "Connection timed out" depois de 4 conexões (esperas de 0, 1 e 3 s), em 12 a 16 s',
        rc.text,
        !rc.killed &&
          rc.code !== 0 &&
          /Connection timed out/.test(rc.stderr) &&
          rc.connections === 4 &&
          rc.ms >= 12_000 &&
          rc.ms < 16_000,
      );
      const adopted = await scenario(adoptedNetArgs(), ADOPTED.callTimeoutMs);
      const verdict = assessAdoptedStall({
        killed: adopted.killed,
        code: adopted.code,
        stderr: adopted.stderr,
        ms: adopted.ms,
        connections: adopted.connections,
        leftover: liveFfmpegProcesses(),
      });
      checks.add(
        `[${tool}] valores adotados: ${adoptedNetArgs().join(' ')}, timeout por chamada ${ADOPTED.callTimeoutMs / 1000} s`,
        `saída espontânea com "Connection timed out" (sem Connection refused, HTTP 5xx ou outro erro), ${ADOPTED.expectedConnections} conexões, duração entre ${ADOPTED.stallMinMs / 1000} e ${ADOPTED.stallBoundMs / 1000} s, classificada como TRANSITÓRIO e sem processo restante`,
        `${adopted.text}; ${verdict.observed}`,
        verdict.ok,
      );
      if (tool === 'ffprobe') {
        const dflt = await scenario(
          [
            '-rw_timeout',
            '2000000',
            '-reconnect',
            '1',
            '-reconnect_on_network_error',
            '1',
          ],
          20_000,
        );
        checks.info(
          '[ffprobe] reconexão com reconnect_delay_max no padrão (120 s), timeout por chamada de 20 s',
          `${dflt.text} — sem limitar a espera, o processo segue reconectando e só termina morto`,
        );
      }
    }
  } finally {
    silent.close();
  }
}

async function run(runId: string): Promise<boolean> {
  const { client, bucket } = context();
  const checks = new Checks();
  const version = async (cmd: string) =>
    (await runProcess(cmd, ['-version'], 10_000)).stdout
      .toString()
      .split('\n')[0];
  checks.info(
    'versões',
    `Node ${process.version}; ${await version('ffmpeg')}; ${await version('ffprobe')}`,
  );
  const httpOptions = (
    await runProcess('ffmpeg', ['-hide_banner', '-h', 'protocol=http'], 10_000)
  ).stdout.toString();
  checks.info(
    'opções do protocolo http no FFmpeg da imagem',
    [
      'reconnect',
      'reconnect_on_network_error',
      'reconnect_delay_max',
      'reconnect_max_retries',
      'reconnect_delay_total_max',
      'http_proxy',
    ]
      .map(
        (o) =>
          `${o}: ${new RegExp(`-${o}\\s`).test(httpOptions) ? 'sim' : 'não'}`,
      )
      .join(', '),
  );
  await fixtureChecks(checks, client, bucket, runId);
  await largeMoovEndCheck(checks, client, bucket, runId);
  await interruptedTransferCheck(checks);
  await timeoutChecks(checks);
  const leftover = liveFfmpegProcesses();
  checks.add(
    'processos ffmpeg/ffprobe restantes no container',
    'nenhum',
    leftover.join(', ') || 'nenhum',
    leftover.length === 0,
  );
  console.log(`RESUMO run: ${checks.summary()}`);
  return checks.allPassed;
}

async function cleanup(runId: string): Promise<boolean> {
  const { client, bucket } = context();
  const k = keys(runId);
  const removed = await cleanupPrefix(client, bucket, k.prefix, []);
  const leftover = liveFfmpegProcesses();
  const files = readdirSync(tmpdir()).filter((f) => f.startsWith('v04-'));
  console.log(
    `LIMPEZA processos ffmpeg/ffprobe restantes: ${leftover.length}; arquivos temporários v04-* em ${tmpdir()}: ${files.length}`,
  );
  return removed && leftover.length === 0 && files.length === 0;
}

if (require.main === module) {
  runProofCli({ run, cleanup });
}

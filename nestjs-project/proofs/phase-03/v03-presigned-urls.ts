// V-03 — URLs pré-assinadas do AWS SDK 3.1170 com WHEN_REQUIRED contra o Silo (phase-03-videos/TD-07, TD-08).
// Roda dentro do container `nestjs-api`, chamado por `v03-roteiro.sh`, que faz as requisições com curl.
//
// Subcomandos:
//   presign <runId>   Cria os multipart temporários e imprime em TSV as URLs de PutObject, UploadPart e
//                     GetObject: assinadas para o endpoint público e para o interno, com WHEN_REQUIRED, e
//                     um controle com os padrões do SDK (WHEN_SUPPORTED), só para comparar a query.
//   verify <runId>    Lê do stdin o TSV das URLs e dos resultados do curl, confere a query, as respostas
//                     e o estado do storage, e imprime um item por linha.
//   cleanup <runId>   Remove os objetos do prefixo temporário e aborta os multipart da prova.
//   snapshot          Retrato do bucket principal (quantidade, bytes e hash), só leitura.
//
// Usa a credencial da aplicação (`S3_ACCESS_KEY_ID`) e o bucket `S3_BUCKET` do `.env`, sob o
// prefixo `proofs/v03-<runId>/`.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import {
  AbortMultipartUploadCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListMultipartUploadsCommand,
  ListObjectsV2Command,
  ListPartsCommand,
  PutObjectCommand,
  S3Client,
  UploadPartCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import {
  appClient,
  Checks,
  readProjectEnv,
  requireKey,
  snapshotBucket,
} from './proof-support';

const EXPIRES_IN = 60;
const CHECKSUM_PARAM = /^x-amz-(checksum-.+|sdk-checksum-algorithm)$/i;

function keys(runId: string) {
  const prefix = `proofs/v03-${runId}/`;
  return {
    prefix,
    putPublic: `${prefix}put-public.bin`,
    putInternal: `${prefix}put-internal.bin`,
    putControl: `${prefix}put-control.bin`,
    multipartPublic: `${prefix}multipart-public.bin`,
    multipartInternal: `${prefix}multipart-internal.bin`,
  };
}

function context() {
  const env = readProjectEnv();
  const bucket = requireKey(env, 'S3_BUCKET');
  const internal = appClient(env, 'S3_ENDPOINT');
  const publicSigner = appClient(env, 'S3_PUBLIC_ENDPOINT');
  // Controle: mesmo endpoint público, com os padrões do SDK para checksums (WHEN_SUPPORTED).
  const control = new S3Client({
    endpoint: requireKey(env, 'S3_PUBLIC_ENDPOINT'),
    region: requireKey(env, 'S3_REGION'),
    forcePathStyle: requireKey(env, 'S3_FORCE_PATH_STYLE') === 'true',
    credentials: {
      accessKeyId: requireKey(env, 'S3_ACCESS_KEY_ID'),
      secretAccessKey: requireKey(env, 'S3_SECRET_ACCESS_KEY'),
    },
  });
  return { env, bucket, internal, publicSigner, control };
}

async function presign(runId: string): Promise<boolean> {
  const { bucket, internal, publicSigner, control } = context();
  const k = keys(runId);
  const uploadIds: Record<string, string> = {};
  for (const key of [k.multipartPublic, k.multipartInternal]) {
    const created = await internal.send(
      new CreateMultipartUploadCommand({ Bucket: bucket, Key: key }),
    );
    uploadIds[key] = created.UploadId ?? '';
    console.log(['upload', key, uploadIds[key]].join('\t'));
  }

  const rows: Array<
    [
      string,
      string,
      S3Client,
      PutObjectCommand | UploadPartCommand | GetObjectCommand,
    ]
  > = [
    [
      'public-put',
      'PUT',
      publicSigner,
      new PutObjectCommand({ Bucket: bucket, Key: k.putPublic }),
    ],
    [
      'public-part',
      'PUT',
      publicSigner,
      new UploadPartCommand({
        Bucket: bucket,
        Key: k.multipartPublic,
        UploadId: uploadIds[k.multipartPublic],
        PartNumber: 1,
      }),
    ],
    [
      'public-get',
      'GET',
      publicSigner,
      new GetObjectCommand({ Bucket: bucket, Key: k.putPublic }),
    ],
    [
      'internal-put',
      'PUT',
      internal,
      new PutObjectCommand({ Bucket: bucket, Key: k.putInternal }),
    ],
    [
      'internal-part',
      'PUT',
      internal,
      new UploadPartCommand({
        Bucket: bucket,
        Key: k.multipartInternal,
        UploadId: uploadIds[k.multipartInternal],
        PartNumber: 1,
      }),
    ],
    [
      'internal-get',
      'GET',
      internal,
      new GetObjectCommand({ Bucket: bucket, Key: k.putInternal }),
    ],
    [
      'control-put',
      'PUT',
      control,
      new PutObjectCommand({ Bucket: bucket, Key: k.putControl }),
    ],
    [
      'control-part',
      'PUT',
      control,
      new UploadPartCommand({
        Bucket: bucket,
        Key: k.multipartPublic,
        UploadId: uploadIds[k.multipartPublic],
        PartNumber: 2,
      }),
    ],
    [
      'control-get',
      'GET',
      control,
      new GetObjectCommand({ Bucket: bucket, Key: k.putPublic }),
    ],
  ];
  // Cada chamada recebe um tipo concreto: com a união dos três comandos, a inferência dos
  // genéricos de getSignedUrl depende da ordem dos tipos no programa e pode falhar no tsc.
  const sign = (
    client: S3Client,
    command: PutObjectCommand | UploadPartCommand | GetObjectCommand,
  ): Promise<string> => {
    const options = { expiresIn: EXPIRES_IN };
    if (command instanceof PutObjectCommand) {
      return getSignedUrl(client, command, options);
    }
    if (command instanceof UploadPartCommand) {
      return getSignedUrl(client, command, options);
    }
    return getSignedUrl(client, command, options);
  };
  console.log(['meta', 'generatedAt', String(Date.now())].join('\t'));
  for (const [id, method, client, command] of rows) {
    const url = await sign(client, command);
    console.log(['url', id, method, url].join('\t'));
  }
  return true;
}

interface CurlResult {
  status: number;
  etag: string;
  allowOrigin: string;
  exposeHeaders: string;
  bodySha256: string;
  errorCode: string;
  errorMessage: string;
}

function parseInput(): {
  urls: Map<string, { method: string; url: string }>;
  results: Map<string, CurlResult>;
  bodies: Map<string, { sha256: string; size: number }>;
  origin: string;
} {
  const urls = new Map<string, { method: string; url: string }>();
  const results = new Map<string, CurlResult>();
  const bodies = new Map<string, { sha256: string; size: number }>();
  let origin = '';
  for (const line of readFileSync(0, 'utf8').split('\n')) {
    const f = line.split('\t');
    if (f[0] === 'url') urls.set(f[1], { method: f[2], url: f[3] });
    if (f[0] === 'body') bodies.set(f[1], { sha256: f[2], size: Number(f[3]) });
    if (f[0] === 'origin') origin = f[1];
    if (f[0] === 'result') {
      results.set(f[1], {
        status: Number(f[2]),
        etag: f[3] ?? '',
        allowOrigin: f[4] ?? '',
        exposeHeaders: f[5] ?? '',
        bodySha256: f[6] ?? '',
        errorCode: f[7] ?? '',
        errorMessage: f[8] ?? '',
      });
    }
  }
  return { urls, results, bodies, origin };
}

function queryReport(url: string) {
  const parsed = new URL(url);
  const names = [...parsed.searchParams.keys()];
  return {
    host: parsed.host,
    path: parsed.pathname,
    names,
    checksumParams: names.filter((name) => CHECKSUM_PARAM.test(name)),
    signedHeaders: parsed.searchParams.get('X-Amz-SignedHeaders') ?? '',
  };
}

const unquote = (etag: string | undefined): string =>
  (etag ?? '').replace(/"/g, '');

async function sha256Of(
  client: S3Client,
  bucket: string,
  key: string,
): Promise<string> {
  const object = await client.send(
    new GetObjectCommand({ Bucket: bucket, Key: key }),
  );
  const bytes = await object.Body?.transformToByteArray();
  return createHash('sha256')
    .update(bytes ?? new Uint8Array())
    .digest('hex');
}

async function verify(runId: string): Promise<boolean> {
  const { bucket, internal } = context();
  const k = keys(runId);
  const { urls, results, bodies, origin } = parseInput();
  const checks = new Checks();
  const result = (id: string): CurlResult | undefined => results.get(id);
  const describe = (r: CurlResult | undefined): string =>
    r === undefined
      ? 'sem resultado'
      : `HTTP ${r.status}; ETag ${r.etag || '—'}; erro ${r.errorCode || '—'}${r.errorMessage ? ` (${r.errorMessage})` : ''}`;

  // 1. Query das URLs com WHEN_REQUIRED: sem parâmetros de checksum automáticos.
  for (const id of [
    'public-put',
    'public-part',
    'public-get',
    'internal-put',
    'internal-part',
    'internal-get',
  ]) {
    const entry = urls.get(id);
    const q = entry ? queryReport(entry.url) : undefined;
    console.log(
      `QUERY ${id}: host=${q?.host} path=${q?.path} params=${q?.names.join(',')} signedHeaders=${q?.signedHeaders}`,
    );
    checks.add(
      `${id}: query sem checksum automático`,
      'nenhum parâmetro x-amz-checksum-* nem x-amz-sdk-checksum-algorithm; só o host assinado',
      q
        ? `checksum: ${q.checksumParams.join(',') || 'nenhum'}; assinados: ${q.signedHeaders}`
        : 'URL ausente',
      q !== undefined &&
        q.checksumParams.length === 0 &&
        q.signedHeaders === 'host',
    );
  }
  // Controle (padrões do SDK): mostra o que o WHEN_REQUIRED evita. Informativo.
  for (const id of ['control-put', 'control-part', 'control-get']) {
    const entry = urls.get(id);
    const q = entry ? queryReport(entry.url) : undefined;
    console.log(
      `CONTROLE ${id}: params=${q?.names.join(',')} checksum=${q?.checksumParams.join(',') || 'nenhum'}`,
    );
  }

  // 2. Respostas do storage às URLs (curl).
  const puts: Array<[string, string, string]> = [
    ['public-put', k.putPublic, 'public'],
    ['internal-put', k.putInternal, 'internal'],
  ];
  for (const [id, key, bodyName] of puts) {
    const r = result(id);
    const head = await internal.send(
      new HeadObjectCommand({ Bucket: bucket, Key: key }),
    );
    const body = bodies.get(bodyName);
    checks.add(
      `${id}: PutObject aceito`,
      `200 com ETag; objeto com ${body?.size} bytes e o mesmo ETag`,
      `${describe(r)}; HeadObject ${head.ContentLength} bytes, ETag ${unquote(head.ETag)}`,
      r?.status === 200 &&
        r.etag !== '' &&
        r.etag === unquote(head.ETag) &&
        head.ContentLength === body?.size,
    );
  }
  const parts: Array<[string, string, string]> = [
    ['public-part', k.multipartPublic, 'public'],
    ['internal-part', k.multipartInternal, 'internal'],
  ];
  for (const [id, key, bodyName] of parts) {
    const r = result(id);
    const uploadId =
      new URL(urls.get(id)?.url ?? 'http://x/').searchParams.get('uploadId') ??
      '';
    const listed = await internal.send(
      new ListPartsCommand({ Bucket: bucket, Key: key, UploadId: uploadId }),
    );
    const part = listed.Parts?.find((p) => p.PartNumber === 1);
    const body = bodies.get(bodyName);
    checks.add(
      `${id}: UploadPart aceito`,
      `200 com ETag; ListParts mostra a parte 1 com ${body?.size} bytes e o mesmo ETag`,
      `${describe(r)}; ListParts: ${listed.Parts?.length ?? 0} parte(s), parte 1 com ${part?.Size} bytes e ETag ${unquote(part?.ETag)}`,
      r?.status === 200 &&
        r.etag !== '' &&
        r.etag === unquote(part?.ETag) &&
        part?.Size === body?.size,
    );
  }
  const gets: Array<[string, string, string]> = [
    ['public-get', k.putPublic, 'public'],
    ['internal-get', k.putInternal, 'internal'],
  ];
  for (const [id, key, bodyName] of gets) {
    const r = result(id);
    const stored = await sha256Of(internal, bucket, key);
    const body = bodies.get(bodyName);
    checks.add(
      `${id}: GetObject devolve o conteúdo enviado`,
      `200; SHA-256 do download igual ao do corpo enviado (${body?.sha256.slice(0, 16)}…)`,
      `${describe(r)}; SHA-256 do download ${r?.bodySha256.slice(0, 16)}…; no storage ${stored.slice(0, 16)}…`,
      r?.status === 200 &&
        r.bodySha256 === body?.sha256 &&
        stored === body?.sha256,
    );
  }

  // 3. CORS nas requisições do endpoint público (o roteiro envia o header Origin).
  for (const id of ['public-put', 'public-part', 'public-get']) {
    const r = result(id);
    const exposesEtag = (r?.exposeHeaders ?? '')
      .split(',')
      .some((h) => h.trim().toLowerCase() === 'etag');
    checks.add(
      `${id}: CORS com a origem ${origin}`,
      'Access-Control-Allow-Origin igual à origem e ETag em Access-Control-Expose-Headers',
      `allow-origin ${r?.allowOrigin || '—'}; expõe ETag: ${exposesEtag}`,
      r?.allowOrigin === origin && exposesEtag,
    );
  }

  // 4. URL expirada: a mesma URL de GET depois do prazo.
  const expired = result('public-get-expired');
  checks.add(
    `public-get depois de ${EXPIRES_IN}s: URL expirada recusada`,
    '403 AccessDenied (Request has expired)',
    describe(expired),
    expired?.status === 403 && expired.errorCode === 'AccessDenied',
  );

  const controlPut = result('control-put');
  console.log(
    `CONTROLE control-put executado (informativo): ${describe(controlPut)}`,
  );
  console.log(`RESUMO verify: ${checks.summary()}`);
  return checks.allPassed;
}

async function cleanup(runId: string): Promise<boolean> {
  const { bucket, internal } = context();
  const k = keys(runId);
  let removedObjects = 0;
  let abortedUploads = 0;
  const listed = await internal.send(
    new ListObjectsV2Command({ Bucket: bucket, Prefix: k.prefix }),
  );
  for (const object of listed.Contents ?? []) {
    await internal.send(
      new DeleteObjectCommand({ Bucket: bucket, Key: object.Key }),
    );
    removedObjects += 1;
  }
  const multipartKeys = [
    k.multipartPublic,
    k.multipartInternal,
    k.putPublic,
    k.putInternal,
    k.putControl,
  ];
  for (const key of multipartKeys) {
    // O MinIO exige a chave exata como prefixo em ListMultipartUploads.
    const uploads = await internal.send(
      new ListMultipartUploadsCommand({ Bucket: bucket, Prefix: key }),
    );
    for (const upload of uploads.Uploads ?? []) {
      await internal.send(
        new AbortMultipartUploadCommand({
          Bucket: bucket,
          Key: key,
          UploadId: upload.UploadId,
        }),
      );
      abortedUploads += 1;
    }
  }
  const objectsLeft =
    (
      await internal.send(
        new ListObjectsV2Command({ Bucket: bucket, Prefix: k.prefix }),
      )
    ).KeyCount ?? 0;
  let uploadsLeft = 0;
  for (const key of multipartKeys) {
    const uploads = await internal.send(
      new ListMultipartUploadsCommand({ Bucket: bucket, Prefix: key }),
    );
    uploadsLeft += uploads.Uploads?.length ?? 0;
  }
  console.log(
    `LIMPEZA prefixo ${k.prefix}: ${removedObjects} objeto(s) removido(s), ${abortedUploads} multipart abortado(s); restam ${objectsLeft} objeto(s) e ${uploadsLeft} multipart`,
  );
  return objectsLeft === 0 && uploadsLeft === 0;
}

async function snapshot(): Promise<boolean> {
  const { env, internal } = context();
  const result = await snapshotBucket(internal, requireKey(env, 'S3_BUCKET'));
  console.log(
    `SNAPSHOT objetos=${result.objects} bytes=${result.bytes} sha256=${result.digest}`,
  );
  return true;
}

async function main(): Promise<void> {
  const [command, runId] = process.argv.slice(2);
  const needsRun = (): string => {
    if (!runId) throw new Error(`uso: ${command} <runId>`);
    return runId;
  };
  const commands: Record<string, () => Promise<boolean>> = {
    presign: () => presign(needsRun()),
    verify: () => verify(needsRun()),
    cleanup: () => cleanup(needsRun()),
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

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 2;
});

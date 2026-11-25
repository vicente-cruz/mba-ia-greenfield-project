// V-01 — configuração do Silo: CORS e idade do multipart incompleto (phase-03-videos/TD-02, TD-07, TD-08).
// Roda dentro do container `nestjs-api`, chamado por `v01-roteiro.sh`, que roda no host.
//
// Subcomandos:
//   cors-main <runId>  CORS da instância principal, só leitura (preflight e GET assinado de chave inexistente).
//   cors-iso <runId>   CORS da instância isolada, com PUT e GET assinados de um objeto temporário.
//   stale <runId>      Idade do multipart incompleto na instância isolada, com expiração curta.
//   snapshot           Retrato do bucket principal (quantidade, bytes e hash), só leitura.
//
// A instância isolada vem de V01_ISO_ENDPOINT, V01_ISO_ACCESS_KEY, V01_ISO_SECRET_KEY,
// V01_ISO_BUCKET, V01_ALLOWED_ORIGIN, V01_EXPIRY_SECONDS e V01_INTERVAL_SECONDS.
import {
  AbortMultipartUploadCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  ListMultipartUploadsCommand,
  ListPartsCommand,
  PutObjectCommand,
  S3Client,
  UploadPartCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import {
  appClient,
  Checks,
  errorName,
  readProjectEnv,
  requireKey,
  sleep,
  snapshotBucket,
} from './proof-support';

const FOREIGN_ORIGIN = 'http://cors-foreign.invalid';
const PRESIGN_SECONDS = 60;

interface Target {
  name: string;
  client: S3Client;
  endpoint: string;
  bucket: string;
  allowedOrigin: string;
}

function mainTarget(): Target {
  const env = readProjectEnv();
  return {
    name: 'principal',
    client: appClient(env, 'S3_ENDPOINT'),
    endpoint: requireKey(env, 'S3_ENDPOINT'),
    bucket: requireKey(env, 'S3_BUCKET'),
    // A variável é uma lista separada por vírgula; a primeira origem é a do frontend.
    allowedOrigin: requireKey(env, 'MINIO_API_CORS_ALLOW_ORIGIN').split(',')[0],
  };
}

function isolatedTarget(): Target {
  const env = process.env;
  const endpoint = requireKey(env, 'V01_ISO_ENDPOINT');
  return {
    name: 'isolada',
    endpoint,
    bucket: requireKey(env, 'V01_ISO_BUCKET'),
    allowedOrigin: requireKey(env, 'V01_ALLOWED_ORIGIN'),
    client: new S3Client({
      endpoint,
      region: 'us-east-1',
      forcePathStyle: true,
      credentials: {
        accessKeyId: requireKey(env, 'V01_ISO_ACCESS_KEY'),
        secretAccessKey: requireKey(env, 'V01_ISO_SECRET_KEY'),
      },
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED',
    }),
  };
}

interface CorsView {
  status: number;
  allowOrigin: string | null;
  allowMethods: string | null;
  exposeHeaders: string | null;
  etag: string | null;
  vary: string | null;
}

function corsView(response: Response): CorsView {
  return {
    status: response.status,
    allowOrigin: response.headers.get('access-control-allow-origin'),
    allowMethods: response.headers.get('access-control-allow-methods'),
    exposeHeaders: response.headers.get('access-control-expose-headers'),
    etag: response.headers.get('etag'),
    vary: response.headers.get('vary'),
  };
}

const show = (view: CorsView): string => JSON.stringify(view);

/** Exige o nome `ETag` explícito: o curinga `*` não vale para requisições com credenciais. */
function exposesEtag(exposeHeaders: string | null): boolean {
  return (exposeHeaders ?? '')
    .split(',')
    .some((header) => header.trim().toLowerCase() === 'etag');
}

function preflight(
  target: Target,
  key: string,
  origin: string,
): Promise<Response> {
  return fetch(`${target.endpoint}/${target.bucket}/${key}`, {
    method: 'OPTIONS',
    headers: {
      Origin: origin,
      'Access-Control-Request-Method': 'PUT',
      'Access-Control-Request-Headers': 'content-type',
    },
  });
}

async function checkPreflights(
  checks: Checks,
  target: Target,
  key: string,
): Promise<void> {
  const allowed = corsView(await preflight(target, key, target.allowedOrigin));
  checks.add(
    `[${target.name}] preflight PUT da origem permitida (${target.allowedOrigin})`,
    'Access-Control-Allow-Origin igual à origem e PUT entre os métodos',
    show(allowed),
    allowed.allowOrigin === target.allowedOrigin &&
      (allowed.allowMethods ?? '').toUpperCase().includes('PUT'),
  );
  const foreign = corsView(await preflight(target, key, FOREIGN_ORIGIN));
  checks.add(
    `[${target.name}] preflight PUT de origem fora de MINIO_API_CORS_ALLOW_ORIGIN (${FOREIGN_ORIGIN})`,
    'sem Access-Control-Allow-Origin (o navegador bloqueia)',
    show(foreign),
    foreign.allowOrigin === null,
  );
}

async function corsMain(runId: string): Promise<boolean> {
  const target = mainTarget();
  const checks = new Checks();
  const key = `proofs/v01-${runId}/absent.bin`;
  await checkPreflights(checks, target, key);

  // GET assinado de chave inexistente: só leitura, nada é gravado na instância principal.
  const url = await getSignedUrl(
    target.client,
    new GetObjectCommand({ Bucket: target.bucket, Key: key }),
    { expiresIn: PRESIGN_SECONDS },
  );
  const allowed = corsView(
    await fetch(url, { headers: { Origin: target.allowedOrigin } }),
  );
  checks.add(
    `[${target.name}] GET assinado com a origem permitida (chave inexistente)`,
    'Access-Control-Allow-Origin igual à origem e ETag em Access-Control-Expose-Headers',
    show(allowed),
    allowed.allowOrigin === target.allowedOrigin &&
      exposesEtag(allowed.exposeHeaders),
  );
  const foreign = corsView(
    await fetch(url, { headers: { Origin: FOREIGN_ORIGIN } }),
  );
  checks.add(
    `[${target.name}] GET assinado com origem estranha`,
    'sem Access-Control-Allow-Origin',
    show(foreign),
    foreign.allowOrigin === null,
  );
  console.log(`RESUMO cors-main: ${checks.summary()}`);
  return checks.allPassed;
}

async function corsIsolated(runId: string): Promise<boolean> {
  const target = isolatedTarget();
  const checks = new Checks();
  const key = `cors/v01-${runId}.bin`;
  await checkPreflights(checks, target, key);

  const body = Buffer.from(`v01 ${runId} cors\n`);
  const putUrl = await getSignedUrl(
    target.client,
    new PutObjectCommand({ Bucket: target.bucket, Key: key }),
    { expiresIn: PRESIGN_SECONDS },
  );
  const put = corsView(
    await fetch(putUrl, {
      method: 'PUT',
      body,
      headers: { Origin: target.allowedOrigin },
    }),
  );
  checks.add(
    `[${target.name}] PUT assinado com a origem permitida`,
    '200, ETag na resposta, Access-Control-Allow-Origin igual à origem e ETag exposto',
    show(put),
    put.status === 200 &&
      put.etag !== null &&
      put.allowOrigin === target.allowedOrigin &&
      exposesEtag(put.exposeHeaders),
  );

  const getUrl = await getSignedUrl(
    target.client,
    new GetObjectCommand({ Bucket: target.bucket, Key: key }),
    { expiresIn: PRESIGN_SECONDS },
  );
  const getResponse = await fetch(getUrl, {
    headers: { Origin: target.allowedOrigin },
  });
  const received = Buffer.from(await getResponse.arrayBuffer());
  const get = corsView(getResponse);
  checks.add(
    `[${target.name}] GET assinado com a origem permitida`,
    '200, mesmo conteúdo, mesmo ETag do PUT e ETag exposto',
    `${show(get)} conteúdo igual: ${received.equals(body)}`,
    get.status === 200 &&
      received.equals(body) &&
      get.etag === put.etag &&
      get.allowOrigin === target.allowedOrigin &&
      exposesEtag(get.exposeHeaders),
  );
  const foreignResponse = await fetch(getUrl, {
    headers: { Origin: FOREIGN_ORIGIN },
  });
  await foreignResponse.arrayBuffer();
  const foreign = corsView(foreignResponse);
  checks.add(
    `[${target.name}] GET assinado com origem estranha`,
    'sem Access-Control-Allow-Origin (o navegador não entrega a resposta ao script)',
    show(foreign),
    foreign.allowOrigin === null,
  );

  await target.client.send(
    new DeleteObjectCommand({ Bucket: target.bucket, Key: key }),
  );
  console.log(`RESUMO cors-iso: ${checks.summary()}`);
  return checks.allPassed;
}

interface TrackedUpload {
  label: string;
  plan: string;
  key: string;
  uploadId: string;
  createdAt: number;
  initiated?: Date;
  partTimes: number[];
  lastSeenAt: number;
  goneAt?: number;
}

async function isGone(target: Target, upload: TrackedUpload): Promise<boolean> {
  try {
    await target.client.send(
      new ListPartsCommand({
        Bucket: target.bucket,
        Key: upload.key,
        UploadId: upload.uploadId,
      }),
    );
    return false;
  } catch (error) {
    if (errorName(error) === 'NoSuchUpload') {
      return true;
    }
    throw error;
  }
}

async function uploadPart(
  target: Target,
  upload: TrackedUpload,
  partNumber: number,
) {
  await target.client.send(
    new UploadPartCommand({
      Bucket: target.bucket,
      Key: upload.key,
      UploadId: upload.uploadId,
      PartNumber: partNumber,
      Body: Buffer.alloc(1024, partNumber),
    }),
  );
  upload.partTimes.push(Date.now());
}

async function listedUploadIds(target: Target, key: string): Promise<string[]> {
  // O MinIO exige a chave exata como prefixo em ListMultipartUploads.
  const page = await target.client.send(
    new ListMultipartUploadsCommand({ Bucket: target.bucket, Prefix: key }),
  );
  return (page.Uploads ?? []).map((upload) => upload.UploadId ?? '');
}

async function stale(runId: string): Promise<boolean> {
  const target = isolatedTarget();
  const expiry = Number(requireKey(process.env, 'V01_EXPIRY_SECONDS'));
  const interval = Number(requireKey(process.env, 'V01_INTERVAL_SECONDS'));
  const slack = 15;
  const pollMs = 2000;
  const t0 = Date.now();
  const rel = (at: number | undefined): string =>
    at === undefined ? '—' : `${((at - t0) / 1000).toFixed(1)}s`;
  console.log(
    `stale: expiração ${expiry}s, intervalo de limpeza ${interval}s, folga ${slack}s, consulta a cada ${pollMs / 1000}s; t0=${new Date(t0).toISOString()}`,
  );

  const plans: Array<[string, string]> = [
    ['A', 'criado com a parte 1 em t0; nenhuma parte depois'],
    [
      'B',
      `criado com a parte 1 em t0; parte 2 em ${(0.6 * expiry).toFixed(0)}s`,
    ],
    ['C', 'criado em t0, sem partes'],
  ];
  const uploads: TrackedUpload[] = [];
  for (const [label, plan] of plans) {
    const key = `stale/v01-${runId}-${label}.bin`;
    const created = await target.client.send(
      new CreateMultipartUploadCommand({ Bucket: target.bucket, Key: key }),
    );
    const now = Date.now();
    uploads.push({
      label,
      plan,
      key,
      uploadId: created.UploadId ?? '',
      createdAt: now,
      partTimes: [],
      lastSeenAt: now,
    });
  }
  for (const upload of uploads) {
    const page = await target.client.send(
      new ListMultipartUploadsCommand({
        Bucket: target.bucket,
        Prefix: upload.key,
      }),
    );
    upload.initiated = page.Uploads?.find(
      (u) => u.UploadId === upload.uploadId,
    )?.Initiated;
  }
  const [a, b] = uploads;
  await uploadPart(target, a, 1);
  await uploadPart(target, b, 1);

  const deadline = t0 + (2 * expiry + 3 * interval + 30) * 1000;
  while (uploads.some((u) => u.goneAt === undefined) && Date.now() < deadline) {
    const now = Date.now();
    if (
      b.goneAt === undefined &&
      b.partTimes.length === 1 &&
      now - b.createdAt >= 0.6 * expiry * 1000
    ) {
      try {
        await uploadPart(target, b, 2);
        console.log(`B: parte 2 enviada em ${rel(b.partTimes[1])}`);
      } catch (error) {
        console.log(
          `B: parte 2 recusada em ${rel(Date.now())}: ${errorName(error)}`,
        );
      }
    }
    for (const upload of uploads.filter((u) => u.goneAt === undefined)) {
      const at = Date.now();
      if (await isGone(target, upload)) {
        upload.goneAt = at;
        console.log(
          `${upload.label}: ausente (NoSuchUpload) em ${rel(at)}; visto pela última vez em ${rel(upload.lastSeenAt)}`,
        );
      } else {
        upload.lastSeenAt = at;
      }
    }
    await sleep(pollMs);
  }

  console.log(
    '\nupload | plano | criado | Initiated (servidor) | partes | visto por último | ausente em | idade desde a criação | idade desde a última parte',
  );
  for (const u of uploads) {
    const lastActivity = u.partTimes.at(-1) ?? u.createdAt;
    const ageCreate =
      u.goneAt === undefined
        ? '—'
        : `${((u.goneAt - u.createdAt) / 1000).toFixed(1)}s`;
    const ageLast =
      u.goneAt === undefined
        ? '—'
        : `${((u.goneAt - lastActivity) / 1000).toFixed(1)}s`;
    console.log(
      `${u.label} | ${u.plan} | ${rel(u.createdAt)} | ${u.initiated?.toISOString() ?? '—'} | ${u.partTimes.map(rel).join(', ') || '—'} | ${rel(u.lastSeenAt)} | ${rel(u.goneAt)} | ${ageCreate} | ${ageLast}`,
    );
  }

  const checks = new Checks();
  const inWindow = (from: number, at: number | undefined): boolean =>
    at !== undefined &&
    at - from >= expiry * 1000 &&
    at - from <= (expiry + interval + slack) * 1000;

  for (const u of uploads) {
    const stillThereBeforeExpiry =
      u.lastSeenAt - u.createdAt >= (expiry - pollMs / 1000 - 1) * 1000;
    checks.add(
      `upload ${u.label}: presente até perto do prazo`,
      `visto por último ≥ ${expiry - pollMs / 1000 - 1}s após a criação (nada some antes de ${expiry}s)`,
      `visto por último ${((u.lastSeenAt - u.createdAt) / 1000).toFixed(1)}s após a criação`,
      stillThereBeforeExpiry,
    );
  }
  for (const u of [uploads[0], uploads[2]]) {
    checks.add(
      `upload ${u.label}: removido pela limpeza do storage`,
      `ausente entre ${expiry}s e ${expiry + interval + slack}s após a criação`,
      u.goneAt === undefined
        ? 'não foi removido até o prazo da prova'
        : `${((u.goneAt - u.createdAt) / 1000).toFixed(1)}s`,
      inWindow(u.createdAt, u.goneAt),
    );
  }

  const bLast = b.partTimes.at(-1) ?? b.createdAt;
  const byCreation =
    inWindow(b.createdAt, b.goneAt) && b.partTimes.length === 2;
  const byLastPart = inWindow(bLast, b.goneAt) && b.partTimes.length === 2;
  const rule = byCreation
    ? 'criação'
    : byLastPart
      ? 'última parte'
      : 'inconclusiva';
  checks.add(
    'upload B: regra de contagem da idade',
    'remoção compatível com uma única regra (criação ou última parte), com a parte 2 aceita antes do prazo',
    `parte 2 em ${rel(b.partTimes[1])}; ausente ${b.goneAt === undefined ? 'nunca' : `${((b.goneAt - b.createdAt) / 1000).toFixed(1)}s após a criação e ${((b.goneAt - bLast) / 1000).toFixed(1)}s após a última parte`} → regra: ${rule}`,
    byCreation !== byLastPart,
  );

  for (const u of uploads) {
    const ids = await listedUploadIds(target, u.key);
    checks.add(
      `upload ${u.label}: ausência confirmada por ListMultipartUploads`,
      'uploadId fora da listagem',
      `${ids.includes(u.uploadId) ? 'presente' : 'ausente'} (${ids.length} uploads com a chave)`,
      !ids.includes(u.uploadId),
    );
    if (ids.includes(u.uploadId)) {
      await target.client.send(
        new AbortMultipartUploadCommand({
          Bucket: target.bucket,
          Key: u.key,
          UploadId: u.uploadId,
        }),
      );
    }
  }
  console.log(`REGRA OBSERVADA: ${rule}`);
  console.log(`RESUMO stale: ${checks.summary()}`);
  return checks.allPassed;
}

async function snapshot(): Promise<boolean> {
  const env = readProjectEnv();
  const result = await snapshotBucket(
    appClient(env, 'S3_ENDPOINT'),
    requireKey(env, 'S3_BUCKET'),
  );
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
    'cors-main': () => corsMain(needsRun()),
    'cors-iso': () => corsIsolated(needsRun()),
    stale: () => stale(needsRun()),
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

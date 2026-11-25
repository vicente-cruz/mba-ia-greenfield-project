// V-10 — repetição do Complete, chaves exclusivas por sessão e guardas opcionais
// (phase-03-videos/TD-02, AMB-4). Roda dentro do container `nestjs-api`, chamado por
// `storage-proof-roteiro.sh v10`.
//
// Subcomandos: run <runId> | cleanup <runId> | snapshot (ver proof-support.ts).
// Usa a credencial da aplicação e o bucket do `.env`. As chaves seguem o formato da TD-02,
// `originals/{videoId}/{sessionId}`, sob o prefixo temporário `proofs/v10-<runId>/`.
//
// Obrigatórios (Checks): segundo Complete → NoSuchUpload; HeadObject confirma o objeto da chave
// da sessão; sessões concluídas fora de ordem não se sobrescrevem; upload abortado → NoSuchUpload
// sem objeto. Opcionais (informativos): suporte a `If-None-Match: *` e a `x-amz-mp-object-size`,
// cada um com um caso positivo e um negativo. A prova registra só o suporte: a revisão de 2026-11-18
// decidiu que a P2 não usa nenhum dos dois guardas nesta fase.
import { createHash, randomBytes } from 'node:crypto';
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  type CompleteMultipartUploadCommandInput,
  type CompletedPart,
  CreateMultipartUploadCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListPartsCommand,
  S3Client,
  UploadPartCommand,
} from '@aws-sdk/client-s3';
import {
  appClient,
  Checks,
  cleanupPrefix,
  readProjectEnv,
  requireKey,
  runProofCli,
  sdkError,
  sha256Base64,
  unquote,
} from './proof-support';

const BODY_SIZE = 1024 * 1024;
const SESSIONS = 8;

function keys(runId: string) {
  const prefix = `proofs/v10-${runId}/`;
  const videoId = `video-${runId}`;
  const session = (n: number): string =>
    `${prefix}originals/${videoId}/session-${n}`;
  return {
    prefix,
    session,
    all: Array.from({ length: SESSIONS }, (_, i) => session(i + 1)),
  };
}

function context() {
  const env = readProjectEnv();
  return {
    client: appClient(env, 'S3_ENDPOINT'),
    bucket: requireKey(env, 'S3_BUCKET'),
  };
}

export interface Upload {
  key: string;
  uploadId: string;
  body: Buffer;
  parts: CompletedPart[];
}

/** Abre o multipart como a P1 (ChecksumAlgorithm SHA256) e envia uma parte com checksum. */
async function openUpload(
  client: S3Client,
  bucket: string,
  key: string,
): Promise<Upload> {
  const body = randomBytes(BODY_SIZE);
  const created = await client.send(
    new CreateMultipartUploadCommand({
      Bucket: bucket,
      Key: key,
      ChecksumAlgorithm: 'SHA256',
    }),
  );
  const uploadId = created.UploadId ?? '';
  const checksum = sha256Base64(body);
  const part = await client.send(
    new UploadPartCommand({
      Bucket: bucket,
      Key: key,
      UploadId: uploadId,
      PartNumber: 1,
      Body: body,
      ChecksumSHA256: checksum,
    }),
  );
  return {
    key,
    uploadId,
    body,
    parts: [{ PartNumber: 1, ETag: part.ETag, ChecksumSHA256: checksum }],
  };
}

export interface Outcome {
  ok: boolean;
  status: number;
  name: string;
  etag: string;
  text: string;
}

export async function complete(
  client: S3Client,
  bucket: string,
  upload: Upload,
  guards: Pick<
    CompleteMultipartUploadCommandInput,
    'IfNoneMatch' | 'MpuObjectSize'
  > = {},
): Promise<Outcome> {
  try {
    const done = await client.send(
      new CompleteMultipartUploadCommand({
        Bucket: bucket,
        Key: upload.key,
        UploadId: upload.uploadId,
        MultipartUpload: { Parts: upload.parts },
        ...guards,
      }),
    );
    const etag = unquote(done.ETag);
    return {
      ok: true,
      status: 200,
      name: 'OK',
      etag,
      text: `200, ETag ${etag}`,
    };
  } catch (error) {
    const e = sdkError(error);
    return {
      ok: false,
      status: e.status,
      name: e.name,
      etag: '',
      text: `HTTP ${e.status} ${e.name} (${e.message})`,
    };
  }
}

export interface Head {
  exists: boolean;
  size?: number;
  etag?: string;
  lastModified?: number;
  text: string;
}

export async function head(
  client: S3Client,
  bucket: string,
  key: string,
): Promise<Head> {
  try {
    const h = await client.send(
      new HeadObjectCommand({ Bucket: bucket, Key: key }),
    );
    return {
      exists: true,
      size: h.ContentLength,
      etag: unquote(h.ETag),
      lastModified: h.LastModified?.getTime(),
      text: `presente, ${h.ContentLength} bytes, ETag ${unquote(h.ETag)}, ${h.LastModified?.toISOString()}`,
    };
  } catch (error) {
    if (isMissingObject(error)) {
      return { exists: false, text: 'ausente (HTTP 404 NotFound, NoSuchKey)' };
    }
    throw error;
  }
}

/**
 * Só um 404 de objeto inexistente conta como ausência. O HEAD não tem corpo; o Silo informa o
 * motivo em `x-minio-error-code`, que precisa ser `NoSuchKey` quando presente (um 404 de bucket
 * inexistente, por exemplo, não é ausência do objeto). Acesso negado, erro do servidor, timeout
 * e falha de rede são propagados, para nunca virarem aprovação por ausência.
 */
function isMissingObject(error: unknown): boolean {
  const e = sdkError(error);
  const storageCode = (
    error as { $response?: { headers?: Record<string, string | undefined> } }
  ).$response?.headers?.['x-minio-error-code'];
  return (
    e.status === 404 &&
    (e.name === 'NotFound' || e.name === 'NoSuchKey') &&
    (storageCode === undefined || storageCode === 'NoSuchKey')
  );
}

/** `NoSuchUpload` confirmado: HTTP 404 com esse código, e nada além disso. */
export const isNoSuchUpload = (
  outcome: Pick<Outcome, 'ok' | 'status' | 'name'>,
): boolean =>
  !outcome.ok && outcome.status === 404 && outcome.name === 'NoSuchUpload';

async function contentSha(
  client: S3Client,
  bucket: string,
  key: string,
): Promise<string> {
  const object = await client.send(
    new GetObjectCommand({ Bucket: bucket, Key: key }),
  );
  const bytes = (await object.Body?.transformToByteArray()) ?? new Uint8Array();
  return createHash('sha256').update(bytes).digest('hex');
}

const sha = (body: Buffer): string =>
  createHash('sha256').update(body).digest('hex');

export async function uploadStillOpen(
  client: S3Client,
  bucket: string,
  upload: Upload,
): Promise<string> {
  try {
    const page = await client.send(
      new ListPartsCommand({
        Bucket: bucket,
        Key: upload.key,
        UploadId: upload.uploadId,
      }),
    );
    return `aberto (${page.Parts?.length ?? 0} parte)`;
  } catch (error) {
    const e = sdkError(error);
    if (isNoSuchUpload({ ok: false, status: e.status, name: e.name })) {
      return 'encerrado (HTTP 404 NoSuchUpload)';
    }
    throw error;
  }
}

async function run(runId: string): Promise<boolean> {
  const { client, bucket } = context();
  const k = keys(runId);
  const checks = new Checks();
  console.log(`chaves das sessões: ${k.session(1)} … ${k.session(SESSIONS)}`);

  // 1. Repetição do Complete depois do sucesso (G-03, F-01).
  const s1 = await openUpload(client, bucket, k.session(1));
  const first = await complete(client, bucket, s1);
  const second = await complete(client, bucket, s1);
  const h1 = await head(client, bucket, s1.key);
  checks.add('Primeiro Complete da sessão 1', '200', first.text, first.ok);
  checks.add(
    'Segundo Complete da sessão 1, depois do sucesso',
    '404 NoSuchUpload',
    second.text,
    isNoSuchUpload(second),
  );
  checks.add(
    'HeadObject na chave da sessão 1 depois do NoSuchUpload (recuperação da P2)',
    `presente, ${BODY_SIZE} bytes, ETag do primeiro Complete`,
    h1.text,
    h1.exists && h1.size === BODY_SIZE && h1.etag === first.etag,
  );

  // 2. Duas sessões do mesmo vídeo, concluídas fora de ordem (AMB-4).
  const s2 = await openUpload(client, bucket, k.session(2));
  const s3 = await openUpload(client, bucket, k.session(3));
  const c3 = await complete(client, bucket, s3);
  const h3Before = await head(client, bucket, s3.key);
  const c2 = await complete(client, bucket, s2);
  const h2 = await head(client, bucket, s2.key);
  const h3After = await head(client, bucket, s3.key);
  const sha2 = await contentSha(client, bucket, s2.key);
  const sha3 = await contentSha(client, bucket, s3.key);
  checks.add(
    'Sessões 2 e 3 do mesmo vídeo: a 3 conclui antes, a 2 depois',
    'os dois Complete com 200',
    `sessão 3: ${c3.text}; sessão 2 (atrasada): ${c2.text}`,
    c3.ok && c2.ok,
  );
  checks.add(
    'A conclusão atrasada da sessão 2 não altera o objeto da sessão 3',
    'HeadObject da sessão 3 igual antes e depois; conteúdo igual ao corpo da sessão 3',
    `antes: ${h3Before.text}; depois: ${h3After.text}; SHA-256 ${sha3 === sha(s3.body) ? 'igual' : 'diferente'} ao corpo da sessão 3`,
    h3Before.exists &&
      h3After.etag === h3Before.etag &&
      h3After.lastModified === h3Before.lastModified &&
      sha3 === sha(s3.body),
  );
  checks.add(
    'A sessão 2 grava só na própria chave',
    `presente, ${BODY_SIZE} bytes, conteúdo igual ao corpo da sessão 2`,
    `${h2.text}; SHA-256 ${sha2 === sha(s2.body) ? 'igual' : 'diferente'} ao corpo da sessão 2`,
    h2.exists &&
      h2.size === BODY_SIZE &&
      h2.etag === c2.etag &&
      sha2 === sha(s2.body),
  );

  // 3. Upload abortado: Complete → NoSuchUpload e nenhum objeto na chave (sessão expirada na P2).
  const s4 = await openUpload(client, bucket, k.session(4));
  await client.send(
    new AbortMultipartUploadCommand({
      Bucket: bucket,
      Key: s4.key,
      UploadId: s4.uploadId,
    }),
  );
  const c4 = await complete(client, bucket, s4);
  const h4 = await head(client, bucket, s4.key);
  checks.add(
    'Complete de uma sessão abortada e o HeadObject da chave dela',
    'HTTP 404 NoSuchUpload; HeadObject ausente (404 de objeto inexistente)',
    `Complete: ${c4.text}; HeadObject: ${h4.text}`,
    isNoSuchUpload(c4) && !h4.exists,
  );

  // 4. Guarda opcional If-None-Match: * no Complete.
  const s5 = await openUpload(client, bucket, k.session(5));
  const positiveINM = await complete(client, bucket, s5, { IfNoneMatch: '*' });
  const h5Before = await head(client, bucket, s5.key);
  const s6 = await openUpload(client, bucket, k.session(5)); // de propósito, mesma chave
  const negativeINM = await complete(client, bucket, s6, { IfNoneMatch: '*' });
  const h5After = await head(client, bucket, s5.key);
  const overwritten = h5After.etag !== h5Before.etag;
  const inmSupported =
    positiveINM.ok &&
    !negativeINM.ok &&
    negativeINM.status === 412 &&
    !overwritten;
  checks.info('If-None-Match: * numa chave nova (positivo)', positiveINM.text);
  // Se a P2 usar o guarda, a repetição do Complete depois do sucesso também leva o header.
  const repeatINM = await complete(client, bucket, s5, { IfNoneMatch: '*' });
  checks.info(
    'Repetição do Complete com If-None-Match: * depois do sucesso',
    `${repeatINM.text} (se a P2 adotasse o guarda, teria de tratar esta resposta como o NoSuchUpload)`,
  );
  checks.info(
    'If-None-Match: * numa chave que já existe (negativo)',
    `${negativeINM.text}; objeto ${overwritten ? 'SOBRESCRITO' : 'preservado'} (antes ${h5Before.etag}, depois ${h5After.etag}); upload ${await uploadStillOpen(client, bucket, s6)}`,
  );
  console.log(
    `GUARDA If-None-Match: ${inmSupported ? 'suportado' : 'não suportado'} (positivo ${positiveINM.ok ? '200' : positiveINM.name}; negativo ${negativeINM.ok ? '200' : `${negativeINM.status} ${negativeINM.name}`})`,
  );

  // 5. Guarda opcional x-amz-mp-object-size no Complete.
  const s7 = await openUpload(client, bucket, k.session(7));
  const positiveSize = await complete(client, bucket, s7, {
    MpuObjectSize: BODY_SIZE,
  });
  const s8 = await openUpload(client, bucket, k.session(8));
  const negativeSize = await complete(client, bucket, s8, {
    MpuObjectSize: BODY_SIZE + 1,
  });
  const h8 = await head(client, bucket, s8.key);
  const sizeSupported =
    positiveSize.ok &&
    !negativeSize.ok &&
    negativeSize.status === 400 &&
    !h8.exists;
  checks.info(
    'x-amz-mp-object-size igual ao tamanho real (positivo)',
    positiveSize.text,
  );
  checks.info(
    'x-amz-mp-object-size com 1 byte a mais (negativo)',
    `${negativeSize.text}; HeadObject: ${h8.text}; upload ${await uploadStillOpen(client, bucket, s8)}`,
  );
  console.log(
    `GUARDA x-amz-mp-object-size: ${sizeSupported ? 'suportado' : 'não suportado'} (positivo ${positiveSize.ok ? '200' : positiveSize.name}; negativo ${negativeSize.ok ? '200' : `${negativeSize.status} ${negativeSize.name}`})`,
  );
  console.log(
    `P2 NESTA FASE (revisão de 2026-11-18): sem If-None-Match e sem x-amz-mp-object-size; suporte observado: If-None-Match ${inmSupported ? 'sim' : 'não'}, x-amz-mp-object-size ${sizeSupported ? 'sim' : 'não'}`,
  );

  console.log(`RESUMO run (obrigatórios): ${checks.summary()}`);
  return checks.allPassed;
}

async function cleanup(runId: string): Promise<boolean> {
  const { client, bucket } = context();
  const k = keys(runId);
  return cleanupPrefix(client, bucket, k.prefix, k.all);
}

// Só como script; importado (por exemplo, num teste com falhas controladas), não executa nada.
if (require.main === module) {
  runProofCli({ run, cleanup });
}

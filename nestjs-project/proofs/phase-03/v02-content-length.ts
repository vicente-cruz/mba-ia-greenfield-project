// V-02 — UploadPart pré-assinado com `content-length` assinado (phase-03-videos/TD-03).
// Roda dentro do container `nestjs-api`, chamado por `storage-proof-roteiro.sh v02`.
//
// Subcomandos: run <runId> | cleanup <runId> | snapshot (ver proof-support.ts).
// Usa a credencial da aplicação e o bucket do `.env`, sob o prefixo `proofs/v02-<runId>/`.
// As URLs são assinadas para o endpoint interno (S3_ENDPOINT); o caminho do navegador é a V-08.
import { randomBytes } from 'node:crypto';
import {
  CreateMultipartUploadCommand,
  ListPartsCommand,
  type Part,
  S3Client,
  UploadPartCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import {
  appClient,
  Checks,
  cleanupPrefix,
  describeResponse,
  md5Hex,
  rawPut,
  readProjectEnv,
  requireKey,
  runProofCli,
  unquote,
} from './proof-support';

const PART_SIZE = 1_048_576;
const EXPIRES_IN = 300;

function keys(runId: string) {
  const prefix = `proofs/v02-${runId}/`;
  return { prefix, multipart: `${prefix}multipart.bin` };
}

function context() {
  const env = readProjectEnv();
  return {
    client: appClient(env, 'S3_ENDPOINT'),
    bucket: requireKey(env, 'S3_BUCKET'),
  };
}

/** Assina o UploadPart com o `content-length` exato entre os headers assinados (TD-03, Option A). */
function presignPart(
  client: S3Client,
  bucket: string,
  key: string,
  uploadId: string,
  partNumber: number,
  size: number,
): Promise<string> {
  return getSignedUrl(
    client,
    new UploadPartCommand({
      Bucket: bucket,
      Key: key,
      UploadId: uploadId,
      PartNumber: partNumber,
      ContentLength: size,
    }),
    { expiresIn: EXPIRES_IN, signableHeaders: new Set(['content-length']) },
  );
}

async function listParts(
  client: S3Client,
  bucket: string,
  key: string,
  uploadId: string,
) {
  const page = await client.send(
    new ListPartsCommand({ Bucket: bucket, Key: key, UploadId: uploadId }),
  );
  return page.Parts ?? [];
}

const describeParts = (parts: Part[]): string =>
  parts.length === 0
    ? 'nenhuma parte'
    : parts
        .map(
          (p) =>
            `parte ${p.PartNumber}: ${p.Size} bytes, ETag ${unquote(p.ETag)}, ${p.LastModified?.toISOString()}`,
        )
        .join('; ');

const rejected = (status: number): boolean => status >= 400 && status < 500;

async function run(runId: string): Promise<boolean> {
  const { client, bucket } = context();
  const k = keys(runId);
  const checks = new Checks();
  const created = await client.send(
    new CreateMultipartUploadCommand({ Bucket: bucket, Key: k.multipart }),
  );
  const uploadId = created.UploadId ?? '';
  const parts = () => listParts(client, bucket, k.multipart, uploadId);

  const url1 = await presignPart(
    client,
    bucket,
    k.multipart,
    uploadId,
    1,
    PART_SIZE,
  );
  const query = new URL(url1).searchParams;
  const signed = (query.get('X-Amz-SignedHeaders') ?? '').split(';');
  const names = [...query.keys()];
  console.log(
    `URL parte 1 (sem a assinatura): ${url1.replace(/X-Amz-Signature=[0-9a-f]+/, 'X-Amz-Signature=…')}`,
  );
  checks.add(
    'URL de UploadPart com content-length assinado',
    'X-Amz-SignedHeaders com content-length e host; nenhum parâmetro de checksum na query',
    `SignedHeaders=${signed.join(';')}; parâmetros=${names.join(',')}`,
    signed.includes('content-length') &&
      signed.includes('host') &&
      !names.some((name) => /^x-amz-(checksum-|sdk-checksum)/i.test(name)),
  );

  const exact = randomBytes(PART_SIZE);
  const larger = randomBytes(PART_SIZE + 1);
  const smaller = randomBytes(PART_SIZE - 1);

  const r1 = await rawPut(url1, larger);
  const after1 = await parts();
  checks.add(
    `Parte nova com corpo maior (${PART_SIZE + 1} bytes; assinado ${PART_SIZE})`,
    'recusa 4xx e a parte 1 ausente do ListParts',
    `${describeResponse(r1)}; ListParts: ${describeParts(after1)}`,
    rejected(r1.status) && after1.length === 0,
  );

  const r2 = await rawPut(url1, smaller);
  const after2 = await parts();
  checks.add(
    `Parte nova com corpo menor (${PART_SIZE - 1} bytes; assinado ${PART_SIZE})`,
    'recusa 4xx e a parte 1 ausente do ListParts',
    `${describeResponse(r2)}; ListParts: ${describeParts(after2)}`,
    rejected(r2.status) && after2.length === 0,
  );

  const r3 = await rawPut(url1, exact);
  const after3 = await parts();
  const stored = after3.find((p) => p.PartNumber === 1);
  checks.add(
    `Parte com o tamanho assinado (${PART_SIZE} bytes)`,
    '200; ListParts com a parte 1 de N bytes e ETag igual ao MD5 do corpo enviado',
    `${describeResponse(r3)}; MD5 do corpo ${md5Hex(exact)}; ListParts: ${describeParts(after3)}`,
    r3.status === 200 &&
      unquote(r3.headers.etag) === md5Hex(exact) &&
      stored?.Size === PART_SIZE &&
      unquote(stored?.ETag) === md5Hex(exact),
  );

  const sameAsStored = (list: Part[]): boolean => {
    const part = list.find((p) => p.PartNumber === 1);
    return (
      list.length === 1 &&
      part?.Size === stored?.Size &&
      part?.ETag === stored?.ETag &&
      part?.LastModified?.getTime() === stored?.LastModified?.getTime()
    );
  };
  const r4 = await rawPut(url1, larger);
  const after4 = await parts();
  checks.add(
    'Reenvio da parte 1 já gravada, com corpo maior',
    'recusa 4xx; a parte 1 continua com o mesmo tamanho, ETag e data',
    `${describeResponse(r4)}; ListParts: ${describeParts(after4)}`,
    rejected(r4.status) && sameAsStored(after4),
  );

  const r5 = await rawPut(url1, smaller);
  const after5 = await parts();
  checks.add(
    'Reenvio da parte 1 já gravada, com corpo menor',
    'recusa 4xx; a parte 1 continua com o mesmo tamanho, ETag e data',
    `${describeResponse(r5)}; ListParts: ${describeParts(after5)}`,
    rejected(r5.status) && sameAsStored(after5),
  );

  // Complementar (o caso do navegador é a V-08 c): corpo em stream, sem Content-Length.
  const url2 = await presignPart(
    client,
    bucket,
    k.multipart,
    uploadId,
    2,
    PART_SIZE,
  );
  const r6 = await rawPut(url2, randomBytes(PART_SIZE), { chunked: true });
  const after6 = await parts();
  checks.add(
    'Parte 2 com o tamanho certo, mas em stream (Transfer-Encoding: chunked, sem Content-Length)',
    'recusa 4xx e a parte 2 ausente do ListParts',
    `${describeResponse(r6)}; ListParts: ${describeParts(after6)}`,
    rejected(r6.status) && !after6.some((p) => p.PartNumber === 2),
  );

  const final = await parts();
  checks.add(
    'ListParts no fim',
    `só a parte 1, com ${PART_SIZE} bytes`,
    describeParts(final),
    final.length === 1 &&
      final[0].PartNumber === 1 &&
      final[0].Size === PART_SIZE,
  );
  console.log(`RESUMO run: ${checks.summary()}`);
  return checks.allPassed;
}

async function cleanup(runId: string): Promise<boolean> {
  const { client, bucket } = context();
  const k = keys(runId);
  return cleanupPrefix(client, bucket, k.prefix, [k.multipart]);
}

runProofCli({ run, cleanup });

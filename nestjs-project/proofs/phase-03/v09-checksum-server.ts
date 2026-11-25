// V-09, parte de servidor — checksum SHA-256 por parte como header assinado, com WHEN_REQUIRED
// (phase-03-videos/TD-02, TD-07). A parte de navegador é a SI-03.5.
// Roda dentro do container `nestjs-api`, chamado por `storage-proof-roteiro.sh v09`.
//
// Subcomandos: run <runId> | cleanup <runId> | snapshot (ver proof-support.ts).
// Usa a credencial da aplicação e o bucket do `.env`, sob o prefixo `proofs/v09-<runId>/`.
// As URLs são assinadas para o endpoint interno (S3_ENDPOINT); o caminho do navegador é a SI-03.5.
import { createHash, randomBytes } from 'node:crypto';
import {
  CompleteMultipartUploadCommand,
  type CompletedPart,
  CreateMultipartUploadCommand,
  GetObjectCommand,
  HeadObjectCommand,
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
  rawPut,
  readProjectEnv,
  requireKey,
  runProofCli,
  sdkError,
  sha256Base64,
  unquote,
} from './proof-support';

const PART1_SIZE = 5 * 1024 * 1024; // mínimo da S3 para partes que não são a última
const PART2_SIZE = 1024 * 1024;
const EXPIRES_IN = 300;
const CHECKSUM_HEADER = 'x-amz-checksum-sha256';

function keys(runId: string) {
  const prefix = `proofs/v09-${runId}/`;
  return {
    prefix,
    main: `${prefix}multipart.bin`,
    withoutChecksums: `${prefix}complete-sem-checksums.bin`,
    queryControl: `${prefix}controle-checksum-na-query.bin`,
  };
}

function context() {
  const env = readProjectEnv();
  return {
    client: appClient(env, 'S3_ENDPOINT'),
    bucket: requireKey(env, 'S3_BUCKET'),
  };
}

/**
 * Assina o UploadPart como a SI-03.9 prevê: `content-length` em `signableHeaders` e o checksum
 * em `unhoistableHeaders`, que o mantém como header assinado em vez de parâmetro da query.
 * Com `hoistChecksum`, o checksum fica com o comportamento padrão do presigner (vai para a query).
 */
function presignPart(
  client: S3Client,
  bucket: string,
  key: string,
  uploadId: string,
  partNumber: number,
  body: Buffer,
  hoistChecksum = false,
): Promise<string> {
  return getSignedUrl(
    client,
    new UploadPartCommand({
      Bucket: bucket,
      Key: key,
      UploadId: uploadId,
      PartNumber: partNumber,
      ContentLength: body.length,
      ChecksumSHA256: sha256Base64(body),
    }),
    {
      expiresIn: EXPIRES_IN,
      signableHeaders: new Set(['content-length']),
      ...(hoistChecksum
        ? {}
        : { unhoistableHeaders: new Set([CHECKSUM_HEADER]) }),
    },
  );
}

async function createUpload(client: S3Client, bucket: string, key: string) {
  const created = await client.send(
    new CreateMultipartUploadCommand({
      Bucket: bucket,
      Key: key,
      ChecksumAlgorithm: 'SHA256',
    }),
  );
  return created;
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
            `parte ${p.PartNumber}: ${p.Size} bytes, ETag ${unquote(p.ETag)}, ChecksumSHA256 ${p.ChecksumSHA256 ?? '—'}`,
        )
        .join('; ');

/** Checksum composto da S3 para multipart: SHA-256 da concatenação dos digests das partes, com "-N". */
function compositeChecksum(bodies: Buffer[]): string {
  const digests = bodies.map((b) => createHash('sha256').update(b).digest());
  return `${createHash('sha256').update(Buffer.concat(digests)).digest('base64')}-${bodies.length}`;
}

async function tryComplete(
  client: S3Client,
  bucket: string,
  key: string,
  uploadId: string,
  parts: CompletedPart[],
): Promise<{ accepted: boolean; status: number; text: string }> {
  try {
    const done = await client.send(
      new CompleteMultipartUploadCommand({
        Bucket: bucket,
        Key: key,
        UploadId: uploadId,
        MultipartUpload: { Parts: parts },
      }),
    );
    return {
      accepted: true,
      status: 200,
      text: `aceito (200): ETag ${unquote(done.ETag)}, ChecksumSHA256 ${done.ChecksumSHA256 ?? '—'}, ChecksumType ${done.ChecksumType ?? '—'}`,
    };
  } catch (error) {
    const e = sdkError(error);
    return {
      accepted: false,
      status: e.status,
      text: `recusado: HTTP ${e.status} ${e.name} (${e.message})`,
    };
  }
}

/** Códigos de recusa por checksum divergente: `BadDigest` na AWS; o Silo usa outro código. */
const CHECKSUM_MISMATCH_CODES = ['BadDigest', 'XAmzContentChecksumMismatch'];

async function run(runId: string): Promise<boolean> {
  const { client, bucket } = context();
  const k = keys(runId);
  const checks = new Checks();
  const body1 = randomBytes(PART1_SIZE);
  const body2 = randomBytes(PART2_SIZE);
  const divergent2 = Buffer.from(body2);
  divergent2[0] ^= 0xff; // mesmo tamanho, conteúdo diferente
  const sha1 = sha256Base64(body1);
  const sha2 = sha256Base64(body2);

  const created = await createUpload(client, bucket, k.main);
  const uploadId = created.UploadId ?? '';
  checks.info(
    'CreateMultipartUpload com ChecksumAlgorithm SHA256',
    `ChecksumAlgorithm ${created.ChecksumAlgorithm ?? '—'}, ChecksumType ${created.ChecksumType ?? '—'}`,
  );
  const parts = () => listParts(client, bucket, k.main, uploadId);

  const url1 = await presignPart(client, bucket, k.main, uploadId, 1, body1);
  const url2 = await presignPart(client, bucket, k.main, uploadId, 2, body2);
  const query = new URL(url2).searchParams;
  const names = [...query.keys()];
  const signed = (query.get('X-Amz-SignedHeaders') ?? '').split(';');
  console.log(
    `URL parte 2 (sem a assinatura): ${url2.replace(/X-Amz-Signature=[0-9a-f]+/, 'X-Amz-Signature=…')}`,
  );
  checks.add(
    'URL de UploadPart com WHEN_REQUIRED e checksum em unhoistableHeaders',
    `nenhum parâmetro x-amz-checksum-* na query; ${CHECKSUM_HEADER}, content-length e host em X-Amz-SignedHeaders`,
    `parâmetros=${names.join(',')}; SignedHeaders=${signed.join(';')}`,
    !names.some((name) => /^x-amz-checksum-/i.test(name)) &&
      [CHECKSUM_HEADER, 'content-length', 'host'].every((h) =>
        signed.includes(h),
      ),
  );
  checks.info(
    'x-amz-sdk-checksum-algorithm na query',
    names.includes('x-amz-sdk-checksum-algorithm')
      ? `presente (${query.get('x-amz-sdk-checksum-algorithm')})`
      : 'ausente',
  );

  const r1 = await rawPut(url1, body1, {
    headers: { [CHECKSUM_HEADER]: sha1 },
  });
  checks.add(
    'Parte 1 com corpo e checksum corretos',
    `200, com ${CHECKSUM_HEADER} da resposta igual ao declarado`,
    `${describeResponse(r1)}; ${CHECKSUM_HEADER} na resposta: ${String(r1.headers[CHECKSUM_HEADER] ?? '—')}`,
    r1.status === 200 && r1.headers[CHECKSUM_HEADER] === sha1,
  );

  const r2 = await rawPut(url2, divergent2, {
    headers: { [CHECKSUM_HEADER]: sha2 },
  });
  const after2 = await parts();
  checks.add(
    'Parte 2 com corpo divergente (mesmo tamanho) e o checksum assinado',
    `400 por checksum divergente depois de receber o corpo (${CHECKSUM_MISMATCH_CODES.join(' ou ')}) e a parte 2 ausente do ListParts`,
    `${describeResponse(r2)}; ListParts: ${describeParts(after2)}`,
    r2.status === 400 &&
      r2.bodySent &&
      CHECKSUM_MISMATCH_CODES.includes(r2.errorCode) &&
      !after2.some((p) => p.PartNumber === 2),
  );
  checks.info(
    'Código de erro do corpo divergente',
    `${r2.errorCode}${r2.errorCode === 'BadDigest' ? '' : ' (a AWS responde BadDigest; o plano previa BadDigest)'}`,
  );

  const r3 = await rawPut(url2, body2);
  const after3 = await parts();
  checks.add(
    `Parte 2 com o corpo certo, mas sem o header ${CHECKSUM_HEADER} assinado`,
    'recusa 4xx (o cliente não pode omitir o checksum) e a parte 2 ausente',
    `${describeResponse(r3)}; ListParts: ${describeParts(after3)}`,
    r3.status >= 400 &&
      r3.status < 500 &&
      !after3.some((p) => p.PartNumber === 2),
  );

  const r4 = await rawPut(url2, divergent2, {
    headers: { [CHECKSUM_HEADER]: sha256Base64(divergent2) },
  });
  const after4 = await parts();
  checks.add(
    'Parte 2 com corpo divergente e o checksum trocado pelo dele (diferente do assinado)',
    'recusa 4xx (o cliente não pode trocar o checksum) e a parte 2 ausente',
    `${describeResponse(r4)}; ListParts: ${describeParts(after4)}`,
    r4.status >= 400 &&
      r4.status < 500 &&
      !after4.some((p) => p.PartNumber === 2),
  );

  const r5 = await rawPut(url2, body2, {
    headers: { [CHECKSUM_HEADER]: sha2 },
  });
  checks.add(
    'Parte 2 com corpo e checksum corretos',
    '200',
    describeResponse(r5),
    r5.status === 200 && r5.headers[CHECKSUM_HEADER] === sha2,
  );

  const listed = await parts();
  const p1 = listed.find((p) => p.PartNumber === 1);
  const p2 = listed.find((p) => p.PartNumber === 2);
  checks.add(
    'ListParts devolve o ChecksumSHA256 de cada parte',
    `parte 1 com ${sha1} e ${PART1_SIZE} bytes; parte 2 com ${sha2} e ${PART2_SIZE} bytes`,
    describeParts(listed),
    listed.length === 2 &&
      p1?.ChecksumSHA256 === sha1 &&
      p1.Size === PART1_SIZE &&
      p2?.ChecksumSHA256 === sha2 &&
      p2.Size === PART2_SIZE,
  );

  const registered: CompletedPart[] = [
    { PartNumber: 1, ETag: p1?.ETag, ChecksumSHA256: sha1 },
    { PartNumber: 2, ETag: p2?.ETag, ChecksumSHA256: sha2 },
  ];

  // Comportamento do Complete com checksum errado e sem checksums (registrado, ver relatório).
  const wrong = await tryComplete(client, bucket, k.main, uploadId, [
    registered[0],
    { ...registered[1], ChecksumSHA256: sha256Base64(divergent2) },
  ]);
  const afterWrong = await parts();
  checks.add(
    'Complete com o checksum da parte 2 errado',
    'recusa 4xx; o upload continua aberto, com as duas partes',
    `${wrong.text}; ListParts depois: ${describeParts(afterWrong)}`,
    !wrong.accepted &&
      wrong.status >= 400 &&
      wrong.status < 500 &&
      afterWrong.length === 2,
  );

  const other = await createUpload(client, bucket, k.withoutChecksums);
  const otherParts: CompletedPart[] = [];
  for (const [partNumber, body] of [
    [1, body1],
    [2, body2],
  ] as const) {
    const sent = await client.send(
      new UploadPartCommand({
        Bucket: bucket,
        Key: k.withoutChecksums,
        UploadId: other.UploadId,
        PartNumber: partNumber,
        Body: body,
        ChecksumSHA256: sha256Base64(body),
      }),
    );
    otherParts.push({ PartNumber: partNumber, ETag: sent.ETag });
  }
  const withoutChecksums = await tryComplete(
    client,
    bucket,
    k.withoutChecksums,
    other.UploadId ?? '',
    otherParts,
  );
  const otherAfter = await listParts(
    client,
    bucket,
    k.withoutChecksums,
    other.UploadId ?? '',
  );
  checks.add(
    'Complete sem os checksums das partes (outro upload criado com SHA256, mesmas partes)',
    'recusa 4xx (o storage exige o checksum de cada parte); o upload continua aberto',
    `${withoutChecksums.text}; ListParts depois: ${describeParts(otherAfter)}`,
    !withoutChecksums.accepted &&
      withoutChecksums.status >= 400 &&
      withoutChecksums.status < 500 &&
      otherAfter.length === 2,
  );

  // Complete como a P2 prevê: montado pelo registro, com o ChecksumSHA256 de cada parte.
  const expectedComposite = compositeChecksum([body1, body2]);
  let completeOk = false;
  let completeText = '';
  try {
    const done = await client.send(
      new CompleteMultipartUploadCommand({
        Bucket: bucket,
        Key: k.main,
        UploadId: uploadId,
        MultipartUpload: { Parts: registered },
      }),
    );
    completeText = `200: ETag ${unquote(done.ETag)}, ChecksumSHA256 ${done.ChecksumSHA256 ?? '—'}, ChecksumType ${done.ChecksumType ?? '—'}`;
    completeOk = true;
  } catch (error) {
    const e = sdkError(error);
    completeText = `recusado: HTTP ${e.status} ${e.name} (${e.message})`;
  }
  checks.add(
    'Complete com os checksums de todas as partes',
    `200; checksum composto esperado ${expectedComposite}`,
    completeText,
    completeOk,
  );

  const head = await client.send(
    new HeadObjectCommand({
      Bucket: bucket,
      Key: k.main,
      ChecksumMode: 'ENABLED',
    }),
  );
  const object = await client.send(
    new GetObjectCommand({ Bucket: bucket, Key: k.main }),
  );
  const content = Buffer.from(
    (await object.Body?.transformToByteArray()) ?? new Uint8Array(),
  );
  const expectedHex = createHash('sha256')
    .update(Buffer.concat([body1, body2]))
    .digest('hex');
  const gotHex = createHash('sha256').update(content).digest('hex');
  checks.add(
    'Objeto final confere com as partes',
    `HeadObject com ${PART1_SIZE + PART2_SIZE} bytes e o checksum composto; conteúdo igual à concatenação das partes`,
    `HeadObject ${head.ContentLength} bytes, ChecksumSHA256 ${head.ChecksumSHA256 ?? '—'}, ChecksumType ${head.ChecksumType ?? '—'}; SHA-256 do conteúdo ${gotHex.slice(0, 16)}… (esperado ${expectedHex.slice(0, 16)}…)`,
    head.ContentLength === PART1_SIZE + PART2_SIZE &&
      head.ChecksumSHA256 === expectedComposite &&
      gotHex === expectedHex,
  );

  // Controle do achado da V-03: checksum içado para a query (sem unhoistableHeaders).
  const control = await createUpload(client, bucket, k.queryControl);
  const controlUrl = await presignPart(
    client,
    bucket,
    k.queryControl,
    control.UploadId ?? '',
    1,
    body2,
    true,
  );
  const controlQuery = new URL(controlUrl).searchParams;
  const rc = await rawPut(controlUrl, divergent2);
  const controlParts = await listParts(
    client,
    bucket,
    k.queryControl,
    control.UploadId ?? '',
  );
  checks.info(
    'Controle: checksum na query (sem unhoistableHeaders) e corpo divergente, sem header',
    `${CHECKSUM_HEADER} na query: ${controlQuery.has(CHECKSUM_HEADER) ? `sim, com o SHA-256 do corpo declarado (${controlQuery.get(CHECKSUM_HEADER)})` : 'não'}; SignedHeaders=${controlQuery.get('X-Amz-SignedHeaders')}; ${describeResponse(rc)}; ListParts: ${describeParts(controlParts)}; o ChecksumSHA256 listado é o ${controlParts[0]?.ChecksumSHA256 === sha256Base64(divergent2) ? 'do corpo recebido (divergente), calculado pelo storage' : controlParts[0]?.ChecksumSHA256 === sha2 ? 'declarado na query' : 'de nenhum dos dois'}`,
  );

  console.log(`RESUMO run: ${checks.summary()}`);
  return checks.allPassed;
}

async function cleanup(runId: string): Promise<boolean> {
  const { client, bucket } = context();
  const k = keys(runId);
  return cleanupPrefix(client, bucket, k.prefix, [
    k.main,
    k.withoutChecksums,
    k.queryControl,
  ]);
}

runProofCli({ run, cleanup });

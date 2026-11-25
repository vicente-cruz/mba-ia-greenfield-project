// Apoio comum aos scripts de prova da Fase 03. Não faz parte da aplicação.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { request as httpRequest, type IncomingHttpHeaders } from 'node:http';
import { join } from 'node:path';
import { parseEnv } from 'node:util';
import {
  AbortMultipartUploadCommand,
  DeleteObjectCommand,
  ListMultipartUploadsCommand,
  ListObjectsV2Command,
  S3Client,
} from '@aws-sdk/client-s3';

export type EnvSource = NodeJS.Dict<string>;

/**
 * Lê o `.env` do nestjs-project. O container `nestjs-api` não recebe essas chaves
 * no ambiente (a aplicação as lê pelo ConfigModule). Os valores nunca são impressos.
 */
export function readProjectEnv(): EnvSource {
  return parseEnv(readFileSync(join(__dirname, '..', '..', '.env'), 'utf8'));
}

export function requireKey(env: EnvSource, key: string): string {
  const value = env[key];
  if (value === undefined || value === '') {
    throw new Error(`${key} não definido`);
  }
  return value;
}

/** Cliente S3 da aplicação, como prevê a TD-07: path-style e checksums só quando exigidos. */
export function appClient(env: EnvSource, endpointKey: string): S3Client {
  return new S3Client({
    endpoint: requireKey(env, endpointKey),
    region: requireKey(env, 'S3_REGION'),
    forcePathStyle: requireKey(env, 'S3_FORCE_PATH_STYLE') === 'true',
    credentials: {
      accessKeyId: requireKey(env, 'S3_ACCESS_KEY_ID'),
      secretAccessKey: requireKey(env, 'S3_SECRET_ACCESS_KEY'),
    },
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
  });
}

export interface CheckResult {
  item: string;
  expected: string;
  observed: string;
  passed: boolean;
}

/** Acumula os itens verificados e imprime cada um numa linha. */
export class Checks {
  readonly results: CheckResult[] = [];

  add(item: string, expected: string, observed: string, passed: boolean): void {
    this.results.push({ item, expected, observed, passed });
    console.log(
      `${passed ? 'PASSOU' : 'FALHOU'} | ${item} | esperado: ${expected} | observado: ${observed}`,
    );
  }

  /** Registro informativo: não conta como item obrigatório nem afeta o resultado. */
  info(item: string, observed: string): void {
    console.log(`INFO | ${item} | observado: ${observed}`);
  }

  get allPassed(): boolean {
    return this.results.every((r) => r.passed);
  }

  summary(): string {
    const failed = this.results.filter((r) => !r.passed).length;
    return `${this.results.length} itens, ${failed} com falha`;
  }
}

export interface BucketSnapshot {
  objects: number;
  bytes: number;
  digest: string;
}

/**
 * Retrato do bucket principal, só leitura: quantidade, bytes e um hash da lista
 * ordenada de chave, ETag e tamanho. Serve para mostrar que a prova preservou os dados.
 */
export async function snapshotBucket(
  client: S3Client,
  bucket: string,
): Promise<BucketSnapshot> {
  const lines: string[] = [];
  let bytes = 0;
  let token: string | undefined;
  do {
    const page = await client.send(
      new ListObjectsV2Command({ Bucket: bucket, ContinuationToken: token }),
    );
    for (const object of page.Contents ?? []) {
      lines.push(`${object.Key}|${object.ETag}|${object.Size}`);
      bytes += object.Size ?? 0;
    }
    token = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (token);
  lines.sort();
  const digest = createHash('sha256').update(lines.join('\n')).digest('hex');
  return { objects: lines.length, bytes, digest };
}

export function errorName(error: unknown): string {
  return error instanceof Error ? error.name : String(error);
}

export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** SHA-256 em base64 com padding, o formato de `x-amz-checksum-sha256`. */
export const sha256Base64 = (data: Buffer): string =>
  createHash('sha256').update(data).digest('base64');

export const md5Hex = (data: Buffer): string =>
  createHash('md5').update(data).digest('hex');

export const unquote = (etag: string | undefined): string =>
  (etag ?? '').replace(/"/g, '');

export interface RawResponse {
  status: number;
  headers: IncomingHttpHeaders;
  /** O corpo chegou a ser enviado (o storage respondeu `100 Continue`). */
  bodySent: boolean;
  errorCode: string;
  errorMessage: string;
  networkError?: string;
}

/**
 * PUT numa URL pré-assinada com `Expect: 100-continue`, como o curl faz com corpos grandes.
 * O corpo só é enviado depois do `100 Continue`. Se o storage responder antes, a recusa
 * aconteceu sem receber o corpo. Com `chunked`, o corpo vai em stream, sem `Content-Length`.
 */
export function rawPut(
  url: string,
  body: Buffer,
  options: { headers?: Record<string, string>; chunked?: boolean } = {},
): Promise<RawResponse> {
  return new Promise((resolve) => {
    const target = new URL(url);
    const headers: Record<string, string | number> = {
      Expect: '100-continue',
      ...options.headers,
    };
    if (options.chunked) {
      headers['Transfer-Encoding'] = 'chunked';
    } else {
      headers['Content-Length'] = body.length;
    }
    let bodySent = false;
    let settled = false;
    const finish = (response: RawResponse): void => {
      if (!settled) {
        settled = true;
        resolve(response);
      }
    };
    const req = httpRequest({
      hostname: target.hostname,
      port: target.port,
      path: `${target.pathname}${target.search}`,
      method: 'PUT',
      headers,
    });
    req.setTimeout(60_000, () => req.destroy(new Error('timeout de 60 s')));
    req.on('continue', () => {
      bodySent = true;
      if (options.chunked) {
        for (let offset = 0; offset < body.length; offset += 65_536) {
          req.write(body.subarray(offset, offset + 65_536));
        }
        req.end();
      } else {
        req.end(body);
      }
    });
    req.on('response', (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        finish({
          status: res.statusCode ?? 0,
          headers: res.headers,
          bodySent,
          errorCode: /<Code>([^<]*)<\/Code>/.exec(text)?.[1] ?? '',
          errorMessage: /<Message>([^<]*)<\/Message>/.exec(text)?.[1] ?? '',
        });
        req.destroy();
      });
    });
    req.on('error', (error) =>
      finish({
        status: 0,
        headers: {},
        bodySent,
        errorCode: '',
        errorMessage: '',
        networkError: error.message,
      }),
    );
    req.flushHeaders();
  });
}

export const describeResponse = (r: RawResponse): string =>
  r.networkError
    ? `erro de rede: ${r.networkError} (corpo enviado: ${r.bodySent ? 'sim' : 'não'})`
    : `HTTP ${r.status}${r.errorCode ? ` ${r.errorCode}` : ''}${r.errorMessage ? ` (${r.errorMessage})` : ''}; ETag ${unquote(r.headers.etag) || '—'}; corpo enviado: ${r.bodySent ? 'sim' : 'não'}`;

/** Código de erro de uma exceção do SDK (`NoSuchUpload`, `PreconditionFailed`...) e o status HTTP. */
export function sdkError(error: unknown): {
  name: string;
  status: number;
  message: string;
} {
  const e = error as {
    name?: string;
    message?: string;
    $metadata?: { httpStatusCode?: number };
  };
  return {
    name: e.name ?? String(error),
    status: e.$metadata?.httpStatusCode ?? 0,
    message: e.message ?? '',
  };
}

/**
 * Remove os objetos sob o prefixo temporário e aborta os multipart das chaves informadas
 * (o MinIO exige a chave exata como prefixo em ListMultipartUploads). Confere que nada restou.
 */
export async function cleanupPrefix(
  client: S3Client,
  bucket: string,
  prefix: string,
  multipartKeys: string[],
): Promise<boolean> {
  let removedObjects = 0;
  let abortedUploads = 0;
  let token: string | undefined;
  do {
    const page = await client.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: prefix,
        ContinuationToken: token,
      }),
    );
    for (const object of page.Contents ?? []) {
      await client.send(
        new DeleteObjectCommand({ Bucket: bucket, Key: object.Key }),
      );
      removedObjects += 1;
    }
    token = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (token);
  const listUploads = async (key: string) =>
    (
      await client.send(
        new ListMultipartUploadsCommand({ Bucket: bucket, Prefix: key }),
      )
    ).Uploads ?? [];
  for (const key of multipartKeys) {
    for (const upload of await listUploads(key)) {
      await client.send(
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
      await client.send(
        new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix }),
      )
    ).KeyCount ?? 0;
  let uploadsLeft = 0;
  for (const key of multipartKeys) {
    uploadsLeft += (await listUploads(key)).length;
  }
  console.log(
    `LIMPEZA prefixo ${prefix}: ${removedObjects} objeto(s) removido(s), ${abortedUploads} multipart abortado(s); restam ${objectsLeft} objeto(s) e ${uploadsLeft} multipart`,
  );
  return objectsLeft === 0 && uploadsLeft === 0;
}

/**
 * Despacha os subcomandos `run <runId>`, `cleanup <runId>` e `snapshot` de um script de prova.
 * Código de saída: 0 com sucesso, 1 com item obrigatório reprovado e 2 com erro de execução.
 */
export function runProofCli(handlers: {
  run: (runId: string) => Promise<boolean>;
  cleanup: (runId: string) => Promise<boolean>;
}): void {
  const [command, runId] = process.argv.slice(2);
  const execute = async (): Promise<boolean> => {
    if (command === 'snapshot') {
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
    if ((command === 'run' || command === 'cleanup') && runId) {
      return handlers[command](runId);
    }
    throw new Error('uso: run <runId> | cleanup <runId> | snapshot');
  };
  execute()
    .then((ok) => {
      process.exitCode = ok ? 0 : 1;
    })
    .catch((error: unknown) => {
      console.error(error);
      process.exitCode = 2;
    });
}

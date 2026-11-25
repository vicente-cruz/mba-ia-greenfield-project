// Apoio HTTP das provas que falam com a API Nest (SI-03.31): JSON sobre node:http, login e
// renovação do access token. Não faz parte da aplicação e não usa credenciais do storage.
// Tokens, senhas e URLs assinadas nunca são impressos.
import { renameSync, writeFileSync } from 'node:fs';
import {
  request as httpRequest,
  type IncomingHttpHeaders,
  type OutgoingHttpHeaders,
} from 'node:http';
import { performance } from 'node:perf_hooks';

/** API pela rede do Compose, pelo nome do serviço. */
export const DEFAULT_API_URL = 'http://nestjs-api:3000';

export interface HttpResponse<T = unknown> {
  status: number;
  headers: IncomingHttpHeaders;
  body: T;
  /** Do envio da requisição até o fim do corpo da resposta. */
  durationMs: number;
}

/** A requisição não terminou dentro do prazo. */
export class RequestTimeoutError extends Error {
  constructor(readonly timeoutMs: number) {
    super(`sem resposta completa em ${timeoutMs} ms`);
    this.name = 'RequestTimeoutError';
  }
}

/** Resposta da API fora dos status esperados, com o código estável do envelope de erro. */
export class ApiError extends Error {
  constructor(
    readonly operation: string,
    readonly status: number,
    readonly code: string,
    readonly retryAfterSeconds: number | null,
  ) {
    super(`${operation}: HTTP ${status}${code ? ` ${code}` : ''}`);
    this.name = 'ApiError';
  }
}

export interface HttpJsonOptions {
  token?: string;
  body?: unknown;
  timeoutMs?: number;
  signal?: AbortSignal;
}

/**
 * Uma requisição JSON. O prazo cobre a requisição inteira, até o fim do corpo da resposta.
 * Corpo que não é JSON vem como texto.
 */
export function httpJson<T = unknown>(
  method: string,
  url: string,
  options: HttpJsonOptions = {},
): Promise<HttpResponse<T>> {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const payload =
      options.body === undefined
        ? undefined
        : Buffer.from(JSON.stringify(options.body));
    const headers: OutgoingHttpHeaders = { accept: 'application/json' };
    if (payload) {
      headers['content-type'] = 'application/json';
      headers['content-length'] = payload.length;
    }
    if (options.token) {
      headers.authorization = `Bearer ${options.token}`;
    }
    const started = performance.now();
    let settled = false;
    const settle = (outcome: () => void): void => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        outcome();
      }
    };
    const req = httpRequest({
      hostname: target.hostname,
      port: target.port,
      path: `${target.pathname}${target.search}`,
      method,
      headers,
      signal: options.signal,
    });
    const timeoutMs = options.timeoutMs ?? 30_000;
    const timer = setTimeout(() => {
      const error = new RequestTimeoutError(timeoutMs);
      settle(() => reject(error));
      req.destroy(error);
    }, timeoutMs);
    req.on('response', (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('error', (error) => settle(() => reject(error)));
      res.on('end', () => {
        const durationMs = performance.now() - started;
        const text = Buffer.concat(chunks).toString('utf8');
        let body: unknown = text;
        if (text !== '') {
          try {
            body = JSON.parse(text) as unknown;
          } catch {
            // Corpo não JSON: fica como texto, para o chamador decidir.
          }
        }
        settle(() =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: body as T,
            durationMs,
          }),
        );
      });
    });
    req.on('error', (error) => settle(() => reject(error)));
    req.end(payload);
  });
}

/** Código estável do envelope de erro (phase-02-auth/TD-07): `code`, ou `error` sem ele. */
export function errorCode(body: unknown): string {
  if (body && typeof body === 'object') {
    const envelope = body as { code?: unknown; error?: unknown };
    if (typeof envelope.code === 'string') {
      return envelope.code;
    }
    if (typeof envelope.error === 'string') {
      return envelope.error;
    }
  }
  return '';
}

export function retryAfterSeconds(headers: IncomingHttpHeaders): number | null {
  const value = Number(headers['retry-after']);
  return Number.isFinite(value) && value >= 0 ? value : null;
}

/** Exige um dos status esperados; senão, `ApiError` com o código do envelope. */
export function expectStatus<T>(
  operation: string,
  response: HttpResponse<T>,
  expected: readonly number[],
): HttpResponse<T> {
  if (!expected.includes(response.status)) {
    throw new ApiError(
      operation,
      response.status,
      errorCode(response.body),
      retryAfterSeconds(response.headers),
    );
  }
  return response;
}

export interface TokenPair {
  access_token: string;
  refresh_token: string;
}

/** Credenciais de um usuário de prova, gravadas só no `/tmp` do container, com modo 0600. */
export interface Credentials {
  email: string;
  password: string;
  accessToken: string;
  refreshToken: string;
}

/** Instante de expiração (`exp`) do JWT, em ms. A assinatura não é conferida aqui. */
export function jwtExpiresAtMs(token: string): number {
  const payload = token.split('.')[1];
  if (!payload) {
    throw new Error('access token sem payload');
  }
  const { exp } = JSON.parse(
    Buffer.from(payload, 'base64url').toString('utf8'),
  ) as { exp?: unknown };
  if (typeof exp !== 'number') {
    throw new Error('access token sem exp');
  }
  return exp * 1000;
}

export async function login(
  apiUrl: string,
  email: string,
  password: string,
): Promise<TokenPair> {
  const response = await httpJson<TokenPair>('POST', `${apiUrl}/auth/login`, {
    body: { email, password },
  });
  return expectStatus('POST /auth/login', response, [200]).body;
}

/** Grava o JSON com modo 0600, por arquivo temporário e `rename`, para nunca ficar pela metade. */
export function writePrivateJson(path: string, value: unknown): void {
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, {
    mode: 0o600,
  });
  renameSync(temporary, path);
}

export interface TokenRenewal {
  kind: 'refresh' | 'login';
  previousExpiresAt: string;
  expiresAt: string;
  durationMs: number;
}

/**
 * Access token de um usuário de prova, renovado por `POST /auth/refresh` quando faltam
 * `marginSeconds` ou menos para expirar (o token vale 15 min, menos que um upload grande).
 * Uma renovação por vez; o refresh token é rotativo, então o par novo é persistido assim que chega.
 * Se o refresh for recusado (401), faz login de novo com a senha.
 */
export class TokenSession {
  private renewal: Promise<void> | null = null;

  constructor(
    private readonly apiUrl: string,
    private credentials: Credentials,
    private readonly marginSeconds: number,
    private readonly persist: (credentials: Credentials) => void,
    private readonly onRenewal: (renewal: TokenRenewal) => void,
  ) {}

  get email(): string {
    return this.credentials.email;
  }

  expiresAtMs(): number {
    return jwtExpiresAtMs(this.credentials.accessToken);
  }

  needsRenewal(now = Date.now()): boolean {
    return this.expiresAtMs() - now <= this.marginSeconds * 1000;
  }

  /** O access token vigente, renovado antes se estiver perto de expirar. */
  async accessToken(): Promise<string> {
    if (this.needsRenewal()) {
      await this.renew();
    }
    return this.credentials.accessToken;
  }

  /**
   * O token vigente, sem esperar a renovação; só renova antes de devolver se ele expira em menos
   * de `hardMarginMs`. A sonda usa no disparo, para que a renovação não atrase a amostra.
   */
  async currentToken(hardMarginMs: number): Promise<string> {
    if (this.expiresAtMs() - Date.now() <= hardMarginMs) {
      await this.renew();
    }
    return this.credentials.accessToken;
  }

  async renewIfNeeded(): Promise<void> {
    if (this.needsRenewal()) {
      await this.renew();
    }
  }

  private renew(): Promise<void> {
    this.renewal ??= this.performRenewal().finally(() => {
      this.renewal = null;
    });
    return this.renewal;
  }

  private async performRenewal(): Promise<void> {
    const previousExpiresAt = new Date(this.expiresAtMs()).toISOString();
    const started = performance.now();
    const response = await httpJson<TokenPair>(
      'POST',
      `${this.apiUrl}/auth/refresh`,
      { body: { refresh_token: this.credentials.refreshToken } },
    );
    let kind: TokenRenewal['kind'] = 'refresh';
    let pair: TokenPair;
    if (response.status === 401) {
      kind = 'login';
      pair = await login(
        this.apiUrl,
        this.credentials.email,
        this.credentials.password,
      );
    } else {
      pair = expectStatus('POST /auth/refresh', response, [200]).body;
    }
    this.credentials = {
      ...this.credentials,
      accessToken: pair.access_token,
      refreshToken: pair.refresh_token,
    };
    this.persist(this.credentials);
    this.onRenewal({
      kind,
      previousExpiresAt,
      expiresAt: new Date(this.expiresAtMs()).toISOString(),
      durationMs: performance.now() - started,
    });
  }
}

export const sleepMs = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const done = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener('abort', done, { once: true });
  });

/** Percentil pelo método do posto mais próximo, sobre valores já ordenados. */
export function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) {
    return Number.NaN;
  }
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length, Math.max(1, rank)) - 1];
}

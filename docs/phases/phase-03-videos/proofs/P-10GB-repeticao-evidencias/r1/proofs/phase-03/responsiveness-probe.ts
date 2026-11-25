// Sonda de responsividade da API (SI-03.31, com o cenário de medição fixado na SI-03.33). Não faz
// parte da aplicação.
// - Faz `GET /videos/:publicId` de um vídeo de controle em `draft`, autenticada como o dono desse
//   vídeo, que é um usuário de prova distinto do usuário que faz o upload.
// - Ritmo fixo: uma requisição a cada 2 s (0,5 req/s, dentro do limite de 60/min por IP da rota),
//   com timeout de 5 s. Os disparos seguem a grade do início, sem acumular atraso; uma requisição
//   lenta não adia a próxima.
// - Grava em stdout um CSV com uma linha por requisição: instância, sequência, instante (ISO 8601 e
//   ms desde a época), status HTTP, latência até o fim do corpo e desfecho (`ok`, `http_error`,
//   `timeout`, `network_error` ou `unexpected_body`). Timeout e erro de rede ficam com status vazio.
// - O login e as renovações do access token (`POST /auth/refresh`, quando faltam
//   `--refresh-margin-seconds` para expirar) não entram nas amostras. Cada instância faz o próprio
//   login, então tem a sua cadeia de refresh tokens.
// - Lê as credenciais do dono (`{ "email", "password" }`, JSON) da entrada padrão, para que nunca
//   apareçam em argumentos, variáveis de ambiente ou logs.
// - Para com SIGINT ou SIGTERM, ou depois de `--duration-seconds`; espera as requisições em
//   andamento (até o timeout) e imprime o resumo em stderr.
// Cada instância roda num container próprio, com IP distinto do cliente de upload, por exemplo:
//   docker compose exec -T nestjs-api cat <credenciais> | docker compose run --rm --no-deps -T \
//     --name <nome> nestjs-api node -r ts-node/register proofs/phase-03/responsiveness-probe.ts \
//     --public-id <publicId> > sonda.csv 2> sonda.log
// O `node -r ts-node/register` faz da sonda o PID 1 do container, que assim recebe o SIGTERM do
// `docker kill --signal SIGTERM <nome>`.
//
// Opções: --public-id (obrigatório), --api (padrão: http://nestjs-api:3000), --instance (padrão: 1),
// --interval-ms (padrão: 2000), --timeout-ms (padrão: 5000), --duration-seconds (padrão: sem
// limite), --refresh-margin-seconds (padrão: 120).
// Código de saída: 0 ao terminar, 1 se o login falhar, 64 com uso inválido.
import { readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { parseArgs } from 'node:util';
import {
  type Credentials,
  DEFAULT_API_URL,
  httpJson,
  login,
  percentile,
  RequestTimeoutError,
  sleepMs,
  type TokenPair,
  TokenSession,
} from './proof-api';

/** Só um token a menos disso de expirar é renovado no disparo, antes da amostra. */
const HARD_RENEWAL_MARGIN_MS = 10_000;
const CSV_HEADER = 'instance,seq,instant,epoch_ms,status,latency_ms,outcome';

type Outcome =
  | 'ok'
  | 'http_error'
  | 'timeout'
  | 'network_error'
  | 'unexpected_body';

interface Sample {
  status: number | null;
  latencyMs: number;
  outcome: Outcome;
}

class UsageError extends Error {}

function positiveInteger(
  name: string,
  value: string | undefined,
  fallback: number | null,
): number | null {
  if (value === undefined) {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new UsageError(`--${name} precisa ser um inteiro positivo`);
  }
  return parsed;
}

const log = (message: string): void => {
  process.stderr.write(`SONDA | ${message}\n`);
};

async function main(): Promise<number> {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    strict: true,
    options: {
      'public-id': { type: 'string' },
      api: { type: 'string' },
      instance: { type: 'string' },
      'interval-ms': { type: 'string' },
      'timeout-ms': { type: 'string' },
      'duration-seconds': { type: 'string' },
      'refresh-margin-seconds': { type: 'string' },
    },
  });
  const publicId = values['public-id'];
  if (!publicId) {
    throw new UsageError('--public-id é obrigatório');
  }
  const apiUrl = values.api ?? DEFAULT_API_URL;
  const instance = values.instance ?? '1';
  if (!/^[\w.-]{1,32}$/.test(instance)) {
    throw new UsageError('--instance aceita letras, dígitos, ".", "_" e "-"');
  }
  const intervalMs =
    positiveInteger('interval-ms', values['interval-ms'], 2000) ?? 2000;
  const timeoutMs =
    positiveInteger('timeout-ms', values['timeout-ms'], 5000) ?? 5000;
  const durationSeconds = positiveInteger(
    'duration-seconds',
    values['duration-seconds'],
    null,
  );
  const marginSeconds =
    positiveInteger(
      'refresh-margin-seconds',
      values['refresh-margin-seconds'],
      120,
    ) ?? 120;

  const owner = JSON.parse(readFileSync(0, 'utf8')) as Pick<
    Credentials,
    'email' | 'password'
  >;
  if (!owner.email || !owner.password) {
    throw new UsageError(
      'a entrada padrão precisa trazer { "email", "password" }',
    );
  }
  let pair: TokenPair;
  try {
    pair = await login(apiUrl, owner.email, owner.password);
  } catch (error) {
    log(
      `login falhou: ${error instanceof Error ? error.message : String(error)}`,
    );
    return 1;
  }
  let renewals = 0;
  const tokens = new TokenSession(
    apiUrl,
    {
      email: owner.email,
      password: owner.password,
      accessToken: pair.access_token,
      refreshToken: pair.refresh_token,
    },
    marginSeconds,
    () => {
      // As credenciais da sonda vivem só na memória do processo.
    },
    (renewal) => {
      renewals += 1;
      log(
        `access token renovado por ${renewal.kind === 'refresh' ? 'POST /auth/refresh' : 'novo login'} em ${renewal.durationMs.toFixed(1)} ms (fora das amostras); expira ${renewal.expiresAt}`,
      );
    },
  );

  const stop = new AbortController();
  let stoppedBy = 'duração';
  for (const name of ['SIGINT', 'SIGTERM'] as const) {
    process.on(name, () => {
      stoppedBy = name;
      stop.abort();
    });
  }
  log(
    `instância ${instance} | GET /videos/${publicId} | intervalo ${intervalMs} ms | timeout ${timeoutMs} ms | renovação ${marginSeconds} s antes de expirar | duração ${durationSeconds === null ? 'até SIGINT/SIGTERM' : `${durationSeconds} s`}`,
  );
  process.stdout.write(`${CSV_HEADER}\n`);

  const samples: Sample[] = [];
  const inFlight = new Set<Promise<void>>();
  const startedAt = Date.now();
  const deadline =
    durationSeconds === null ? Infinity : startedAt + durationSeconds * 1000;

  const probeOnce = async (seq: number): Promise<void> => {
    // No disparo, o token vigente; a renovação acontece depois da amostra, longe do próximo disparo.
    const token = await tokens.currentToken(HARD_RENEWAL_MARGIN_MS);
    const instant = new Date();
    const started = performance.now();
    let sample: Sample;
    try {
      const response = await httpJson<{ publicId?: string; status?: string }>(
        'GET',
        `${apiUrl}/videos/${publicId}`,
        { token, timeoutMs },
      );
      const latencyMs = performance.now() - started;
      const success = response.status >= 200 && response.status < 300;
      const expectedBody =
        response.body.publicId === publicId && response.body.status === 'draft';
      sample = {
        status: response.status,
        latencyMs,
        outcome: !success
          ? 'http_error'
          : expectedBody
            ? 'ok'
            : 'unexpected_body',
      };
    } catch (error) {
      sample = {
        status: null,
        latencyMs: performance.now() - started,
        outcome:
          error instanceof RequestTimeoutError ? 'timeout' : 'network_error',
      };
    }
    samples.push(sample);
    process.stdout.write(
      `${instance},${seq},${instant.toISOString()},${instant.getTime()},${sample.status ?? ''},${sample.latencyMs.toFixed(3)},${sample.outcome}\n`,
    );
    // Renovação logo depois da amostra, fora da medição e entre disparos.
    await tokens.renewIfNeeded();
  };

  for (let seq = 1; !stop.signal.aborted; seq += 1) {
    const scheduled = startedAt + (seq - 1) * intervalMs;
    if (scheduled >= deadline) {
      break;
    }
    await sleepMs(Math.max(0, scheduled - Date.now()), stop.signal);
    if (stop.signal.aborted) {
      break;
    }
    const task: Promise<void> = probeOnce(seq)
      .catch((error: unknown) => {
        log(
          `falha fora da amostra: ${error instanceof Error ? error.message : String(error)}`,
        );
      })
      .finally(() => inFlight.delete(task));
    inFlight.add(task);
  }
  await Promise.all([...inFlight]);

  const latencies = samples
    .filter((sample) => sample.outcome === 'ok')
    .map((sample) => sample.latencyMs)
    .sort((a, b) => a - b);
  const count = (outcome: Outcome) =>
    samples.filter((sample) => sample.outcome === outcome).length;
  const status429 = samples.filter((sample) => sample.status === 429).length;
  log(
    `fim (${stoppedBy}) | ${samples.length} amostras em ${((Date.now() - startedAt) / 1000).toFixed(1)} s | ok ${count('ok')} | fora de 2xx ${count('http_error')} (429: ${status429}) | timeout ${count('timeout')} | erro de rede ${count('network_error')} | corpo inesperado ${count('unexpected_body')} | renovações ${renewals}`,
  );
  if (latencies.length > 0) {
    log(
      `latência das respostas ok (ms): p50 ${percentile(latencies, 50).toFixed(1)} | p95 ${percentile(latencies, 95).toFixed(1)} | p99 ${percentile(latencies, 99).toFixed(1)} | máx ${latencies[latencies.length - 1].toFixed(1)}`,
    );
  }
  return 0;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    process.stderr.write(
      `SONDA | ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = error instanceof UsageError ? 64 : 1;
  });

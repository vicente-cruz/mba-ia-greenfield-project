'use strict';
// Roteiro dos navegadores (V-08 e V-09, parte de navegador), executado por run.sh dentro do
// serviço `proof-browser`. Só observa e relata; a avaliação é feita por `v08-browser-urls.ts verify`.
//
// - Serve a página de prova em http://localhost:4173 (contexto seguro, exigido pelo Web Crypto) e
//   uma origem de controle, fora do CORS, em http://127.0.0.1:4174.
// - Em Chromium e Firefox, executa os casos do manifesto (URLs pré-assinadas pela API) e registra,
//   para cada um, a resposta lida pelo script e os eventos de rede vistos pelo navegador.
// - Mede o SHA-256 do arquivo de 1 GiB, 64 MiB por vez, num Worker (duas rodadas por navegador).
// - Faz um preflight direto (OPTIONS) igual ao do navegador, a partir das duas origens.
// Entrada: V08_MANIFEST_B64 (manifesto em base64), HASH_FILE e PROOF_DEPS. Saída: `RESULT <json>`.
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const { chromium, firefox } = require(
  require.resolve('playwright-core', { paths: [process.env.PROOF_DEPS] }),
);

const PAGE_DIR = path.join(__dirname, 'page');
const PAGE_PORT = 4173;
const CONTROL_PORT = 4174;
const PAGE_ORIGIN = `http://localhost:${PAGE_PORT}`;
const CONTROL_ORIGIN = `http://127.0.0.1:${CONTROL_PORT}`;
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8' };

const manifest = JSON.parse(Buffer.from(process.env.V08_MANIFEST_B64, 'base64').toString('utf8'));
const hashFile = process.env.HASH_FILE;
const log = (...args) => console.error(...args);

function serve(host, port) {
  const server = http.createServer((req, res) => {
    const name = path.basename(new URL(req.url, 'http://page').pathname) || 'index.html';
    const file = path.join(PAGE_DIR, name);
    if (!fs.existsSync(file)) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, {
      'content-type': TYPES[path.extname(file)] || 'application/octet-stream',
      'cache-control': 'no-store',
    });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((resolve) => server.listen(port, host, () => resolve(server)));
}

/** SHA-256 (base64) de cada parte do arquivo, calculado no Node para conferir o navegador. */
function expectedDigests(file, partBytes) {
  const fd = fs.openSync(file, 'r');
  const buffer = Buffer.alloc(partBytes);
  const digests = [];
  try {
    for (let offset = 0; ; offset += partBytes) {
      const read = fs.readSync(fd, buffer, 0, partBytes, offset);
      if (read === 0) break;
      digests.push(crypto.createHash('sha256').update(buffer.subarray(0, read)).digest('base64'));
    }
  } finally {
    fs.closeSync(fd);
  }
  return digests;
}

/** Preflight igual ao que o navegador envia antes do PUT com o header de checksum. */
function directPreflight(origin, url) {
  return new Promise((resolve) => {
    const target = new URL(url);
    const req = http.request(
      {
        hostname: target.hostname,
        port: target.port,
        path: `${target.pathname}${target.search}`,
        method: 'OPTIONS',
        headers: {
          Origin: origin,
          'Access-Control-Request-Method': 'PUT',
          'Access-Control-Request-Headers': 'x-amz-checksum-sha256',
        },
      },
      (res) => {
        res.resume();
        resolve({
          origin,
          status: res.statusCode,
          allowOrigin: res.headers['access-control-allow-origin'] ?? null,
          allowHeaders: res.headers['access-control-allow-headers'] ?? null,
          allowMethods: res.headers['access-control-allow-methods'] ?? null,
        });
      },
    );
    req.on('error', (error) =>
      resolve({ origin, status: 0, allowOrigin: null, allowHeaders: null, allowMethods: error.message }),
    );
    req.end();
  });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function runBrowser(name, type, expected) {
  const spec = manifest.browsers[name];
  const storageHost = new URL(spec.cases[0].url).host;
  const browser = await type.launch();
  const version = `${name} ${browser.version()}`;
  log(`== ${version}`);
  const context = await browser.newContext();
  const events = [];
  const preflightEvents = [];
  const partOf = (url) => {
    const u = new URL(url);
    return u.host === storageHost && u.searchParams.get('uploadId') === spec.uploadId
      ? Number(u.searchParams.get('partNumber'))
      : null;
  };
  context.on('request', (r) => {
    const part = partOf(r.url());
    if (part === null) return;
    // Headers de enquadramento que o navegador pôs no PUT, e o tamanho do corpo quando exposto.
    // `headersRead` distingue "header ausente" de "headers ainda não lidos".
    const body = r.postDataBuffer();
    const entry = {
      part,
      method: r.method(),
      event: 'request',
      detail: '',
      headersRead: false,
      contentLength: null,
      transferEncoding: null,
      bodyBytes: body ? body.length : null,
    };
    events.push(entry);
    r.allHeaders()
      .then((h) => {
        entry.headersRead = true;
        entry.contentLength = h['content-length'] ?? null;
        entry.transferEncoding = h['transfer-encoding'] ?? null;
        entry.detail = `content-length ${entry.contentLength ?? '—'}, transfer-encoding ${entry.transferEncoding ?? '—'}, corpo ${body ? `${body.length} bytes` : 'não exposto'}`;
      })
      .catch((error) => {
        entry.detail = `headers indisponíveis: ${error.message}`;
      });
  });
  context.on('response', (r) => {
    const part = partOf(r.url());
    if (part !== null)
      events.push({
        part,
        method: r.request().method(),
        event: 'response',
        status: r.status(),
        detail: `HTTP ${r.status()}`,
      });
  });
  context.on('requestfailed', (r) => {
    const part = partOf(r.url());
    if (part !== null) {
      const errorText = r.failure()?.errorText ?? '';
      events.push({ part, method: r.method(), event: 'requestfailed', errorText, detail: errorText });
    }
  });

  const page = await context.newPage();
  const control = await context.newPage();
  if (name === 'chromium') {
    // Só o Chromium expõe o protocolo do DevTools; nele, o preflight aparece como requisição própria.
    for (const p of [page, control]) {
      const cdp = await context.newCDPSession(p);
      await cdp.send('Network.enable');
      cdp.on('Network.requestWillBeSent', (e) => {
        if (e.type === 'Preflight' || e.request.method === 'OPTIONS') {
          const part = partOf(e.request.url);
          if (part !== null) preflightEvents.push(`parte ${part}: ${e.request.method} enviado (${e.type})`);
        }
      });
      cdp.on('Network.responseReceived', (e) => {
        if (e.type === 'Preflight') {
          const part = partOf(e.response.url);
          const acao = e.response.headers['Access-Control-Allow-Origin'] ?? e.response.headers['access-control-allow-origin'];
          if (part !== null)
            preflightEvents.push(`parte ${part}: preflight HTTP ${e.response.status}, Allow-Origin ${acao ?? '—'}`);
        }
      });
      cdp.on('Network.loadingFailed', (e) => {
        if (e.type === 'Preflight' || (e.corsErrorStatus && e.corsErrorStatus.corsError)) {
          preflightEvents.push(`falha de rede (${e.type}): ${e.errorText}${e.corsErrorStatus ? `, CORS ${e.corsErrorStatus.corsError}` : ''}`);
        }
      });
    }
  }
  await page.goto(`${PAGE_ORIGIN}/index.html`);
  await control.goto(`${CONTROL_ORIGIN}/index.html`);
  const secure = await page.evaluate(() => window.proof.secureContext);
  log(`página em ${PAGE_ORIGIN}: contexto seguro = ${secure}`);

  const cases = [];
  for (const c of spec.cases) {
    const target = c.origin === 'control' ? control : page;
    const result = await target.evaluate((s) => window.proof.runCase(s), c);
    await sleep(500); // eventos de falha de rede chegam depois da exceção do fetch
    // Referências aos próprios eventos: os headers lidos depois ainda entram no resultado final.
    const network = events.filter((e) => e.part === c.part);
    cases.push({ id: c.id, ...result, network });
    log(`${c.id}: ${JSON.stringify(result)} | rede: ${JSON.stringify(network)}`);
  }

  await page.setInputFiles('#hash-file', hashFile);
  const runs = [];
  for (let i = 0; i < manifest.hashRuns; i += 1) {
    const run = await page.evaluate((o) => window.proof.hashSelectedFile(o), {
      partBytes: manifest.hashPartBytes,
    });
    log(`hash rodada ${i + 1}: ${(run.totalMs / 1000).toFixed(2)} s, Worker ${run.inWorker}, atraso máx. ${run.mainThreadMaxLagMs.toFixed(0)} ms`);
    runs.push(run);
  }
  await browser.close();
  return { version, secureContext: secure, cases, preflightEvents, hash: { expected, runs } };
}

async function main() {
  const size = fs.statSync(hashFile).size;
  if (size !== manifest.hashTotalBytes) {
    throw new Error(`arquivo da medição com ${size} bytes; esperado ${manifest.hashTotalBytes}`);
  }
  const expected = expectedDigests(hashFile, manifest.hashPartBytes);
  const servers = [await serve('localhost', PAGE_PORT), await serve('127.0.0.1', CONTROL_PORT)];
  try {
    const preflightUrl = manifest.browsers.chromium.cases.find((c) => c.id === 'preflight').url;
    const directPreflightResults = [
      await directPreflight(PAGE_ORIGIN, preflightUrl),
      await directPreflight(CONTROL_ORIGIN, preflightUrl),
    ];
    const browsers = {};
    for (const [name, type] of [
      ['chromium', chromium],
      ['firefox', firefox],
    ]) {
      browsers[name] = await runBrowser(name, type, expected);
    }
    console.log(
      `RESULT ${JSON.stringify({ pageOrigin: PAGE_ORIGIN, controlOrigin: CONTROL_ORIGIN, directPreflight: directPreflightResults, browsers })}`,
    );
  } finally {
    servers.forEach((s) => s.close());
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

// Instrumentação TEMPORÁRIA do diagnóstico R-02 (não faz parte da aplicação nem do repositório).
// Carregada com NODE_OPTIONS=--require=<este arquivo>; só age no processo `dist/main` da API.
// Registra em R02_OUT, sem tokens nem corpos:
// - requests.jsonl: chegada (evento 'request' do http.Server) e duração até o 'finish' de cada
//   requisição, com método, caminho sem query e status;
// - loop.jsonl: por segundo, atraso do event loop (máx, p99, média), CPU, RSS, faltas de página;
// - db.jsonl: espera por conexão do pool do pg (Pool.connect) e duração de cada Client.query.
// A escrita é em lote, assíncrona, a cada segundo, para não bloquear o caminho medido.
'use strict';
const isApi = process.argv.some((a) => /dist\/main(\.js)?$/.test(a));
if (isApi && process.env.R02_OUT) {
  const fs = require('node:fs');
  const http = require('node:http');
  const { monitorEventLoopDelay, performance } = require('node:perf_hooks');
  const out = process.env.R02_OUT;
  fs.mkdirSync(out, { recursive: true });
  const buffers = { requests: [], loop: [], db: [] };
  const push = (kind, record) => buffers[kind].push(JSON.stringify(record));
  const flush = (sync) => {
    for (const kind of Object.keys(buffers)) {
      if (buffers[kind].length === 0) continue;
      const data = buffers[kind].join('\n') + '\n';
      buffers[kind] = [];
      const file = `${out}/${kind}.jsonl`;
      if (sync) fs.appendFileSync(file, data);
      else fs.appendFile(file, data, () => {});
    }
  };

  const originalEmit = http.Server.prototype.emit;
  http.Server.prototype.emit = function (event, req, res) {
    if (event === 'request') {
      const t = Date.now();
      const started = performance.now();
      res.on('finish', () =>
        push('requests', {
          t,
          method: req.method,
          path: String(req.url).replace(/\?.*$/, ''),
          status: res.statusCode,
          ms: Number((performance.now() - started).toFixed(3)),
        }),
      );
    }
    return originalEmit.apply(this, arguments);
  };

  const delay = monitorEventLoopDelay({ resolution: 10 });
  delay.enable();
  let lastCpu = process.cpuUsage();
  setInterval(() => {
    const cpu = process.cpuUsage(lastCpu);
    lastCpu = process.cpuUsage();
    const usage = process.resourceUsage();
    push('loop', {
      t: Date.now(),
      elMaxMs: Number((delay.max / 1e6).toFixed(3)),
      elP99Ms: Number((delay.percentile(99) / 1e6).toFixed(3)),
      elMeanMs: Number((delay.mean / 1e6).toFixed(3)),
      cpuMs: Math.round((cpu.user + cpu.system) / 1000),
      rss: process.memoryUsage().rss,
      majflt: usage.majorPageFault,
    });
    delay.reset();
    flush(false);
  }, 1000).unref();
  process.on('exit', () => flush(true));

  // pg: espera por conexão do pool e duração das consultas. Carregado do node_modules da aplicação,
  // o mesmo módulo que o TypeORM usa (o cache de módulos do Node é por caminho).
  try {
    const pg = require(require.resolve('pg', { paths: [process.cwd()] }));
    const originalConnect = pg.Pool.prototype.connect;
    pg.Pool.prototype.connect = function (callback) {
      const t = Date.now();
      const started = performance.now();
      if (typeof callback === 'function') {
        return originalConnect.call(this, (err, client, release) => {
          push('db', { t, kind: 'connect', ms: Number((performance.now() - started).toFixed(3)), err: !!err });
          callback(err, client, release);
        });
      }
      return originalConnect.call(this);
    };
    const originalQuery = pg.Client.prototype.query;
    pg.Client.prototype.query = function (config) {
      const t = Date.now();
      const started = performance.now();
      const result = originalQuery.apply(this, arguments);
      if (result && typeof result.then === 'function') {
        const sql = String(typeof config === 'string' ? config : (config && config.text) || '')
          .replace(/\s+/g, ' ')
          .slice(0, 60);
        const done = (err) =>
          push('db', { t, kind: 'query', sql, ms: Number((performance.now() - started).toFixed(3)), err });
        result.then(() => done(false), () => done(true));
      }
      return result;
    };
  } catch (error) {
    push('db', { t: Date.now(), kind: 'instrumentation-error', message: String(error && error.message) });
  }
}

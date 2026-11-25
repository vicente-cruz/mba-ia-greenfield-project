// Monitores da API na repetição da P-10GB (R-02). Não fazem parte da aplicação: são carregados só
// na execução da prova, com NODE_OPTIONS=--require=<este arquivo>, e só agem no processo `dist/main`.
// Derivados do preload-v3.js do diagnóstico R-02, SEM o perfil de CPU. Escrevem em R02_OUT, sem
// tokens nem corpos:
// - requests.jsonl: chegada ao handler e duração até o 'finish' de cada requisição;
// - loop.jsonl: a cada ~1 s, a duração real desde a coleta anterior (intervalMs), o atraso máximo
//   do event loop e a CPU do processo em usuário e sistema;
// - gc.jsonl: cada pausa de coleta de lixo, com o tipo pelas constantes de node:perf_hooks;
// - db.jsonl: tempo para obter conexão do pool (Pool.connect) e duração de cada Client.query.
// A escrita é em lote, assíncrona, a cada segundo.
'use strict';
const isApi = process.argv.some((a) => /dist\/main(\.js)?$/.test(a));
if (isApi && process.env.R02_OUT) {
  const fs = require('node:fs');
  const http = require('node:http');
  const { constants, monitorEventLoopDelay, performance, PerformanceObserver } = require('node:perf_hooks');
  const out = process.env.R02_OUT;
  fs.mkdirSync(out, { recursive: true });
  const buffers = { requests: [], loop: [], db: [], gc: [] };
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

  // Pausas de coleta de lixo, com o instante de parede do início, o tipo bruto e o nome pelas
  // constantes de node:perf_hooks.
  const gcKinds = {
    [constants.NODE_PERFORMANCE_GC_MINOR]: 'minor',
    [constants.NODE_PERFORMANCE_GC_MAJOR]: 'major',
    [constants.NODE_PERFORMANCE_GC_INCREMENTAL]: 'incremental',
    [constants.NODE_PERFORMANCE_GC_WEAKCB]: 'weakcb',
  };
  new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) {
      const kind = entry.detail && entry.detail.kind;
      push('gc', {
        t: Math.round(performance.timeOrigin + entry.startTime),
        kindRaw: kind,
        kind: gcKinds[kind] || `desconhecido-${kind}`,
        flags: entry.detail && entry.detail.flags,
        ms: Number(entry.duration.toFixed(3)),
      });
    }
  }).observe({ entryTypes: ['gc'] });

  const delay = monitorEventLoopDelay({ resolution: 10 });
  delay.enable();
  let lastCpu = process.cpuUsage();
  let lastT = Date.now();
  setInterval(() => {
    const now = Date.now();
    const cpu = process.cpuUsage(lastCpu);
    lastCpu = process.cpuUsage();
    push('loop', {
      t: now,
      intervalMs: now - lastT,
      elMaxMs: Number((delay.max / 1e6).toFixed(3)),
      elP99Ms: Number((delay.percentile(99) / 1e6).toFixed(3)),
      cpuUserMs: Math.round(cpu.user / 1000),
      cpuSystemMs: Math.round(cpu.system / 1000),
      rss: process.memoryUsage().rss,
      heapUsed: process.memoryUsage().heapUsed,
      majflt: process.resourceUsage().majorPageFault,
    });
    lastT = now;
    delay.reset();
    flush(false);
  }, 1000).unref();
  process.on('exit', () => flush(true));

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

// Instrumentação TEMPORÁRIA do diagnóstico R-02, versão 3 (não faz parte da aplicação nem do
// repositório). Mudanças sobre preload-perfil.js: os tipos de coleta de lixo vêm das constantes de
// node:perf_hooks (o mapeamento anterior estava errado), e o perfil registra âncoras de tempo
// (process.hrtime e Date.now no pedido e nos callbacks de start e stop), no mesmo relógio monotônico
// dos carimbos do V8, para alinhar o perfil à parede sem depender do instante do callback. Carregada com NODE_OPTIONS=--require=<este arquivo>; só age no processo
// `dist/main` da API. Escreve em R02_OUT, sem tokens nem corpos:
// - requests.jsonl: chegada ao handler e duração até o 'finish' de cada requisição;
// - loop.jsonl: a cada ~1 s, a duração REAL desde a coleta anterior (intervalMs), o atraso máximo do
//   event loop e a CPU do processo separada em usuário e sistema (process.cpuUsage);
// - gc.jsonl: cada pausa de coleta de lixo (PerformanceObserver 'gc'), com tipo, início e duração;
// - db.jsonl: tempo para obter conexão do pool (Pool.connect) e duração de cada Client.query;
// - perfil: com o arquivo <R02_OUT>/profile.start (conteúdo: nome), inicia o perfil de CPU do V8
//   (inspector, em processo, amostragem de 1 ms); com <R02_OUT>/profile.stop, para e grava
//   <nome>.cpuprofile e <nome>-meta.json (instantes de parede no início e no fim, para alinhar o
//   perfil ao relógio).
'use strict';
const isApi = process.argv.some((a) => /dist\/main(\.js)?$/.test(a));
if (isApi && process.env.R02_OUT) {
  const fs = require('node:fs');
  const http = require('node:http');
  const inspector = require('node:inspector');
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

  // Perfil de CPU em processo, controlado por arquivos: profile.start contém o nome do perfil;
  // profile.stop encerra, grava <nome>.cpuprofile e <nome>-meta.json e remove os dois gatilhos.
  const session = new inspector.Session();
  session.connect();
  let profiling = null;
  const startFile = `${out}/profile.start`;
  const stopFile = `${out}/profile.stop`;
  setInterval(() => {
    if (!profiling && fs.existsSync(startFile) && !fs.existsSync(stopFile)) {
      const name = fs.readFileSync(startFile, 'utf8').trim() || 'perfil';
      profiling = { name, starting: true };
      const requested = { wallMs: Date.now(), hrtimeUs: Number(process.hrtime.bigint() / 1000n) };
      session.post('Profiler.enable', () =>
        session.post('Profiler.setSamplingInterval', { interval: 1000 }, () =>
          session.post('Profiler.start', () => {
            profiling.meta = {
              name,
              pid: process.pid,
              startRequested: requested,
              startCallback: { wallMs: Date.now(), hrtimeUs: Number(process.hrtime.bigint() / 1000n) },
            };
            profiling.starting = false;
            fs.writeFileSync(`${out}/${name}-meta.json`, JSON.stringify(profiling.meta));
          }),
        ),
      );
    } else if (profiling && !profiling.starting && fs.existsSync(stopFile)) {
      const current = profiling;
      profiling = { name: current.name, starting: true };
      current.meta.stopRequested = { wallMs: Date.now(), hrtimeUs: Number(process.hrtime.bigint() / 1000n) };
      session.post('Profiler.stop', (err, result) => {
        current.meta.stopCallback = { wallMs: Date.now(), hrtimeUs: Number(process.hrtime.bigint() / 1000n) };
        current.meta.error = err ? String(err.message) : null;
        if (!err) fs.writeFileSync(`${out}/${current.name}.cpuprofile`, JSON.stringify(result.profile));
        fs.writeFileSync(`${out}/${current.name}-meta.json`, JSON.stringify(current.meta));
        fs.rmSync(startFile, { force: true });
        fs.rmSync(stopFile, { force: true });
        profiling = null;
      });
    }
  }, 200).unref();

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

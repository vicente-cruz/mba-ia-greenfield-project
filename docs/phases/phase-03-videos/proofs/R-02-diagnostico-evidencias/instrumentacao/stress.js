// Estressor TEMPORÁRIO do diagnóstico R-02: lê um arquivo e calcula o SHA-256 em blocos de 1 MiB,
// como o cliente de upload faz nos checksums, em passadas repetidas por N segundos.
// Uso: node stress.js <warm|cold> <segundos> <arquivo>
// - warm: lê do cache de páginas (o arquivo já foi lido antes);
// - cold: antes de cada passada, descarta o cache do arquivo (`dd iflag=nocache count=0`, sem
//   privilégio), para que a leitura vá ao disco.
'use strict';
const { createHash } = require('node:crypto');
const { createReadStream, statSync } = require('node:fs');
const { spawnSync } = require('node:child_process');
const { performance } = require('node:perf_hooks');
const [mode, seconds, file] = process.argv.slice(2);
if (!['warm', 'cold'].includes(mode) || !Number(seconds) || !file) {
  console.error('uso: node stress.js <warm|cold> <segundos> <arquivo>');
  process.exit(64);
}
const size = statSync(file).size;
const end = Date.now() + Number(seconds) * 1000;
(async () => {
  let passes = 0;
  let bytes = 0;
  const started = performance.now();
  while (Date.now() < end) {
    if (mode === 'cold') {
      spawnSync('dd', [`if=${file}`, 'iflag=nocache', 'count=0', 'status=none']);
    }
    const t0 = performance.now();
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(file, { highWaterMark: 1 << 20 })) {
      hash.update(chunk);
      if (Date.now() >= end) break;
    }
    hash.digest('hex');
    const ms = performance.now() - t0;
    passes += 1;
    bytes += size;
    console.log(`passada ${passes} | ${mode} | ${(size / 1048576 / (ms / 1000)).toFixed(1)} MiB/s | ${ms.toFixed(0)} ms`);
  }
  const total = (performance.now() - started) / 1000;
  console.log(`fim | ${mode} | ${passes} passadas em ${total.toFixed(1)} s`);
})();

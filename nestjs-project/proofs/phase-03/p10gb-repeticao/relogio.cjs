// Repetição da P-10GB (R-02): diferença entre o relógio da VM do Docker (sondas, API, amostras) e o
// do Windows (cliente de upload). Roda com o Node do Windows: cerca cada leitura do relógio da VM
// (`docker.exe exec <container> date +%s%3N`) entre duas leituras do relógio do Windows e fica com a
// medida de menor ida e volta. Diferença = VM − (t1 + t2) / 2; incerteza = (t2 − t1) / 2.
// Uso: node.exe relogio.cjs <container> [medidas]
'use strict';
const { execFileSync } = require('node:child_process');
const [container, n = '15'] = process.argv.slice(2);
const samples = [];
for (let i = 0; i < Number(n); i++) {
  const t1 = Date.now();
  const vm = Number(execFileSync('docker.exe', ['exec', container, 'date', '+%s%3N']).toString().trim());
  const t2 = Date.now();
  samples.push({ t1, t2, vm, rttMs: t2 - t1, offsetMs: vm - (t1 + t2) / 2 });
}
samples.sort((a, b) => a.rttMs - b.rttMs);
const best = samples[0];
console.log(JSON.stringify({ offsetMs: Math.round(best.offsetMs), uncertaintyMs: Math.ceil(best.rttMs / 2), atWindowsMs: best.t1, samples }));

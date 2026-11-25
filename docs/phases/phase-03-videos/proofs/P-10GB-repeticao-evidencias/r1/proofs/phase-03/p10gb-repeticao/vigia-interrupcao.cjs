// Vigia da interrupção na repetição da P-10GB (R-02). Roda NO WINDOWS, com o Node do Windows, na pasta
// do cliente. Lê a cada 50 ms o progresso que o cliente grava e, quando a fração pedida das partes do
// plano já teve o PUT concluído (o mesmo limite do `interrupt-when`: ceil(partCount × fração)), cria o
// arquivo de gatilho que o ctrl-c.ps1 armado espera; ele envia um Ctrl+C real ao console do cliente.
// O cliente trata o SIGINT, aborta os PUTs em andamento e sai com 130. Não encerra o processo à força.
// Por que no Windows: lido pelo WSL (/mnt/c), o arquivo fica aberto sem compartilhamento de exclusão, e
// a troca atômica do progresso pelo cliente (arquivo temporário e rename) falha com EPERM
// (pré-checagem de 2026-11-25). O Node no Windows abre arquivos com compartilhamento de leitura,
// escrita e exclusão.
// Uso: node.exe vigia-interrupcao.cjs <progresso.json> <fração> <pid do console> <arquivo de gatilho>
'use strict';
const fs = require('node:fs');
const [progressPath, fractionArg, consolePid, triggerFile] = process.argv.slice(2);
const fraction = Number(fractionArg);
const deadline = Date.now() + 30 * 60_000;
const alive = (pid) => {
  try {
    process.kill(Number(pid), 0);
    return true;
  } catch {
    return false;
  }
};
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
for (;;) {
  let progress = null;
  try {
    progress = JSON.parse(fs.readFileSync(progressPath, 'utf8'));
  } catch {
    // O cliente ainda não gravou o progresso.
  }
  if (progress && progress.partCount) {
    const threshold = Math.ceil(progress.partCount * fraction);
    if (['done', 'failed'].includes(progress.phase) || !alive(progress.pid)) {
      console.log(`VIGIA | o cliente terminou (${progress.phase}) com ${progress.putDone.length} de ${progress.partCount} partes antes do limite de ${threshold}`);
      process.exit(1);
    }
    if (progress.putDone.length >= threshold) {
      const sent = Date.now();
      fs.writeFileSync(triggerFile, String(sent));
      console.log(`VIGIA | gatilho do Ctrl+C real criado em ${sent} (relógio do Windows) para o console ${consolePid}, com ${progress.putDone.length} de ${progress.partCount} partes com PUT concluído (limite: ${threshold}) | PUT concluído: [${progress.putDone.join(',')}] | registradas: [${progress.registered.join(',')}] | em andamento: [${progress.inFlight.join(',')}]`);
      process.exit(0);
    }
  } else if (!alive(consolePid)) {
    console.log('VIGIA | o console do cliente terminou antes de gravar o progresso');
    process.exit(1);
  }
  if (Date.now() > deadline) {
    console.log('VIGIA | o limite não foi atingido em 30 min');
    process.exit(1);
  }
  sleep(50);
}

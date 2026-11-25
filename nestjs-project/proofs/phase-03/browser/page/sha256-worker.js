'use strict';
// Worker da medição de SHA-256 (V-09, parte de navegador). Lê uma parte por vez com
// `File.slice().arrayBuffer()`, calcula o digest com Web Crypto e descarta o buffer antes da
// próxima parte, de modo que a memória fica limitada a uma parte (64 MiB).
function toBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let text = '';
  for (let i = 0; i < bytes.length; i += 1) {
    text += String.fromCharCode(bytes[i]);
  }
  return btoa(text);
}

self.onmessage = async (event) => {
  const { file, partBytes } = event.data;
  try {
    const parts = [];
    for (let index = 0, offset = 0; offset < file.size; index += 1, offset += partBytes) {
      const t0 = performance.now();
      const buffer = await file.slice(offset, Math.min(offset + partBytes, file.size)).arrayBuffer();
      const t1 = performance.now();
      const digest = await crypto.subtle.digest('SHA-256', buffer);
      const t2 = performance.now();
      parts.push({ index, readMs: t1 - t0, hashMs: t2 - t1, digest: toBase64(digest) });
    }
    const inWorker =
      typeof WorkerGlobalScope !== 'undefined' && self instanceof WorkerGlobalScope;
    self.postMessage({ parts, inWorker });
  } catch (error) {
    self.postMessage({ error: `${error.name}: ${error.message}` });
  }
};

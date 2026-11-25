'use strict';
// Página da prova de navegador (V-08 e V-09). Executada pelo Playwright em Chromium e Firefox.
// Não é código do frontend: só reproduz, com a API do navegador, o envio de uma parte para uma
// URL pré-assinada e o cálculo de SHA-256 por parte num Worker.
(function () {
  /** Mesmo conteúdo determinístico que `pattern()` de v08-browser-urls.ts gera no Node. */
  function pattern(seed, length) {
    const out = new Uint8Array(length);
    for (let i = 0; i < length; i += 1) {
      out[i] = (seed * 131 + i * 31 + (i >>> 8) * 7) & 0xff;
    }
    return out;
  }

  /**
   * PUT de uma parte na URL pré-assinada, com o header de checksum assinado. O Content-Length é
   * definido pelo navegador a partir do corpo; o script não pode defini-lo (header proibido).
   */
  async function runCase(spec) {
    const bytes = pattern(spec.seed, spec.sendSize);
    const init = { method: 'PUT', headers: { 'x-amz-checksum-sha256': spec.checksum } };
    if (spec.body === 'stream') {
      let offset = 0;
      init.body = new ReadableStream({
        pull(controller) {
          if (offset >= bytes.length) {
            controller.close();
            return;
          }
          const end = Math.min(offset + 65536, bytes.length);
          controller.enqueue(bytes.slice(offset, end));
          offset = end;
        },
      });
      init.duplex = 'half';
    } else {
      init.body = new Blob([bytes]);
    }
    const result = {
      status: 0,
      etag: null,
      errorCode: '',
      exception: '',
      responseReceived: false,
    };
    try {
      const response = await fetch(spec.url, init);
      result.responseReceived = true;
      result.status = response.status;
      result.etag = response.headers.get('ETag');
      const text = await response.text();
      const code = /<Code>([^<]*)<\/Code>/.exec(text);
      if (code) {
        result.errorCode = code[1];
      }
    } catch (error) {
      result.exception = `${error.name}: ${error.message}`;
    }
    return result;
  }

  /**
   * SHA-256 do arquivo selecionado, uma parte por vez, num Worker. Mede também o maior atraso
   * de um timer de 50 ms na thread principal durante o cálculo.
   */
  async function hashSelectedFile(options) {
    const file = document.getElementById('hash-file').files[0];
    if (!file) {
      throw new Error('nenhum arquivo selecionado');
    }
    const worker = new Worker('/sha256-worker.js');
    let maxLag = 0;
    let last = performance.now();
    const timer = setInterval(() => {
      const now = performance.now();
      maxLag = Math.max(maxLag, now - last - 50);
      last = now;
    }, 50);
    const started = performance.now();
    try {
      const data = await new Promise((resolve, reject) => {
        worker.onmessage = (event) => resolve(event.data);
        worker.onerror = (event) => reject(new Error(event.message));
        worker.postMessage({ file, partBytes: options.partBytes });
      });
      const totalMs = performance.now() - started;
      if (data.error) {
        throw new Error(data.error);
      }
      return {
        totalMs,
        parts: data.parts,
        inWorker: data.inWorker,
        mainThreadMaxLagMs: Math.max(0, maxLag),
      };
    } finally {
      clearInterval(timer);
      worker.terminate();
    }
  }

  window.proof = { runCase, hashSelectedFile, secureContext: window.isSecureContext };
})();

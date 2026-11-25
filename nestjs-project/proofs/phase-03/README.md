# Scripts de prova — Fase 03

Scripts das provas de viabilidade e das provas documentadas da Fase 03. Não fazem parte da aplicação:

- ficam fora do build: o `tsconfig.build.json` exclui `proofs/`, então `npm run build` não emite nada desta pasta;
- entram no type-check: `npx tsc --noEmit` usa o `tsconfig.json`, que cobre `proofs/` junto com `src/` e `test/`;
- os scripts TypeScript rodam dentro do container `nestjs-api` (`npx ts-node proofs/phase-03/<script>.ts`), contra o ambiente real do Compose (storage, Redis e Postgres pelos nomes de serviço);
- os roteiros `*-roteiro.sh` rodam no host, a partir de `nestjs-project/`, porque também usam o Docker e as portas publicadas. Eles chamam os scripts TypeScript no container.

| Prova | Roteiro | Script | O que usa |
|-------|---------|--------|-----------|
| V-01 | `v01-roteiro.sh [saída]` | `v01-storage-config.ts` | Instância principal só para leitura; instância isolada do Silo, com volume temporário, para as escritas e a expiração curta |
| V-03 | `v03-roteiro.sh [saída]` | `v03-presigned-urls.ts` | Credencial da aplicação e prefixo temporário `proofs/v03-<runId>/` no bucket principal, removido no final |
| V-02 | `storage-proof-roteiro.sh v02 [saída]` | `v02-content-length.ts` | Credencial da aplicação e prefixo temporário `proofs/v02-<runId>/`, removido no final; retratos do bucket comparados |
| V-09 (servidor) | `storage-proof-roteiro.sh v09 [saída]` | `v09-checksum-server.ts` | Idem, com o prefixo `proofs/v09-<runId>/` |
| V-10 | `storage-proof-roteiro.sh v10 [saída]` | `v10-complete-retry.ts` | Idem, com o prefixo `proofs/v10-<runId>/` e chaves `originals/{videoId}/{sessionId}` abaixo dele |
| V-04 | `storage-proof-roteiro.sh v04 [saída]` | `v04-ffmpeg-signed-url.ts` | Fixtures de `test/fixtures/videos/` (geradas por `generate.sh`) e um objeto de 303 MB gerado na hora, no prefixo temporário `proofs/v04-<runId>/`; proxy HTTP local para registrar as requisições Range e servidor local que não envia bytes |
| V-08 e V-09 (navegador) | `browser-proof-roteiro.sh [saída]` | `v08-browser-urls.ts` (no `nestjs-api`) e `browser/` (no `proof-browser`) | Serviço `proof-browser` do perfil `proofs` (imagem oficial do Playwright 1.60.0), página em `http://localhost:4173` (origem incluída em `MINIO_API_CORS_ALLOW_ORIGIN`), prefixo temporário `proofs/v08-<runId>/` e arquivo de 1 GiB no `/tmp` do container |
| V-06 | `bullmq-proof-roteiro.sh v06 [saída]` | `v06/` (módulo Nest, processor `WorkerHost` e `v06.integration-spec.ts`) | Redis do Compose com o prefixo `proofs-v06-<pid>`. A spec roda com `npx jest --rootDir . --roots '<rootDir>/proofs/phase-03/v06'`, fora da suíte normal (`rootDir: src`) |
| V-11 | `bullmq-proof-roteiro.sh v11 [saída]` | `v11-bullmq-behavior.ts` (`core`, `maintenance`, `cleanup` e `snapshot`) | Redis do Compose com o prefixo `proofs-v11-<runId>`; workers em processos filhos para `SIGKILL`, `SIGSTOP` e `SIGTERM` reais; `docker compose stop redis` e `start` durante a manutenção; `SAVE` final do conjunto restaurado |
| V-07 | `v07-roteiro.sh [saída]` | `upload-client.ts`, `responsiveness-probe.ts` e `upload-proof-support.ts` | A API real (`nestjs-api:3000`, servida com `npm run start:dev`), dois usuários de prova `v07-<runId>-uploader` e `v07-<runId>-control` `@proofs.streamtube.test`, um arquivo sintético no `/tmp/v07-<runId>/` do `nestjs-api`, a sonda num container próprio (`v07-<runId>-probe`) e o `du`/`df` do volume do storage |
| P-10GB (SI-03.33) | `p10gb-roteiro.sh [saída]` | `upload-client.ts`, `responsiveness-probe.ts` e `upload-proof-support.ts` (`latency-verdict`) | O mesmo arranjo da V-07, com 10.000.000.000 bytes: dois usuários de prova `p10gb-<runId>-uploader` e `p10gb-<runId>-control`, o arquivo sintético no `/tmp/p10gb-<runId>/` do `nestjs-api` e 4 instâncias da sonda, cada uma num container próprio (`p10gb-<runId>-probe-<i>`). Exige 29,5 GB livres na unidade C: |
| P-10GB, repetição (SI-03.33, R-02) | `p10gb-repeticao-roteiro.sh [saída]` | Os mesmos scripts, compilados para JS, e os auxiliares de `p10gb-repeticao/` | A API pelo build (`npm run build` e `npm run start:prod`), 13 sondas compiladas executadas com `node` em containers próprios (`p10gbr-<runId>-probe-<i>`), o cliente compilado no Node do Windows, com o arquivo de 10 GB na pasta temporária do Windows, e dois usuários de prova `p10gbr-<runId>-uploader` e `p10gbr-<runId>-control`. Exige a API **parada** no início e 29,5 GB livres na unidade C: |
| Fluxo completo (SI-03.32) | `fluxo-completo-roteiro.sh [saída]` | `upload-client.ts` e `upload-proof-support.ts` (`flow-check`) | A API real e o `video-worker`, um usuário de prova `fluxo-<runId>-uploader@proofs.streamtube.test` e um MP4 H.264/AAC gerado com o FFmpeg da imagem no `/tmp/fluxo-<runId>/` do `nestjs-api`. Os temporários que o Silo já guardava em `.minio.sys/tmp` só são listados, antes e depois |

### Cliente de prova, sonda e apoio (SI-03.31)

São os scripts das provas que passam pela API real: a V-07, o fluxo completo (SI-03.32) e a P-10GB (SI-03.33). Os cabeçalhos dos scripts trazem todas as opções.

- **`upload-client.ts`:** cliente de prova do upload, que reproduz o contrato do futuro cliente (TD-01 e TD-02).
  - **Partes e checksums:** fatias de exatamente `expectedSize` bytes, com o SHA-256 de cada parte lido em blocos de 1 MiB e calculado à frente da assinatura.
  - **Envio:** `part-urls` em lotes de até 10 partes e PUT com 4 partes simultâneas. Os ETags vão à API a cada 4 PUTs concluídos, com prioridade sobre a próxima assinatura, e os pedidos de `part-urls` respeitam 1,1 s entre si (o limite da rota é de 60 por minuto por IP).
  - **Interrupção e retomada:** SIGINT ou SIGTERM abortam os PUTs em andamento, e o cliente sai com 130 ou 143. A retomada (`resume`) faz o GET da sessão, recalcula o checksum das partes `confirmed` e `unregistered`, confere o arquivo por `file-verifications` e reenvia só as partes `missing`, `divergent` e `unregistered`.
  - **Conclusão:** `completion` e polling a cada 2 s até `ready` ou `error`.
  - **Token:** renova o access token por `POST /auth/refresh` quando faltam 120 s para expirar, antes de cada chamada e a cada 15 s, e grava o par novo no arquivo de credenciais.
  - **Storage:** as URLs assinadas apontam para `localhost:9000` (o `S3_PUBLIC_ENDPOINT`). Dentro de um container, `--storage-connect localhost:9000=storage:9000` conecta no serviço `storage` mantendo o `Host` assinado, como o `curl --connect-to`.
  - **Subcomandos:** `generate` (arquivo sintético determinístico), `start`, `resume` e `complete`.
  - **Arquivos:** grava o estado (`publicId` e sessão), os eventos com instante (JSON por linha) e o progresso. Nenhum deles traz token, senha ou URL assinada.
- **`responsiveness-probe.ts`:** a sonda de latência com o contrato da SI-03.33.
  - Faz `GET /videos/:publicId` de um vídeo de controle em `draft`, autenticada como o dono, a cada 2 s em grade fixa e com timeout de 5 s.
  - Lê `{ email, password }` da entrada padrão e faz o próprio login; renova o token depois de uma amostra, fora da medição.
  - Escreve em stdout o CSV `instance,seq,instant,epoch_ms,status,latency_ms,outcome` e, em stderr, o resumo.
  - Roda num container próprio, com `node -r ts-node/register` para ser o PID 1 e receber o SIGTERM do `docker kill`.
- **`upload-proof-support.ts`:** apoio que roda no `nestjs-api`.
  - **Preparo:** `api-check`; `account`, que registra o usuário de prova, o confirma pelo e-mail do Mailpit e faz login, gravando as credenciais com modo 0600; `control-video`.
  - **Evidências:** `parts-snapshot` (registro da API e `ListParts`, só leitura), `compare-parts`, `interrupt-when` (o vigia que envia o sinal ao cliente quando uma fração das partes teve o PUT concluído) e `summarize` (medidas e projeção). No `summarize`, os bytes e o throughput são os dos PUTs concluídos: os bytes parciais dos PUTs abortados não são medidos, e o tempo deles conta.
  - **Vereditos de latência (`latency-verdict`, SI-03.33):** separa as amostras da sonda em aquecimento, base, carga e fora.
    - **Base:** de quando todas as instâncias amostram até o lançamento do cliente, pelos instantes que o roteiro passa.
    - **Carga:** só os intervalos de upload ativo dos eventos do cliente.
    - **Percentis:** pelo posto mais próximo, sobre todas as amostras da fase.
    - **Critérios:** aplica os critérios (a), (b) e (c) da SI-03.33, com o mínimo de 300 amostras por fase, e calcula o `N` para uma repetição.
    - **Incerteza do relógio do cliente (`--clock-uncertainty-ms`, padrão 0):** usada quando o cliente roda em outro relógio, como na repetição da P-10GB.
      - **Recorte:** os intervalos de carga continuam os nominais.
      - **Amostras de borda:** as que estão a até `u` ms de um início ou de um fim. A análise considera cada uma dentro ou fora da carga e calcula a carga certa, a possível, as faixas de p95 e p99 e os vereditos possíveis.
      - **Regra:** se a incerteza puder alterar (a), (b) ou a suficiência de amostras, o critério fica `inconclusivo`, com o veredito nominal registrado ao lado.
  - **Fluxo completo (`flow-check`, SI-03.32):** confere, depois do `ready`:
    - o arquivo enviado: ffprobe, caixas de topo do MP4 (sem preenchimento) e SHA-256;
    - o `202` e o `ready`, pelos eventos do cliente;
    - os metadados da API contra o ffprobe do arquivo;
    - o `thumbnail_key` e o objeto da thumbnail (`HeadObject`, JPEG e dimensões);
    - três requisições `Range` na `playback-url`, no início, no meio e no fim, com `206`, `Content-Range` e bytes iguais aos do arquivo;
    - o SHA-256 do download pela `download-url`.

    As URLs assinadas são usadas só em memória; o resultado registra o host, o caminho e se a URL estava assinada.
  - **Retrato e limpeza:** `snapshot` e `cleanup`. A limpeza só aceita e-mails `<prova>-<runId>-<papel>@proofs.streamtube.test` e remove só os recursos desses usuários: multiparts, linhas, jobs, objetos e e-mails do Mailpit.

O `v07-roteiro.sh` mede no ambiente real um upload de 1.000.000.000 bytes, ajustável por `V07_SIZE_BYTES`:

- interrupção por SIGINT com metade das partes enviadas e retomada até o `202`;
- polling até o estado final;
- o pico de disco do storage, com amostras de 0,25 s e um `df` sem pausa em volta do completion;
- o espaço livre no host.

O roteiro só começa a medir com a lixeira do Silo vazia. Depois da limpeza, espera a purga que libera o disco. Exige a API servida no `nestjs-api`.

O `p10gb-roteiro.sh` repete o arranjo da V-07 com 10.000.000.000 bytes e 4 instâncias da sonda:

- **Espaço:** confere antes o espaço livre na unidade C: e para se ele for menor que os 29,5 GB exigidos pela V-07 (`P10GB_MIN_FREE_BYTES`).
- **Base:** 600 s com as 4 instâncias, sem upload.
- **Upload:** interrompido por SIGINT a 50% e retomado até o `202`.
- **Vereditos:** calculados com o `latency-verdict`.
- **Resíduos:** na limpeza, compara os temporários do Silo de antes e de depois, separando os anteriores dos novos, que não são removidos.

O `p10gb-repeticao-roteiro.sh` é a repetição formal da P-10GB, com registro prévio próprio em `P-10GB-repeticao.md`. A execução reprovada e o `p10gb-roteiro.sh` ficam preservados. Mantém o contrato da P-10GB e muda só o modo de execução, o do ensaio compilado do diagnóstico R-02:

- **API e sondas:** a API sobe pelo build, sem watch, com os monitores de `p10gb-repeticao/monitor-api.cjs`. As sondas são o `responsiveness-probe.ts` compilado uma vez com `tsc` e executado com `node`, com o JS montado só para leitura (`-v` do `docker compose run`). São 13 instâncias (registro prévio r2, mantido na r3), lançadas com 154 ms (2000/13) entre si.
- **Cliente:** o `upload-client.ts` compilado roda no Node nativo do Windows, pelo `localhost` do Windows. O `iniciar-windows.ps1` o inicia num console próprio, com o processamento de Ctrl+C reativado.
- **Interrupção:** um Ctrl+C real, nunca um encerramento forçado:
  - o `ctrl-c.ps1` é armado antes do cliente e envia `CTRL_C_EVENT` ao console dele quando aparece o arquivo de gatilho;
  - o `vigia-interrupcao.cjs`, que roda no Node do Windows, cria esse gatilho quando `ceil(partes × 0,5)` PUTs terminaram;
  - o cliente trata o SIGINT e sai com 130.
- **Relógios:**
  - **Medida:** o `relogio.cjs` mede, antes da base e depois da carga, a diferença entre o relógio do Windows e o da VM.
  - **Conversão:** o `eventos-relogio-vm.py` faz a conversão nominal dos eventos do cliente para o relógio da VM, sem encolher nem descartar intervalos, inclusive o da liberação ao `202`.
  - **Incerteza:** fica registrada à parte (`relogio.json`) e vai ao `latency-verdict --clock-uncertainty-ms`, que analisa as amostras de borda.
- **Base:** termina antes de armar o envio do Ctrl+C, para que a partida do PowerShell não entre nela.
- **Monitores:** amostrador da VM (`amostrador-vm.sh`), sonda do PostgreSQL (`sonda-db.sh`), `docker stats` e monitor do Windows (`monitor-windows.ps1`). A memória é medida com as 13 sondas em execução, e o roteiro confere que todas estão no ar antes de medir. Os 4 GiB livres no Windows são só uma referência informativa.
- **Trava:** acima de 1.000.000.000 bytes, o roteiro exige `P10GB_CONFIRMA_10GB=sim` e, sem ela, sai com 64 antes de criar recursos. As pré-checagens usam `P10GB_SIZE_BYTES=1000000000`, `P10GB_BASELINE_SECONDS=60` e `P10GB_ROTULO=pre-checagem`.
- **Falhas:** as etapas rodam dentro de `step`, onde o `set -e` não vale. Por isso cada comando obrigatório verifica o próprio código (`|| { falha $? "…"; return; }`, registro prévio r3).
  - **Antes do upload:** a falha aparece no resultado da etapa e encerra o roteiro, que segue para a limpeza. É o caso do build, do `tsc` e das cópias, das pastas e auxiliares, das contas e do `CONTROL_ID`, da sonda do banco e dos monitores, entre outros.
  - **Depois do upload:** a falha fica registrada na etapa, a coleta continua, e a primeira falha define o código final.
- **Limpeza:** remove as sondas, os monitores, o cliente, a API, as pastas no container e no Windows, o JS compilado e os recursos do runId. Depois, espera a purga da lixeira e compara os retratos e os temporários do Silo.
- **Controles sem upload (`p10gb-repeticao/controles.sh`):**
  - **`veredito <saída>`:** casos sintéticos do `latency-verdict` com a incerteza, gerados por `controles-veredito.py`: intervalo menor que a incerteza, amostra lenta na borda, contagem perto de 300, reprovação robusta, incerteza zero e base dentro da incerteza.
  - **`reprocessa <pré-checagem> <saída>`:** conversão nominal e veredito sobre as evidências arquivadas, sem alterá-las.
  - **`falhas <saída> [roteiro] [modos]`:** roda o roteiro inteiro com uma falha por vez, injetada por shims de `docker` e `cp` no `PATH`.
    - **Modos:** pastas, auxiliares, build, `tsc`, cópias, credenciais, `CONTROL_ID` e sonda do banco.
    - **O que confere:** a etapa com a falha registrada, a etapa seguinte não iniciada e a limpeza completa.
    - **Sentinelas:** shims de `node.exe` e `powershell.exe` bloqueiam a geração do arquivo antes da hora e qualquer início de upload.
  - **`funcoes <saída> <pré-checagem 4> <caso sintético>`:** carrega só as funções do roteiro, sem o fluxo principal.
    - **Com falha injetada:** confere que cada etapa auditada retorna erro.
    - **Sem falha:** confere que o resumo e o veredito do roteiro reproduzem o reprocessamento da pré-checagem 4.

O `fluxo-completo-roteiro.sh` gera no `nestjs-api` um MP4 de 180 s, 1280x720 a 30 fps, H.264 a 4 Mb/s e AAC a 128 kb/s, de fontes sintéticas do FFmpeg (`testsrc2` e `sine`), ajustáveis por `FLUXO_DURATION_SECONDS` e `FLUXO_VIDEO_BITRATE`. Depois:

- registra o tempo de geração, o tamanho e o SHA-256;
- envia o vídeo pelo `upload-client.ts start`, com o completion e o polling até o estado final;
- roda o `flow-check`;
- na limpeza, remove só os recursos do runId, espera a purga da lixeira e compara os retratos e a lista de temporários do Silo de antes e de depois. Exige a API servida no `nestjs-api` e o `video-worker` no ar.

`proof-support.ts` reúne o que os scripts compartilham:

- leitura do `.env` sem imprimir valores;
- o cliente S3 da aplicação;
- o registro dos itens verificados (obrigatórios e informativos);
- o retrato do bucket;
- o `PUT` HTTP com `Expect: 100-continue`;
- a limpeza por prefixo;
- o despachante dos subcomandos `run`, `cleanup` e `snapshot`.

Cada roteiro grava um log no diretório de saída (por padrão, um `mktemp -d`) e remove os recursos temporários num `trap EXIT`, inclusive em caso de erro. O `bullmq-proof-roteiro.sh` também garante o serviço `redis` no ar e saudável na limpeza, mesmo que o roteiro seja interrompido com o Redis parado, e compara o Redis antes e depois: chaves e tipos, política de memória e clientes conectados. O código de saída é 0 só quando todas as etapas e a limpeza passam. Se o roteiro for interrompido ou uma etapa falhar, sai com o código dessa falha original; se só a limpeza falhar, sai com o código dela.

`browser/` tem os arquivos que rodam dentro do `proof-browser`. São JavaScript, fora do `tsc` do nestjs-project:

- `run.sh`: instala o `playwright-core` do `package-lock.json` em `/tmp` do container e gera o arquivo da medição;
- `run-browser.cjs`: o roteiro dos navegadores;
- `page/`: a página de prova e o Worker do SHA-256.

O diretório é montado somente leitura.

O modelo e os relatórios ficam em `docs/phases/phase-03-videos/proofs/`.

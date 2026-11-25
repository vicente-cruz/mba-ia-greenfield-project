# StreamTube — API e worker de vídeos (`nestjs-project`)

Backend da StreamTube em NestJS 11: a API REST (`src/main.ts`) e o worker de vídeos (`src/worker.ts`), que usam o mesmo código e a mesma imagem. As convenções de desenvolvimento (comandos sempre no container, tipos de teste, `.env`) ficam no [`CLAUDE.md`](CLAUDE.md).

Todos os comandos abaixo rodam a partir de `nestjs-project/`. Os comandos `npm` e `npx` rodam **dentro** do container (`docker compose exec nestjs-api …`); os comandos `docker compose` e os roteiros de prova `*-roteiro.sh` rodam no host.

## Ambiente

### Serviços

| Serviço | O que é | Portas no host |
|---------|---------|----------------|
| `nestjs-api` | API NestJS. O container só roda `tail -f /dev/null`; o servidor sobe sob demanda | `3000` |
| `video-worker` | Worker de processamento e manutenção (BullMQ + FFmpeg). Sobe com `docker compose up` (exceção da TD-10, ver `CLAUDE.md`) | — |
| `db` | PostgreSQL 17 | `5432` |
| `mailpit` | Captura de e-mails (SMTP e interface web) | `1025` e `8025` |
| `storage` | Storage S3 compatível (`pgsty/silo`, fork comunitário do MinIO, fixado por tag e digest), volume `storage-data` | `9000` (API S3) e `9001` (console) |
| `storage-init` | Execução única: cria o bucket privado `S3_BUCKET` e a credencial da aplicação restrita a ele | — |
| `redis` | Redis 8.8.4 das filas `video-processing` e `video-maintenance`, com `noeviction`, volume `redis-data` | — (só `redis:6379` na rede do Compose) |
| `proof-browser` | Imagem do Playwright para as provas de navegador (V-08 e V-09). Só sobe com `--profile proofs` | — |

### Subir o ambiente

```bash
cp .env.example .env          # só na primeira vez; revise as credenciais antes de subir
docker compose up -d
docker compose exec nestjs-api npm install        # só na primeira vez
docker compose exec nestjs-api npm run migration:run
```

As migrations não rodam sozinhas: a configuração do TypeORM usa `synchronize: false` e nenhuma usa `migrationsRun`. O `migration:run` aplica as pendentes. Se o `node_modules` ainda não existia quando o ambiente subiu, o `video-worker` termina logo ao iniciar, porque o comando dele chama `node_modules/.bin/nest`. Depois do `npm install`, suba-o de novo com `docker compose up -d video-worker`.

### Conferir a prontidão

```bash
docker compose ps                     # db, mailpit, storage e redis "running (healthy)"; nestjs-api e video-worker "running"
docker compose ps -a storage-init     # "Exited (0)"
docker compose exec db pg_isready -U streamtube                      # accepting connections
docker compose exec storage curl -fsS -o /dev/null -w '%{http_code}\n' http://localhost:9000/minio/health/ready   # 200
docker compose exec redis redis-cli ping                             # PONG
docker compose exec redis redis-cli config get maxmemory-policy      # noeviction
docker compose logs video-worker | grep 'video-worker started'       # video-worker started (pid N)
```

O host usa um proxy corporativo que não exclui `localhost`. Por isso, um `curl` feito do host para uma porta publicada precisa de `--noproxy '*'`; sem isso, o proxy responde `503`.

### Rodar a API

Só quando for preciso servir a aplicação. O processo não termina, então rode-o em segundo plano:

```bash
docker compose exec nestjs-api npm run start:dev
curl --noproxy '*' http://localhost:3000          # 200 e "Hello World!"
```

### Testes

```bash
docker compose exec nestjs-api npm test -- --runInBand            # unitários e integração
docker compose exec nestjs-api npm run test:e2e -- --runInBand    # e2e
```

As suítes de integração e e2e usam o banco, o storage, o Redis e o `video-worker` reais do Compose (R-10 e TD-15, com a exceção IC-3 ao guia de testes). Por isso, precisam do ambiente pronto, com o worker no ar. Elas compartilham o banco e controlam as filas pelos helpers de `test/helpers/queues.ts`. Não rode provas ao mesmo tempo que as suítes.

## Provas da Fase 03

- **Scripts:** ficam em [`proofs/phase-03/`](proofs/phase-03/README.md), cujo README detalha o que cada um usa e como limpa os recursos. Os scripts TypeScript rodam no container `nestjs-api`. Os roteiros `*-roteiro.sh` rodam no host e chamam esses scripts no container.
- **Logs:** cada roteiro grava o log no diretório de saída, que é o segundo argumento dos roteiros com subcomando e o primeiro dos outros. Sem o argumento, o roteiro usa um `mktemp -d`. Os recursos temporários são removidos num `trap EXIT`, mesmo em caso de erro, e o código de saída é 0 só quando todas as etapas e a limpeza passam.
- **Relatórios:** ficam em [`docs/phases/phase-03-videos/proofs/`](../docs/phases/phase-03-videos/proofs/README.md), que também traz o modelo e a regra de resultado (`aprovada` ou `reprovada`). Os roteiros não escrevem o relatório: ele é preenchido a partir do log. Uma prova só conta como executada quando o relatório existe nessa pasta.

### Provas existentes

As nove primeiras foram executadas e aprovadas em 2026-11-18; a V-07 e o fluxo completo, em 2026-11-24. A P-10GB foi executada em 2026-11-24 e saiu **reprovada** nos critérios de latência (ver "Orientação sobre as provas grandes"). A repetição formal dela, com registro prévio próprio (r3), foi executada uma vez em 2026-11-25 e saiu **aprovada**, o que a revisão confirmou: a SI-03.33 está aprovada, e a Fase 03 está concluída, com 33/33 SIs. A P-10GB original continua reprovada no histórico. Os relatórios trazem as execuções, as versões e as evidências.

| Prova | Comando (host, em `nestjs-project/`) | Relatório |
|-------|--------------------------------------|-----------|
| V-01 — variáveis `MINIO_*`, `mc`, CORS e idade do multipart incompleto | `proofs/phase-03/v01-roteiro.sh [saída]` | `V-01.md` |
| V-03 — URLs pré-assinadas do AWS SDK contra o Silo | `proofs/phase-03/v03-roteiro.sh [saída]` | `V-03.md` |
| V-02 — recusa de `UploadPart` com tamanho diferente do assinado | `proofs/phase-03/storage-proof-roteiro.sh v02 [saída]` | `V-02.md` |
| V-09 (parte de servidor) — checksum SHA-256 assinado | `proofs/phase-03/storage-proof-roteiro.sh v09 [saída]` | `V-09.md` |
| V-10 — Complete repetido e guardas opcionais | `proofs/phase-03/storage-proof-roteiro.sh v10 [saída]` | `V-10.md` |
| V-04 — FFmpeg 5.1 sobre URL assinada, formatos, timeouts e reconexões | `proofs/phase-03/storage-proof-roteiro.sh v04 [saída]` | `V-04.md` |
| V-08 e V-09 (navegador) — PUT em Chromium e Firefox reais | `proofs/phase-03/browser-proof-roteiro.sh [saída]` | `V-08.md` e `V-09.md` |
| V-06 — BullMQ e `@nestjs/bullmq` em CommonJS com Jest | `proofs/phase-03/bullmq-proof-roteiro.sh v06 [saída]` | `V-06.md` |
| V-11 — lock, stall, reentrega e parada graciosa no BullMQ | `proofs/phase-03/bullmq-proof-roteiro.sh v11 [saída]` | `V-11.md` |
| V-07 — tempo e disco das provas grandes, medidos com um upload real de 1.000.000.000 bytes | `proofs/phase-03/v07-roteiro.sh [saída]` | `V-07.md` (evidências em `V-07-evidencias/`) |
| Fluxo completo com vídeo válido até `ready` (SI-03.32) | `proofs/phase-03/fluxo-completo-roteiro.sh [saída]` | `P-fluxo-completo.md` (evidências em `P-fluxo-completo-evidencias/`) |
| P-10GB — upload real de 10.000.000.000 bytes com medição de responsividade (SI-03.33), **reprovada** | `proofs/phase-03/p10gb-roteiro.sh [saída]` | `P-10GB.md` (evidências em `P-10GB-evidencias/`) |
| P-10GB, repetição — o mesmo contrato, com a API e as sondas compiladas e o cliente no Windows (SI-03.33, R-02), **aprovada** | `P10GB_CONFIRMA_10GB=sim proofs/phase-03/p10gb-repeticao-roteiro.sh [saída]` | `P-10GB-repeticao.md` (pacote da execução em `P-10GB-repeticao-evidencias/prova/`; pré-checagens e controles na mesma pasta) |

Cuidados ao rodar:

- **V-04:** as fixtures pequenas vêm de `docker compose exec nestjs-api sh test/fixtures/videos/generate.sh`. Elas já estão versionadas em `test/fixtures/videos/`. A prova também gera um objeto de 303 MB num prefixo temporário.
- **V-08 e V-09 (navegador):** usam o serviço `proof-browser` do perfil `proofs` e um arquivo de 1 GiB no `/tmp` desse container.
- **V-11:** para e religa o `redis` durante a manutenção (`docker compose stop redis` e `start`).
- **V-01:** usa uma instância isolada do Silo, com volume temporário, para as escritas.
- **V-07:** exige a API servida no `nestjs-api` (ver "Rodar a API") e leva cerca de 6 a 10 min.
  - **Recursos:** cria e remove dois usuários de prova, um arquivo de 1 GB no `/tmp` do `nestjs-api` e um container da sonda.
  - **Lixeira do Silo:** a medição só começa com a lixeira do Silo vazia. Depois da limpeza, o roteiro espera a purga que libera o disco, de 3 a 4 min.
  - **Resíduo:** cada interrupção pode deixar até 4 temporários de 64 MiB em `.minio.sys/tmp` do volume `storage-data`, que a limpeza da aplicação não alcança. Ver o relatório.
- **Fluxo completo:** exige a API servida no `nestjs-api` e o `video-worker` no ar, e leva cerca de 5 min, quase todo na espera da purga da lixeira do Silo.
  - **Recursos:** cria e remove um usuário de prova e um MP4 de cerca de 93 MB no `/tmp` do `nestjs-api`. O vídeo é gerado com o FFmpeg da imagem em cerca de 30 s.
  - **Resíduos:** só lista os temporários que o Silo já guardava em `.minio.sys/tmp`, antes e depois, sem removê-los.
- **P-10GB:** exige a API servida no `nestjs-api`, o `video-worker` no ar e a janela de 40 min com o ambiente exclusivo. Levou 17 min 44 s.
  - **Espaço:** o roteiro para antes de criar recursos se a unidade C: tiver menos de 29,5 GB livres.
  - **Recursos:** cria e remove dois usuários de prova, um arquivo de 10 GB no `/tmp` do `nestjs-api` e 4 containers da sonda.
  - **VHDX:** a execução fez o `docker_data.vhdx` crescer de 24,9 GB para 40,9 GB, e ele não encolhe sem compactação, que não foi testada. Ver o relatório.
  - **Resíduos:** compara os temporários do Silo de antes e de depois e separa os anteriores dos novos, sem remover nenhum.
- **P-10GB, repetição:** exige a API **parada** (o roteiro faz o build e a sobe com `start:prod`), o `video-worker` no ar, `node.exe`, `powershell.exe` e `docker.exe` no PATH do Windows e a janela de 40 min com o ambiente exclusivo.
  - **Espaço:** o mesmo limite de 29,5 GB livres na unidade C:. O arquivo de 10 GB fica na pasta temporária do Windows, e não no VHDX.
  - **Recursos:** cria e remove dois usuários de prova, o arquivo e o cliente compilado no Windows, o JS compilado da sonda e 13 containers da sonda.
  - **Trava:** sem `P10GB_CONFIRMA_10GB=sim`, recusa tamanhos acima de 1.000.000.000 bytes, com código 64.
  - **Duração:** a execução formal levou 15 min 54 s.
- **V-05:** reprodução e seek em navegador, adiada para a Fase 05. Não tem roteiro nem relatório nesta fase.

### Cliente de prova, sonda e apoio (SI-03.31 a SI-03.33)

Scripts das provas que passam pela API real. Rodam no container (`docker compose exec nestjs-api npx ts-node proofs/phase-03/<script>.ts …`), e os cabeçalhos trazem todas as opções; o [`proofs/phase-03/README.md`](proofs/phase-03/README.md) resume o comportamento de cada um.

| Script | Subcomandos e uso |
|--------|-------------------|
| `upload-client.ts` | `generate --file <caminho> --size <bytes> --seed <texto>`; `start --file <caminho> --credentials <json> --state <json> --events <jsonl> [--no-complete]`; `resume …` e `complete …` com as mesmas opções. Dentro de um container, use `--storage-connect localhost:9000=storage:9000` |
| `responsiveness-probe.ts` | `--public-id <publicId>`, com `{ email, password }` do dono do vídeo de controle na entrada padrão; o CSV sai em stdout. Cada instância roda num container próprio: `docker compose run --rm --no-deps -T --name <nome> nestjs-api node -r ts-node/register proofs/phase-03/responsiveness-probe.ts --public-id <publicId>` |
| `upload-proof-support.ts` | `api-check`, `account`, `control-video`, `parts-snapshot`, `compare-parts`, `interrupt-when`, `summarize`, `latency-verdict`, `flow-check`, `snapshot` e `cleanup`. O `latency-verdict` aplica às sondas as fases e os critérios da SI-03.33 (`--events --probe … --baseline-start <ms> --baseline-end <ms> --out [--clock-uncertainty-ms <ms>]`). Com a incerteza do relógio do cliente, analisa as amostras de borda e marca como `inconclusivo` o critério que ela possa alterar. O `flow-check` confere, depois do `ready`, os metadados, a thumbnail, o Range na `playback-url` e o SHA-256 do download (`--credentials --state --events --source --out --thumbnail [--storage-connect]`). A limpeza só aceita e-mails de usuários de prova (`<prova>-<runId>-<papel>@proofs.streamtube.test`) |

Os três exigem a API servida no `nestjs-api` (ver "Rodar a API"). As credenciais dos usuários de prova ficam só no `/tmp` do container, com modo 0600, e nenhum script imprime tokens, senhas ou URLs assinadas.

### Orientação sobre as provas grandes (TD-15)

- **Fora da rotina:** as provas grandes não rodam na suíte regular nem no CI. A suíte usa arquivos pequenos e limites configuráveis, e o CI só verifica o contrato OpenAPI.
- **Ordem:** primeiro a V-07 (feita), depois o fluxo completo (feito), a de 10 GB (feita, reprovada) e a repetição dela (feita e aprovada; a SI-03.33 está aprovada).
  - **O que a V-07 mediu:** um upload real de 1.000.000.000 bytes e a projeção para 10.000.000.000 bytes, com margem de 30%. A prova de 10 GB só roda na janela e com o disco que ela definiu.
  - **Janela:** **40 min contínuos**, com o ambiente exclusivo: nenhuma suíte nem outra prova em paralelo, e o `video-worker` no ar.
  - **Fase de carga e sondas:** fase de carga projetada `D` de 270 s (351 s com margem), com **4 instâncias da sonda**.
- **Disco:** a prova de 10 GB precisa de **29,5 GB livres na unidade C:**, que guarda o `docker_data.vhdx` do Docker Desktop. Esse valor é o pico projetado de 22,68 GB com margem:
  - cerca de 12,7 GB no volume `storage-data`;
  - os 10 GB do arquivo sintético.

  O Complete não acrescenta pico, porque o Silo passa as partes para o objeto sem cópia. A liberação ao final tem três limites:
  - o disco dentro do Docker só é liberado na purga da lixeira do Silo, de 3 a 4 min depois da remoção;
  - o `docker_data.vhdx` não encolhe sozinho;
  - os temporários de PUTs abortados ficam no volume (ver `V-07.md`).
- **Prova de 10 GB (feita, `P-10GB.md`, `reprovada`):**
  - **Upload:** arquivo sintético de exatamente 10.000.000.000 bytes, em 150 partes (a última com 779.264 bytes), com 4 partes em paralelo.
  - **Retomada:** interrupção a 51% e retomada pelo GET da sessão e por `file-verifications`, até `202`, sem reenviar partes `confirmed`.
  - **Desfecho:** `MEDIA_INVALID`, o resultado esperado. Upload, retomada e limpeza passaram.
  - **Critérios de latência:** ficaram fixados no relatório **antes** da execução e não foram ajustados.
    - **(a) e (b) reprovados:** p95 de carga de 802 ms e p99 de 3.404 ms, contra p95 de base de 5,1 ms, com 1.200 amostras de base e 437 de carga.
    - **(c) aprovado:** nenhuma resposta fora de 2xx, nenhum 429 e nenhum timeout.
    - **Requisito afetado:** R-02.
  - **Medidas:** fase de carga `D` de 217,6 s, pico de 10,1 GB no volume do storage, nenhum temporário novo do Silo e purga 42 s depois da limpeza.
  - **Consequência na época:** a TD-01 ficou reaberta, sem fallback, e uma nova execução passou a depender dela. Logo depois da execução, havia 23,6 GB livres em C:, abaixo dos 29,5 GB que a V-07 exige; em 2026-11-25, havia 40,0 GB.
  - **Situação vigente (2026-11-25):** a reabertura está encerrada pela repetição aprovada, abaixo, e a TD-01 foi mantida sem alteração.
- **Repetição da P-10GB (feita, `P-10GB-repeticao.md`, `aprovada`; SI-03.33 aprovada na revisão de 2026-11-25):**
  - **Mantido:** o contrato e os critérios (a), (b) e (c) da P-10GB.
  - **Mudança:** só o modo de execução, o do ensaio compilado do diagnóstico R-02:
    - a API pelo build, sem watch;
    - 13 sondas compiladas, dimensionadas pela execução de 1 GB mais rápida com a carga até 30% mais curta (D_mín = 48,951 s);
    - o cliente no Node do Windows, interrompido por um Ctrl+C real;
    - os eventos do cliente levados ao relógio da VM pela conversão nominal;
    - a incerteza do relógio analisada à parte: um critério que ela possa alterar fica `inconclusivo`.
  - **Revisão vigente do registro prévio:** r3, que acrescenta a propagação explícita de falhas em todas as etapas obrigatórias do roteiro. A r1 e a r2 ficam preservadas como versões anteriores.
  - **Execução:** `20261125142232-bc4b5d`, em 2026-11-25, em 15 min 54 s.
    - **Upload:** 10.000.000.000 bytes com 4 PUTs simultâneos; interrupção real em 75 de 150 partes (saída 130); retomada sem reenvio de `confirmed`; `202` e `MEDIA_INVALID`; limpeza completa.
    - **Latência:** base de 618 s com 4.019 amostras (p95 de 3,89 ms) e carga de 85,8 s com 554 amostras (p95 de 17,51 ms e p99 de 144,45 ms). (a), (b) e (c) aprovados, e a incerteza do relógio não altera nenhum veredito.
    - **Episódio:** três amostras de carga ficaram acima de 500 ms. Está registrado no relatório e não altera os percentis.
  - **Situação:** a aplicação e a arquitetura não mudaram. O VHDX não cresceu, e C: voltou a 39,8 GB livres.
  - **Encerramento (2026-11-25):**
    - **R-02:** encerrado para o cenário efetivamente validado: a API e as sondas compiladas, o cliente nativo do Windows e 13 sondas. O cenário da P-10GB original não foi validado.
    - **TD-01:** mantida.
    - **TD-15:** a condição das provas grandes está atendida (V-07, fluxo completo e prova de 10 GB).
    - **Causa dos atrasos anteriores:** não foi comprovada de forma definitiva (ver `R-02-diagnostico.md`).
- **Fluxo completo (feito, `P-fluxo-completo.md`):**
  - vídeo H.264/AAC válido de 180 s, gerado com o FFmpeg da imagem e sem preenchimento artificial;
  - vai até `ready`, com o objeto da thumbnail no storage;
  - a URL de reprodução responde `206` a uma requisição parcial, e o download tem o SHA-256 do arquivo enviado.

## Verificação manual do T-12 (`docker compose kill video-worker`)

> **Situação:** procedimento documentado, **ainda não executado**. O T-12 é coberto automaticamente pela integração `src/worker/maintenance/processing-reconciler.collect.integration-spec.ts`. Ela usa workers reais do BullMQ em processos filhos, com `lockDuration` de 1.000 ms, e SIGKILL até passar do `maxStalledCount`. A verificação manual com os valores reais de 30 s não foi feita na SI-03.25, porque leva minutos.

**O que se verifica:** um worker morto à força no meio do processamento gera uma reentrega do job. Acima de `QUEUE_MAX_STALLED_COUNT` (1), o job falha por stall, e a reconciliação encerra o vídeo em `error` `PROCESSING_STALLED`.

**Pré-requisitos:**

- **Ambiente e API:** o ambiente pronto e a API rodando (`npm run start:dev`, ver acima).
- **Usuário:** um usuário confirmado e autenticado. O `api.http` traz o cadastro, a confirmação (o e-mail chega ao Mailpit, em `http://localhost:8025`) e o login.
- **Upload preparado até o registro dos ETags, sem concluir.** Use um vídeo pequeno e válido, como `test/fixtures/videos/h264-aac-faststart.mp4`, e as rotas do contrato (`openapi.json`). A ordem é a de `test/videos-upload-completion.e2e-spec.ts`:
  1. **Criar o vídeo e a sessão:** `POST /videos`, com `fileName`, `sizeBytes` e `contentType`, responde `201`. Guarde o `publicId`, o `uploadSession.id`, o `uploadSession.partSize` e o `uploadSession.partCount`;
  2. **Pedir as URLs:** `POST /videos/<publicId>/upload-sessions/<sessionId>/part-urls`, com `parts` (o `partNumber` e o `checksumSha256` de cada parte, um SHA-256 em base64), responde `200`. Para cada parte, `parts` traz `url`, `method`, `expectedSize` e `headers`;
  3. **Enviar as partes:** faça o `PUT` de cada parte na `url`, com o `method` e os `headers` devolvidos e um corpo de exatamente `expectedSize` bytes. A URL usa o host do `S3_PUBLIC_ENDPOINT` (`localhost:9000` no `.env.example`), então, do host, use `curl --noproxy '*'`;
  4. **Capturar os ETags:** guarde o header `ETag` de cada resposta `200` desses `PUT`s;
  5. **Registrar os ETags:** `POST …/part-urls` de novo, agora com `completedParts` (o `partNumber` e o `etag` de cada parte). Responde `200`.

  **Não** faça ainda o `POST …/completion`: ele só vem no passo 2 do procedimento, com o worker já parado.
- **Com o cliente de prova (SI-03.31):** o `upload-client.ts start --no-complete` faz os passos 1 a 5 acima e para antes do `completion`, e o `complete` faz o passo 2 do procedimento, com o polling. O `upload-proof-support.ts account` cria um usuário de prova, e o `cleanup` remove os recursos dele ao final. Esse uso do cliente no T-12 também não foi testado.

**Procedimento:**

1. **Parar o worker.** Rode `docker compose stop video-worker`, que é gracioso.
2. **Concluir o upload.** Faça o `POST /videos/<publicId>/upload-sessions/<sessionId>/completion` e confira a resposta `202`, com `status` `processing`. O vídeo fica em `processing`, e o job fica em espera, porque não há worker no ar.
3. **Segurar o job.** Rode `docker compose pause storage`. Este passo é um recurso para pegar o job ativo e também não foi testado.
   - Com arquivos pequenos, o processamento leva menos de 1 s: na V-04, cada chamada do ffprobe levou de 67 a 83 ms, e cada extração de frame de 96 a 106 ms.
   - Com o storage pausado, o ffprobe fica sem resposta. As opções adotadas na V-04 limitam a espera: `-rw_timeout` de 10 s sem progresso por operação, até 4 conexões e `VIDEO_PROCESSING_TIMEOUT_MS` (60 s) por chamada.
   - Os jobs de manutenção que tocam o storage também ficam presos ou falham nesse intervalo.
4. **Primeira morte.** Rode `docker compose start video-worker` e espere o job ficar ativo: `docker compose exec redis redis-cli LRANGE bull:video-processing:active 0 -1` mostra o id `video-<videoId>-<run>-<dispatch>`. Então rode logo `docker compose kill video-worker`, que manda SIGKILL, sem parada graciosa. Se o ffprobe desistir antes do kill, a tentativa falha normalmente e volta pelo backoff, não por stall, e a verificação precisa ser refeita.
5. **Reentrega.** Rode `docker compose start video-worker`, com o storage ainda pausado.
   - Depois que o lock expira (`QUEUE_LOCK_DURATION_MS`, 30 s), a checagem seguinte (`QUEUE_STALLED_INTERVAL_MS`, 30 s) devolve o job à fila. O log mostra `video-processing.stalled`, e o job é entregue de novo.
   - Com o job ativo outra vez, rode `docker compose kill video-worker`.
6. **Acima do limite.** Rode `docker compose unpause storage` e `docker compose start video-worker`. Na checagem seguinte, o job vai para `failed` com `job stalled more than allowable limit`, sem chamar o processor.
7. **Reconciliação.**
   - A cada `MAINTENANCE_RECONCILE_INTERVAL_MS` (60 s), a reconciliação trata os vídeos cujo `processing_started_at` é mais antigo que `PROCESSING_RECONCILE_GRACE_MS` (300 s).
   - O vídeo vai para `error` `PROCESSING_STALLED`, e o log mostra `video-maintenance.reconcile-closed`.
   - Só depois disso o job é removido da fila.
   - Com os valores padrão, o vídeo só pode ir para `error` depois de 300 s desde `processing_started_at`, então o procedimento leva vários minutos.

**Observação durante o procedimento:**

```bash
docker compose exec db psql -U streamtube -d streamtube -c \
  "SELECT id, public_id, status, error_code, processing_run, processing_dispatch, processing_recoveries, processing_started_at FROM videos WHERE public_id = '<publicId>';"
docker compose exec redis redis-cli HMGET \
  'bull:video-processing:video-<videoId>-<run>-<dispatch>' \
  ats atm failedReason
docker compose exec redis redis-cli ZRANGE bull:video-processing:failed 0 -1
docker compose logs -f video-worker      # acompanha o log; encerre com Ctrl+C
```

**Marcadores:** os trechos entre `<` e `>` não são literais e devem ser trocados pelos valores reais do vídeo:

- `<publicId>`: o `publicId` devolvido pelo `POST /videos`;
- `<videoId>`, `<run>` e `<dispatch>`: as colunas `id`, `processing_run` e `processing_dispatch` da consulta acima. O id do job mostrado pelo `LRANGE` do passo 4 já vem nesse formato (`video-<videoId>-<run>-<dispatch>`), e a chave é esse id com o prefixo `bull:video-processing:`.

Mantenha as aspas simples da chave: sem elas, o shell interpreta `<` e `>` como redirecionamento.

**Ao final:** confira que o storage não ficou pausado (`docker compose ps storage` deve mostrar `healthy`) e que o `video-worker` está no ar (`video-worker started` no log).

## Versões validadas da imagem (DG-1)

A API e o worker usam a imagem `streamtube-nestjs-dev`, construída a partir do `Dockerfile.dev`: `node:25.6.0-slim` (Debian 12 bookworm) com `ffmpeg` do apt.

| Componente | Versão validada | Onde foi validada |
|------------|-----------------|-------------------|
| Node | `v25.6.0` | V-04 (2026-11-18, execução `20261118204858-6293af`), V-06 e V-11 |
| FFmpeg | `ffmpeg version 5.1.9-0+deb12u1` (pacote Debian `7:5.1.9-0+deb12u1`) | V-04 |
| ffprobe | `ffprobe version 5.1.9-0+deb12u1` | V-04 |

- **Conferência em 2026-11-24:** os containers `nestjs-api` e `video-worker` rodam a mesma imagem (`sha256:6b5db062366a…`, construída em 2026-11-18T02:06Z, antes da execução da V-04), com essas mesmas versões. Para ler as versões:

  ```bash
  docker compose exec nestjs-api node -v
  docker compose exec nestjs-api ffmpeg -version | head -1
  docker compose exec nestjs-api ffprobe -version | head -1
  ```

- **Regra (DG-1):** quando a imagem mudar, é preciso repetir a V-04 e a prova do fluxo completo (SI-03.32, ainda não disponível) antes de confiar no processamento, e registrar as novas versões no relatório da V-04. A imagem muda com:
  - uma troca de base no `Dockerfile.dev`;
  - uma mudança no `apt install`;
  - qualquer rebuild que traga outra versão do FFmpeg. O `Dockerfile.dev` não fixa a versão do pacote, então confira as versões depois de todo rebuild.
- **Node 25:** está em fim de vida desde 2026-06-01. A atualização é uma tarefa separada (D-07) e, quando acontecer, aciona a regra acima.

## Contrato OpenAPI e CI

- **Regenerar o contrato:** `docker compose exec nestjs-api npm run openapi:export` regenera o `openapi.json` versionado. O comando passa pelo `nest build`, que aplica o plugin do Swagger. O teste `src/openapi-export.integration-spec.ts` falha quando o arquivo versionado difere do gerado.
- **Sincronizar o frontend:** a partir da raiz do repositório, rode `bash scripts/sync-openapi.sh`. Depois, com o container do frontend no ar (`docker compose up -d` em `next-frontend/`), rode `cd next-frontend && docker compose exec next-frontend npm run openapi:types`. As duas cópias e os tipos entram juntos no commit.
- **Workflow do CI:** `.github/workflows/openapi-freshness.yml` (next-frontend-openapi-typing/TD-03).
  - **Gatilhos:** todo `pull_request` (tipos de atividade padrão `opened`, `synchronize` e `reopened`, para qualquer branch de destino), `push` em `main` e `dev`, e execução manual (`workflow_dispatch`).
  - **O que faz:**
    1. confere que `nestjs-project/openapi.json`, `next-frontend/openapi.json` e `next-frontend/lib/api/types.gen.ts` são rastreados pelo Git;
    2. instala as dependências do frontend com `npm ci`;
    3. sincroniza a cópia e regenera os tipos;
    4. falha em qualquer diferença, mostrando os comandos de atualização.
  - **O que não faz:** usa o contrato do backend versionado, sem regenerá-lo, e não roda testes nem provas.
  - **Situação (2026-11-24):** validado só localmente, em repositórios temporários (ajuste da revisão da SI-03.29). Ainda **não** houve execução observada no GitHub Actions. Depois do commit e do push do workflow, ele só roda nestes eventos:
    - um pull request aberto, atualizado com novos commits (`synchronize`) ou reaberto. O GitHub não roda o workflow enquanto o pull request tem conflito de merge;
    - um push em `main` ou `dev`. Um push em outra branch, como `feature/*`, não o dispara;
    - uma execução manual (`workflow_dispatch`), disponível só quando o arquivo do workflow estiver na branch padrão do repositório.

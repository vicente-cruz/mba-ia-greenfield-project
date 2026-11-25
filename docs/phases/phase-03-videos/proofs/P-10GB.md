# P-10GB — Upload real de 10.000.000.000 bytes com medição de responsividade

- **Prova:** P-10GB. Upload real de 10.000.000.000 bytes, com interrupção e retomada, medindo a responsividade da API com critérios numéricos fixados antes da execução.
- **Requisitos:**
  - R-02: até 10 GB sem passar pela API e sem bloquear o atendimento;
  - R-03: retomada após falha de conexão.
- **TDs afetadas:** phase-03-videos/TD-01 (os bytes vão direto ao storage, e a API só orquestra) e TD-15 (prova grande na janela e com o disco definidos pela V-07). A prova também exercita a TD-02 (registro, conferência e conclusão das partes).
- **SI:** SI-03.33
- **Data:** 2026-11-24. Execução `20261124215534-349fa9`, das 21:55:34Z às 22:13:18Z (17 min 44 s).
- **Resultado:** `reprovada`. Os critérios de latência (a) e (b) foram violados, com amostras suficientes, e o requisito afetado é o R-02. O critério (c) e todos os itens do upload, da retomada (R-03) e da limpeza passaram.

## Registro prévio

Esta seção foi fixada às 21:55Z de 2026-11-24, antes de qualquer coleta. Uma cópia está em [`P-10GB-evidencias/registro-previo.md`](P-10GB-evidencias/registro-previo.md), com o SHA-256 registrado no `progress.md`. Os critérios e as regras abaixo não são ajustados depois de ver os números.

### Ambiente e janela

Conferidos às 21:50Z:
- **serviços:** `db`, `mailpit`, `storage` e `redis` saudáveis; `nestjs-api` e `video-worker` no ar; `storage-init` com `Exited (0)`; Redis com `maxmemory-policy noeviction`;
- **espaço livre:** 39.694.196.736 bytes na unidade C:, acima dos 29.500.000.000 exigidos pela V-07. O `docker_data.vhdx` tinha 24.881.659.904 bytes, e o disco de dados do Docker, 19.038.932.992 bytes usados;
- **janela:** 40 min contínuos, com o ambiente exclusivo: nenhuma suíte nem outra prova em paralelo, e o `video-worker` no ar. A estimativa da V-07 é de cerca de 25 min, ou 33 min com a margem;
- **API:** servida por `npm run start:dev` (modo watch) no `nestjs-api`, como na V-07. O cliente de upload roda no mesmo container;
- **resíduos anteriores:** o volume `storage-data` guarda 5 temporários de 64 MiB (327.720 KiB) da SI-03.31, listados no [`P-fluxo-completo.md`](P-fluxo-completo.md). A prova os lista antes e depois e não os remove.

### Versões

| Componente | Versão efetiva | Como foi lida |
|------------|----------------|---------------|
| Storage | `pgsty/silo:RELEASE.2026-11-12T00-00-00Z@sha256:c20d112390b9a9ce8c11b8af95ad35bcaa62f4759663c09c936cd8d2b511f329` | `docker compose config --images` e `docker image inspect` |
| Redis | `redis:8.8.4`, imagem `sha256:6e61ab45b3e867bacbef2fdd969ec74f4e0f8aaca8cc946cb8ac0c494035e7e7` | `docker image inspect` |
| Imagem da API e do worker | `streamtube-nestjs-dev` `sha256:6b5db062366a…`, criada em 2026-11-18T02:06:47Z, a mesma da V-07 | `docker image inspect` |
| Node | v25.6.0 | `node -v` no `nestjs-api` |
| Bibliotecas | `@aws-sdk/client-s3` 3.1170.0, `@nestjs/core` 11.1.16, `@nestjs/throttler` 6.5.0, `bullmq` 6.7.7, `ioredis` 5.11.1, `typeorm` 0.3.28, `ts-node` 10.9.2, `typescript` 5.9.3 | `package.json` instalado em `node_modules` |
| FFmpeg / ffprobe | 5.1.9-0+deb12u1 (só leva o conteúdo sintético a `MEDIA_INVALID`) | `ffprobe -version` no `video-worker` |
| Docker | Docker Desktop, Engine 29.8.2; 16 CPUs; 8.208.449.536 bytes de memória na VM | `docker version` e `docker info` |
| Configuração do upload | partes de 67.108.864 bytes, URLs de parte por 900 s e limite de 10.000.000.000 bytes, os padrões da validação, sem sobrescrita no `.env`; access token de 15 min | `config.constants.ts` e `.env`, sem imprimir segredos |

O roteiro registra de novo as versões no log da execução.

### Cenário de medição

- **Sonda:** `GET /videos/:publicId` de um vídeo de controle em `draft`.
  - **Dono:** o usuário de prova `p10gb-<runId>-control`, distinto do usuário `p10gb-<runId>-uploader`, que faz o upload.
  - **Instâncias:** cada uma num container próprio (`docker compose run`), com IP distinto do `nestjs-api`, onde roda o cliente de upload. São as mesmas instâncias na base e na carga.
  - **Ritmo:** uma requisição a cada 2 s em grade fixa (0,5 req/s por instância, dentro do limite de 60 por minuto por IP da rota), com timeout de 5 s.
  - **Token:** cada instância faz o próprio login e renova o access token por `POST /auth/refresh` 120 s antes de expirar, depois de uma amostra. Login e renovações não entram nas amostras.
- **Instante de cada amostra:** o do disparo, pelo relógio dos containers, o mesmo dos eventos do cliente.
- **Fases:**
  - **aquecimento:** do início de cada instância até todas estarem amostrando. Só conta no critério (c);
  - **base:** de quando todas as instâncias estão amostrando até o lançamento do cliente de upload, sem upload. Dura pelo menos 600 s (`P10GB_BASELINE_SECONDS=600`);
  - **carga:** só os intervalos com o cliente de upload ativo, pelos eventos do cliente:
    - do primeiro `part-urls` à interrupção;
    - da retomada à espera antes do completion;
    - da liberação do completion à resposta `202`.

    O intervalo entre a interrupção e o reinício do cliente e a espera antes do completion, em que o roteiro tira o retrato das partes, ficam fora. É o mesmo recorte medido na V-07;
  - **fora:** as demais amostras depois da base. Só contam no critério (c).
- **Percentis:** p50, p95 e p99 pelo posto mais próximo, sobre todas as amostras da fase, cada uma com a latência medida até a resposta, o timeout ou o erro.
- **Amostras:** no mínimo 300 por fase, na base e na carga.

### Dimensionamento das sondas

`N = ceil(600 / D)`, porque 300 amostras a uma a cada 2 s somam 600 s de sonda. O ritmo de cada instância não aumenta.

| Referência da V-07 para `D` | `D` | `ceil(600 / D)` | Amostras de carga com `N` = 4 |
|-----------------------------|-----|-----------------|-------------------------------|
| Projeção central (execução final, 26,98 s × 10) | ≈ 270 s | 3 | ≈ 540 |
| Projeção com a margem de 30% | ≈ 351 s | 2 | ≈ 702 |
| **Referência conservadora** (2ª execução, a mais rápida, 16,81 s × 10) | **≈ 168 s** | **4** | ≈ 336 |

- **`N` = 4:** a escolha segue a referência conservadora, `ceil(600 / 168) = 4`. Ela não é a projeção central: é a menor fase de carga projetada entre as execuções da V-07, o caso com menos amostras de carga.
- **Cobertura:** com 4 instâncias, a carga rende 300 amostras sempre que `D` ≥ 150 s. A base, com 600 s, rende cerca de 1.200 amostras.
- **Memória:** as 4 instâncias somam cerca de 0,74 GiB, a 184 MiB cada, como medido na V-07.

### Critérios de aprovação

Fixados na SI-03.33 e aplicados sem ajuste:

- **(a)** p95 de carga ≤ max(1,5 × p95 de base; p95 de base + 50 ms);
- **(b)** p95 de carga ≤ 250 ms e p99 de carga ≤ 500 ms;
- **(c)** zero respostas fora de 2xx, zero `429` e zero timeouts.
  - Vale para todas as amostras coletadas: aquecimento, base, carga e fora, inclusive numa execução inconclusiva.
  - Conta como falha qualquer amostra sem um 2xx válido: status fora de 2xx (inclusive `429`), timeout de 5 s, erro de rede ou corpo inesperado.

**Regras de veredito:**
- **Amostras insuficientes:** com menos de 300 amostras na base ou na carga, (a) e (b) são `inconclusivo`, nunca `aprovado`. A execução é então repetida com `N` recalculado pela `D` medida, depois de conferir de novo o espaço livre em C:. Períodos ociosos nunca entram nos percentis de carga.
- **Latência:**
  - `reprovada` se qualquer critério for reprovado;
  - `inconclusiva` se (a) ou (b) for inconclusivo e (c) passar;
  - `aprovada` só com os três aprovados.
- **Reprovação:** o relatório registra o critério violado e o requisito afetado (R-02), sem flexibilizar o critério e sem descartar a execução.

### Itens obrigatórios do upload e da limpeza

- **Upload:**
  - arquivo sintético de exatamente 10.000.000.000 bytes, declarado `video/mp4`;
  - aceito em 150 partes de 67.108.864 bytes, a última com 779.264;
  - até 4 PUTs simultâneos.
- **Interrupção:** SIGINT externo por volta de 50%, quando 75 das 150 partes tiverem o PUT concluído. O cliente aborta os PUTs em andamento e sai com 130.
- **Retomada (R-03):** pelo GET da sessão e por `file-verifications` de todas as partes recebidas (`confirmed` e `unregistered`), com `200` `match`.
- **Partes `confirmed`:** nenhuma é reenviada, conferido por três fontes: os eventos do cliente, o `ListParts` do storage (ETag, tamanho e `LastModified`) e o registro da API.
- **Conclusão:** `202` depois da retomada; o processamento do conteúdo sintético termina em `error` `MEDIA_INVALID`, o resultado esperado.
- **Limpeza:** remove só os recursos da prova, com o retrato de antes igual ao de depois.
- **Disco:** liberado ao final, com a purga da lixeira do Silo. Os temporários do Silo são comparados antes e depois, separando os anteriores dos novos. Se restarem temporários novos, a liberação é registrada como incompleta, e não completa.

**Resultado da prova:** `aprovada` só com todos os itens obrigatórios e a latência aprovados. Qualquer item ou critério reprovado torna a prova `reprovada`, com o critério e o requisito afetados registrados. Uma latência inconclusiva leva à repetição.

### Procedimento

1. **Pré-requisitos:** `docker compose up -d` com o ambiente saudável e a API servida no `nestjs-api` por `docker compose exec nestjs-api npm run start:dev`.
2. **Comando:** no host, a partir de `nestjs-project/`, `proofs/phase-03/p10gb-roteiro.sh <diretório de saída>`, com os padrões `P10GB_SIZE_BYTES=10000000000`, `P10GB_PROBES=4`, `P10GB_BASELINE_SECONDS=600`, `P10GB_RESUME_GAP_SECONDS=5` e `P10GB_MIN_FREE_BYTES=29500000000`. O roteiro executa, nesta ordem:
   1. estado do ambiente e **conferência do espaço livre em C:**, que para o roteiro se for menor que o exigido;
   2. versões, `api-check`, espaço livre, retrato do banco, do bucket, da fila e do Mailpit, e a lista dos temporários do Silo;
   3. os dois usuários de prova, pela API real, e o vídeo de controle em `draft`;
   4. o arquivo sintético de 10.000.000.000 bytes (`upload-client.ts generate`) no `/tmp/p10gb-<runId>/` do `nestjs-api`;
   5. a espera da lixeira do Silo vazia e o amostrador de disco;
   6. as 4 instâncias da sonda e a base de 600 s;
   7. o upload (`upload-client.ts start --no-complete`), interrompido pelo vigia `interrupt-when --fraction 0.5`;
   8. o retrato das partes, a retomada (`resume --hold-before-completion`), o segundo retrato, a comparação (`compare-parts`) e a liberação do completion, com polling até o estado final;
   9. o fim das sondas e do amostrador, o resumo (`summarize`) e os vereditos (`latency-verdict`);
   10. a limpeza (`trap EXIT`): os containers das sondas, os recursos dos dois usuários (`cleanup`), o diretório de prova, a purga da lixeira, os retratos e a comparação dos temporários do Silo.
3. **Pré-registro:** as fases, os percentis e os critérios acima estão implementados no subcomando `latency-verdict` do `upload-proof-support.ts`. Ele foi testado antes da execução sobre as evidências da V-07, sem novo upload.

## Resultados

O registro prévio acima não mudou depois da execução: a seção é idêntica à da cópia em `P-10GB-evidencias/registro-previo.md`. As evidências ficam em [`P-10GB-evidencias/`](P-10GB-evidencias/), com o caminho local da saída trocado por `<saída>`:
- o log do roteiro;
- os eventos e os logs do cliente;
- o resumo (`summary.json`) e os vereditos (`latency-verdict.json`);
- os CSVs e os logs das 4 instâncias da sonda;
- os retratos das partes;
- as amostras de disco, o `df` rápido do completion e o `docker stats`;
- os retratos de antes e depois e as listas dos temporários do Silo;
- a análise informativa da carga (`analise-da-carga.txt`) e as verificações dos scripts.

Nenhum arquivo traz token, senha ou URL assinada; isso foi conferido por busca de `X-Amz-Signature`, `X-Amz-Credential`, JWT (`eyJ…`) e `password`.

### Vereditos de latência

Calculados pelo `latency-verdict` com as fases e os critérios do registro prévio:

| Fase | Duração | Amostras (por instância) | p50 | p95 | p99 | Máximo | Fora de 2xx / 429 / timeout / erro de rede / corpo inesperado |
|------|---------|--------------------------|-----|-----|-----|--------|------------------------------------------------------------|
| Aquecimento | — | 4 (1, 1, 1, 1) | 4,23 ms | 6,89 ms | 6,89 ms | 6,89 ms | 0 / 0 / 0 / 0 / 0 |
| **Base** | 600,4 s | **1.200** (300, 300, 300, 300) | 2,88 ms | **5,11 ms** | 13,60 ms | 36,29 ms | 0 / 0 / 0 / 0 / 0 |
| **Carga** (upload ativo) | 217,6 s | **437** (109, 110, 109, 109) | 10,45 ms | **802,26 ms** | **3.404,37 ms** | 3.775,20 ms | 0 / 0 / 0 / 0 / 0 |
| Fora da base e da carga | — | 75 (19, 18, 19, 19) | 5,03 ms | 12,11 ms | 34,57 ms | 34,57 ms | 0 / 0 / 0 / 0 / 0 |
| Todas | — | 1.716 (429 cada) | 3,15 ms | 263,27 ms | 1.088,47 ms | 3.775,20 ms | 0 / 0 / 0 / 0 / 0 |

| Critério | Limite | Medido | Veredito |
|----------|--------|--------|----------|
| Amostras por fase | ≥ 300 na base e na carga | 1.200 e 437 | atingido |
| **(a)** | p95 de carga ≤ max(1,5 × 5,11; 5,11 + 50) = 55,11 ms | 802,26 ms | **reprovado** |
| **(b)** | p95 de carga ≤ 250 ms e p99 de carga ≤ 500 ms | 802,26 ms e 3.404,37 ms | **reprovado** |
| **(c)** | 0 amostras sem 2xx válido, em todas as fases | 0 de 1.716 | aprovado |
| **Latência** | | | **reprovada** |

- **Regra das amostras:** não se aplica. A carga teve 437 amostras com 4 instâncias, então não há veredito inconclusivo nem repetição. Pela `D` medida, `N` seria `ceil(600 / 217,6) = 3`.
- **Sondas:**
  - os IPs das instâncias foram `172.20.0.9`, `.10`, `.8` e `.11`, e o do `nestjs-api`, onde rodam a API e o cliente, `172.20.0.6`;
  - as mesmas 4 instâncias ficaram da base ao fim da carga, cada uma com 429 amostras em 857 s;
  - cada instância renovou o token uma vez, por `POST /auth/refresh` (360 a 451 ms), fora das amostras;
  - nenhuma amostra teve `429`, timeout ou erro.

### Upload, retomada e conclusão

| Item | Esperado | Observado | Situação |
|------|----------|-----------|----------|
| Arquivo sintético | Exatamente 10.000.000.000 bytes | 10.000.000.000 bytes, gerados em 96,4 s (98,9 MiB/s); SHA-256 `24d3e56b…9175f` | passou |
| Plano | `201` com 150 partes de 67.108.864 bytes, a última com 779.264, declarado `video/mp4` | vídeo `k3PsZE0qAiQ`, sessão `50927a07-…`; 150 partes, a última com 779.264; `SHA256` | passou |
| Paralelismo | Até 4 PUTs simultâneos | `--concurrency 4` | passou |
| Interrupção por volta de 50% | SIGINT externo; o cliente aborta os PUTs em andamento e sai com 130 | SIGINT do vigia com 76 de 150 partes com PUT concluído (51,0% dos bytes). O PUT da parte 77 foi abortado, e o cliente saiu com 130 | passou |
| Retomada pelo GET da sessão (R-03) | Classificação das 150 partes | `confirmed` [1–74], `unregistered` [75, 76], `missing` [77–150], `divergent` [] | passou |
| `file-verifications` de todas as partes recebidas | `confirmed` e `unregistered` conferidas, `200` `match` | 76 partes (5.100.273.664 bytes) recalculadas em 46,7 s (104,4 MiB/s); `200` `match` em 124,7 ms | passou |
| Nenhuma parte `confirmed` reenviada: cliente | Nenhum PUT de parte `confirmed` na retomada | PUTs da retomada: [75–150] | passou |
| Nenhuma parte `confirmed` reenviada: storage | ETag, tamanho e `LastModified` iguais | 74 de 74 iguais no `ListParts` | passou |
| Nenhuma parte `confirmed` reenviada: registro da API | ETag e `etag_registered_at` inalterados | 74 de 74 | passou |
| Controle da evidência do storage | Cada parte reenviada com `LastModified` novo | 76 de 76 | passou |
| Antes do completion | As 150 partes no storage, registradas com o mesmo ETag | 150 de 150 | passou |
| Conclusão | `202` | `202` em 188,1 ms | passou |
| Desfecho do conteúdo sintético | `error` `MEDIA_INVALID`, nunca `ready` | `error` `MEDIA_INVALID` 2,0 s depois do `202` | passou |
| Chamadas à API do cliente | Sem `401` nem `429` | 98 chamadas: 1 `201`, 96 `200` e 1 `202`. Foram 91 `part-urls`; o token foi renovado uma vez | passou |

### Tempos e throughput

| Medida | Execução | V-07 (projeção central; com margem) |
|--------|----------|-------------------------------------|
| Geração do arquivo sintético | 96,4 s | 95 s; 123 s |
| **Upload ativo `D`** | **217,6 s**: 71,3 s antes da interrupção, 146,1 s na retomada e 0,19 s no completion | 270 s; 351 s (referência conservadora: 168 s) |
| Intervalo entre a interrupção e a retomada (fora da carga) | 19,5 s | — |
| Bytes dos PUTs concluídos com sucesso | 10.134.217.728 (1,34% de reenvio, as partes 75 e 76). O PUT abortado da parte 77 fica fora da soma | — |
| Throughput dos PUTs concluídos (esses bytes ÷ tempo com pelo menos um PUT ativo) | 60,9 MiB/s: 74,9 antes da interrupção e 51,2 na retomada | 45,7 MiB/s medidos com 1 GB |
| Checksums antes da assinatura | 10.134.217.728 bytes em 164,8 s (58,7 MiB/s) | — |
| Checksums da conferência da retomada | 5.100.273.664 bytes em 46,6 s somando cada parte (104,4 MiB/s), e 46,7 s de conferência ao todo | 12,6 s projetados; até cerca de 90 s no pior ritmo |
| Complete (`POST …/completion` até o `202`) | 188,1 ms | 1,9 s; 2,4 s |
| Do `202` ao `MEDIA_INVALID` | 2,0 s | 2,2 s; 2,9 s |
| Purga da lixeira depois da limpeza | 42 s | 184 s; 240 s |
| Janela usada | 17 min 44 s, do início do roteiro ao fim da limpeza | 40 min recomendados |

### Disco

- **Volume do storage** (`du`, 3.019 amostras com mediana de 265 ms):
  - **pico:** 10.135.601.152 bytes acima do início, às 22:11:56.691Z, logo depois do completion;
  - **composição do pico:** o objeto de 10.001.403.904 bytes e 131.940 KiB na lixeira, as versões antigas das partes 75 e 76, sobrescritas na retomada;
  - **temporários:** 0 bytes de crescimento.
  - **V-07:** a projeção linear era de 12,68 GB (16,49 GB com margem), e o modelo por componente, de cerca de 10,3 GB.
- **Durante o Complete:**
  - o multipart caiu de 9.767.012 KiB para 16, e o bucket subiu de 4 para 9.766.408, sem cópia;
  - o `df` sem pausa (1.032 amostras, mediana de 5 ms) teve 34 amostras dentro do completion, com variação de 8 KiB.
- **Disco de dados do Docker** (`df` do `/data`): 28.358.584 KiB usados no início do amostrador, já com o arquivo sintético, e no máximo 38.267.632 KiB.
- **Pico da prova no disco do Docker:** cerca de 20,1 GB (o storage mais o arquivo), contra os 22,68 GB projetados pela V-07 (29,49 GB com margem).

| Momento | Livre em C: | `docker_data.vhdx` | Usado no disco de dados do Docker |
|---------|-------------|--------------------|-----------------------------------|
| Antes da prova | 39.633.719.296 bytes | 24.881.659.904 bytes | 19.038.932.992 bytes |
| Com o arquivo sintético | 34.295.959.552 | 30.183.260.160 | 29.039.185.920 |
| Antes da limpeza | 23.628.390.400 | 40.853.569.536 | 39.175.172.096 |
| Depois da limpeza e da purga | 23.628.189.696 | 40.853.569.536 | 19.039.166.464 |

### Limpeza e liberação do disco

| Item | Esperado | Observado | Situação |
|------|----------|-----------|----------|
| Recursos de prova | 0 linhas, objetos, multiparts, jobs e e-mails de prova | 5 de 5 itens da limpeza: 2 usuários, 2 vídeos e 2 sessões; o objeto de 10 GB; os e-mails. Os containers das sondas e os arquivos do amostrador foram removidos, e o diretório de prova também | passou |
| Retratos | Antes igual a depois | iguais: banco sem linhas de prova, bucket vazio, fila sem jobs e Mailpit com as 8 mensagens alheias à prova | passou |
| Disco do volume do storage | Liberado depois da purga | A lixeira recebeu 9.898.388 KiB e foi purgada 42 s depois da limpeza. O volume voltou a 327.988 KiB, abaixo dos 328.240 KiB do início | passou |
| Temporários do Silo | Anteriores preservados; nenhum novo | 5 de 5 anteriores preservados, com o mesmo nome e tamanho (327.720 KiB); **0 novos**. O PUT abortado desta execução não deixou temporário | passou |

- **Volume do storage:** a liberação foi completa. Não sobraram temporários novos, e o uso do volume voltou ao do início.
- **Espaço em C::** não voltou.
  - O `docker_data.vhdx` cresceu de 24,88 GB para 40,85 GB e não encolhe sem compactação, que não foi testada.
  - O livre em C: caiu de 39,63 GB para 23,63 GB e continua assim depois da prova.
  - O disco de dados do Docker voltou a 19,04 GB usados. Os cerca de 21,8 GB livres dentro do VHDX podem ser reaproveitados pelo Docker sem crescer o arquivo.
- **Resíduos anteriores:** os 5 temporários da SI-03.31 continuam no volume, como antes.

### Observações sobre a latência

Informativas, sem efeito nos vereditos. Detalhes em `analise-da-carga.txt`:
- **Lentidão ao longo da carga:** as respostas lentas aparecem nos três trechos com amostras.
  - **Início** (PUTs, checksums e registro): p95 de 743 ms.
  - **Conferência da retomada:** p95 de 1.753 ms. Nesse trecho, o cliente só lê o arquivo de 10 GB e calcula o SHA-256 das 76 partes recebidas, sem PUT e sem chamadas à API.
  - **PUTs da retomada:** p95 de 778 ms.
- **Mediana:** a mediana de carga ficou em 10 ms. A degradação está na cauda: 89 das 437 amostras de carga passaram de 250 ms.
- **Ambiente:**
  - a API rodou em modo watch no mesmo container do cliente de upload, como na V-07;
  - o `nestjs-api` ficou com mediana de 175 a 232% de CPU (máximo de 372%), e o storage chegou a 725%;
  - o arquivo de 10 GB não cabe na memória da VM (7,6 GiB), e a leitura vai ao disco.
- **Causa:** não investigada. Esta SI não testa hipóteses nem muda o cenário. A V-07 já registrava a latência sob carga como risco (p95 de 237 ms a 2,48 s, com poucas amostras).

## Resultado

`reprovada`.
- **Critérios violados:**
  - **(a):** p95 de carga de 802,26 ms, acima do limite de 55,11 ms;
  - **(b):** p95 de carga de 802,26 ms, acima de 250 ms, e p99 de carga de 3.404,37 ms, acima de 500 ms.

  As fases tiveram amostras suficientes (1.200 e 437), então os vereditos não são inconclusivos, e a execução não foi descartada nem repetida.
- **Requisito afetado:** R-02, "até 10 GB sem passar pela API e sem bloquear o atendimento". A parte de não passar pela API se confirmou: os bytes foram direto ao storage, e o tráfego da API se limitou a 98 chamadas de controle. A parte de não bloquear o atendimento não foi demonstrada nos critérios fixados: as respostas de `GET /videos/:publicId` degradaram durante o upload.
- **O que passou:**
  - **critério (c):** nenhuma resposta fora de 2xx, nenhum `429` e nenhum timeout em 1.716 amostras;
  - **upload:** os 10.000.000.000 bytes em 150 partes;
  - **retomada (R-03):** a conferência de todas as partes recebidas, sem reenvio de partes `confirmed`, provada por três fontes;
  - **conclusão:** o `202` e o desfecho `MEDIA_INVALID`;
  - **limpeza:** só os recursos de prova, sem temporários novos.

## Consequência

- **TD reaberta, sem fallback:** pela regra das provas, a TD-01 é reaberta para uma nova decisão sobre o R-02. Nenhuma alternativa foi adotada, nenhum critério foi flexibilizado, e nenhuma melhoria de arquitetura foi iniciada.
- **Bloqueio:**
  - nenhuma SI da fase depende da SI-03.33;
  - a entrega da fase continua bloqueada, porque a TD-15 exige as duas provas grandes aprovadas.
- **Pendências para a revisão:**
  - a decisão sobre o R-02 e a TD-01, incluindo se o cenário de medição fixado representa o ambiente que o requisito pede;
  - qualquer nova execução depende dessa decisão;
  - a compactação do `docker_data.vhdx`, que hoje ocupa 40,85 GB em C:, com 23,63 GB livres. Uma nova prova de 10 GB exige 29,5 GB livres em C: pela regra da V-07, a menos que a decisão passe a contar o espaço livre dentro do VHDX.

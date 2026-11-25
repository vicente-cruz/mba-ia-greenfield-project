# P-10GB — Upload real de 10.000.000.000 bytes com medição de responsividade

- **Prova:** P-10GB. Upload real de 10.000.000.000 bytes, com interrupção e retomada, medindo a responsividade da API com critérios numéricos fixados antes da execução.
- **Requisitos:**
  - R-02: até 10 GB sem passar pela API e sem bloquear o atendimento;
  - R-03: retomada após falha de conexão.
- **TDs afetadas:** phase-03-videos/TD-01 (os bytes vão direto ao storage, e a API só orquestra) e TD-15 (prova grande na janela e com o disco definidos pela V-07). A prova também exercita a TD-02 (registro, conferência e conclusão das partes).
- **SI:** SI-03.33
- **Data:** 2026-11-24.
- **Resultado:** a preencher depois da execução.

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

A preencher depois da execução.

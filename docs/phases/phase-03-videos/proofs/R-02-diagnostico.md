# R-02 — Diagnóstico da latência na P-10GB

- **Objetivo:** investigar a pendência do R-02 deixada pela P-10GB, `reprovada` nos critérios de latência (a) e (b). É diagnóstico, não uma rodada de melhorias.
- **Datas:**
  - ensaios `20261124234623-4a6b9e` em 2026-11-24, das 23:46Z às 23:58Z;
  - comparação A×B `20261125002224-94186e` em 2026-11-25, das 00:22Z às 00:28Z (ver a seção 9);
  - ensaio com perfil de CPU `20261125010724-84efe2` em 2026-11-25, das 01:07Z às 01:13Z (ver a seção 10);
  - checagem de memória do Windows `20261125013921-d3ea41` em 2026-11-25, às 01:39Z (ver a seção 11);
  - ensaio de 1 GB com a API e as sondas compiladas `20261125015519-9477cd` em 2026-11-25, das 01:55Z às 02:01Z (ver a seção 12).
  - preparação da repetição formal da P-10GB em 2026-11-25, com quatro pré-checagens de 1 GB, das 02:24Z às 05:08Z, e o registro prévio fixado às 05:11Z (ver a seção 13).
- **Encerramento (2026-11-25):** a pendência do R-02 está **encerrada para o cenário efetivamente validado** pela repetição formal da P-10GB, aprovada na revisão: a API e as sondas compiladas, o cliente nativo do Windows e 13 sondas. A causa dos atrasos anteriores não foi comprovada de forma definitiva (ver a seção 14).
- **Preservado:**
  - a execução reprovada `20261124215534-349fa9`, os CSVs, o registro prévio e os critérios da P-10GB não foram alterados. A P-10GB continua `reprovada`;
  - a arquitetura não mudou: nada em código, configuração, multipart, storage, fila ou protocolo;
  - não houve upload de 10 GB, compactação do VHDX, remoção de volumes nem de arquivos internos do storage.
- **Resultado do diagnóstico:**
  - **hipótese principal, sustentada pelas medições:** disputa por disco e por memória no ambiente de execução. As respostas lentas coincidem com travamentos curtos que alcançam, ao mesmo tempo, a API, o PostgreSQL e outros processos da VM do Docker Desktop, nos picos de pressão de disco e de memória;
  - **o que não foi provado:** a API, o banco e a rede não foram excluídos definitivamente. As medições não mostram gargalo neles, mas também não provam que eles nunca contribuem;
  - **reprodução:** os ensaios reproduziram os atrasos, mas não isolaram definitivamente o mecanismo (writeback, swap, journal ou o disco virtual no host Windows);
  - **cliente fora do Docker/WSL (seção 9):** com o cliente no Node nativo do Windows, os atrasos continuaram e foram mais longos. Ler o arquivo dentro da VM não é necessário para que eles ocorram. Mover o cliente para fora não bastou neste host, onde o arquivo do Windows fica no mesmo disco físico do VHDX;
  - **CPU da API nos episódios:** a conclusão de que a API quase não usa CPU durante os atrasos vale só para os episódios dos primeiros ensaios. Nos dois episódios da comparação, o processo da API registrou CPU quase igual à duração real do intervalo (2.772 ms em 3.036 ms; 1.407 ms em 1.515 ms). Esse consumo **não foi atribuído** a uma função, ao banco nem exclusivamente ao ambiente;
  - **perfil de CPU (seção 10):** as duas execuções com perfil não tiveram episódio, ou seja, **os perfis não capturaram os episódios investigados**, e não explicam aquele consumo. O alinhamento temporal dos perfis atuais e os tipos de GC foram corrigidos na análise (seção 11). Fora de episódio, a API ficou ociosa em 92 a 96% do tempo, sem ponto quente no código da aplicação;
  - **memória do Windows (seção 10):** o host tinha cerca de 2 GB livres, com o commit em 86 a 92% do limite. A memória disponível caiu a 332 MB durante um upload de 1 GB, e o processo da VM do WSL cresceu cerca de 1,25 GB por upload. É um fato novo, ainda sem correlação medida com um episódio.

## Hipóteses

| Hipótese | Pergunta | Situação ao final |
|----------|----------|-------------------|
| H1 | O tempo nasce fora da API: na sonda, na rede do Docker ou no caminho até o handler? | **Pouco provável como origem principal, não excluída.** A espera fica do lado servidor e alcança todas as sondas juntas |
| H2 | O event loop da API fica ocupado por trabalho da própria API (CPU)? | **Em aberto.** Nos episódios dos primeiros ensaios (A4 e B4), a API usou 2 a 3 ms de CPU no segundo travado. Nos da comparação, usou CPU quase igual ao intervalo real (2.772 em 3.036 ms; 1.407 em 1.515 ms). O consumo não foi atribuído: o perfil (seção 10) não capturou episódio |
| H3 | O PostgreSQL é a origem (consulta lenta ou espera por conexão)? | **Não sustentada como origem, não excluída.** Ele também atrasa nos episódios, e o tempo para obter conexão do pool aumenta a espera |
| H4 | A VM inteira trava sob disputa por disco ou memória? | **Hipótese principal, sustentada pelas medições.** Processos de containers diferentes param juntos, nos picos de pressão de I/O e de memória. O mecanismo não foi isolado |
| H5 | O modo watch da API causa ou agrava? | **Não é necessário para o efeito.** O maior travamento (1,5 s) foi sem watch. O efeito de agravamento não foi quantificado |
| H6 | O cliente dentro da VM (leitura do arquivo e CPU) é necessário para os episódios? | **Não sustentada.** Com o cliente no Windows, houve episódios nas 2 de 2 rodadas, mais longos que no cenário A (seção 9) |

## 1. Evidências existentes da P-10GB (só leitura)

Fonte: `P-10GB-evidencias/`; análise em [`R-02-diagnostico-evidencias/analise-p10gb.txt`](R-02-diagnostico-evidencias/analise-p10gb.txt).

**Fatos:**
- **Momento:** as 89 amostras acima de 250 ms caíram todas em intervalos de upload ativo.
- **Conferência da retomada:** cerca de 47 s em que o cliente só lia o arquivo e calculava SHA-256, sem PUT e sem chamadas à API. O p95 foi de 1.753 ms.
- **Fim simultâneo:** as respostas lentas de sondas diferentes terminam juntas. Das 89, 68 estão em grupos de instâncias distintas cujo fim cai dentro de 100 ms, muitos com diferença de 1 a 8 ms e latências quase iguais.
- **Disparo sincronizado:** as 4 instâncias disparam praticamente no mesmo instante a cada 2 s (`epoch_ms mod 2000` entre 177 e 207 ms), porque foram iniciadas juntas. Elas amostram os mesmos instantes: um travamento atinge até 4 amostras de uma vez, e um travamento entre dois disparos passa despercebido.

**Leitura:** a espera é comum, do lado servidor ou do ambiente, e não nasce em cada sonda. Os fatos sozinhos não separavam H2, H3 e H4, e por isso foram feitos os ensaios.

## 2. Ensaios

Os ensaios foram curtos, com arquivos de 1 GB e uma variável por fase. Os scripts estão em [`R-02-diagnostico-evidencias/instrumentacao/`](R-02-diagnostico-evidencias/instrumentacao/).

**Instrumentação temporária:** fora do repositório da aplicação e removida no final, sem infraestrutura permanente.
- **`preload.js`:** carregado por `NODE_OPTIONS=--require=…` só no processo `dist/main` da API. Registra:
  - o instante de chegada ao handler (evento `request` do `http.Server`) e a duração até o `finish`;
  - por segundo, o atraso máximo do event loop (`monitorEventLoopDelay`), a CPU, o RSS e as faltas de página maiores do processo;
  - a espera por conexão do pool do `pg` (`Pool.connect`) e a duração de cada `Client.query`, só com o texto SQL truncado, sem parâmetros;
  - em escrita assíncrona em lote.
- **`sampler.sh`:** no `nestjs-api`, a cada 0,5 s. Registra os contadores da VM (`/proc/vmstat`: swap e faltas de página maiores), o PSI de CPU, I/O e memória, `/proc/meminfo` e `/proc/stat`, e, por processo (API, estressor e cliente), CPU, faltas de página maiores, RSS, swap e bytes lidos do disco.
- **`dbprobe.sh`:** uma sessão `psql` no container `db`, com uma consulta equivalente à do `GET /videos/:publicId` a cada 1 s.
- **Monitoramento:** `docker stats` a cada 2 s, e as 4 sondas oficiais (`responsiveness-probe.ts`, sem mudança) em containers próprios, como na P-10GB.

**Fases:** os marcadores usam o relógio dos containers.

| Fase | Variável | API |
|------|----------|-----|
| A0 | repouso | watch (`npm run start:dev`), como na P-10GB |
| A1 | SHA-256 de 1 GB em cache, no `nestjs-api` (CPU) | watch |
| A2 | SHA-256 de 1 GB com o cache do arquivo descartado (`dd iflag=nocache`) antes de cada passada, no `nestjs-api` (leitura de disco) | watch |
| A3 | o mesmo de A2, num container separado | watch |
| A4 | upload real de 1 GB pelo cliente de prova, até `MEDIA_INVALID` | watch |
| B0, B2, B4 | repetições de A0, A2 e A4 | **sem watch** (`node dist/main`), a única variável trocada |

## 3. Medidas por fase

Saída completa em [`R-02-diagnostico-evidencias/analise.txt`](R-02-diagnostico-evidencias/analise.txt) e [`processos.txt`](R-02-diagnostico-evidencias/processos.txt). As fases A4 e B4 incluem o upload inteiro (14 a 16 s).

| Fase | Sonda: p95 / máx (amostras >250 ms) | Servidor, `GET /videos/:id`: p95 / máx | Event loop: máx | `pg`: consulta máx / espera do pool máx | PSI io / memória (% do tempo) | iowait | Swap out |
|------|------|------|------|------|------|------|------|
| A0 repouso | 9,6 / 12,3 ms (0) | 7,4 / 11,4 ms | 83 ms | 3,7 / 0,1 ms | 0,0 / 0,0 | 0,0% | 0 |
| A1 SHA-256 em cache | 4,3 / 13,7 ms (0) | 3,4 / 12,6 ms | 11 ms | 2,3 / 8,0 ms | 0,0 / 0,0 | 0,0% | 0 |
| A2 SHA-256 frio | 8,6 / **1.067** ms (4) | 6,8 / **892** ms | **269 ms** | **270 / 888 ms** | 1,3 / 0,0 | 0,5% | 0 |
| A3 frio em outro container | 6,4 / 24 ms (0) | 4,7 / 22 ms | 15 ms | 3,9 / 13,7 ms | 0,3 / 0,0 | 0,1% | 0 |
| A4 upload de 1 GB | 250 / **1.650** ms (2) | 126 / 180 ms | **1.073 ms** | 93 / 90 ms | 5,4 / 8,0 | 3,6% | 1.177 pág |
| B0 repouso, sem watch | 5,9 / 24 ms (0) | 4,1 / 16 ms | 13 ms | 9,9 / 9,1 ms | 0,1 / 0,0 | 0,0% | 0 |
| B2 SHA-256 frio, sem watch | 7,1 / 34 ms (0) | 5,9 / 32 ms | 14 ms | 5,0 / 21 ms | 0,1 / 0,0 | 0,1% | 0 |
| B4 upload de 1 GB, sem watch | 92 / 92 ms (0) | 69 / 70 ms | **1.512 ms** | 18 / 50 ms | 19,2 / 2,6 | 10,2% | 636 pág |

**Consumo por processo no `nestjs-api`:**
- **API:** de 1 a 4% de um núcleo em todas as fases, sem páginas do processo em swap (`VmSwap` 0), com até 17 faltas de página maiores por fase.
- **Estressor:** de 115 a 126% de CPU. Na leitura fria, foi mesmo ao disco: 26 a 28 GB lidos em 60 s, a cerca de 450 MiB/s.
- **Cliente:** de 118 a 144% de CPU no upload.
- **Sondas:** perto de 0% de CPU.

## 4. Os travamentos

Os segundos em que o event loop da API atrasou mais de 100 ms, cruzados com as outras fontes:

| Episódio | Atraso do event loop | CPU da API no segundo | Amostrador no `nestjs-api` (intervalo; o normal é 0,53 s) | Sonda do db, em outro container (intervalo; o normal é 1,0 s) | Pressão na VM no intervalo | Efeito nas sondas |
|----------|------|------|------|------|------|------|
| A2, SHA-256 frio | 269 ms | 458 ms | **1,32 s** | **1,44 s** | I/O: 328 ms (`some`) e 299 ms (`full`); iowait de 12,8% | 4 requisições simultâneas: 2 com 273 ms (consulta de 269 ms) e 2 com 892 ms (887 ms para obter conexão do pool, no `Pool.connect`); sonda até 1.067 ms |
| A4, upload com watch | 1.073 ms | **2 ms** | **3,66 s** | sem lacuna | memória: 466 ms; I/O: 142 ms; 332 páginas para o swap; 45 faltas maiores | 1 amostra de 1.650 ms, que chegou ao handler 1.466 ms depois do disparo |
| B4, upload sem watch | 1.512 ms | **3 ms** | **2,26 s** | **3,15 s** | I/O: **2.257 ms** (`some`) e **1.620 ms** (`full`) em 2,26 s; iowait de 45%; 144 MiB em writeback logo antes | nenhuma: o travamento caiu entre dois disparos das sondas sincronizadas |

Nestes três episódios dos primeiros ensaios:
- **A API parada:** a API parou sem trabalhar. Nos dois longos, o processo usou 2 a 3 ms de CPU no segundo travado: estava esperando fora da CPU. **Isso não se generaliza:** nos episódios da comparação (seção 9), o processo da API registrou CPU quase igual à duração real do intervalo (ver a seção 10).
- **Outros processos:** outros processos pararam junto: o amostrador em shell do mesmo container e, na A2 e na B4, o PostgreSQL ou o `psql` de outro container.
- **Pressão no ambiente:** o intervalo coincide com pressão de I/O (na B4, algum processo esperou disco durante todo o intervalo, e todos os processos ativos, em 72% dele) ou com recuperação de memória e swap (A4).

## 5. Conclusões e hipótese principal

As conclusões abaixo valem para o que foi medido. Elas sustentam a disputa por disco e memória como hipótese principal, mas não excluem definitivamente a API, o banco ou a rede, e não isolam o mecanismo.

1. **Episódios curtos:** a latência alta vem de episódios curtos (0,3 a 1,5 s nos ensaios, até 3,8 s na P-10GB) em que a API segura as requisições. Por isso as respostas das sondas terminam juntas.
2. **A VM inteira para:** nos episódios dos primeiros ensaios, o processo da API fica fora da CPU, e processos de outros containers param ao mesmo tempo. Nos da comparação, os outros processos também param, mas a API registra CPU quase igual ao intervalo; esse consumo não foi atribuído. Os episódios coincidem com pressão de disco e de memória na VM do Docker Desktop.
   - **VM:** 16 vCPUs e 7,6 GiB.
   - **Swap:** 2 GiB, dos quais cerca de 1,55 GiB já estavam em uso em repouso, antes dos ensaios.
   - **Disco:** um único disco virtual (`docker_data.vhdx`) para o storage, o banco, a API e o arquivo do cliente.
3. **Sem transporte de bytes pela API:**
   - **episódio sem chamadas:** a A2 reproduziu um episódio sem nenhuma chamada do cliente à API, só com leitura e SHA-256 locais, como na conferência da P-10GB;
   - **pouco trabalho fora dos episódios:** a API usou de 1 a 4% de CPU durante os uploads dos primeiros ensaios, e de 6 a 14% nos do ensaio com perfil, em que ficou ociosa em 92 a 96% do tempo;
   - **rotas de controle rápidas:** fora dos episódios, o `GET /videos/:id` ficou abaixo de 12 ms no servidor, e as rotas de controle do upload ficaram abaixo de 160 ms (`part-urls` até 134 ms, `completion` até 157 ms).

   O desenho do R-02 em que a API não transporta bytes se confirma; o que falha é o atendimento durante os travamentos do ambiente.
4. **PostgreSQL:** nas fases sem episódio, as consultas ficaram com p95 abaixo de 2 ms e a espera do pool abaixo de 22 ms.
   - **No episódio da A2:** uma consulta levou 269 ms, e o tempo para obter conexão do pool (`Pool.connect`), 887 ms.
   - **Pool:** a instrumentação mede só o tempo até o pool entregar a conexão; ela não registra se a conexão era nova ou reaproveitada. Uma explicação possível é o pool abrir conexões para as rajadas de 4 requisições sincronizadas (ele fecha as ociosas depois de 10 s, por padrão), mas isso **não foi verificado**. De todo modo, esse tempo aumenta a espera nos episódios, sem ser a origem sustentada pelas medidas.
5. **Modo watch:** não é necessário para o efeito. O maior atraso do event loop (1.512 ms) foi sem watch. O agravamento não foi medido.
6. **Método:** as 4 instâncias da sonda disparam juntas.
   - **Na P-10GB:** as 437 amostras de carga cobrem cerca de 110 instantes distintos, e cada travamento conta até 4 vezes.
   - **Nos ensaios (B4):** um travamento de 1,5 s passou despercebido entre dois disparos.

   Isso não muda o veredito da P-10GB, cujos critérios continuam valendo, mas é relevante para a decisão sobre o cenário de medição.

**Não confirmado:** os ensaios reproduziram os atrasos, mas não isolaram definitivamente o mecanismo dentro da VM: writeback de páginas sujas, journal do ext4, swap ou latência do disco virtual no host Windows. Também não foi confirmado que a memória mais apertada dos 10 GB torna os episódios mais frequentes e longos na P-10GB, embora seja coerente com os dados (a carga da P-10GB teve 89 amostras lentas em 218 s).

## 6. Menor ajuste necessário (indicado, não implementado)

**Situação depois do perfil (seção 10):** **não há conclusão suficiente** para indicar com segurança um ajuste sustentado pelas evidências.
- **Episódios não capturados:** o perfil não capturou nenhum episódio, então o consumo de CPU da API nos episódios da comparação continua sem explicação.
- **Pressão de memória no host:** a pressão de memória no Windows é um fato novo, mas ainda sem correlação medida com um episódio.

Os itens abaixo continuam como candidatos, não como ajuste sustentado.

- **No código e na arquitetura:** nenhum ajuste é indicado pelas medidas, que não apontam gargalo na API, nas consultas nem no desenho do upload. Como a API, o banco e a rede não foram excluídos definitivamente, isso deve ser reavaliado se a hipótese principal não se confirmar.
- **No ambiente da prova:** pela hipótese principal, o problema está no ambiente compartilhado. O menor ajuste candidato é isolar o I/O pesado da prova da API e do banco, mantendo a arquitetura e o cenário da sonda.
  - **Já testado (seção 9):** rodar o cliente e o arquivo fora do Docker/WSL **não bastou** neste host. A carga que fica na VM (as escritas do storage no VHDX e a entrada de rede pela porta publicada) e o disco físico compartilhado com o Windows bastaram para os episódios.
  - **Opção 1:** limitar ou dar peso menor ao I/O do container `storage` durante a prova (por exemplo, `blkio_config` no Compose). O I/O do cliente sozinho não explica os episódios (seção 9).
  - **Opção 2:** rodar o storage e o arquivo do cliente num disco ou VM separados dos da API e do banco.
  - **Memória:** liberar a memória da VM antes da prova, já que o swap está 75% ocupado em repouso.

  Qualquer dessas opções muda configuração ou ambiente e depende da decisão sobre o R-02 e a TD-01. Antes de uma nova execução de 10 GB, os mesmos ensaios curtos devem mostrar que os episódios desaparecem.
- **Atenuação secundária, opcional e não verificada:** manter conexões ociosas no pool do `pg` poderia reduzir o tempo para obter conexão durante os travamentos, se esse tempo vier de abertura de conexões, o que não foi verificado. Não remove a hipótese principal e só faz sentido se a decisão quiser.
- **Para a decisão:** se o cenário fixado, com o cliente de upload e o arquivo de 10 GB no mesmo disco e VM do servidor, representa o ambiente que o R-02 pede. Em produção, o cliente é o navegador do usuário, fora do servidor.

## 7. Limitações

- **Poucos episódios:** os ensaios foram curtos (60 s por fase; uploads de 14 a 16 s), com 120 amostras por fase. Houve 1 episódio na A2, 2 na A4 e 3 na B4, e a frequência não foi estimada.
- **Memória menor que na P-10GB:**
  - **Arquivo:** o arquivo de 1 GB cabe na memória da VM, então a pressão de memória foi bem menor que na P-10GB (10 GB, maior que a RAM). Os ensaios reproduziram o mecanismo, não a intensidade.
  - **Leitura fria:** com o cache descartado por `dd iflag=nocache`, a leitura foi ao disco a cerca de 450 MiB/s, mais rápida que os 104 MiB/s da conferência da P-10GB.
- **A3 não isola a variável do container:** o arquivo da A3 tinha acabado de ser escrito, e a leitura dele não foi amostrada por processo, porque roda em outro container.
- **Watch e sem watch:** foram comparados com um upload de 1 GB cada. Os dois modos tiveram episódios, e a diferença não foi quantificada.
- **Sonda do db (só nos ensaios; corrigida na comparação da seção 9):** o `\timing` do `psql` não foi ativado, porque o `echo` do `sh` transformou `\t` em tabulação. Sem a duração das consultas por essa via, só a cadência de 1 s foi usada, e as lacunas dela aparecem nos episódios. A duração das consultas vem da instrumentação do `pg` na API.
- **Caminho das saídas:** as saídas das sondas, do amostrador e da sonda do db passam pelos streams do `docker compose exec` e `run` até arquivos no WSL. Parte das lacunas poderia vir desse caminho. Mas a medida do próprio processo da API (event loop e CPU, gravada em arquivo dentro do container) mostra o mesmo travamento.
- **Instrumentação:** o preload acrescenta um custo pequeno ao processo da API.
- **Prova oficial:** os ensaios não substituem a P-10GB, que continua `reprovada` com os critérios fixados.

## 8. Recursos e limpeza

- **Criados e removidos:**
  - os usuários `r02-<runId>-uploader` e `r02-<runId>-control` `@proofs.streamtube.test`, com o vídeo de controle e os dois vídeos de 1 GB;
  - o diretório `/tmp/r02-<runId>/` do `nestjs-api`, com a instrumentação e o arquivo de 1 GB;
  - os containers das sondas e do estressor;
  - os arquivos da sonda do db.
- **Depois da limpeza:**
  - **retratos:** iguais aos de antes;
  - **storage:** a lixeira foi purgada 190 s depois, e os 5 temporários anteriores do Silo continuam, sem nenhum novo;
  - **API:** parada.
- **Espaço:** 42,40 GB livres em C: no fim. O `docker_data.vhdx` continuou com 40,85 GB, sem compactação.
- **Evidências:** [`R-02-diagnostico-evidencias/`](R-02-diagnostico-evidencias/), com o caminho local trocado por `<saída>`, `<scratchpad>` ou `<repositório>`:
  - `analise-p10gb.txt`, `analise.txt` e `processos.txt`;
  - `instrumentacao/`, com os scripts temporários;
  - `ensaios/`, com o log, as marcas de fase, os CSVs e logs das sondas, os registros da instrumentação da API, as amostras da VM, a sonda do db, o `docker stats`, os eventos dos uploads, os retratos e os temporários do Silo.

  Nenhum arquivo traz token, senha ou URL assinada. As ocorrências da palavra `password` são o nome da rota `/auth/forgot-password` no log e o nome da coluna no texto SQL, sem parâmetros.

## 9. Comparação: cliente no ambiente atual (A) × fora do Docker/WSL (B)

**Pergunta:** a leitura do arquivo e a CPU do cliente dentro da VM do Docker são necessárias para os atrasos?

**Viabilidade, conferida antes com as ferramentas existentes:**
- **interop:** o WSL executa binários do Windows (`binfmt_misc` `WSLInterop` ativo);
- **Node nativo:** v22.17.0 no Windows, sem instalação nova;
- **rede:** pelo `localhost` do Windows, o Node alcança o storage (porta 9000, HTTP 200) e a API (porta 3000, HTTP 200). É o mesmo caminho do navegador, e as URLs assinadas (`localhost:9000`) servem sem `--storage-connect`.

Nenhuma infraestrutura nova foi criada.

**Desenho:**
- **Mesmo cliente:**
  - o `upload-client.ts` foi compilado **uma vez** para JavaScript, no container. O mesmo arquivo (SHA-256 `712670275c780413…`) rodou no Node do container (A) e no Node do Windows (B), sem mudança de lógica;
  - os parâmetros foram iguais: 4 PUTs simultâneos, lotes de 10, registro a cada 4 e 1,1 s entre `part-urls`.
- **Mesmo ambiente:** API (watch, como na P-10GB, com a mesma instrumentação), banco, storage, worker e as 4 sondas iguais nos dois cenários.
- **Contas:** usuários de upload separados para A e B, para que a rotação do refresh token de um não afete o outro.
- **Arquivos:** os de 1 GB foram gerados antes da medição: no `/tmp` do `nestjs-api` (A, 4,6 s) e na pasta temporária do Windows (B, 3,8 s). Os dois ficaram quentes no cache do próprio sistema, sem descarte.
- **Ordem:** repouso de 60 s e depois A1, B1, A2 e B2, alternados, com 20 s entre as rodadas. Cada upload foi até `MEDIA_INVALID`, sem interrupção.
- **Janela de cada upload:** pelo relógio do servidor, o mesmo da sonda e das amostras da VM. Vai da chegada do primeiro `part-urls` ao fim do `completion`, no log de requisições da API, e vale igual para A e B.
- **Sonda do PostgreSQL corrigida:** o `\timing` agora é ativado com `printf`. Ela registra o tempo de cada consulta e a cadência de 1 s.

**Diferenças inevitáveis entre os cenários:**
- **Rede:** A usa a rede do Compose, com `--storage-connect`; B usa as portas publicadas no Windows (encaminhamento do Docker Desktop). Os PUTs de B foram mais lentos (71 a 87 MiB/s, contra 150 a 177 MiB/s), e por isso os uploads de B duraram mais: 11,4 a 13,6 s, contra 7,0 a 8,0 s.
- **Disco do arquivo:** A lê do ext4 no VHDX do Docker. B lê do NTFS do Windows, **no mesmo disco físico C: que guarda o `docker_data.vhdx`**. B tira o cliente da VM, mas não do disco físico.
- **Node:** v25.6.0 no container e v22.17.0 no Windows.
- **Métricas do Windows:** a CPU e o disco do processo `node.exe` no Windows não foram amostrados. Do lado do cliente, só há os eventos dele (checksums e PUTs).

**Resultados** (saída completa em [`R-02-diagnostico-evidencias/analise-comparacao.txt`](R-02-diagnostico-evidencias/analise-comparacao.txt)):

| Janela | Duração no servidor | Sonda: amostras; máx (>250 ms) | `GET` no servidor: máx | Event loop: máx | Amostrador: maior intervalo | Sonda do db: maior intervalo; consulta máx | PSI io / memória (`some`) | Swap out | Cliente: PUT; checksum |
|------|------|------|------|------|------|------|------|------|------|
| R0 repouso | 60,2 s | 120; 39 ms (0) | 38 ms | 38 ms | 0,55 s | 1,00 s; 0,9 ms | 0,1% / 0,0% | 0 | — |
| A1 (container) | 8,0 s | 16; 13 ms (0) | 11 ms | 27 ms | 0,65 s | 1,07 s; 1,1 ms | 3,5% / 0,0% | 0 | 177; 154 MiB/s |
| B1 (Windows) | 11,4 s | 24; **3.163 ms** (4) | **2.960 ms** | **2.781 ms** | **4,12 s** | **3,83 s**; 1,4 ms | 9,8% / **21,1%** | 180 pág | 87; 222 MiB/s |
| A2 (container) | 7,0 s | 16; **2.308 ms** (2) | 172 ms | **921 ms** | **2,54 s** | 1,55 s; 1,2 ms | 11,2% / 12,8% | 39 pág | 150; 313 MiB/s |
| B2 (Windows) | 13,6 s | 28; **4.691 ms** (6) | **4.573 ms** | **1.380 ms** | **6,17 s** | **4,91 s**; 1,4 ms | 8,1% / 7,0% | 110 pág | 71; 88 MiB/s |

**Fatos:**
- Os 4 uploads chegaram a `202` e `MEDIA_INVALID`.
- **Cenário A:** um episódio em 2 rodadas (A2). O A1 ficou limpo em todos os sinais (event loop, amostrador, sonda do db e PSI), não só nas sondas.
- **Cenário B:** episódios nas 2 de 2 rodadas, mais longos que em A:
  - event loop de 1,4 a 2,8 s;
  - o próprio `GET` medido no servidor chegou a 4,6 s;
  - o amostrador do `nestjs-api` ficou parado de 4,1 a 6,2 s, e a sonda do db, de 3,8 a 4,9 s.
- **Pressão na VM em B:** mesmo sem o cliente dentro dela, a VM teve pressão de memória (PSI `some` de 21% na B1) e swap.
- **PostgreSQL:** quando a sonda do db conseguiu rodar, as consultas levaram no máximo 1,4 ms. O que aparece são as lacunas na cadência, ou seja, o processo parado, e não consultas lentas.

**O que isso sustenta e o que não sustenta:**
- **Sustenta:** a leitura do arquivo e a CPU do cliente dentro da VM **não são necessárias** para os episódios (H6 não sustentada). A disputa por disco e memória continua como hipótese principal, porque em B a VM seguiu com pressão de memória e swap, e os episódios têm a mesma assinatura do ambiente inteiro.
- **Não separa:** as cargas que sobram em B não foram separadas entre si:
  - as escritas do storage no VHDX, comuns a A e B;
  - a entrada de rede pelo encaminhamento de portas do Docker Desktop, só em B, com o storage a 191% de CPU na B1;
  - a leitura do Windows no mesmo disco físico do VHDX, só em B.
- **Duração:** B ficou exposto por mais tempo (uploads 43 a 94% mais longos), o que aumenta a chance de episódio.
- **Amostra:** com 2 rodadas por cenário, a comparação mostra que os episódios persistem fora do container; não mede a diferença de frequência entre A e B.

**Limitações da comparação:**
- poucas rodadas, curtas (7 a 14 s), com 16 a 28 amostras de sonda por rodada, ainda com as instâncias sincronizadas;
- arquivo de 1 GB, quente no cache, sem a pressão de memória dos 10 GB;
- o caminho de rede e a versão do Node diferem entre os cenários;
- o Windows não foi instrumentado: nem a CPU e o disco do `node.exe`, nem a atividade de antivírus ou de outros processos;
- os ensaios não substituem a P-10GB.

**Recursos e limpeza da comparação:**
- **criados:**
  - 3 usuários `r02b-<runId>-*` `@proofs.streamtube.test` e 5 vídeos (controle e 4 uploads de 1 GB);
  - o `/tmp/r02b-<runId>/` do `nestjs-api`;
  - a pasta `r02b-<runId>` na pasta temporária do Windows, com o arquivo de 1 GB, o cliente compilado e as credenciais do usuário B;
  - os containers das sondas e os arquivos da sonda do db;
- **removidos:** todos;
- **depois da limpeza:**
  - **retratos:** iguais;
  - **storage:** a lixeira foi purgada 80 s depois, e os 5 temporários anteriores do Silo continuam, sem nenhum novo;
  - **API:** parada;
  - **espaço:** 42,16 GB livres em C:.

A aplicação, o pool do banco e os limites de I/O não foram alterados.

**Evidências:** [`R-02-diagnostico-evidencias/comparacao/`](R-02-diagnostico-evidencias/comparacao/):
- o log, as marcas, os CSVs e logs das sondas, os registros da instrumentação da API, as amostras da VM, a sonda do db com tempos, o `docker stats` e os eventos dos 4 uploads;
- os retratos e os temporários do Silo;
- os scripts em [`instrumentacao/`](R-02-diagnostico-evidencias/instrumentacao/): `r02-comparacao.sh`, `analisa-comparacao.py` e `dbprobe-corrigido.sh`. O `dbprobe.sh` original dos ensaios foi preservado.

O caminho local e a pasta temporária do Windows foram trocados por `<saída>`, `<scratchpad>`, `<repositório>` e `<temp-do-windows>`.

## 10. CPU da API nos episódios, perfil de CPU, GC e memória do Windows

### 10.1 Conferência dos registros da comparação

Detalhes em [`R-02-diagnostico-evidencias/analise-cpu-comparacao.txt`](R-02-diagnostico-evidencias/analise-cpu-comparacao.txt).

**Registros do processo da API** (preload, `comparacao/api-loop.jsonl`):

| Registro | Intervalo real desde a coleta anterior | CPU do processo (usuário + sistema) | Atraso máx. do event loop | Faltas de página maiores |
|----------|------|------|------|------|
| `t=1795566313070` (B1) | **3.036 ms** | **2.772 ms** (91% de um núcleo) | 2.780,8 ms | sem aumento |
| `t=1795566378412` (B2) | **1.515 ms** | **1.407 ms** (93% de um núcleo) | 1.379,9 ms | sem aumento |

**Amostrador** (`/proc/<pid>/stat` do `node dist/main`):
- **Consumo:** soma cerca de 2,9 s de CPU (2.060 ms de usuário e 830 ms de sistema) em volta do primeiro episódio.
- **Carimbo:** o amostrador também parou, e o carimbo de cada volta é tirado antes da leitura do `/proc`. Por isso esse consumo aparece numa volta com carimbo anterior ao travamento, e a duração real vem do registro do processo.

**Conclusão:** nesses episódios, a API **usou CPU** durante o atraso, ao contrário dos episódios dos primeiros ensaios. Esse consumo não está atribuído a uma função, ao banco nem exclusivamente ao ambiente.

### 10.2 Ensaio com perfil de CPU (cenário B, cliente no Windows)

**Instrumentação** (temporária, fora do repositório): `preload-perfil.js`, uma nova versão; o `preload.js` anterior foi preservado.
- **Perfil de CPU:** do V8, só no processo `dist/main` da API, com o módulo `inspector` em processo e amostragem de 1 ms. É ligado e desligado por arquivos de gatilho a cada upload.
- **Pausas de GC:** por `PerformanceObserver` do tipo `gc`.
- **CPU:** de usuário e de sistema separadas, com a **duração real** entre coletas.
- **O resto:** event loop, requisições e `pg`, como antes.

**Monitoramento:**
- **Ambiente da VM:** o amostrador, a sonda do PostgreSQL (`dbprobe-corrigido.sh`), o `docker stats` e as 4 sondas.
- **Windows** (`monitor-windows.ps1`, com CIM e `Get-Process`, ferramentas nativas): memória disponível e comprometida, limite de commit, paginação, arquivo de paginação, disco físico, working set do `vmmemWSL` e CPU do `node.exe`. Uma amostra a cada cerca de 1,3 s.

**Desenho:**
- **Cliente e parâmetros:** o mesmo cliente compilado, rodando no Node do Windows, com os mesmos parâmetros (4 PUTs simultâneos).
- **Arquivo:** o de 1 GB foi preparado antes da medição.
- **Critério de episódio, fixado antes:** algum registro com atraso do event loop ≥ 500 ms na janela do upload.
- **Repetição:** sem episódio, só mais uma execução.

**Resultado:** **não houve episódio** nas duas execuções (B1 e B2), e pela regra não houve uma terceira.

| Execução | Maior atraso do event loop no upload | CPU da API por segundo | GC | `GET` no servidor: máx | Windows: memória disponível (mín) | Windows: commit (máx) | `vmmemWSL` |
|------|------|------|------|------|------|------|------|
| B1 | 28,5 ms | 6 a 14% (um segundo com 36%, na coleta que reduziu o heap de 128 para 81 MiB) | 3 pausas, 48 ms no total, maior de 26,9 ms | 35,9 ms | 1.285 MB | 29,71 de 33,05 GB | 2,75 → 4,00 GB |
| B2 | 20,0 ms (sem contar o arranque do perfil) | 6 a 14% | nenhuma | 40,7 ms | **332 MB** | 30,50 de 33,05 GB | 4,42 → 5,20 GB |

**Perfil de CPU da API** (análise em [`R-02-diagnostico-evidencias/analise-perfil.txt`](R-02-diagnostico-evidencias/analise-perfil.txt)):
- **Ociosidade:** a API ficou ociosa, `(idle)`, em 92,5% (B1) e 96,4% (B2) do tempo.
- **Maior consumo:** foi da própria instrumentação: o arranque do perfil (`inspector`), com 538 ms na B1 e 158 ms na B2.
- **Código usado:** o resto se espalha em fatias pequenas (no máximo 46 ms por pacote em cerca de 13 s):
  - montagem de consultas do TypeORM;
  - leitura de linhas do `pg`;
  - `createPublicKey` do `jsonwebtoken`, na validação do token;
  - o throttler;
  - escrita em socket.
- **Sem ponto quente:** não há ponto quente no código da aplicação.
- **GC:** 73 ms na B1 e 0 na B2.

**Artefato da instrumentação:** ligar o perfil bloqueou o event loop. Houve um atraso de 562,6 ms, com 544 ms de CPU, logo antes da B1, e outro de 164,9 ms no início da B2. Os dois caem no instante do `Profiler.start`. Eles ficaram fora das conclusões, e numa próxima medição o perfil deve ser ligado bem antes do upload.

**Memória e paginação do Windows** (`perfil/windows.csv`):
- **Antes dos uploads:** o host tinha cerca de 2,0 a 2,2 GB disponíveis (de 16 GiB), com o commit em 28,5 a 29,1 GB de um limite de 33,05 GB.
- **Durante cada upload:**
  - a memória disponível caiu: até 1.285 MB na B1 e **332 MB** na B2;
  - o `vmmemWSL` cresceu cerca de 1,25 GB;
  - houve picos de paginação: entradas até cerca de 91 mil páginas/s e saídas até cerca de 103 mil páginas/s;
  - houve picos de disco, com fila de até 38.
- **Leitura dos contadores:** parte das entradas de página deve ser a leitura do arquivo de 1 GB pelo cache do Windows, e parte das escritas, o VHDX recebendo os dados do storage. Os contadores não separam essas parcelas.

**O que isso sustenta:**
- **Fora de episódio:** durante um upload normal de 1 GB, a API não tem ponto quente de CPU nem pausas de GC relevantes.
- **Host sob pressão de memória:** o host Windows trabalha com pouca memória livre e chega perto de esgotá-la durante um upload de 1 GB.

**O que não sustenta:**
- **Origem da CPU:** de onde vieram os 2,8 s e 1,4 s de CPU da API nos episódios da comparação. Nenhuma das execuções com perfil teve episódio.
- **Relação com o Windows:** se a pressão de memória do Windows causa os episódios. Ela não foi medida durante nenhum episódio.

Uma explicação possível, **não verificada**, é que a paginação do host atrase a VM de um modo que o convidado contabiliza como CPU do processo em execução. Ela seria coerente com os dois tipos de episódio (CPU perto de zero e CPU perto do intervalo), mas não há medida que a confirme.

**Menor ajuste sustentado:** **nenhum, com as evidências atuais.**
- **Próximo passo diagnóstico:** capturar um episódio com o perfil já ligado, bem antes do upload, e com o monitor do Windows ativo.
- **Aproximação:** a correlação entre o episódio, a CPU da API, o perfil e a memória do host é o que pode separar as hipóteses.
- **Restrições:** RAM e limites de I/O não foram alterados, conforme pedido.

**Limitações:**
- os episódios não se repetiram em 2 execuções;
- o monitor do Windows amostra a cada cerca de 1,3 s, mais devagar que o event loop;
- os contadores do Windows misturam o cache de arquivo e o arquivo de paginação;
- os relógios do Windows e da VM diferem em cerca de 20 ms, com incerteza de ±250 ms;
- o arranque do perfil é intrusivo.

**Recursos e limpeza:**
- **Removidos:**
  - 2 usuários `r02c-<runId>-*`;
  - 3 vídeos: o de controle e os 2 uploads de 1 GB;
  - o `/tmp/r02c-<runId>/` do `nestjs-api`;
  - a pasta `r02c-<runId>` na pasta temporária do Windows, com o arquivo de 1 GB, o cliente compilado, as credenciais, o monitor e o CSV;
  - os containers das sondas e os arquivos da sonda do db.

  Um teste prévio do monitor do Windows, numa pasta própria, também foi removido.
- **Depois da limpeza:**
  - **retratos:** iguais;
  - **storage:** a lixeira foi purgada 180 s depois, e os 5 temporários anteriores do Silo continuam, sem nenhum novo;
  - **API:** parada;
  - **espaço:** 42,16 GB livres em C:.

A aplicação, a arquitetura, o pool, a RAM e os limites de I/O não foram alterados.

**Evidências:**
- [`R-02-diagnostico-evidencias/perfil/`](R-02-diagnostico-evidencias/perfil/):
  - os **perfis de CPU** `perfil-B1.cpuprofile` e `perfil-B2.cpuprofile`, que abrem no Chrome DevTools, e os `-meta.json`;
  - `api-loop.jsonl`, com a CPU de usuário e de sistema e o intervalo real;
  - `api-gc.jsonl`, `api-requests.jsonl` e `api-db.jsonl`;
  - `windows.csv`;
  - as amostras da VM, a sonda do db com tempos, o `docker stats`, as sondas, os eventos, os retratos e o log.
- [`instrumentacao/`](R-02-diagnostico-evidencias/instrumentacao/): `preload-perfil.js`, `monitor-windows.ps1`, `r02-perfil.sh` e `analisa-perfil.py`.

### 10.3 Correção no material arquivado

O `instrumentacao/r02-comparacao.sh` arquivado passou a usar o `dbprobe-corrigido.sh`, com comentário. Antes ele usava o `dbprobe.sh`, e quem reproduzisse a comparação reintroduziria o erro do `\timing`. O `dbprobe-corrigido.sh` arquivado é idêntico ao usado na comparação, e a comparação não foi repetida.

## 11. Preparação de uma repetição da P-10GB

### 11.1 Ajustes da instrumentação e incerteza dos perfis atuais

**Tipos de coleta de lixo:**
- **Erro:** o `preload-perfil.js` mapeava `entry.detail.kind` como `{1: minor, 2: major, 4: incremental, 8: weakcb}`, mas as constantes de `node:perf_hooks` são `NODE_PERFORMANCE_GC_MINOR = 1`, `MAJOR = 4`, `INCREMENTAL = 8` e `WEAKCB = 16`, conferidas no Node do container e no do Windows.
- **Efeito:** nos registros gravados, o rótulo `incremental` é uma coleta **major**, e o rótulo `weakcb` é uma **incremental**.
- **Correção nos dados atuais:** como cada rótulo antigo corresponde a um único valor bruto, a análise nova o converte sem alterar os dados brutos. Na B1 do ensaio com perfil, as três pausas são uma minor de 26,9 ms, uma **major de 17,1 ms** (gravada como `incremental`) e uma incremental de 4,4 ms (gravada como `weakcb`).
- **Versão nova:** o `preload-v3.js` usa as constantes e grava também o valor bruto (`kindRaw`) e as `flags`.

**Alinhamento temporal do perfil:**
- **Erro:** o `wallStartMs` era tirado no callback do `Profiler.start`, depois do arranque do perfil. Mas os deltas das amostras contam a partir do `startTime` do V8, que é anterior.
- **Efeito:** a análise antiga deslocava todas as amostras para mais tarde, e as últimas passavam do `wallStopMs` em 523 ms (B1) e 136 ms (B2).
- **Relógio:** um teste mostrou que os carimbos do V8 usam o mesmo relógio monotônico do `process.hrtime`. O `startTime` cai entre o `hrtime` lido antes do `start` e o do callback, e o `endTime` entre o lido antes do `stop` e o do callback, com 1,7 ms de folga no teste.
- **Perfis atuais:** o `analisa-perfil-v2.py` os realinha pelo fim (`wallStopMs` contra `endTime`). Com isso, a última amostra coincide com o `wallStopMs`, e o `startTime` realinhado fica 523 ms (B1) e 137 ms (B2) antes do callback.
- **Incerteza que resta nos perfis atuais:** a latência entre o `endTime` e o callback do `stop`, que não foi medida nesses perfis (1,7 ms no teste isolado).
- **Conclusões:** não mudam, porque a análise do perfil inteiro não depende do alinhamento e não houve janela de episódio.
- **Versão nova:** o `preload-v3.js` grava `hrtime` e o horário de parede no pedido e nos callbacks de `start` e `stop`, para alinhar novos perfis pelo mesmo relógio do V8.

**Dados preservados:** os perfis, os `jsonl` e o `analise-perfil.txt` originais não foram alterados. A análise corrigida está em [`analise-perfil-realinhada.txt`](R-02-diagnostico-evidencias/analise-perfil-realinhada.txt).

### 11.2 Checagem do Windows com os serviços e as sondas em execução

**Meta operacional de preparação**, que não é critério de aprovação do R-02: 4 GiB disponíveis no Windows. A regra foi fixada antes, no `r02-verificacao.sh`.
- **Condições:** com a API (watch, como na P-10GB, com o `preload-v3.js` e sem perfil), os usuários de prova, o vídeo de controle, as 4 sondas, o amostrador, a sonda do PostgreSQL, o `docker stats`, o monitor do Windows e o arquivo de 1 GB já preparado no Windows.
- **Medida:** o **mínimo** de memória disponível em pelo menos 10 amostras (cerca de 20 s) precisa ser de pelo menos 4.096 MiB.
- **Sem a folga:** listar os maiores consumidores e parar, sem encerrar nada e sem mudar RAM, paginação, limites de I/O nem serviços.

**Resultado:** **folga insuficiente.**

| Medida | Valor |
|--------|-------|
| Memória disponível no Windows, na janela da folga (11 amostras) | mínimo de **1.600 MB**, mediana de 1.690 MB |
| Memória disponível, em todas as 19 amostras do monitor | de 1.522 a 1.841 MB |
| Commit | 23,75 de 33,05 GB |
| Arquivo de paginação | 13% usado |
| `vmmemWSL` (VM do WSL) | 4,86 GB de working set |
| Espaço livre em C: | 42,2 GB (o mínimo exigido pela V-07 é 29,5 GB) |

**Maiores consumidores de memória do Windows** (por nome de processo, sem PID, caminho ou título; [`verificacao/consumidores-memoria-windows.txt`](R-02-diagnostico-evidencias/verificacao/consumidores-memoria-windows.txt)):

| Processo | Instâncias | Working set | Memória privada |
|----------|-----------|-------------|-----------------|
| `vmmemWSL` (VM do WSL e do Docker) | 1 | 4.632 MB | 6.473 MB |
| `brave` | 13 | 1.469 MB | 1.466 MB |
| `svchost` | 100 | 1.069 MB | 1.411 MB |
| `Code` | 10 | 708 MB | 1.357 MB |
| `msedgewebview2` | 13 | 362 MB | 721 MB |
| `com.docker.backend` | 2 | 336 MB | 558 MB |
| `explorer` | 1 | 271 MB | 582 MB |
| `Taskmgr` | 1 | 181 MB | 105 MB |
| `powershell` (inclui o monitor) | 2 | 180 MB | 149 MB |
| `dwm` | 2 | 135 MB | 174 MB |

Os demais ficam abaixo de 125 MB cada.

**Decisão, pela regra:**
- **Parado:** nada foi encerrado.
- **Não executados:** a verificação de 1 GB e o registro prévio de uma nova execução de 10 GB (item 5), que dependiam dela.
- **Este passo:** não aprova o R-02 nem comprova a causa. Só mostra que, hoje, o host não tem a folga de memória definida para preparar a repetição.

**Recursos e limpeza:**
- **Removidos:**
  - 2 usuários `r02d-<runId>-*` e o vídeo de controle;
  - o `/tmp/r02d-<runId>/` do `nestjs-api`;
  - a pasta `r02d-<runId>` no temporário do Windows, com o arquivo de 1 GB, o cliente, as credenciais, o monitor e o CSV;
  - os containers das sondas e os arquivos da sonda do db.
- **Depois da limpeza:**
  - **retratos:** iguais;
  - **storage:** nenhum temporário novo no Silo;
  - **API:** parada;
  - **espaço:** 42,19 GB livres em C:.

**Para prosseguir:** é preciso que a pessoa responsável libere memória no Windows (por exemplo, fechando aplicativos) ou decida outra meta. A checagem pode ser repetida com o mesmo roteiro ([`instrumentacao/r02-verificacao.sh`](R-02-diagnostico-evidencias/instrumentacao/r02-verificacao.sh)), que faz a verificação de 1 GB só se a folga for atingida.

**Evidências:**
- [`R-02-diagnostico-evidencias/verificacao/`](R-02-diagnostico-evidencias/verificacao/): o log, o `windows.csv`, os consumidores, as sondas, os registros da API, as amostras da VM, a sonda do db, os retratos e os temporários.
- [`instrumentacao/`](R-02-diagnostico-evidencias/instrumentacao/): `preload-v3.js`, `analisa-perfil-v2.py` e `r02-verificacao.sh`.

## 12. Ensaio de 1 GB com a API e as sondas compiladas

### 12.1 Registro prévio (às 01:54Z de 2026-11-25, antes do ensaio)

**Revisão da meta de memória:** os 4 GiB disponíveis no Windows (seção 11.2) passam a ser uma **referência informativa**, não um bloqueio automático desta verificação de 1 GB. A memória é registrada e comparada a 4 GiB, mas o ensaio segue em qualquer caso. A revisão **não modifica** nenhum critério de aprovação do R-02 nem da P-10GB.

**Mudança no modo de execução, a única variável deste ensaio em relação aos anteriores:**
- **API:** sem watch, pelo build do projeto: `npm run build` (`nest build`) e depois `npm run start:prod` (`node dist/main`), no `nestjs-api`. Os monitores corrigidos (`preload-v3.js`) ficam ativos, sem perfil de CPU.
- **Sondas:** as 4 compiladas uma vez para JavaScript (`tsc`) e executadas com `node`, sem `ts-node`. Mantêm o mesmo comportamento e os mesmos parâmetros (2 s e 5 s de timeout), cada uma num container próprio (`docker compose run`), com o JS montado só para leitura pela opção `-v` do `run`. Isso não muda o Compose.
- **Cliente:** o mesmo cliente compilado, no Node nativo do Windows, com os mesmos parâmetros (4 PUTs simultâneos, lotes de 10, registro a cada 4, 1,1 s entre `part-urls`).
- **Arquivo:** o de 1 GB, preparado antes.
- **Inalterados:** o `video-worker` e os demais serviços.

**O que é registrado:**
- **Antes do upload:** a memória do Windows e dos containers, com os serviços e as sondas em execução.
- **Durante o upload:** as latências, o event loop, a memória e as falhas.

**Atraso:** um registro com event loop ≥ 500 ms ou uma sonda acima de 250 ms.

**Alcance:** uma execução, que não aprova o R-02 nem comprova a causa.

### 12.2 Execução

**Comandos e versões:**
- **Versões:** Node v25.6.0 no container, Node v22.17.0 no Windows, `tsc` 5.9.3 e Nest CLI 11.0.16.
- **API:**
  - `npm run build` (`nest build`), no `nestjs-api`. Regenerou só o `dist/`, que está fora do Git: o `openapi.json` e o `git status` ficaram iguais antes e depois, e o `dist-worker/` não mudou;
  - `NODE_OPTIONS=--require=<preload-v3.js> npm run start:prod`. Os processos foram `npm run start:prod`, depois `sh -c node dist/main` e por fim `node dist/main`, e a API ficou pronta em 3 s.
- **Sondas:**
  - compilação: `npx tsc … proofs/phase-03/upload-client.ts proofs/phase-03/responsiveness-probe.ts`, uma vez;
  - execução: `docker compose run --rm --no-deps -T -v <js>:/r02js:ro --name r02e-<runId>-probe-<i> nestjs-api node /r02js/responsiveness-probe.js --public-id <id> --instance <i>`. O processo 1 do container era `node /r02js/responsiveness-probe.js …`;
  - pré-checagem: a sonda compilada, montada no container, saiu com 64 em uso inválido.
- **Cliente:** o mesmo `upload-client.js` de antes (hash `712670275c780413`), no Node do Windows, com `--concurrency 4 --sign-batch 10 --register-every 4 --part-urls-interval-ms 1100`.

**Memória com os serviços e as sondas em execução**, antes do upload:

| Onde | Medida |
|------|--------|
| Windows (12 amostras) | disponível de **2.410 MB** (mínimo) e 2.464 MB (mediana), abaixo da referência informativa de 4 GiB; commit em 22,11 de 33,05 GB; arquivo de paginação em 9%; `vmmemWSL` com 3,50 GB |
| VM do Docker | `MemAvailable` de 4.536 MiB; swap livre de 484 MiB, de 2 GiB |
| Containers (`docker stats`) | `nestjs-api` (API compilada) 290,9 MiB; `video-worker` 238,3 MiB; `storage` 123,5 MiB; `db` 35,3 MiB; `mailpit` 28,2 MiB; `redis` 9,8 MiB; **cada sonda 13,7 a 13,8 MiB** |

**Upload V1 (1 GB, uma única execução).**

Janelas usadas, ajustadas na revisão:
- **E:** o **intervalo estrito do servidor**, da chegada do primeiro `part-urls` ao fim do `completion`, no log da API: de 1795571813974 a 1795571821135, ou seja, **7,161 s**;
- **E+1:** os registros de 1 s do processo da API que terminam entre o início de E e 1 s depois do fim;
- **M:** as marcas do roteiro em volta do cliente (10,272 s), que incluem a partida e o fim do processo do cliente;
- **A:** a janela ampla, M ± 3 s (16,3 s), usada antes para o Windows.

O monitor do Windows tem **5 amostras em E** e 12 em A.

| Medida | Janela | V1 |
|--------|--------|----|
| Duração | E | 7,161 s |
| Sonda: amostras, p95 / máximo | E (disparos) | 12; 90,5 / 90,5 ms; nenhuma acima de 250 ms |
| `GET /videos/:id` no servidor: p95 / máximo | E (chegadas) | 70,8 / 70,8 ms |
| Event loop: máximo | E+1 (8 registros) | 134,1 ms, num único segundo acima de 100 ms, com só 36 ms de CPU nesse segundo |
| CPU da API | E+1 | de 0,8 a 14,1% de um núcleo por segundo, com intervalos reais de 998 a 1.001 ms |
| GC | E | 1 pausa minor de 5,8 ms |
| Amostrador: maior intervalo | E | 588 ms, sem parada |
| Sonda do db: maior intervalo; consulta máxima | E ± 1,5 s | 1.002 ms, sem parada; 1,0 ms |
| VM (Linux): PSI de I/O (`some`/`full`), memória e CPU; iowait; swap da VM (páginas enviadas ao swap) | E | 3,4% / 3,2%; 0,0%; 1,3%; 1,9%; **0 páginas de swap na VM** |
| Windows: memória disponível; commit | E (5 amostras) | de 1.636 a 2.243 MB; até 23,09 GB |
| Windows: **leituras** de página (entradas para resolver faltas) | E (5 amostras) | até 10.052 páginas/s, em até 666 leituras/s |
| Windows: **escritas** de página (saídas) | E (5 amostras) | até **87.794 páginas/s**, em até 342 escritas/s; arquivo de paginação de 9 a 12% |
| Windows: disco físico | E (5 amostras) | leitura de até 198 MiB/s; escrita de até 438 MiB/s; fila de até 24 |
| Windows: `vmmemWSL` | E (5 amostras) | de 3,88 para 4,61 GB |
| Windows, para comparação | A (12 amostras) | disponível de 1.636 a 2.416 MB; leituras de página de até 69.758 páginas/s (na amostra 17 ms antes de E, na leitura inicial do arquivo); escritas de até 87.794 páginas/s; `vmmemWSL` de 3,59 para 4,67 GB |
| Cliente | eventos do cliente | PUT a 157,8 MiB/s; checksum a 261,8 MiB/s; `202` em 62,8 ms, depois `MEDIA_INVALID` |
| Falhas | ensaio inteiro | nenhuma nas sondas |

**Leituras, escritas e paginação:**
- **VM:** não houve swap na VM do Docker (Linux), e a pressão de memória lá ficou em 0%.
- **Windows, ao contrário, houve paginação intensa:**
  - leituras de página de até cerca de 10 mil páginas/s em E (até cerca de 70 mil em A);
  - escritas de página de até cerca de 88 mil páginas/s em E;
  - disco com até 438 MiB/s de escrita.
- **Limite dos contadores:** os contadores não separam o arquivo de paginação do cache de arquivos. Parte das leituras deve ser o arquivo de 1 GB lido pelo cache do Windows, e parte das escritas, o VHDX recebendo os dados do storage. A afirmação anterior "sem swap" valia só para a VM e foi corrigida.

**Folga de memória:** a referência de 4 GiB não foi mantida. O Windows ficou entre 1,6 e 2,4 GB disponíveis antes e durante o upload (2,24 GB no máximo em E). Mesmo assim, **não houve atraso** pelo critério registrado (event loop ≥ 500 ms ou sonda > 250 ms), nem parada do ambiente na VM.

### 12.3 Comparação com os ensaios anteriores, cliente no Windows

| Execução | Modo da API e das sondas | Perfil de CPU | Atraso pelo critério | Maior atraso do event loop | Pior sonda |
|----------|--------------------------|---------------|----------------------|----------------------------|------------|
| Comparação B1 | API em watch; sondas com `ts-node` | não | **sim** | 2.781 ms | 3.163 ms |
| Comparação B2 | API em watch; sondas com `ts-node` | não | **sim** | 1.380 ms | 4.691 ms |
| Perfil B1 | API em watch; sondas com `ts-node` | sim | não | 28,5 ms (fora o arranque do perfil) | 37,0 ms |
| Perfil B2 | API em watch; sondas com `ts-node` | sim | não | 20,0 ms (fora o arranque do perfil) | 50,9 ms |
| **V1 (este ensaio)** | **API sem watch (`start:prod`); sondas compiladas com `node`** | não | **não** | 134,1 ms | 90,5 ms |

**O que mudou de modo:**
- **API:** sem watch, pelo build. Os primeiros ensaios já tinham comparado watch e sem watch com o cliente no container: o maior travamento, de 1,5 s, foi sem watch.
- **Sondas:** sem `ts-node`, com o mesmo comportamento. A memória de cada uma caiu de cerca de 184 MiB para cerca de 14 MiB, o que libera cerca de 0,7 GiB na VM com 4 instâncias.

**Leitura:**
- **Atrasos:** com o cliente no Windows, houve atrasos em 2 das 4 execuções anteriores e em nenhuma de 1 execução neste modo. Com uma só execução e um fenômeno intermitente, **não dá para atribuir** a ausência de atraso à mudança de modo.
- **Memória:** a redução de memória das sondas é medida. Seu efeito sobre os atrasos não é.
- **Alcance:** este ensaio **não aprova o R-02 nem comprova a causa** dos atrasos.

**Limitações:**
- uma única execução de 1 GB, curta (7,2 s no servidor), com 12 amostras de sonda, ainda com as 4 instâncias sincronizadas;
- a memória do Windows não atingiu a referência de 4 GiB;
- o modo de execução mudou em duas coisas ao mesmo tempo, a API e as sondas, como foi pedido. O efeito de cada uma não foi separado.

**Recursos e limpeza:**
- **Removidos:**
  - 2 usuários `r02e-<runId>-*` e 2 vídeos (o de controle e o de 1 GB);
  - o `/tmp/r02e-<runId>/` do `nestjs-api`;
  - a pasta `r02e-<runId>` no temporário do Windows, com o arquivo de 1 GB, o cliente, as credenciais, o monitor e o CSV;
  - o JS compilado das sondas no scratchpad;
  - os containers das sondas e os arquivos da sonda do db.
- **Fica:** o `dist/` regenerado pelo build, que é artefato fora do Git e substitui o que o `start:dev` já gerava.
- **Depois da limpeza:**
  - **retratos:** iguais;
  - **storage:** a lixeira foi purgada 50 s depois, e não há temporário novo no Silo;
  - **API:** parada;
  - **espaço:** 42,15 GB livres em C:.
- **Sem alteração:** a aplicação, a arquitetura, as dependências, o Compose e os critérios. Nenhum aplicativo do Windows foi encerrado.

**Evidências:**
- [`R-02-diagnostico-evidencias/compilado/`](R-02-diagnostico-evidencias/compilado/):
  - o log;
  - `memoria-containers.txt` e `memoria-vm.txt`;
  - `windows.csv`;
  - as sondas;
  - os registros da API (`api-loop.jsonl`, com a CPU de usuário e de sistema e o intervalo real; `api-gc.jsonl`, com os tipos pelas constantes; `api-requests.jsonl`; `api-db.jsonl`);
  - as amostras da VM, a sonda do db, o `docker stats`, os eventos, os retratos e os temporários.
- [`analise-compilado.txt`](R-02-diagnostico-evidencias/analise-compilado.txt).
- [`instrumentacao/r02-compilado.sh`](R-02-diagnostico-evidencias/instrumentacao/r02-compilado.sh).

**Próximo passo:** não preparado nem executado. Esta etapa para antes de preparar ou executar outra prova de 10 GB.

## 13. Preparação da repetição formal da P-10GB

- **O que é:** a repetição formal da P-10GB tem registro prévio e roteiro próprios:
  - registro prévio: [`P-10GB-repeticao.md`](P-10GB-repeticao.md), fixado às 05:11Z de 2026-11-25;
  - roteiro: `nestjs-project/proofs/phase-03/p10gb-repeticao-roteiro.sh`, com os auxiliares em `p10gb-repeticao/`.
- **O que mantém:** o contrato e os critérios (a), (b) e (c) da P-10GB.
- **O que muda:** só o modo de execução, o do ensaio da seção 12:
  - a API sem watch e as sondas compiladas;
  - o cliente compilado no Node do Windows;
  - os outros serviços como estão.
- **Preservado:** a execução reprovada, o registro prévio dela e as evidências não mudaram. Neste diagnóstico, a seção 12.2 foi ajustada para separar a VM (0 páginas de swap) das leituras, escritas e paginação do Windows, com a janela de cada métrica.

**Dimensionamento:**
- **Referência:** a execução de 1 GB mais rápida medida (6,993 s, comparação A2), projetada para 10 GB, dá D ≈ 69,9 s.
- **Margem:** a carga pode ser até 30% mais curta, o que dá D_mín = 53,8 s.
- **N = 12**, com espaçamento de 167 ms entre as partidas.
- **Mantidos:** a base de pelo menos 600 s, as mesmas instâncias na base e na carga, uma requisição a cada 2 s e o mínimo de 300 amostras por fase. Nenhum período ocioso entra na carga.

**Relógios:**
- **Medida:** antes da base e depois da carga, com a menor ida e volta entre 15 medidas.
- **Ajuste:** os eventos do cliente vão para o relógio da VM, e cada intervalo de carga é encolhido pela incerteza dos dois lados.
- **Nas pré-checagens:** diferença de 36 a 66 ms e incerteza usada de 116 a 157 ms.

**Impedimentos registrados antes de prosseguir:**
1. **`kill -INT` pelo WSL:** encerra o `node.exe` do Windows com código 1, sem passar pelo handler de SIGINT.
2. **Ctrl+C ignorado:** o atributo "ignorar Ctrl+C" vinha herdado da interoperação do WSL. O iniciador o reativa.
3. **Vigia no WSL:** ler o progresso por `/mnt/c` fez falhar com `EPERM` a troca atômica do arquivo pelo cliente. O vigia passou a rodar no Windows.
4. **Envio do Ctrl+C lento:** levava 3,6 s para partir. Passou a ser armado antes do cliente, e o evento sai cerca de 165 ms depois do gatilho.

**Correções:**
- **Ajuste de relógio:** descarta o intervalo que fica vazio, o da liberação ao `202`, de cerca de 90 ms. Os vereditos das pré-checagens 2 e 3 foram recalculados com as mesmas amostras e os mesmos percentis.
- **Fim da base:** a base passou a terminar antes de armar o envio do Ctrl+C.

**Pré-checagens (1 GB, 12 sondas, base de 60 s):**
- **Pré-checagem 1:** falhou pelo `EPERM`.
- **Pré-checagem 2:** interrompeu tarde.
- **Pré-checagens 3 e 4:**
  - **interrupção:** pelo handler real de SIGINT, com 8 de 15 partes, e saída 130;
  - **retomada:** 7 `confirmed`, 1 `unregistered` e 7 `missing`, com `200 match` e a comparação aprovada, sem PUT de `confirmed`;
  - **desfecho:** `202` e `MEDIA_INVALID`;
  - **limpeza:** completa.
- **Versões:** as da pré-checagem 4 ficaram fixadas por SHA-256 no registro prévio.

**Memória com as 12 sondas:**
- **Windows:** de 1.371 a 2.009 MB disponíveis no mínimo, sempre abaixo da referência informativa de 4 GiB.
- **VM:** de 4.012 a 4.140 MiB disponíveis, com cerca de 1,4 a 1,5 GiB do swap da VM ocupados.

**Situação:** o arquivo de 10 GB não foi gerado nem enviado. A aplicação e a arquitetura não mudaram. O R-02 continua pendente.

### 13.1 Revisão r2 do registro prévio (13:43Z de 2026-11-25)

A revisão da r1 confirmou a interrupção real por SIGINT no Windows, a retomada sem reenvio das 7 partes `confirmed`, a limpeza e os hashes. Ela pediu quatro correções, feitas na r2, que fica em [`P-10GB-repeticao.md`](P-10GB-repeticao.md). A r1 fica preservada em `P-10GB-repeticao-evidencias/registro-previo.md` e `r1/`.

1. **Relógios:**
   - **Conversão:** nominal, com a diferença medida aplicada e todos os intervalos preservados, inclusive o da liberação ao `202`.
   - **Incerteza:** registrada à parte e analisada pelo `latency-verdict --clock-uncertainty-ms`.
   - **Regra:** um critério que a incerteza possa alterar, ou cuja suficiência de amostras ela possa alterar, fica `inconclusivo`.
2. **Dimensionamento:** D_mín = 69,93 × 0,70 = 48,951 s, o que dá **N = 13**. A medição de memória confere as 13 em execução.
3. **Falhas no build:** o `build_and_compile` retorna explicitamente na falha do build, do `tsc` ou das cópias.
   - **Controles da r2:** os quatro controles isolados, com a falha injetada, pararam o roteiro antes da geração do arquivo de prova.
   - **Controle negativo:** com a r1, a mesma falha seguiu até a geração, bloqueada pela sentinela.
4. **Validação sem upload:**
   - **Casos sintéticos do veredito:** 8 de 8 passaram.
   - **Reprocessamento das pré-checagens 3 e 4:**
     - os três intervalos nominais preservados;
     - 57 e 58 amostras de carga nominais;
     - 18 e 9 amostras de borda;
     - `inconclusivo` por carga insuficiente em qualquer classificação.
   - **Explicação corrigida:** a base efetiva da pré-checagem 4 teve 122,01 s e 732 amostras, e a insuficiência ocorreu na carga.

**Situação:** o arquivo de 10 GB não foi gerado nem enviado. A aplicação e a arquitetura não mudaram. O R-02 continua pendente.

### 13.2 Revisão r3 e execução formal (2026-11-25)

- **r3 (14:21Z):**
  - **Propagação de falhas:** explícita em `prepare`, `accounts`, `start_monitors` e nas demais etapas obrigatórias do roteiro.
  - **Controles:** 10 de 10 modos no roteiro inteiro, 20 de 20 funções isoladas e 8 de 8 casos sintéticos. O controle negativo com a r2 confirmou o defeito antigo.
  - **Sem mudança:** os critérios, a análise de incerteza e o cenário.
- **Execução formal** (`20261125142232-bc4b5d`, das 14:22Z às 14:38Z), única, com **resultado `aprovada`** pela regra do registro prévio, aguardando a revisão. Ver [`P-10GB-repeticao.md`](P-10GB-repeticao.md), seção "Resultados".
  - **Funcional:** 10.000.000.000 bytes, interrupção real em 75 de 150 partes com saída 130, retomada sem reenvio de `confirmed`, `202` e `MEDIA_INVALID`, e limpeza completa.
  - **Latência:**
    - base de 618,3 s e 4.019 amostras, com p95 de 3,89 ms;
    - carga de 85,8 s e 554 amostras, com p95 de 17,51 ms e p99 de 144,45 ms;
    - (a), (b) e (c) aprovados;
    - a incerteza do relógio (± 145 ms, 8 amostras de borda) não altera nenhum veredito.
- **Para o diagnóstico:** às 14:35:27Z houve um episódio curto.
  - **Sondas:** três acima de 500 ms (640, 531 e 520 ms).
  - **API e PostgreSQL no mesmo instante:** `GET` de 519 a 633 ms e consultas de 503 a 591 ms.
  - **Event loop:** 281 ms um segundo antes, com 45 ms de CPU.
  - **Windows:** fila de disco de 12 a 18 logo antes.
  - **Leitura:** o padrão é o mesmo dos episódios dos ensaios (a API e o banco atrasam juntos, com pouca CPU), compatível com a H4, agora curto e raro o bastante para não afetar os percentis de carga. A causa continua sem atribuição definitiva.

**Situação:** a repetição foi executada uma vez e aguarda a revisão. A P-10GB original continua `reprovada`. O R-02 aguarda a revisão das duas execuções.

## 14. Encerramento da pendência R-02 (2026-11-25)

A revisão da repetição formal da P-10GB foi concluída, e a SI-03.33 está aprovada.

- **Encerramento para o cenário efetivamente validado:**
  - a API compilada (`npm run build` e `npm run start:prod`, sem watch);
  - 13 sondas compiladas, executadas com `node`;
  - o cliente de upload no Node nativo do Windows;
  - os demais serviços do Compose, neste host.
  - **Fora da validação:** o cenário da P-10GB original (API em watch, sondas com `ts-node` e cliente no container) não foi validado.
- **Decisões:**
  - **TD-01:** mantida, sem alteração, e a reabertura de 2026-11-24 fica encerrada;
  - **TD-15:** a condição das provas grandes está atendida (V-07, fluxo completo e prova de 10 GB);
  - **arquitetura:** nenhuma melhoria foi aberta.
- **Histórico:**
  - a P-10GB original continua `reprovada`, e a repetição foi aprovada;
  - os registros prévios, os critérios e as evidências brutas deste diagnóstico não foram alterados.
- **O que fica registrado, sem conclusão nova:**
  - **Causa:** a dos atrasos da P-10GB original e dos ensaios não foi comprovada de forma definitiva. A hipótese principal (H4, disputa de disco e de memória no ambiente) é sustentada pelas medições. H1, H2 e H3 não foram excluídas (ver "Hipóteses").
  - **Execução aprovada:** teve três respostas acima de 500 ms (640, 531 e 520 ms, às 14:35:27Z). No mesmo instante, a API e o PostgreSQL ficaram lentos. É o mesmo padrão dos episódios do diagnóstico, curto e raro o bastante para não afetar os percentis de carga (seção 13.2).

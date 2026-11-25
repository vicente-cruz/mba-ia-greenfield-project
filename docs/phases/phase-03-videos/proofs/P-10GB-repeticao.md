# P-10GB (repetição) — Upload real de 10.000.000.000 bytes com medição de responsividade

- **Prova:** repetição formal da P-10GB, para tratar a pendência do R-02. É um upload real de 10.000.000.000 bytes, com interrupção e retomada, medindo a responsividade da API com os mesmos critérios numéricos, fixados antes da execução.
- **Requisitos:**
  - R-02: até 10 GB sem passar pela API e sem bloquear o atendimento;
  - R-03: retomada após falha de conexão.
- **TDs afetadas:** phase-03-videos/TD-01 e TD-15, como na P-10GB.
- **SI:** SI-03.33.
- **Relação com a execução reprovada:**
  - a [`P-10GB.md`](P-10GB.md) (execução `20261124215534-349fa9`), o registro prévio dela e as evidências ficam **preservados**, sem alteração, e ela continua `reprovada`;
  - esta repetição tem registro e roteiro próprios, e o resultado dela é registrado aqui;
  - como as duas execuções serão consideradas cabe à revisão.
- **Revisão do registro prévio:** **r3**, que substitui a r2 e a r1 antes de qualquer execução de 10 GB (ver "Revisões").
- **Situação:** **executada uma vez** pela r3 (runId `20261125142232-bc4b5d`, em 2026-11-25, das 14:22:32Z às 14:38:26Z) e **aprovada na revisão de 2026-11-25**. A SI-03.33 está aprovada, e a pendência do R-02 está encerrada para o cenário validado (ver "Revisão dos resultados").
- **Resultado:** **`aprovada`**, pela regra do registro prévio, e confirmada na revisão. Todos os itens obrigatórios e os critérios (a), (b) e (c) passaram, e a incerteza do relógio não altera nenhum veredito. Há um episódio de três amostras acima de 500 ms na carga, registrado em "Resultados".

## Revisões

| Revisão | Fixada em | Cópia | Situação |
|---------|-----------|-------|----------|
| r1 | 05:11Z de 2026-11-25 | [`P-10GB-repeticao-evidencias/registro-previo.md`](P-10GB-repeticao-evidencias/registro-previo.md), SHA-256 `6b8cd786baea39243d0412d312ce50e9c4f1c37f13ef3c851617d4f7f464b208` | **substituída**, preservada como versão anterior. As versões dos arquivos dela estão em [`P-10GB-repeticao-evidencias/r1/`](P-10GB-repeticao-evidencias/r1/) |
| r2 | 13:43Z de 2026-11-25 | [`P-10GB-repeticao-evidencias/registro-previo-r2.md`](P-10GB-repeticao-evidencias/registro-previo-r2.md), SHA-256 `f550471fd37496aabf5346cafd6edc2427197e6cfe8561651fb8b3befefef0e9` | **substituída**, preservada como versão anterior. As versões dos arquivos dela estão em [`P-10GB-repeticao-evidencias/r2/`](P-10GB-repeticao-evidencias/r2/) |
| **r3** | 14:21Z de 2026-11-25 | [`P-10GB-repeticao-evidencias/registro-previo-r3.md`](P-10GB-repeticao-evidencias/registro-previo-r3.md), SHA-256 no `progress.md` | **vigente** |

**O que a r3 corrige, a partir da revisão da r2**, que confirmou os cálculos, as 13 sondas, os hashes e a propagação das falhas em `build_and_compile`:
1. **Propagação de falhas em `prepare`, `accounts` e `start_monitors`.** Cada comando obrigatório verifica o próprio código (`|| { falha $? "…"; return; }`):
   - **`prepare`:** a criação das pastas e a cópia dos auxiliares para o `nestjs-api` e para o Windows;
   - **`accounts`:** a cópia das credenciais para o Windows (que não pode ficar vazia) e a obtenção do `CONTROL_ID` (que não pode ficar vazio);
   - **`start_monitors`:** a preparação e a cópia da sonda do banco, conferida no `db` antes de iniciar qualquer monitor. Os monitores são conferidos vivos 3 s depois da partida.
   - **Efeito:** antes do upload, a falha aparece no resultado da etapa e interrompe o roteiro, que segue para a limpeza dos recursos já criados.
2. **O mesmo defeito, conferido nas demais etapas obrigatórias.** Também retornam erro agora:
   - **antes do upload:**
     - `api_stopped`: a falha de `ps` virava "0 processos";
     - `versions`, `host_disk` e `check_free_space`;
     - `wait_trash_empty`: a falha do uso do storage só aparecia depois de 900 s;
     - `residue_into`: um `cd` falho virava "nenhum temporário";
     - `clock` e `memory_snapshot`;
     - os instantes de início e de fim da base;
   - **depois do upload:**
     - `copy_client_files`: terminava com `return 0`, e uma cópia falha dos eventos faria a comparação de partes usar eventos antigos;
     - a cópia das sondas para o resumo e o veredito: uma sonda podia sumir do veredito em silêncio;
     - as cópias de `collect_evidence` e do resumo;
     - a cópia do `latency-verdict.json`, que terminava em `|| true`.
   - **Desenho mantido depois do upload:** a falha é registrada na etapa, a coleta das evidências continua, e a primeira falha define o código final.
3. **Controles ampliados**, preservando os anteriores (ver "Controles"):
   - 10 modos de falha no roteiro inteiro: os 4 da r2 e 6 novos;
   - 20 controles das funções isoladas, inclusive o resumo e o veredito sobre a pré-checagem 4;
   - os 8 casos sintéticos do veredito, de novo;
   - um controle negativo com a r2.
4. **Sem mudança:** os critérios, a análise de incerteza dos relógios, o cenário e o dimensionamento (13 sondas).

**O que a r2 corrigiu, a partir da revisão da r1:**
1. **Relógios e recortes de carga:** a r1 encolhia cada intervalo de carga pela incerteza do relógio e descartava o que ficava vazio, como o da liberação ao `202`. Na r2:
   - a conversão é **nominal**: aplica a diferença medida e preserva todos os intervalos;
   - a incerteza é registrada à parte;
   - as amostras de borda, cuja classificação ela pode mudar, são analisadas. Se ela puder alterar o veredito ou a suficiência de amostras, o critério fica `inconclusivo`, sem escolher o recorte mais favorável.
2. **Dimensionamento:** a r1 declarava uma margem de 30% e calculava D_mín = 69,9 / 1,3 = 53,8 s, o que corresponde a 23% a menos. Com a margem declarada, D_mín = 69,93 × 0,70 = 48,951 s, e **N = 13**.
3. **Propagação de falhas:** na r1, `build_and_compile` ignorava falhas do build, do `tsc` e da cópia dos artefatos. A função roda dentro de `step` ("$@" || rc=$?), onde o `set -e` não vale. Na r2, cada comando retorna explicitamente. Controles isolados comprovam que essas falhas impedem a geração do arquivo.
4. **Explicação dos vereditos das pré-checagens:** a r1 atribuía o `inconclusivo` à "base de 60 s". A base efetiva da pré-checagem 4 teve 122,01 s e 732 amostras, acima do mínimo. A insuficiência ocorreu **na carga**.

## Registro prévio

Fixado antes de gerar ou enviar o arquivo de 10 GB (ver o carimbo e as versões no fim desta seção). Os critérios e as regras abaixo não são ajustados depois de ver os números.

### O que é preservado da P-10GB

- arquivo sintético de **exatamente 10.000.000.000 bytes**, declarado `video/mp4`, em 150 partes de 67.108.864 bytes (a última com 779.264);
- **4 PUTs simultâneos**, com lotes de 10 partes por `part-urls`, registro a cada 4 PUTs e pelo menos 1,1 s entre `part-urls`;
- **interrupção perto de 50%**: quando `ceil(150 × 0,5) = 75` partes tiverem o PUT concluído;
- **retomada** pelo GET da sessão e por `file-verifications` de todas as partes recebidas (`confirmed` e `unregistered`), com `200` `match`;
- **nenhuma parte `confirmed` reenviada**, conferido por três fontes: os eventos do cliente, o `ListParts` do storage e o registro da API;
- conclusão com `202` e desfecho `error` `MEDIA_INVALID`;
- **limpeza** só dos recursos da prova, com a purga da lixeira e a comparação dos temporários do Silo (anteriores e novos);
- **sonda:**
  - `GET /videos/:publicId` de um vídeo de controle em `draft`, autenticada como o dono, um usuário distinto do que faz o upload;
  - cada instância num container próprio, as mesmas na base e na carga;
  - **uma requisição a cada 2 s** por instância, com timeout de 5 s;
  - renovação do token fora das amostras;
- **fases:**
  - **base:** de quando todas as instâncias amostram até o início da etapa de upload, com **pelo menos 600 s**. Na repetição, a base termina antes de armar o envio do Ctrl+C, que antecede o lançamento do cliente. A base efetiva inclui a medição de memória, que roda com as sondas já amostrando (cerca de 21 a 62 s nas pré-checagens);
  - **carga:** só os intervalos com o cliente de upload ativo, todos preservados: do primeiro `part-urls` à interrupção, da retomada à espera antes do completion e da liberação ao `202`;
  - **aquecimento e fora:** só contam no critério (c);
  - **pausas ociosas fora da carga:** a pausa entre a interrupção e a retomada e a espera antes do completion não entram na carga. **Nenhum período ocioso entra na carga** para aumentar amostras;
- **percentis:** pelo posto mais próximo, sobre todas as amostras da fase;
- **amostras:** pelo menos 300 por fase.

### O que muda: o modo de execução

As mudanças vêm do diagnóstico do R-02 ([`R-02-diagnostico.md`](R-02-diagnostico.md), seções 9 a 13).

| Item | P-10GB (`20261124215534-349fa9`) | Repetição |
|------|----------------------------------|-----------|
| API | `npm run start:dev` (watch) | `npm run build` e `npm run start:prod` (`node dist/main`), sem watch, com os monitores de `p10gb-repeticao/monitor-api.cjs`, sem perfil de CPU |
| Sondas | `responsiveness-probe.ts` com `ts-node` (`node -r ts-node/register`) | o mesmo arquivo compilado uma vez para JS (`tsc`) e executado com `node`, com o mesmo comportamento e os mesmos parâmetros. O JS é montado só para leitura (`-v` do `docker compose run`), sem mudar o Compose |
| Número de sondas | 4 | **13** (ver "Dimensionamento") |
| Partida das sondas | todas juntas, com disparos sincronizados | lançamento sequencial com espaçamento de 2000/N ms (154 ms com 13), para evitar os disparos sincronizados. O ritmo de cada instância continua uma requisição a cada 2 s. A fase de cada instância depende da partida do container e fica registrada no CSV dela: na pré-checagem 4, com 12, a menor distância entre duas instâncias foi de 16 ms e a maior, de 380 ms |
| Fim da base | no lançamento do cliente | **antes de armar o envio do Ctrl+C**, cerca de 1,4 s antes do lançamento do cliente. A partida do PowerShell não entra na base, porque elevaria o p95 da base e afrouxaria o critério (a). As amostras desse trecho ficam fora da base e da carga e só contam no critério (c) |
| Cliente de upload | `upload-client.ts` com `ts-node`, no container `nestjs-api` (mesma VM e disco da API) | o mesmo cliente compilado para JS, no **Node nativo do Windows** (fora do Docker e do WSL), pelo `localhost` do Windows (portas publicadas, o caminho do navegador), com os mesmos parâmetros |
| Arquivo de prova | no `/tmp` do `nestjs-api` (VHDX do Docker) | na pasta temporária do Windows (NTFS em C:), gerado antes da medição |
| Interrupção | `SIGINT` pelo `interrupt-when`, no mesmo container | **Ctrl+C real** (`CTRL_C_EVENT` ao console do cliente, `ctrl-c.ps1`), pedido pelo vigia que roda no Windows (`vigia-interrupcao.cjs`), que aciona o handler de SIGINT do cliente, com saída 130 |
| Relógios | cliente e sondas no mesmo relógio | cliente no relógio do Windows, convertido para o da VM; incerteza analisada à parte (ver "Relógios") |
| Monitores | amostrador de disco do storage e `docker stats` | os mesmos, mais o amostrador da VM, a sonda do PostgreSQL (com `\timing`) e o monitor do Windows (memória, commit, paginação, disco e `vmmemWSL`) |
| Worker, banco, storage, Redis e Mailpit | como estão | como estão |

Nada disso altera a aplicação, a arquitetura, as dependências nem o Compose. Os critérios também não mudam.

### Relógios: cliente no Windows e sondas na VM

As sondas, a API e as amostras usam o relógio da VM do Docker; o cliente, o do Windows. Os recortes de carga vêm dos eventos do cliente, então os eventos são levados ao relógio da VM antes dos vereditos.

1. **Medida:** antes da base e depois da carga, `relogio.cjs` roda no Node do Windows e faz 15 medidas. Cada uma cerca a leitura do relógio da VM (`docker.exe exec <nestjs-api> date +%s%3N`) entre duas leituras do relógio do Windows.
   - **Medida usada:** a de menor ida e volta.
   - **Diferença:** VM − (t1 + t2) / 2.
   - **Incerteza:** (t2 − t1) / 2.
2. **Diferença usada (o):** a média das duas medidas.
3. **Incerteza usada (u):** a maior das duas, mais a metade da variação entre elas. Ela fica registrada à parte, em `relogio.json`.
4. **Conversão nominal:** `eventos-relogio-vm.py` soma `o` ao instante de **todos** os eventos do cliente.
   - **Intervalos:** nenhum é encolhido nem descartado, inclusive o da liberação ao `202`, mais curto que `u`.
   - **Uso:** o resumo e os vereditos usam os intervalos nominais.
5. **Análise da incerteza** (`latency-verdict --clock-uncertainty-ms u`):
   - **Amostras de borda:** as que estão a no máximo `u` ms de um início ou de um fim de intervalo nominal, sem estarem com certeza dentro de algum intervalo (entre início + u e fim − u). Num intervalo mais curto que 2u, todas as amostras dele são de borda.
   - **Hipótese conservadora:** cada amostra de borda pode estar dentro ou fora da carga, independentemente das outras.
   - **Cálculo:** para cada quantidade k de amostras de borda dentro da carga, as k mais rápidas dão os menores percentis e as k mais lentas, os maiores. Como (a), (b) e o mínimo de 300 são limites monótonos, esses extremos, para k de 0 a m, cobrem todos os vereditos possíveis.
   - **Regra:** se a incerteza puder alterar (a), (b) ou a suficiência de amostras, o critério afetado é registrado como `inconclusivo`. O registro traz o veredito nominal ao lado, e nenhum recorte mais favorável é escolhido.
   - **Critério (c):** usa todas as amostras e não depende da classificação.
   - **Base:** é delimitada no relógio dos containers e precisa terminar ao menos `u` ms antes do primeiro intervalo. Caso contrário, o veredito é recusado.
   - **Registro:** o log e o `latency-verdict.json` (`clockUncertainty`) trazem a incerteza, cada amostra de borda (com a borda mais próxima e a distância), a carga certa, a possível, as faixas de p95 e p99 e os vereditos possíveis.

**Ordem de grandeza nas quatro pré-checagens:**
- **Diferença:** de 36 a 66 ms.
- **Incerteza de cada medida:** de 106 a 143 ms.
- **Variação entre antes e depois:** de até 30 ms.
- **Incerteza usada:** de 116 a 157 ms.
- **Amostras de borda, no reprocessamento das pré-checagens 3 e 4 com 12 sondas:** 18 e 9, em cerca de 9 s de carga com três intervalos. O número depende da quantidade de bordas (seis) e do agrupamento das fases das sondas, não da duração da carga.

### Dimensionamento das sondas

`N = ceil(600 / D_mín)`. Com N instâncias a uma requisição a cada 2 s, uma carga de D segundos rende cerca de N × D / 2 amostras.

**Uploads de 1 GB medidos no diagnóstico:** duração no intervalo estrito do servidor, do primeiro `part-urls` ao fim do `completion`.

| Execução | Cenário | Duração |
|----------|---------|---------|
| comparação A2 | cliente no container | **6,993 s** (a mais rápida) |
| ensaio compilado V1 | cliente no Windows, API e sondas compiladas | 7,161 s |
| perfil B2 e B1 | cliente no Windows | 7,307 s e 7,377 s |
| comparação A1 | cliente no container | 8,049 s |
| ensaios A4 e B4 | cliente no container | 9,090 s e 11,653 s |
| comparação B1 e B2 | cliente no Windows | 11,372 s e 13,553 s |

- **Referência:** a execução mais rápida medida, de 6,993 s, projetada linearmente para 10 GB: **D_proj = 69,93 s**.
  - **Por que é conservadora:** a projeção não inclui o intervalo da interrupção, que fica fora da carga, nem a conferência das partes recebidas na retomada (cerca de 5 GB de checksums no Windows), que entra na carga e só a alonga.
- **Margem declarada:** a carga pode ser **até 30% mais curta** que essa projeção: **D_mín = 69,93 × 0,70 = 48,951 s**.
- **N = ceil(600 / 48,951) = ceil(12,26) = 13.**

**Amostras esperadas com 13 sondas:**
- **base:** 13 × 600 / 2 = 3.900, mais as da medição de memória;
- **carga nominal:** cerca de 455 com D = 69,93 s e cerca de 318 com D = 48,951 s.

**Efeito da incerteza do relógio:** nas pré-checagens, 8 das amostras de borda estavam dentro da carga nominal. Com D = 48,951 s, a carga certa fica em cerca de 310, ainda acima de 300. Se ficar abaixo de 300 e a carga possível chegar a 300, a suficiência é incerta, e (a) e (b) ficam `inconclusivo`.

**Se a carga ficar com menos de 300 amostras:** vale a regra da SI-03.33. O veredito de (a) e (b) é `inconclusivo`, e a prova é repetida com `N` recalculado pela D medida.

**Memória:** cada sonda compilada ocupa cerca de 14 MiB, e as 13 somam cerca de 0,18 GiB (com `ts-node`, eram cerca de 184 MiB cada).

### Critérios de aprovação, sem alteração

Os mesmos da SI-03.33 e da P-10GB:
- **(a)** p95 de carga ≤ max(1,5 × p95 de base; p95 de base + 50 ms);
- **(b)** p95 de carga ≤ 250 ms e p99 de carga ≤ 500 ms;
- **(c)** zero respostas fora de 2xx, zero `429` e zero timeouts, em todas as amostras coletadas. Conta como falha qualquer amostra sem um 2xx válido.

**Regras de veredito**, as mesmas da P-10GB, mais a da incerteza do relógio:
- **Amostras:** com menos de 300 amostras na base ou na carga, (a) e (b) são `inconclusivo`.
- **Incerteza do relógio:** se ela puder alterar (a), (b) ou a suficiência de amostras, o critério afetado é `inconclusivo` (ver "Relógios").
- **Latência:**
  - `reprovada` se qualquer critério for reprovado;
  - `inconclusiva` se (a) ou (b) for inconclusivo e (c) passar;
  - `aprovada` só com os três aprovados.
- **Reprovação:** registra o critério violado e o requisito afetado (R-02), sem flexibilizar o critério e sem descartar a execução. Uma reprovação que nenhuma classificação das bordas evita continua `reprovada`.
- **Resultado da prova:** `aprovada` só com todos os itens obrigatórios e a latência aprovados.

### Disco e memória

**Disco:**
- **Arquivo de prova:** 10,0 GB no NTFS de C:, ou 13,0 GB com margem de 30%.
- **Pico do storage:** medido na P-10GB, foi de 10,14 GB dentro do disco de dados do Docker, ou 13,2 GB com margem.
  - **Folga no VHDX:** o `docker_data.vhdx` tem 40,85 GB, com 19,04 GB usados, o que dá cerca de 21,8 GB livres dentro dele. Por isso o pico não deve fazer o VHDX crescer.
- **Exigência mantida:** **29,5 GB livres em C:** antes de começar, a exigência da V-07, mais conservadora que o orçamento recalculado (cerca de 13 GB em C: com margem, se o VHDX não crescer). O roteiro para antes de criar recursos se o espaço for menor.
- **Nas pré-checagens:**
  - havia de 40,0 a 41,7 GB livres em C:;
  - o `docker_data.vhdx` ficou com 40.853.569.536 bytes do início ao fim de cada uma (não cresceu);
  - o uso do disco de dados do Docker subiu cerca de 1,07 GB com 1 GB enviado e voltou depois da purga.

**Memória:**
- **Referência informativa:** os 4 GiB disponíveis no Windows continuam como referência, não critério nem bloqueio.
- **Medição:** a memória do Windows, dos containers e da VM é medida com **todas as 13 sondas** em execução, antes da base. O roteiro confere que as 13 estão em execução e para, antes da base, se não estiverem.
- **Nas pré-checagens, com 12 sondas** (detalhes por execução na tabela abaixo):
  - **Windows:** de 1.371 a 2.009 MB disponíveis no mínimo, sempre abaixo da referência, com o commit em 23,27 a 24,09 de 33,05 GB, o arquivo de paginação em 12 a 13% e o `vmmemWSL` em 4,89 a 5,13 GB;
  - **VM:** de 4.012 a 4.140 MiB disponíveis, com 1.441 a 1.545 MiB do swap da VM ocupados. Esse swap é da VM inteira, não do processo da API;
  - **containers:** a API compilada com 310 a 341 MiB e cada sonda com cerca de 14 MiB. A 13ª sonda acrescenta cerca de 14 MiB.

### Janela

Estimativa:
- preparação e build: cerca de 1 min;
- geração de 10 GB no Windows: de cerca de 0,5 min, à velocidade das pré-checagens (1 GB a 319 a 333 MiB/s), a cerca de 1,6 min, à da P-10GB (98,9 MiB/s no container);
- sondas e memória: cerca de 1 min;
- base: 10 min;
- carga: cerca de 1,5 a 3 min;
- conclusão, limpeza e purga: até cerca de 5 min.

São cerca de 20 a 25 min. A pré-checagem 4 levou cerca de 9 min, com base de 60 s, 1 GB e 285 s de espera pela purga. A janela recomendada é de **40 min** com o ambiente exclusivo, como na V-07.

### Impedimentos e correções da preparação

1. **`kill -INT` pelo WSL não aciona o SIGINT do Node no Windows:** enviado ao processo de interoperação, encerra o `node.exe` com código 1, sem o handler e sem o evento `exit`. O `process.kill()` do Node no Windows também encerra o alvo sem passar pelo handler.
   - **Tratamento:** o Ctrl+C real do console (`CTRL_C_EVENT`), o mesmo evento de um Ctrl+C digitado, pelo `ctrl-c.ps1` (PowerShell e `kernel32`, ferramentas existentes).
2. **O Ctrl+C não chegava ao Node:** o atributo "ignorar Ctrl+C" é herdado pelos filhos e vem ligado da cadeia de inicialização pela interoperação do WSL.
   - **Tratamento:** o `iniciar-windows.ps1` reativa o processamento normal de Ctrl+C antes de iniciar o cliente num console próprio e oculto.
   - **Teste mínimo:** o handler foi acionado, e a saída foi 130.
3. **Pré-checagem 1 (`EPERM`):** o vigia lia o progresso pelo WSL (`/mnt/c`), e o arquivo aberto sem compartilhamento de exclusão fez falhar a troca atômica do progresso pelo cliente. O cliente falhou com 4 de 15 partes.
   - **Tratamento:** o vigia passou a rodar no Windows (`vigia-interrupcao.cjs`), porque o Node lá abre arquivos com compartilhamento de exclusão. A versão descartada está nas evidências.
4. **Pré-checagem 2 (interrupção tardia):** o `ctrl-c.ps1` levava cerca de 3,6 s para partir, compilar e gerar o evento. No upload curto de 1 GB, a interrupção veio com os 15 PUTs concluídos, e não perto de 50%.
   - **Tratamento:** o envio é armado antes do início do cliente e dispara por um arquivo de gatilho, que o vigia cria ao atingir o limite. Nas pré-checagens 3 e 4, o Ctrl+C foi gerado 163 e 166 ms depois do gatilho.
5. **Ajuste de relógio:**
   - **r1:** encolhia os intervalos e descartava o vazio, depois de um defeito na pré-checagem 3: um intervalo ficava com o fim antes do início.
   - **r2:** substituído pela conversão nominal com a análise da incerteza à parte (ver "Revisões" e "Relógios"). Os vereditos da r1 e os recálculos dela ficam preservados nas evidências.
6. **Fim da base:** a base passou a terminar antes de armar o envio do Ctrl+C. Na r1, terminava depois.
7. **Propagação de falhas no build (r2):** `build_and_compile` passou a retornar na primeira falha do build, do `tsc` ou da cópia de cada artefato. A cópia vazia de um artefato também conta como falha. Ver "Controles".
8. **Propagação de falhas nas demais etapas obrigatórias (r3):** `prepare`, `accounts`, `start_monitors` e as etapas da auditoria (ver "Revisões"). Ver "Controles".

### Pré-checagens (até 1 GB, não fazem parte da prova)

Feitas com o roteiro da r1, com `P10GB_SIZE_BYTES=1000000000`, `P10GB_BASELINE_SECONDS=60`, `P10GB_ROTULO=pre-checagem` e 12 sondas.

| Pré-checagem | Versões | Interrupção | Retomada e partes | Desfecho | Relógio (antes; depois; u) | Memória com 12 sondas | Limpeza |
|--------------|---------|-------------|-------------------|----------|----------------------------|-----------------------|---------|
| 1 (`20261125022403-73f57a`) | vigia no WSL | **falhou:** o cliente saiu com 1 (`EPERM` na troca do progresso), com 4 de 15 partes; o Ctrl+C não chegou a ser pedido | 0 `confirmed`, 4 `unregistered` conferidas com `200 match`; a comparação reprovou o item "nenhum PUT de `confirmed`", por não haver `confirmed` | `202` e `MEDIA_INVALID` | 39 ± 107; 50 ± 124 ms | Windows 1.371 MB mín.; VM 4.078 MiB | completa; retratos iguais; nenhum temporário novo; purga em 51 s |
| 2 (`20261125044220-c1154c`) | vigia no Windows, Ctrl+C sem armar | Ctrl+C real pedido com 8 de 15; gerado 3,6 s depois, com os 15 PUTs concluídos; handler de SIGINT e saída **130** | 14 `confirmed` e 1 `unregistered`, 15 conferidas com `200 match`; comparação 5 de 5 | `202` e `MEDIA_INVALID` | 36 ± 106; 40 ± 114; u = 116 ms | Windows 1.571 MB mín.; VM 4.140 MiB | completa; retratos iguais; nenhum temporário novo; purga em 113 s |
| 3 (`20261125044914-338152`) | Ctrl+C armado; ajuste de relógio antigo | gatilho com 8 de 15 (limite 8); Ctrl+C gerado 163 ms depois; handler de SIGINT, com 8 PUTs concluídos e 4 abortados, e saída **130** | 7 `confirmed`, 1 `unregistered` e 7 `missing`; 8 conferidas com `200 match`; comparação 5 de 5, sem PUT de `confirmed` | `202` e `MEDIA_INVALID` | 36 ± 111; 66 ± 137; u = 152 ms | Windows 2.009 MB mín.; VM 4.102 MiB | completa; retratos iguais; nenhum temporário novo; purga em 51 s |
| 4 (`20261125045940-f17f11`) | as da r1 | gatilho com 8 de 15 (limite 8); Ctrl+C gerado 166 ms depois; handler de SIGINT, com 8 PUTs concluídos e 4 abortados, e saída **130** | 7 `confirmed`, 1 `unregistered` e 7 `missing`; 8 conferidas com `200 match`; comparação 5 de 5, sem PUT de `confirmed` | `202` e `MEDIA_INVALID` | 38 ± 112; 66 ± 143; u = 157 ms | Windows 2.009 MB mín. (mediana 2.013 MB), commit 23,58 de 33,05 GB; VM 4.012 MiB | completa; retratos iguais; nenhum temporário novo; purga em 285 s |

**O que as pré-checagens 3 e 4 validaram:**
- **Interrupção:** o Ctrl+C real aciona o handler de SIGINT do cliente no Windows, que registra a interrupção (`INTERRUPÇÃO | SIGINT`, com as partes concluídas, registradas e em andamento), aborta os PUTs em andamento e sai com 130. Não houve encerramento forçado nem evento simulado.
- **Retomada:** classifica as partes, confere as recebidas por `file-verifications` e reenvia só as `unregistered` e as `missing`. A comparação das três fontes (eventos, `ListParts` e registro da API) confirma que nenhuma das 7 partes `confirmed` foi reenviada.
- **Sondas:** as 12 amostraram sem falha; o critério (c) ficou aprovado, com 745 e 1.000 amostras.
- **Fora da r1:** essas partes do roteiro (interrupção, retomada, comparação, limpeza) não mudaram na r2.

**Vereditos das pré-checagens (explicação corrigida na r2):** os vereditos de latência das pré-checagens 2 a 4 são `inconclusivo`, e é isso que dá o código final 1. Todas as etapas obrigatórias e a limpeza passaram.
- **Base:** a base efetiva vai de quando todas as sondas amostram até o fim da base e inclui a medição de memória. Ela **teve amostras suficientes**:
  - 121,93 s e 732 amostras na pré-checagem 2;
  - 80,84 s e 485 na 3;
  - **122,01 s e 732** na 4.
- **Carga:** a insuficiência ocorreu nela, com cerca de 8 a 11 s de upload ativo de 1 GB:
  - com o ajuste da r1, 68, 49 e 50 amostras;
  - com a conversão nominal da r2, 57 e 58 amostras nas pré-checagens 3 e 4.

**Reprocessamento das pré-checagens 3 e 4 pela r2**, sem novo upload e sem alterar os arquivos anteriores:

| Pré-checagem | Diferença; incerteza | Intervalos nominais | Base | Carga nominal | Amostras de borda | Carga certa; possível | p95 e p99 de carga possíveis | Veredito |
|--------------|----------------------|---------------------|------|---------------|-------------------|-----------------------|------------------------------|----------|
| 3 | + 51 ms; ± 152 ms | 4,139 s, 4,651 s e **0,091 s** (liberação ao `202`, preservado) | 80,8 s, 485 amostras | 8,9 s, 57 amostras | 18 (8 dentro da carga nominal, 10 fora) | 49; 49 a 67 | p95 de 14,94 a 15,87 ms; p99 de 27,86 ms | (a) e (b) `inconclusivo` (carga insuficiente em qualquer classificação); (c) aprovado; latência `inconclusiva` |
| 4 | + 52 ms; ± 157 ms | 4,097 s, 4,605 s e **0,089 s** (liberação ao `202`, preservado) | 122,0 s, 732 amostras | 8,8 s, 58 amostras | 9 (8 dentro, 1 fora) | 50; 50 a 59 | p95 de 16,2 ms; p99 de 18,12 ms | (a) e (b) `inconclusivo` (carga insuficiente em qualquer classificação); (c) aprovado; latência `inconclusiva` |

### Controles (sem upload)

#### Controles da r2

Executados com `proofs/phase-03/p10gb-repeticao/controles.sh`. As evidências estão em [`P-10GB-repeticao-evidencias/controles-r2/`](P-10GB-repeticao-evidencias/controles-r2/).

**Veredito com a incerteza do relógio** (`controles.sh veredito`, casos sintéticos de `controles-veredito.py`):
- **Base comum:** 700 s com 13 instâncias, 4.550 amostras a 5 ms, o que dá o limite de (a) de 55 ms.
- **Carga comum:** intervalos nominais de 200 s, 10 s e 89 ms.
- **Incerteza:** u = 157 ms, salvo onde indicado.
- **Resultado:** 8 de 8 casos passaram.

| Caso | Montagem | Resultado esperado e obtido |
|------|----------|-----------------------------|
| Intervalo menor que a incerteza | o intervalo de 89 ms tem uma amostra dentro; outra fica 100 ms antes dele | o intervalo fica preservado; a amostra dentro conta na carga nominal (321) e é de borda; 2 de borda; `aprovado`, igual ao nominal |
| Amostra lenta na borda que altera o veredito | 320 certas a 10 ms; 4 de 600 ms a 50 ms fora de quatro bordas | p99 possível de 10 a 600 ms; (b) nominal `aprovado` vira `inconclusivo`; (a) segue `aprovado`; latência `inconclusiva` |
| Amostra lenta na borda que não altera | 400 certas a 10 ms; 1 de 600 ms na borda | p95 e p99 ficam em 10 ms com ou sem ela; `aprovado` |
| Contagem perto de 300 que altera a suficiência | 296 certas e 6 de borda dentro da carga nominal (302) | carga possível de 296 a 302; suficiência incerta; (a) e (b) `inconclusivo`; nominal `aprovado` |
| Contagem perto de 300 que não altera | 304 certas e 4 de borda fora | carga possível de 304 a 308; `aprovado` |
| Reprovação robusta | 320 certas a 800 ms e 4 rápidas na borda | `reprovado` em qualquer classificação: a incerteza não transforma reprovação em inconclusivo |
| Incerteza zero | o caso da borda lenta com u = 0 | sem amostras de borda; `aprovado`, o comportamento da P-10GB original |
| Base dentro da incerteza | a base termina 100 ms antes do primeiro intervalo | veredito recusado (código 1) |

**Propagação de falhas** (`controles.sh falhas`):
- **Injeção:** a falha é injetada por shims de `docker` e `cp` no `PATH`, um comando por vez.
- **Sentinela:** um shim de `node.exe` bloqueia a geração do arquivo de prova (código 99) se ela for alcançada.
- **Parâmetros:** `P10GB_SIZE_BYTES=1000000`, com a API parada.
- **Critério do controle:** passa quando o roteiro sai com código diferente de zero, a etapa do build registra a falha, a etapa de geração não começa, a sentinela não é acionada e a limpeza deixa os retratos iguais.

| Roteiro | Falha injetada | Registro no log | Etapa do build | Geração do arquivo | Sentinela | Retratos | Código do roteiro | Controle |
|---------|----------------|-----------------|----------------|--------------------|-----------|----------|-------------------|----------|
| r2 | `npm run build` | `FALHA \| build da API: código 2` | código 2 | não começou | não acionada | iguais | 2 | **passou** |
| r2 | `tsc` do cliente e da sonda | `FALHA \| tsc do cliente e da sonda: código 2` | código 2 | não começou | não acionada | iguais | 2 | **passou** |
| r2 | cópia do JS do container (`api cat`) | `FALHA \| cópia de upload-client.js do container: código 2` | código 2 | não começou | não acionada | iguais | 2 | **passou** |
| r2 | cópia do JS para o Windows (`cp`) | `FALHA \| cópia de upload-client.js para o Windows: código 2` | código 2 | não começou | não acionada | iguais | 2 | **passou** |
| r1 (controle negativo) | `npm run build` | só a mensagem do shim | **código 0** | **começou** | **acionada** (código 99) | iguais | 99 | não passou, como esperado: confirma o defeito da r1 e que o controle o detecta |

O controle negativo rodou uma cópia temporária do roteiro da r1, removida em seguida. Em nenhum controle um arquivo de prova foi gerado, e não sobrou container, pasta nem processo.

#### Controles da r3

Executados com o `controles.sh` da r3, com a API parada. Os anteriores foram mantidos e repetidos. Evidências em [`P-10GB-repeticao-evidencias/controles-r3/`](P-10GB-repeticao-evidencias/controles-r3/).

**Roteiro inteiro, uma falha por vez** (`controles.sh falhas`):
- **Injeção:** shims de `docker` e `cp` no `PATH` provocam a falha.
- **Sentinelas:**
  - um shim de `node.exe` bloqueia a geração do arquivo nos modos anteriores a ela. Nos demais, a geração é de 1 MB;
  - um shim de `powershell.exe` bloqueia qualquer início de upload.
- **Critério:** o controle passa quando, ao mesmo tempo:
  - o roteiro sai com código diferente de zero;
  - a etapa registra a falha;
  - a etapa seguinte não começa;
  - nenhuma sentinela é acionada;
  - a limpeza remove os containers, a pasta no `nestjs-api`, a pasta no Windows, o JS compilado, a API e os recursos de prova, e deixa os retratos iguais.
- **Resultado:** 10 de 10 passaram.

| Modo | Etapa que falhou (código) | Registro no log | Etapa seguinte | Limpeza |
|------|---------------------------|-----------------|----------------|---------|
| `prepare-pasta` (r3) | Pastas de prova (2) | `FALHA \| pasta /tmp/p10gbr-<runId> no nestjs-api` | Build: não começou | completa, retratos iguais |
| `prepare-auxiliar-container` (r3) | Pastas de prova (2) | `FALHA \| cópia de monitor-api.cjs para o nestjs-api` | Build: não começou | completa, retratos iguais |
| `prepare-auxiliar-windows` (r3) | Pastas de prova (2) | `FALHA \| cópia de vigia-interrupcao.cjs para o Windows` | Build: não começou | completa, retratos iguais |
| `build` (r2) | Build (2) | `FALHA \| build da API` | Geração do arquivo: não começou | completa, retratos iguais |
| `tsc` (r2) | Build (2) | `FALHA \| tsc do cliente e da sonda` | Geração do arquivo: não começou | completa, retratos iguais |
| `copia-container` (r2) | Build (2) | `FALHA \| cópia de upload-client.js do container` | Geração do arquivo: não começou | completa, retratos iguais |
| `copia-windows` (r2) | Build (2) | `FALHA \| cópia de upload-client.js para o Windows` | Geração do arquivo: não começou | completa, retratos iguais |
| `accounts-credenciais` (r3) | Contas de prova (2) | `FALHA \| cópia das credenciais do usuário de upload para o Windows` | Relógio antes da base: não começou | completa: API parada, usuários e vídeo de controle removidos, retratos iguais |
| `accounts-control-id` (r3) | Contas de prova (1) | `FALHA \| leitura do publicId do vídeo de controle` | Relógio antes da base: não começou | completa: API parada, usuários e vídeo de controle removidos, retratos iguais |
| `monitores-sonda-db` (r3) | Monitores (2) | `FALHA \| cópia da sonda do banco para o db` | Sondas: não começaram | completa: amostrador do storage parado, API parada, usuários removidos, retratos iguais |

**Controle negativo com a r2** (`accounts-credenciais`, base de 5 s, cópia temporária do roteiro da r2, removida em seguida):
- a etapa das contas saiu com "código 0", apesar da falha;
- o roteiro seguiu até o início do upload, bloqueado pela sentinela.

O controle **não passou**, como esperado. Isso confirma o defeito da r2 e mostra que os novos controles o detectam. A limpeza dele também ficou completa.

**Funções do roteiro isoladas** (`controles.sh funcoes`):
- **Montagem:** o harness carrega só as funções do roteiro, sem o fluxo principal, num ambiente isolado. Ele as chama no mesmo contexto de `step`, em que o `set -e` não vale.
- **Resultado:** 20 de 20 passaram.

| Grupo | Casos | Resultado |
|-------|-------|-----------|
| Antes do upload, com falha injetada | `api_stopped` (`ps`), `versions` (imagem), `host_disk` (`df` de C:), `residue_into`, `wait_trash_empty` (uso do storage), `clock` (`relogio.cjs`), `memory_snapshot` sem as 13 sondas | todos retornam erro, com a falha registrada; `api_stopped` sem falha retorna 0 |
| Depois do upload, com os arquivos reais da pré-checagem 4 | `copy_client_files`: sem falha (0), eventos ausentes (1), cópia com falha (2); cópia das sondas: a 13ª ausente (1), cópia da 3ª com falha (2), sem falha (0, 12 instâncias) | todos como esperado |
| Resumo e veredito do roteiro sobre a pré-checagem 4 | `summarize` (0) e `latency_verdict` (1, `inconclusivo`) | o `latency-verdict.json` é igual, em conteúdo, ao do reprocessamento da r2 (58 amostras nominais, 9 de borda, ± 157 ms) |
| Cópia do veredito | caso sintético aprovado: sem falha (0); com a cópia do `latency-verdict.json` falhando (1) | a falha da cópia não passa mais em silêncio |
| Sentinelas | nenhuma geração e nenhum upload | não acionadas |

**Veredito com a incerteza do relógio:** os 8 casos sintéticos da r2 foram repetidos, com os mesmos resultados, e **8 de 8 passaram**.

Em nenhum controle um arquivo de prova maior que 1 MB foi gerado ou um upload foi iniciado. Não sobrou container, pasta nem processo.

### Procedimento

1. **Pré-requisitos:**
   - `docker compose up -d`, com o ambiente saudável e o `video-worker` no ar;
   - a **API parada**, porque o roteiro faz o build e a sobe;
   - no Windows: `node.exe`, `powershell.exe` e `docker.exe` no PATH;
   - as versões fixadas da r3: em `nestjs-project/`, `sha256sum -c ../docs/phases/phase-03-videos/proofs/P-10GB-repeticao-evidencias/versoes-sha256-r3.txt`, com `OK` em todos os arquivos;
   - 29,5 GB livres em C:;
   - a janela de 40 min.
2. **Comando:** no host, a partir de `nestjs-project/`, `P10GB_CONFIRMA_10GB=sim proofs/phase-03/p10gb-repeticao-roteiro.sh <diretório de saída>`.
   - **Padrões:** `P10GB_SIZE_BYTES=10000000000`, `P10GB_PROBES=13`, `P10GB_PROBE_STAGGER_MS=154` (2000/13), `P10GB_BASELINE_SECONDS=600`, `P10GB_INTERRUPT_FRACTION=0.5`, `P10GB_RESUME_GAP_SECONDS=5` e `P10GB_MIN_FREE_BYTES=29500000000`.
   - **Trava:** sem `P10GB_CONFIRMA_10GB=sim`, o roteiro recusa tamanhos acima de 1.000.000.000 bytes com código 64, antes de criar qualquer recurso.
3. **Etapas do roteiro:**
   1. confere o ambiente, a API parada e o espaço em C:, registra as versões e o disco, e tira os retratos e a lista dos temporários do Silo;
   2. faz o build da API e compila o cliente e a sonda;
   3. gera o arquivo no Windows;
   4. sobe a API com `start:prod`, cria as contas e o vídeo de controle e mede o relógio;
   5. espera a lixeira vazia e inicia os amostradores e os monitores;
   6. lança as 13 sondas espaçadas e mede a memória, conferindo que as 13 estão em execução;
   7. faz a base de 600 s;
   8. encerra a base, arma o envio do Ctrl+C e inicia o upload no Windows; o vigia cria o gatilho em 75 partes, e o cliente sai com 130;
   9. tira o retrato das partes, faz a retomada no Windows (`--hold-before-completion`), tira o segundo retrato, compara e libera o completion, com polling até `MEDIA_INVALID`;
   10. mede o relógio de novo, para as sondas e os monitores, converte os eventos para o relógio da VM (nominal) e roda `summarize` e `latency-verdict --clock-uncertainty-ms`;
   11. limpa (`trap EXIT`): sondas, monitores, cliente, API, containers, pastas no container, no Windows e no diretório de saída, os recursos de prova (`cleanup`), a purga, os retratos e os temporários.

   **Falhas:**
   - **Etapas 1 a 7:** qualquer falha obrigatória aparece no resultado da etapa e encerra o roteiro, que segue direto para a limpeza (etapa 11). O arquivo de prova só é gerado depois de o build e as cópias passarem.
   - **Etapas 8 a 10:** a falha fica registrada na etapa, a coleta das evidências continua, e a primeira falha define o código final.
4. **Arquivos:** o roteiro está em [`nestjs-project/proofs/phase-03/p10gb-repeticao-roteiro.sh`](../../../../nestjs-project/proofs/phase-03/p10gb-repeticao-roteiro.sh), e os auxiliares e os controles, em [`nestjs-project/proofs/phase-03/p10gb-repeticao/`](../../../../nestjs-project/proofs/phase-03/p10gb-repeticao/).

**Evidências da preparação:** em [`P-10GB-repeticao-evidencias/`](P-10GB-repeticao-evidencias/):
- `pre-checagem-1` a `pre-checagem-4`: os logs, as sondas, os eventos do cliente (originais e no relógio da VM pela r1), as medidas de relógio, a memória, o monitor do Windows, os registros da API, os retratos e os temporários, os vereditos recalculados da r1 (`*-relogio-corrigido.*`) e o vigia descartado (`pre-checagem-1/vigia-interrupcao-wsl-descartado.py`);
- `r1/` e `r2/`: as versões da r1 e da r2 do roteiro, dos auxiliares e dos scripts;
- `controles-r2/` e `controles-r3/`: os controles de cada revisão e o reprocessamento da r2.

O caminho local da saída, o do repositório e a pasta temporária do Windows, que contém o nome do usuário, foram trocados por marcadores. Nenhum arquivo traz token, senha ou URL assinada.

### Versões fixadas (r3)

A prova usa exatamente estas versões. A lista também está em [`P-10GB-repeticao-evidencias/versoes-sha256-r3.txt`](P-10GB-repeticao-evidencias/versoes-sha256-r3.txt).
- **Conferência:** o roteiro não confere os hashes sozinho; a conferência é um pré-requisito do procedimento (`sha256sum -c`).
- **Mudanças:** qualquer mudança nesses arquivos exige uma nova revisão deste registro antes da execução.
- **Em relação à r2:** mudaram só o roteiro (propagação de falhas) e o `controles.sh` (novos modos, sentinela do upload e controles das funções isoladas). Os demais arquivos são os da r2.
- **Em relação à r1:** a r2 já tinha mudado o roteiro (13 sondas, `build_and_compile`, conferência das sondas na medição de memória, conversão nominal e incerteza no veredito), o `eventos-relogio-vm.py` e o `upload-proof-support.ts` (`latency-verdict --clock-uncertainty-ms`), e acrescentado `controles.sh` e `controles-veredito.py`. Os auxiliares do Windows, o cliente e a sonda são os da r1, validados na pré-checagem 4.

| Arquivo (em `nestjs-project/`) | SHA-256 |
|--------------------------------|---------|
| `proofs/phase-03/p10gb-repeticao-roteiro.sh` | `e12e79a13b122bf8512a382129876919f97995f02edf9809c227dc83e13ae183` |
| `proofs/phase-03/p10gb-repeticao/amostrador-vm.sh` | `1041a26f7aa000a2df0beb4f3e3e8db63f4d431f75a83fa7616e4fd76efff3a3` |
| `proofs/phase-03/p10gb-repeticao/controles-veredito.py` | `6bbcc98a40e7bfe417d46235e71861eb8e877912883d12802695927a81728ff4` |
| `proofs/phase-03/p10gb-repeticao/controles.sh` | `c8d572557fc372716a088f3a6a7c3d811948a197e1048457bd0972076d5691cc` |
| `proofs/phase-03/p10gb-repeticao/ctrl-c.ps1` | `5d920acf624597d057f54465c471dccbf76b50ea2b2142a00d2d279b073f53be` |
| `proofs/phase-03/p10gb-repeticao/eventos-relogio-vm.py` | `1ea847ddbb8093d6dff27735c88976dca9b55c610ca618c73f7caa655f717e95` |
| `proofs/phase-03/p10gb-repeticao/iniciar-windows.ps1` | `8956921313a5f40713fb388b92e93f93e4ba0997aa11b706b6c8f76672209a17` |
| `proofs/phase-03/p10gb-repeticao/monitor-api.cjs` | `2c2d2424adadf94ef7877241a9477a124ae1d3784fd5ee016ab959bc351b617c` |
| `proofs/phase-03/p10gb-repeticao/monitor-windows.ps1` | `37e8edc8dd1d78f1536c8572ccec21e20e1a4e242d091fc1abdafd2e26b838ed` |
| `proofs/phase-03/p10gb-repeticao/relogio.cjs` | `e065135f52b81a73321ed02f9f34afcbf716788b6c8668ec311892b23bf67ead` |
| `proofs/phase-03/p10gb-repeticao/sonda-db.sh` | `d04c334d3ce546888fd60619034181053148c9d8f2d953e44c7f13eb96be38bd` |
| `proofs/phase-03/p10gb-repeticao/vigia-interrupcao.cjs` | `344cf69286e78160b4c3f8137abd683b7553301e220db0e076677559b73a9076` |
| `proofs/phase-03/upload-client.ts` | `807f26135ca07840e37522dfd9e558fe76258ed475f5087a923c386108f67d9d` |
| `proofs/phase-03/responsiveness-probe.ts` | `bb61b3b7041f746ae942afa3230bcacc34e1af91d108d07e9f47a9adaae16527` |
| `proofs/phase-03/upload-proof-support.ts` | `907042a1fd308554f69372bc1e5d3f899197ad9d4bfbc26ddca78151e858fa73` |

### Carimbo

A revisão r3 deste registro prévio foi fixada às 14:21Z de 2026-11-25, antes de gerar ou enviar o arquivo de 10 GB.
- **Cópia:** [`P-10GB-repeticao-evidencias/registro-previo-r3.md`](P-10GB-repeticao-evidencias/registro-previo-r3.md), com o SHA-256 registrado no `progress.md`.
- **Versões anteriores:** a r2 continua em `registro-previo-r2.md` e a r1 em `registro-previo.md`, sem alteração.

Os critérios e as regras acima não mudam depois de ver os números.

## Resultados

Execução única da r3: runId `20261125142232-bc4b5d`, em 2026-11-25, das 14:22:32Z às 14:38:26Z (15 min 54 s). Roteiro e auxiliares conferidos contra `versoes-sha256-r3.txt` antes da execução (0 divergentes). O código final do roteiro foi **0**: as 38 etapas, os vereditos e a limpeza passaram. O registro prévio acima não mudou depois da execução: a seção "Registro prévio" é idêntica à da cópia `registro-previo-r3.md`.

### Pré-requisitos (antes da execução)

- **Versões:** os 15 arquivos fixados da r3 com `OK`.
- **Ambiente:**
  - `db`, `mailpit`, `redis` e `storage` saudáveis e `storage-init` com `Exited (0)`;
  - o `video-worker` no ar desde 2026-11-23 19:50Z;
  - a API parada, sem outra prova ou suíte em execução e sem container de prova.
- **Espaço:** 39,79 GB livres em C:, contra os 29,5 GB exigidos.
- **Windows:** `node.exe` v22.17.0, PowerShell 5.1 e `docker.exe` 29.8.2.
- **Lixeira do storage:** 256 KiB.
- **Verificações:** `tsc --noEmit` e o ESLint dos scripts de prova saíram com 0.

### Itens obrigatórios

| Item | Esperado | Observado | Resultado |
|------|----------|-----------|-----------|
| Arquivo sintético | exatamente 10.000.000.000 bytes, 150 partes de 64 MiB (a última com 779.264) | 10.000.000.000 bytes, gerados no Windows em 86,1 s (110,7 MiB/s); SHA-256 `5f973ec9…db6a46`; plano de 150 partes, a última com 779.264 bytes | passou |
| PUTs simultâneos | 4 | `--concurrency 4`; na interrupção, 4 PUTs em andamento, abortados | passou |
| Interrupção real perto de 50% | gatilho em `ceil(150 × 0,5) = 75` partes com PUT concluído; handler de SIGINT; saída 130 | gatilho com 75 de 150 (limite 75); `CTRL_C_EVENT` gerado 169 ms depois; o cliente registrou `INTERRUPÇÃO \| SIGINT` com 75 PUTs concluídos e 4 em andamento, e saiu com **130**; vigia e envio do Ctrl+C com 0 | passou |
| Retomada | GET da sessão e classificação das partes | sessão `active`; 73 `confirmed`, 2 `unregistered` (73 e 75), 75 `missing` (76 a 150) e 0 `divergent`; retomada 11,1 s depois da interrupção | passou |
| Conferência das partes recebidas | `file-verifications` com `200` `match` | 75 partes (5.033.164.800 bytes) recalculadas em 11,2 s; `200` `match` em 40,7 ms | passou |
| Nenhuma parte `confirmed` reenviada | três fontes concordam | cliente: nenhum PUT de `confirmed`; storage: 73 de 73 iguais (ETag, tamanho e `LastModified`); registro da API: 73 de 73 inalterados; as 77 reenviadas aparecem com `LastModified` novo; antes do completion, 150 de 150 registradas com o mesmo ETag (5 de 5 itens) | passou |
| Conclusão | `202` e desfecho `error` `MEDIA_INVALID` | `202` em 341,4 ms; `MEDIA_INVALID` 2,1 s depois | passou |
| Memória com as 13 sondas | medida antes da base (referência informativa de 4 GiB) | 13 de 13 sondas em execução; o Windows com 2.138 MB disponíveis no mínimo e mediana de 2.151 MB (abaixo da referência, informativo) | passou (medida registrada) |
| Limpeza | só os recursos da prova; retratos iguais; temporários comparados | API parada; containers, pastas no `nestjs-api` e no Windows e JS compilado removidos; usuários, vídeos, objetos, multiparts, jobs e e-mails de prova removidos; purga da lixeira 51 s depois; retratos iguais; temporários anteriores preservados (5 de 5) e nenhum novo | passou |

### Latência

| Fase | Duração | Amostras | p50 | p95 | p99 | Máximo |
|------|---------|----------|-----|-----|-----|--------|
| Base (13 instâncias, relógio dos containers) | 618,3 s | 4.019 | 2,65 ms | 3,89 ms | 5,21 ms | 13,51 ms |
| Carga nominal (3 intervalos: 36,559 s, 48,855 s e 0,433 s, o da liberação ao `202`) | 85,8 s | 554 | 4,49 ms | **17,51 ms** | **144,45 ms** | 640,39 ms |
| Aquecimento | — | 17 | 10,3 ms | 24,28 ms | 24,28 ms | 24,28 ms |
| Fora da base e da carga | — | 222 | 3,44 ms | 8,22 ms | 11,28 ms | 18,98 ms |
| Todas | — | 4.812 | 2,72 ms | 6,85 ms | 14,3 ms | 640,39 ms |

**Relógios e incerteza:**
- **Medidas:** −15 ms ± 107 ms antes da base e +32 ms ± 121 ms depois da carga.
- **Conversão nominal:** + 8 ms, com os três intervalos preservados.
- **Incerteza registrada à parte:** ± 145 ms.
- **Amostras de borda:** 8, sendo 4 dentro da carga nominal e 4 fora. A mais lenta tem 18,98 ms.
- **Carga:** 550 amostras certas e de 550 a 558 possíveis.
- **Faixas possíveis:** p95 de 17,51 a 17,81 ms; p99 de 144,45 ms em qualquer classificação.
- **Vereditos possíveis:** (a) só `aprovado`, (b) só `aprovado` e suficiência sempre atingida. **A incerteza não altera nenhum veredito.**

**Vereditos (critérios do registro prévio, sem alteração):**
- **(a)** p95 de carga de 17,51 ms ≤ max(1,5 × 3,89; 3,89 + 50) = 53,89 ms: **aprovado**.
- **(b)** p95 de carga de 17,51 ms ≤ 250 ms e p99 de carga de 144,45 ms ≤ 500 ms: **aprovado**.
- **(c)** 0 amostras sem 2xx válido em 4.812 (fora de 2xx 0, `429` 0, timeout 0, erro de rede 0, corpo inesperado 0): **aprovado**.
- **Latência:** **aprovada**. Nominal e com a incerteza, o resultado é o mesmo.
- **Amostras:** 4.019 na base e 554 na carga, acima do mínimo de 300.

**Episódio registrado na carga** (informativo; não altera os vereditos, que são por percentis e foram fixados antes):
- **Quando:** às 14:35:27Z, no primeiro intervalo de carga.
- **Sondas:** três amostras passaram de 500 ms no mesmo instante: 640,4, 531,4 e 520,1 ms, nas instâncias 8, 12 e 13. Outras duas, de 204,5 e 175,3 ms, saíram em instantes diferentes. São 3 de 554 amostras de carga acima de 500 ms; o p99 da carga é de 144,45 ms.
- **Do lado do servidor, no mesmo instante:**
  - a API registrou três `GET` de 633, 528 e 519 ms;
  - o PostgreSQL registrou três consultas de 591, 522 e 503 ms;
  - o event loop teve um atraso de 281 ms um segundo antes, num segundo com 45 ms de CPU;
  - nenhuma pausa de GC passou de 11,3 ms durante a carga.
- **Windows:** de 14:35:25 a 14:35:26Z, a fila de disco estava em 12 a 18, com cerca de 1,08 GB disponíveis.
- **Leitura:** o quadro é coerente com a hipótese principal do diagnóstico R-02 (disputa de disco e memória no ambiente), sem atribuição definitiva.

### Medidas

- **Upload:**
  - 85,85 s de upload ativo (a D medida), contra 69,93 s projetados. A carga inclui a conferência das 75 partes recebidas, de cerca de 11 s;
  - 152 PUTs concluídos, com 10.134.217.728 bytes (1,34% reenviados: as partes `unregistered` 73 e 75), a 132,6 MiB/s;
  - 4 PUTs abortados na interrupção;
  - 62 chamadas à API e nenhuma renovação de token;
  - N recalculado pela D medida: 7.
- **Disco:**
  - C: tinha 39,79 GB livres antes, 29,79 GB com o arquivo de prova e 39,80 GB depois da limpeza;
  - o `docker_data.vhdx` ficou com 40.853.569.536 bytes antes e depois (não cresceu);
  - o disco de dados do Docker foi de 19,04 GB para 29,18 GB no pico, um crescimento de 10,14 GB, e voltou a 19,04 GB depois da purga. Em volta do completion, o `df` sem pausa subiu só 12 KiB: o Silo passa as partes para o objeto sem cópia.
- **Memória:**
  - **antes da base, com as 13 sondas:**
    - Windows com 2.138 MB disponíveis no mínimo e mediana de 2.151 MB, commit de 24,51 de 33,05 GB, arquivo de paginação em 15% e `vmmemWSL` com 4,71 GB;
    - VM com 3.769 MiB disponíveis de 7.828 MiB e 1.410 MiB do swap da VM ocupados;
    - API com 337,8 MiB e cada sonda com 13,5 a 13,6 MiB;
  - **durante a carga:** o Windows chegou a 441 MB disponíveis, com até 4.353 leituras e 422 escritas de página por segundo e escrita em disco de até 495 MiB/s.

### Relação com a execução reprovada e próximo passo

- **P-10GB original:** a [`P-10GB.md`](P-10GB.md) (`20261124215534-349fa9`) continua `reprovada` e preservada.
- **Repetição:** esta execução saiu `aprovada` pela regra fixada antes, com outro modo de execução:
  - a API e as sondas compiladas;
  - o cliente no Windows;
  - 13 sondas;
  - o relógio do cliente analisado à parte.
- **Revisão:** como as duas execuções serão consideradas para o R-02 cabe à revisão. A SI-03.33 fica **aguardando a revisão dos resultados**.
- **Execução única:** o upload de 10 GB não foi repetido.

### Evidências

O pacote está em [`P-10GB-repeticao-evidencias/prova/`](P-10GB-repeticao-evidencias/prova/), com índice em `LEIAME.md`:
- o log da execução, a saída do roteiro e os pré-requisitos;
- `evidencias/`:
  - as 13 sondas;
  - os eventos do cliente (originais e no relógio da VM), os relógios e o `relogio.json`;
  - o resumo e o `latency-verdict.json`;
  - os retratos das partes, os registros da API (requisições, event loop, GC e banco), a sonda do PostgreSQL, o amostrador da VM, o `docker stats` e o monitor do Windows;
  - a memória, os retratos e os temporários;
- `scripts/`: as versões exatas usadas, iguais às de `versoes-sha256-r3.txt`.

O registro prévio vigente está em `registro-previo-r3.md`. Os caminhos locais e a pasta temporária do Windows foram trocados por marcadores, e nenhum arquivo traz token, senha ou URL assinada.

### Revisão dos resultados (2026-11-25)

A revisão da repetição formal foi concluída, e **a SI-03.33 está aprovada**.

- **R-02 encerrado para o cenário efetivamente validado:**
  - a API compilada (`npm run build` e `npm run start:prod`, sem watch);
  - 13 sondas compiladas, executadas com `node`;
  - o cliente de upload no Node nativo do Windows;
  - o worker, o banco, o storage, o Redis e o Mailpit do Compose, neste host.
  - **Fora da validação:** outros cenários, como o da P-10GB original (API em watch, sondas com `ts-node` e cliente dentro do container), não foram validados.
- **TD-01:** mantida, sem alteração. A reabertura causada pela P-10GB original fica encerrada, sem fallback e sem mudança de arquitetura.
- **TD-15:** a condição das provas grandes está atendida, com as três provas aprovadas: a V-07, o fluxo completo até `ready` e esta prova de 10 GB.
- **Histórico:**
  - a [`P-10GB.md`](P-10GB.md) continua `reprovada`;
  - os registros prévios (o da P-10GB e as revisões r1, r2 e r3 desta repetição), os critérios e as evidências brutas não foram alterados.
- **Observações mantidas:**
  - **Episódio desta execução:** três respostas acima de 500 ms (640, 531 e 520 ms, às 14:35:27Z), com a API e o PostgreSQL lentos no mesmo instante.
  - **Atrasos anteriores:** a causa dos atrasos da P-10GB original e dos ensaios do diagnóstico **não foi comprovada de forma definitiva** (ver [`R-02-diagnostico.md`](R-02-diagnostico.md)).

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
- **Situação:** **preparada, não executada**. O arquivo de 10 GB não foi gerado nem enviado.
- **Resultado:** a preencher depois da execução.

## Registro prévio

Fixado antes de gerar ou enviar o arquivo de 10 GB (ver o carimbo e o SHA-256 da cópia no fim desta seção). Os critérios e as regras abaixo não são ajustados depois de ver os números.

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
  - **base:** de quando todas as instâncias amostram até o início da etapa de upload, com **pelo menos 600 s**. Na repetição, a base termina antes de armar o envio do Ctrl+C, que antecede o lançamento do cliente (ver a tabela abaixo);
  - **carga:** só os intervalos com o cliente de upload ativo: do primeiro `part-urls` à interrupção, da retomada à espera antes do completion e da liberação ao `202`;
  - **aquecimento e fora:** só contam no critério (c);
  - **nenhum período ocioso entra na carga** para aumentar amostras;
- **percentis:** pelo posto mais próximo, sobre todas as amostras da fase;
- **amostras:** pelo menos 300 por fase.

### O que muda: o modo de execução

As mudanças vêm do diagnóstico do R-02 ([`R-02-diagnostico.md`](R-02-diagnostico.md), seções 9 a 12).

| Item | P-10GB (`20261124215534-349fa9`) | Repetição |
|------|----------------------------------|-----------|
| API | `npm run start:dev` (watch) | `npm run build` e `npm run start:prod` (`node dist/main`), sem watch, com os monitores de `p10gb-repeticao/monitor-api.cjs`, sem perfil de CPU |
| Sondas | `responsiveness-probe.ts` com `ts-node` (`node -r ts-node/register`) | o mesmo arquivo compilado uma vez para JS (`tsc`) e executado com `node`, com o mesmo comportamento e os mesmos parâmetros. O JS é montado só para leitura (`-v` do `docker compose run`), sem mudar o Compose |
| Número de sondas | 4 | **12** (ver "Dimensionamento") |
| Partida das sondas | todas juntas, com disparos sincronizados | lançamento sequencial com espaçamento de 2000/N ms (167 ms), para evitar os disparos sincronizados. O ritmo de cada instância continua uma requisição a cada 2 s. A fase de cada instância depende da partida do container e fica registrada no CSV dela: na pré-checagem 4, a menor distância entre duas instâncias foi de 16 ms e a maior, de 380 ms |
| Fim da base | no lançamento do cliente | **antes de armar o envio do Ctrl+C**, cerca de 1,4 s antes do lançamento do cliente. A partida do PowerShell não entra na base, porque elevaria o p95 da base e afrouxaria o critério (a). As amostras desse trecho ficam fora da base e da carga e só contam no critério (c) |
| Cliente de upload | `upload-client.ts` com `ts-node`, no container `nestjs-api` (mesma VM e disco da API) | o mesmo cliente compilado para JS, no **Node nativo do Windows** (fora do Docker e do WSL), pelo `localhost` do Windows (portas publicadas, o caminho do navegador), com os mesmos parâmetros |
| Arquivo de prova | no `/tmp` do `nestjs-api` (VHDX do Docker) | na pasta temporária do Windows (NTFS em C:), gerado antes da medição |
| Interrupção | `SIGINT` pelo `interrupt-when`, no mesmo container | **Ctrl+C real** (`CTRL_C_EVENT` ao console do cliente, `ctrl-c.ps1`), pedido pelo vigia que roda no Windows (`vigia-interrupcao.cjs`), que aciona o handler de SIGINT do cliente, com saída 130 |
| Monitores | amostrador de disco do storage e `docker stats` | os mesmos, mais o amostrador da VM, a sonda do PostgreSQL (com `\timing`) e o monitor do Windows (memória, commit, paginação, disco e `vmmemWSL`) |
| Worker, banco, storage, Redis e Mailpit | como estão | como estão |

Nada disso altera a aplicação, a arquitetura, as dependências nem o Compose. Os critérios também não mudam.

### Relógios: cliente no Windows e sondas na VM

As sondas, a API e as amostras usam o relógio da VM do Docker; o cliente, o do Windows. Os recortes de carga vêm dos eventos do cliente, então os eventos são levados ao relógio da VM antes dos vereditos:

1. **Medida:** antes da base e depois da carga, `relogio.cjs` roda no Node do Windows e faz 15 medidas. Cada uma cerca a leitura do relógio da VM (`docker.exe exec <nestjs-api> date +%s%3N`) entre duas leituras do relógio do Windows.
   - **Medida usada:** a de menor ida e volta.
   - **Diferença:** VM − (t1 + t2) / 2.
   - **Incerteza:** (t2 − t1) / 2.
2. **Diferença usada:** a média das duas medidas.
3. **Incerteza usada:** a maior das duas, mais a metade da variação entre elas.
4. **Ajuste dos eventos:** `eventos-relogio-vm.py` soma a diferença ao instante de cada evento do cliente. Em seguida, **encolhe cada intervalo de carga pela incerteza, dos dois lados** (início + u e fim − u). Os intervalos seguem a mesma regra do `latency-verdict`: abrem em `load_start` e fecham em `load_end` ou `segment_end`.
   - **Intervalo fechado sem `load_end`:** recebe um `load_end` no fim encolhido, marcado com `"ajuste": "relogio"`.
   - **Intervalo vazio depois do encolhimento:** é descartado, e o descarte é registrado no log. Nas quatro pré-checagens, o trecho da liberação ao `202` (de 89 a 116 ms) foi descartado assim, e o mesmo deve ocorrer na prova.
   - **Efeito:** nenhum instante ocioso entra na carga por erro de relógio; no máximo, alguns instantes ativos nas bordas ficam fora.
5. **Uso:** os vereditos (`latency-verdict`) e o resumo usam os eventos ajustados, e o log registra cada intervalo, original e ajustado ou descartado.

**Ordem de grandeza nas quatro pré-checagens:**
- **Diferença:** de 36 a 66 ms.
- **Incerteza de cada medida:** de 106 a 143 ms.
- **Variação entre antes e depois:** de até 30 ms.
- **Incerteza usada:** de 116 a 157 ms. Em cada borda, isso tira cerca de 0,15 s da carga.

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

- **Referência:** a execução mais rápida medida, de 6,993 s, projetada linearmente para 10 GB: D ≈ 69,9 s.
  - **Por que é conservadora:** a projeção não inclui o intervalo da interrupção, que fica fora da carga, nem a conferência das partes recebidas na retomada (cerca de 5 GB de checksums no Windows), que entra na carga e só a alonga.
- **Margem explícita:** a carga pode ser **até 30% mais curta** que essa projeção: D_mín = 69,9 / 1,3 = **53,8 s**.
- **N = ceil(600 / 53,8) = 12.**

**Amostras esperadas:**
- **base:** 12 × 600 / 2 = 3.600;
- **carga:** cerca de 419 com D = 69,9 s e pelo menos 323 com D = 53,8 s.

**Efeito do relógio:** o encolhimento tira cerca de 2 × 0,16 s de cada um dos dois intervalos de upload, cerca de 0,6 s ao todo. Com D = 53,8 − 0,6 = 53,2 s, ainda são cerca de 319 amostras.

**Se a carga ainda ficar com menos de 300 amostras:** vale a regra da SI-03.33. O veredito de (a) e (b) é `inconclusivo`, e a prova é repetida com `N` recalculado pela D medida.

**Memória:** cada sonda compilada ocupa cerca de 14 MiB, e as 12 somam cerca de 0,2 GiB (com `ts-node`, eram cerca de 184 MiB cada).

### Critérios de aprovação, sem alteração

Os mesmos da SI-03.33 e da P-10GB:
- **(a)** p95 de carga ≤ max(1,5 × p95 de base; p95 de base + 50 ms);
- **(b)** p95 de carga ≤ 250 ms e p99 de carga ≤ 500 ms;
- **(c)** zero respostas fora de 2xx, zero `429` e zero timeouts, em todas as amostras coletadas. Conta como falha qualquer amostra sem um 2xx válido.

**Regras de veredito**, as mesmas da P-10GB:
- **Amostras:** com menos de 300 amostras na base ou na carga, (a) e (b) são `inconclusivo`.
- **Latência:**
  - `reprovada` se qualquer critério for reprovado;
  - `inconclusiva` se (a) ou (b) for inconclusivo e (c) passar;
  - `aprovada` só com os três aprovados.
- **Reprovação:** registra o critério violado e o requisito afetado (R-02), sem flexibilizar o critério e sem descartar a execução.
- **Resultado da prova:** `aprovada` só com todos os itens obrigatórios e a latência aprovados.

### Disco e memória

**Disco:**
- **Arquivo de prova:** 10,0 GB no NTFS de C:, ou 13,0 GB com margem de 30%.
- **Pico do storage:** medido na P-10GB, foi de 10,14 GB dentro do disco de dados do Docker, ou 13,2 GB com margem.
  - **Folga no VHDX:** o `docker_data.vhdx` tem 40,85 GB, com 19,04 GB usados, o que dá cerca de 21,8 GB livres dentro dele. Por isso o pico não deve fazer o VHDX crescer.
- **Exigência mantida:** **29,5 GB livres em C:** antes de começar, a exigência da V-07, mais conservadora que o orçamento recalculado (cerca de 13 GB em C: com margem, se o VHDX não crescer). O roteiro para antes de criar recursos se o espaço for menor.
- **Nas pré-checagens:** havia de 40,0 a 41,7 GB livres em C:, e o `docker_data.vhdx` ficou com 40.853.569.536 bytes do início ao fim de cada uma (não cresceu). O uso do disco de dados do Docker subiu cerca de 1,07 GB com 1 GB enviado e voltou depois da purga.

**Memória:**
- **Referência informativa:** os 4 GiB disponíveis no Windows continuam como referência, não critério nem bloqueio.
- **Medição:** a memória do Windows, dos containers e da VM é medida com **todas as 12 sondas** em execução, antes da base.
- **Nas pré-checagens, com as 12 sondas** (detalhes por execução na tabela abaixo):
  - **Windows:** de 1.371 a 2.009 MB disponíveis no mínimo, sempre abaixo da referência, com o commit em 23,27 a 24,09 de 33,05 GB, o arquivo de paginação em 12 a 13% e o `vmmemWSL` em 4,89 a 5,13 GB;
  - **VM:** de 4.012 a 4.140 MiB disponíveis, com 1.441 a 1.545 MiB do swap da VM ocupados. Esse swap é da VM inteira, não do processo da API;
  - **containers:** a API compilada com 310 a 341 MiB e cada sonda com cerca de 14 MiB.

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
5. **Pré-checagem 3 (defeito no ajuste de relógio):** o trecho da liberação ao `202`, de cerca de 90 ms, ficou com fim antes do início depois do encolhimento. Nenhuma amostra foi mal classificada, mas a duração somada da carga ficou menor.
   - **Tratamento:** o `eventos-relogio-vm.py` passou a seguir a regra de pareamento do `latency-verdict`, a descartar o intervalo vazio e a fechar com `load_end` de ajuste o intervalo sem `load_end`.
   - **Recálculo:** os vereditos das pré-checagens 2 e 3 foram recalculados nas evidências, e os originais foram preservados. As amostras e os percentis não mudaram; a carga passou de 10,784 para 10,900 s e de 7,969 para 8,182 s.
6. **Revisão conservadora do fim da base:** a base terminava depois de armar o envio do Ctrl+C. Passou a terminar antes, como na tabela "O que muda".

### Pré-checagens (até 1 GB, não fazem parte da prova)

Feitas com o próprio roteiro, com `P10GB_SIZE_BYTES=1000000000`, `P10GB_BASELINE_SECONDS=60`, `P10GB_ROTULO=pre-checagem` e 12 sondas (`P10GB_PROBES=12` nas três primeiras; o padrão do roteiro, também 12, na quarta). Os vereditos de latência delas são `inconclusivo` por construção, já que a base é curta, e não contam para o R-02.

| Pré-checagem | Versões | Interrupção | Retomada e partes | Desfecho | Relógio (antes; depois; u) | Memória com 12 sondas | Limpeza |
|--------------|---------|-------------|-------------------|----------|----------------------------|-----------------------|---------|
| 1 (`20261125022403-73f57a`) | vigia no WSL | **falhou:** o cliente saiu com 1 (`EPERM` na troca do progresso), com 4 de 15 partes; o Ctrl+C não chegou a ser pedido | 0 `confirmed`, 4 `unregistered` conferidas com `200 match`; a comparação reprovou o item "nenhum PUT de `confirmed`", por não haver `confirmed` | `202` e `MEDIA_INVALID` | 39 ± 107; 50 ± 124 ms | Windows 1.371 MB mín.; VM 4.078 MiB | completa; retratos iguais; nenhum temporário novo; purga em 51 s |
| 2 (`20261125044220-c1154c`) | vigia no Windows, Ctrl+C sem armar | Ctrl+C real pedido com 8 de 15; gerado 3,6 s depois, com os 15 PUTs concluídos; handler de SIGINT e saída **130** | 14 `confirmed` e 1 `unregistered`, 15 conferidas com `200 match`; comparação 5 de 5 | `202` e `MEDIA_INVALID` | 36 ± 106; 40 ± 114; u = 116 ms | Windows 1.571 MB mín.; VM 4.140 MiB | completa; retratos iguais; nenhum temporário novo; purga em 113 s |
| 3 (`20261125044914-338152`) | Ctrl+C armado; ajuste de relógio antigo | gatilho com 8 de 15 (limite 8); Ctrl+C gerado 163 ms depois; handler de SIGINT, com 8 PUTs concluídos e 4 abortados, e saída **130** | 7 `confirmed`, 1 `unregistered` e 7 `missing`; 8 conferidas com `200 match`; comparação 5 de 5, sem PUT de `confirmed` | `202` e `MEDIA_INVALID` | 36 ± 111; 66 ± 137; u = 152 ms | Windows 2.009 MB mín.; VM 4.102 MiB | completa; retratos iguais; nenhum temporário novo; purga em 51 s |
| **4 (`20261125045940-f17f11`)** | **as fixadas abaixo** | gatilho com 8 de 15 (limite 8); Ctrl+C gerado 166 ms depois; handler de SIGINT, com 8 PUTs concluídos e 4 abortados, e saída **130** | 7 `confirmed`, 1 `unregistered` e 7 `missing`; 8 conferidas com `200 match`; comparação 5 de 5, sem PUT de `confirmed` | `202` e `MEDIA_INVALID` | 38 ± 112; 66 ± 143; u = 157 ms | Windows 2.009 MB mín. (mediana 2.013 MB), commit 23,58 de 33,05 GB; VM 4.012 MiB | completa; retratos iguais; nenhum temporário novo; purga em 285 s |

**O que a pré-checagem 4 validou, com as versões fixadas:**
- **Interrupção:** o Ctrl+C real aciona o handler de SIGINT do cliente no Windows, que registra a interrupção (`INTERRUPÇÃO | SIGINT`, com as partes concluídas, registradas e em andamento), aborta os PUTs em andamento e sai com 130. Não houve encerramento forçado nem evento simulado.
- **Retomada:** a retomada classifica as partes, confere as recebidas por `file-verifications` e reenvia só as `unregistered` e as `missing`. A comparação das três fontes (eventos, `ListParts` e registro da API) confirma que nenhuma parte `confirmed` foi reenviada.
- **Relógio:** o ajuste roda dentro do roteiro e descarta o intervalo vazio.
- **Base:** termina antes de armar o envio do Ctrl+C.
- **Sondas:** as 12 amostraram sem falha; o critério (c) ficou aprovado, com 1.000 amostras.

**Código de saída:** o código final 1 das pré-checagens 2 a 4 vem só do veredito de latência. Ele é `inconclusivo` por construção, com a base de 60 s e cerca de 50 amostras de carga. Todas as etapas obrigatórias e a limpeza passaram.

**Evidências:** em [`P-10GB-repeticao-evidencias/`](P-10GB-repeticao-evidencias/), uma pasta por pré-checagem:
- o log, as sondas, os eventos do cliente (originais e no relógio da VM), as medidas de relógio, a memória, o monitor do Windows, os registros da API, os retratos e os temporários;
- os vereditos recalculados das pré-checagens 2 e 3 (`*-relogio-corrigido.*`);
- o vigia descartado (`pre-checagem-1/vigia-interrupcao-wsl-descartado.py`).

O caminho local da saída, o do repositório e a pasta temporária do Windows, que contém o nome do usuário, foram trocados por marcadores. Nenhum arquivo traz token, senha ou URL assinada.

### Procedimento

1. **Pré-requisitos:**
   - `docker compose up -d`, com o ambiente saudável e o `video-worker` no ar;
   - a **API parada**, porque o roteiro faz o build e a sobe;
   - no Windows: `node.exe`, `powershell.exe` e `docker.exe` no PATH;
   - as versões fixadas: em `nestjs-project/`, `sha256sum -c ../docs/phases/phase-03-videos/proofs/P-10GB-repeticao-evidencias/pre-checagem-4/versoes-sha256.txt`, com `OK` em todos os arquivos;
   - 29,5 GB livres em C:;
   - a janela de 40 min.
2. **Comando:** no host, a partir de `nestjs-project/`, `P10GB_CONFIRMA_10GB=sim proofs/phase-03/p10gb-repeticao-roteiro.sh <diretório de saída>`.
   - **Padrões:** `P10GB_SIZE_BYTES=10000000000`, `P10GB_PROBES=12`, `P10GB_PROBE_STAGGER_MS=167`, `P10GB_BASELINE_SECONDS=600`, `P10GB_INTERRUPT_FRACTION=0.5`, `P10GB_RESUME_GAP_SECONDS=5` e `P10GB_MIN_FREE_BYTES=29500000000`.
   - **Trava:** sem `P10GB_CONFIRMA_10GB=sim`, o roteiro recusa tamanhos acima de 1.000.000.000 bytes com código 64, antes de criar qualquer recurso.
3. **Etapas do roteiro:**
   1. confere o ambiente, a API parada e o espaço em C:, registra as versões e o disco, e tira os retratos e a lista dos temporários do Silo;
   2. faz o build da API e compila o cliente e a sonda;
   3. gera o arquivo no Windows;
   4. sobe a API com `start:prod`, cria as contas e o vídeo de controle e mede o relógio;
   5. espera a lixeira vazia e inicia os amostradores e os monitores;
   6. lança as 12 sondas espaçadas e mede a memória com todas elas;
   7. faz a base de 600 s;
   8. encerra a base, arma o envio do Ctrl+C e inicia o upload no Windows; o vigia cria o gatilho em 75 partes, e o cliente sai com 130;
   9. tira o retrato das partes, faz a retomada no Windows (`--hold-before-completion`), tira o segundo retrato, compara e libera o completion, com polling até `MEDIA_INVALID`;
   10. mede o relógio de novo, para as sondas e os monitores, converte os eventos para o relógio da VM e roda `summarize` e `latency-verdict`;
   11. limpa (`trap EXIT`): sondas, monitores, cliente, API, containers, pastas no container, no Windows e no diretório de saída, os recursos de prova (`cleanup`), a purga, os retratos e os temporários.
4. **Arquivos:** o roteiro está em [`nestjs-project/proofs/phase-03/p10gb-repeticao-roteiro.sh`](../../../../nestjs-project/proofs/phase-03/p10gb-repeticao-roteiro.sh), e os auxiliares, em [`nestjs-project/proofs/phase-03/p10gb-repeticao/`](../../../../nestjs-project/proofs/phase-03/p10gb-repeticao/).

### Versões fixadas

A prova usa exatamente estas versões, validadas na pré-checagem 4. A lista também está em [`P-10GB-repeticao-evidencias/pre-checagem-4/versoes-sha256.txt`](P-10GB-repeticao-evidencias/pre-checagem-4/versoes-sha256.txt). O roteiro não confere os hashes sozinho: a conferência é um pré-requisito do procedimento (`sha256sum -c`). Qualquer mudança nesses arquivos exige uma revisão deste registro antes da execução.

| Arquivo (em `nestjs-project/`) | SHA-256 |
|--------------------------------|---------|
| `proofs/phase-03/p10gb-repeticao-roteiro.sh` | `c42369502b12e2cc088f2577dc087f0c98a72dfa80ddded9de25a011068b8b81` |
| `proofs/phase-03/p10gb-repeticao/amostrador-vm.sh` | `1041a26f7aa000a2df0beb4f3e3e8db63f4d431f75a83fa7616e4fd76efff3a3` |
| `proofs/phase-03/p10gb-repeticao/ctrl-c.ps1` | `5d920acf624597d057f54465c471dccbf76b50ea2b2142a00d2d279b073f53be` |
| `proofs/phase-03/p10gb-repeticao/eventos-relogio-vm.py` | `c6848c5ec7030d94be029270e398c8ae02bc7f80c2e123e2edd5fccba79c95ba` |
| `proofs/phase-03/p10gb-repeticao/iniciar-windows.ps1` | `8956921313a5f40713fb388b92e93f93e4ba0997aa11b706b6c8f76672209a17` |
| `proofs/phase-03/p10gb-repeticao/monitor-api.cjs` | `2c2d2424adadf94ef7877241a9477a124ae1d3784fd5ee016ab959bc351b617c` |
| `proofs/phase-03/p10gb-repeticao/monitor-windows.ps1` | `37e8edc8dd1d78f1536c8572ccec21e20e1a4e242d091fc1abdafd2e26b838ed` |
| `proofs/phase-03/p10gb-repeticao/relogio.cjs` | `e065135f52b81a73321ed02f9f34afcbf716788b6c8668ec311892b23bf67ead` |
| `proofs/phase-03/p10gb-repeticao/sonda-db.sh` | `d04c334d3ce546888fd60619034181053148c9d8f2d953e44c7f13eb96be38bd` |
| `proofs/phase-03/p10gb-repeticao/vigia-interrupcao.cjs` | `344cf69286e78160b4c3f8137abd683b7553301e220db0e076677559b73a9076` |
| `proofs/phase-03/upload-client.ts` | `807f26135ca07840e37522dfd9e558fe76258ed475f5087a923c386108f67d9d` |
| `proofs/phase-03/responsiveness-probe.ts` | `bb61b3b7041f746ae942afa3230bcacc34e1af91d108d07e9f47a9adaae16527` |
| `proofs/phase-03/upload-proof-support.ts` | `2d8dcc509a27f30acc6eb3e89143a4e0b0dc7e8c499940ab5fe486d50f641413` |

### Carimbo

Este registro prévio foi fixado às 05:11Z de 2026-11-25, antes de gerar ou enviar o arquivo de 10 GB. Uma cópia está em [`P-10GB-repeticao-evidencias/registro-previo.md`](P-10GB-repeticao-evidencias/registro-previo.md), com o SHA-256 registrado no `progress.md`. Os critérios e as regras acima não mudam depois de ver os números.

## Resultados

A preencher depois da execução de 10 GB, que não foi feita nesta etapa.

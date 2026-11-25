---
kind: phase
name: phase-03-videos
status: clean
issue_count: 0
sources_mtime:
  docs/phases/phase-03-videos/context.md: "2026-11-17T21:14:16-03:00"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-11-17T21:13:07-03:00"
issues:
  - id: IC-1
    status: resolved
    summary: "Out of scope 'Not specified' contradiz a delimitação explícita do escopo"
    resolved_by: clarification
  - id: IC-2
    status: resolved
    summary: "D-05: TD-08 herdada supõe throttler por módulo; a âncora diz que é global"
    resolved_by: phase-02-auth/TD-08
  - id: IC-3
    status: resolved
    summary: "D-06: guia de testes indica storage local; R-10 exige storage real"
    resolved_by: phase-03-videos/TD-15
  - id: IC-4
    status: resolved
    summary: "CE-01: sincronizar OpenAPI no next-frontend × frontend fora da fase"
    resolved_by: clarification
  - id: IC-5
    status: resolved
    summary: "TD-11: fallback para a B por formato × regra de reabrir a TD se V-04 falhar"
    resolved_by: phase-03-videos/TD-11
  - id: AMB-1
    status: resolved
    summary: "Evidência de 'streaming funcionando' e do download sem player na Fase 03"
    resolved_by: phase-03-videos/TD-14
  - id: AMB-2
    status: resolved
    summary: "Evidência de aceite do upload de até 10GB (R-02 × provas da TD-15)"
    resolved_by: phase-03-videos/TD-15
  - id: AMB-3
    status: resolved
    summary: "OR-01: proteção das gravações no storage contra execuções obsoletas"
    resolved_by: phase-03-videos/TD-12
  - id: AMB-4
    status: resolved
    summary: "OR-02: vínculo objeto × sessão ao recuperar conclusão parcial"
    resolved_by: phase-03-videos/TD-02
  - id: AMB-5
    status: resolved
    summary: "OR-03: fallbacks de checksum e de limite têm garantias diferentes"
    resolved_by: phase-03-videos/TD-03
  - id: AMB-6
    status: resolved
    summary: "Processo e gatilho da varredura de sessões e da reconciliação"
    resolved_by: phase-03-videos/TD-12
  - id: DG-1
    status: resolved
    summary: "D-07: imagem Node 25 em fim de vida × FFmpeg do worker e V-04"
    resolved_by: phase-03-videos/TD-10
  - id: OQ-1
    status: resolved
    summary: "phase-03-videos/TD-01 pending — Protocolo de upload direto e retomável"
    resolved_by: phase-03-videos/TD-01
  - id: OQ-2
    status: resolved
    summary: "phase-03-videos/TD-02 pending — Ciclo de vida da sessão de upload"
    resolved_by: phase-03-videos/TD-02
  - id: OQ-3
    status: resolved
    summary: "phase-03-videos/TD-03 pending — Política e aplicação do limite de 10GB"
    resolved_by: phase-03-videos/TD-03
  - id: OQ-4
    status: resolved
    summary: "phase-03-videos/TD-04 pending — Modelo de estados do vídeo e transições"
    resolved_by: phase-03-videos/TD-04
  - id: OQ-5
    status: resolved
    summary: "phase-03-videos/TD-05 pending — Identificador público e URL única"
    resolved_by: phase-03-videos/TD-05
  - id: OQ-6
    status: resolved
    summary: "phase-03-videos/TD-06 pending — Organização dos objetos e acesso no bucket"
    resolved_by: phase-03-videos/TD-06
  - id: OQ-7
    status: resolved
    summary: "phase-03-videos/TD-07 pending — Topologia de endpoints do storage e env"
    resolved_by: phase-03-videos/TD-07
  - id: OQ-8
    status: resolved
    summary: "phase-03-videos/TD-08 pending — Distribuição do MinIO no Docker Compose"
    resolved_by: phase-03-videos/TD-08
  - id: OQ-9
    status: resolved
    summary: "phase-03-videos/TD-09 pending — Tecnologia de fila"
    resolved_by: phase-03-videos/TD-09
  - id: OQ-10
    status: resolved
    summary: "phase-03-videos/TD-10 pending — Execução e empacotamento do worker"
    resolved_by: phase-03-videos/TD-10
  - id: OQ-11
    status: resolved
    summary: "phase-03-videos/TD-11 pending — Acesso do worker à mídia"
    resolved_by: phase-03-videos/TD-11
  - id: OQ-12
    status: resolved
    summary: "phase-03-videos/TD-12 pending — Consistência estado × fila e idempotência"
    resolved_by: phase-03-videos/TD-12
  - id: OQ-13
    status: resolved
    summary: "phase-03-videos/TD-13 pending — Formato de entrega para reprodução"
    resolved_by: phase-03-videos/TD-13
  - id: OQ-14
    status: resolved
    summary: "phase-03-videos/TD-14 pending — Caminho de acesso para streaming e download"
    resolved_by: phase-03-videos/TD-14
  - id: OQ-15
    status: resolved
    summary: "phase-03-videos/TD-15 pending — Estratégia de prova com infraestrutura real"
    resolved_by: phase-03-videos/TD-15
  - id: OQ-16
    status: resolved
    summary: "Q-01 aberta — 10 GB ou 10 GiB (provisório 10 GB, não aprovado)"
    resolved_by: phase-03-videos/TD-03
  - id: OQ-17
    status: resolved
    summary: "Q-02 aberta — quem reproduz e baixa um vídeo ready; 404 ou 403"
    resolved_by: phase-03-videos/TD-14
  - id: OQ-18
    status: resolved
    summary: "Q-03 aberta — formatos aceitos no upload (MOV depende de V-04)"
    resolved_by: phase-03-videos/TD-11
  - id: OQ-19
    status: resolved
    summary: "Q-04 aberta — destino do rascunho cuja sessão expirou"
    resolved_by: phase-03-videos/TD-02
  - id: OQ-20
    status: resolved
    summary: "Q-05 aberta — reprocessar a partir de error entra na Fase 03?"
    resolved_by: phase-03-videos/TD-12
  - id: OQ-21
    status: resolved
    summary: "Q-06 aberta — aceitar o fork pgsty/silo após V-01, V-03 e V-09?"
    resolved_by: phase-03-videos/TD-08
  - id: OQ-22
    status: resolved
    summary: "Q-07 aberta — video-worker sobe com o Compose apesar da regra (D-11)?"
    resolved_by: phase-03-videos/TD-10
  - id: OQ-23
    status: resolved
    summary: "Q-08 aberta — retomada de 24h com expiração do storage em 48h"
    resolved_by: phase-03-videos/TD-02
  - id: OQ-24
    status: resolved
    summary: "Q-09 aberta — polling basta para acompanhar o estado?"
    resolved_by: phase-03-videos/TD-04
  - id: OQ-25
    status: resolved
    summary: "Q-10 aberta — conferir todas as partes ao retomar ou uma amostra?"
    resolved_by: phase-03-videos/TD-02
  - id: OQ-26
    status: resolved
    summary: "V-01 não executada — Silo: MINIO_*, mc, CORS e expiração de multipart"
    resolved_by: phase-03-videos/TD-08
  - id: OQ-27
    status: resolved
    summary: "V-02 não executada — storage recusa UploadPart fora do content-length"
    resolved_by: phase-03-videos/TD-03
  - id: OQ-28
    status: resolved
    summary: "V-03 não executada — URLs do AWS SDK 3.1170 aceitas pelo Silo"
    resolved_by: phase-03-videos/TD-07
  - id: OQ-29
    status: resolved
    summary: "V-04 não executada — ffprobe/ffmpeg 5.1 sobre URL assinada"
    resolved_by: phase-03-videos/TD-11
  - id: OQ-30
    status: resolved
    summary: "V-05 não executada — reprodução e seek após redirect (Fase 05)"
    resolved_by: phase-03-videos/TD-14
  - id: OQ-31
    status: resolved
    summary: "V-06 não executada — bullmq 6 + @nestjs/bullmq 11 + Redis 8 + Jest 30"
    resolved_by: phase-03-videos/TD-09
  - id: OQ-32
    status: resolved
    summary: "V-07 não executada — tempo e disco das duas provas de arquivo grande"
    resolved_by: phase-03-videos/TD-15
  - id: OQ-33
    status: resolved
    summary: "V-08 não executada — Content-Length assinado em navegador real"
    resolved_by: phase-03-videos/TD-01
  - id: OQ-34
    status: resolved
    summary: "V-09 não executada — checksum por parte assinado e verificado"
    resolved_by: phase-03-videos/TD-02
  - id: OQ-35
    status: resolved
    summary: "V-10 não executada — retentativa do Complete no servidor escolhido"
    resolved_by: phase-03-videos/TD-02
  - id: OQ-36
    status: resolved
    summary: "V-11 não executada — padrões e comportamentos do BullMQ 6.7.7"
    resolved_by: phase-03-videos/TD-12
advisories: []
---

# phase-03-videos — Validation

_Validação lida exclusivamente de `docs/phases/phase-03-videos/context.md`, depois da conciliação da Phase A do plano: revisões de 2026-11-17 das TD-02, TD-06 e TD-12 e notas de F-02/F-03, G, T e V-11. Escopo considerado: backend, worker, infraestrutura e documentação; a implementação do frontend está fora da fase, exceto a sincronização do contrato OpenAPI autorizada como manutenção. O status `clean` indica coerência documental para seguir ao planejamento. Não indica provas aprovadas: nenhuma prova foi executada, e as decisões condicionadas continuam dependendo delas._

## Findings

### Inconsistencies

_None._

### Ambiguities

_None._

### Missing Decisions

_None._

### Dependency Gaps

_None._

### Inherited Constraint Conflicts

_None._

### Unresolved Open Questions

_None._

### UI Coverage Gaps

_None._

## Notas do exame (sem issue)

### Verificações padrão

- **Cobertura de capacidades:** as 9 capacidades de `## Capability Coverage` têm pelo menos uma TD decidida.
- **TDs pendentes:** nenhuma; as 15 TDs estão `decided`, e as linhas "Last revision" das TD-02, TD-06 e TD-12 refletem as revisões novas.
- **TD de frontend órfã:** nenhuma TD atual tem `Scope: Frontend`.
- **Sincronização de contrato (Decisão #29):** não se aplica, porque o `## UI Inventory` está com o marcador de adiamento, que é falso positivo de interface.
- **Fatias:** um único documento de escopo de fase; a Check 8 não se aplica.
- **Regras customizadas:** `docs/rules/plan-validate/` não existe.
- **Herança:** a Revision de `phase-02-auth/TD-08` (throttler global) continua coerente com a revisão de throttling da TD-02. As revisões novas não conflitam com convenções herdadas (TypeORM, `registerAs`, envelope de erro e JWT global).

### Revisões novas conferidas

| TD | Revisão de 2026-11-17 | Coerência no `context.md` |
|----|-----------------------|---------------------------|
| TD-02 | Coordenação de sessão e contratos: `initiating`, `claim_token`, bloqueio do vídeo, compensação, reinícios concorrentes, releitura da conclusão, `expectedSize`, fórmula do tamanho da parte, conferência com lista vazia e 400 × 413/415 | Substitui de forma explícita a proposta de estados da Recommendation; compatível com a TD-03 (`content-length` assinado; V-02 e V-08 seguem bloqueantes) e com a TD-06 (chave por sessão) |
| TD-06 | Exclusão segura (P4): elegibilidade só por fatos estáveis; posse por token antes de abortar uploads de claims vencidos; `current_attempt_id` residual não protege | Compatível com as revisões de limpeza da TD-02 e da TD-12 e com a nota de G-10 |
| TD-12 | Recuperações por geração: `jobId` por execução e geração, reserva atômica com recuperação contada, sem `job.retry()`, retomada na mesma geração, executor atrasado preso à própria geração, retenção dos jobs e ordem de leituras | Substitui de forma explícita a conduta da tabela da Option A e o "`jobId` determinístico por execução" da linha Decision; as notas de F-02/F-03, G-05/G-06/G-07 e T-09/T-11 e a V-11 ampliada estão espelhadas |

### Situação das decisões e provas (como registrada no context.md)

| Situação | Itens |
|----------|-------|
| Decisão arquitetural aprovada | TD-04, TD-05, TD-06, TD-14, TD-15 |
| Decisão condicionada a prova | TD-01 (V-08), TD-02 (V-01, V-09, V-10), TD-03 (V-02, V-08), TD-07 e TD-08 (V-01, V-03, V-09), TD-09 (V-06, V-11), TD-10 (V-04, V-11), TD-11 e TD-13 (V-04), TD-12 (V-11, ampliada) |
| Prova executada e aprovada | Nenhuma |
| Verificação adiada para outra fase | V-05 (Fase 05); o aceite de streaming e download da Fase 03 segue a revisão da TD-14 |

Os testes T-01 a T-14, com as ampliações registradas, e as provas grandes da TD-15 não foram executados.

### Observações para o planejamento (não bloqueiam)

- **`Job.retry()` na V-11:** o roteiro original da V-11 e a revisão "Situação" da TD-12 ainda citam `Job.retry()` para `failed` e `completed`. Depois da revisão de recuperações por geração, a reconciliação não usa mais `Job.retry()`, então esse item da V-11 passa a ser informativo. Quando as SIs forem escritas, ele não deve condicionar a TD-12 nem reabri-la.
- **Algoritmo de checksum:** a Recommendation da TD-02 chama o SHA-256 de "provisório"; na prática ele está fixado pela V-09, que prova `x-amz-checksum-sha256`.
- **Responsividade na prova de 10 GB:** a revisão da TD-15 exige medição. O critério numérico fica para o plano.
- **Tabela de transições e protocolos:** a tabela consolidada está na seção "Consequências" do documento de decisões, e os protocolos P1–P5 estão no plano. O `context.md` só os referencia.
- **D-08:** continua como tarefa separada, a fazer antes de ampliar a suíte de integração.

## Resolved Issues

_Preservadas das revisões anteriores (resolvidas pelo `/plan-resolve` em 2026-11-17). Nenhuma prova foi executada; as V-NN abaixo foram classificadas, não aprovadas._

- **IC-1** _(resolved_by clarification)_ — Out of scope 'Not specified' contradiz a delimitação explícita do escopo. Campo `Out of scope` do context.md corrigido e delimitação registrada no topo do documento de decisões; `project-plan.md` não alterado.
- **IC-2** _(resolved_by phase-02-auth/TD-08)_ — D-05: TD-08 herdada supõe throttler por módulo; a âncora diz que é global. Throttler global preservado; Revision documental em `phase-02-auth/TD-08` e limites explícitos por rota da Fase 03 na revisão da `phase-03-videos/TD-02`.
- **IC-3** _(resolved_by phase-03-videos/TD-15)_ — D-06: guia de testes indica storage local; R-10 exige storage real. R-10 prevalece; exceção ao guia registrada: integração e e2e usam storage, fila e worker reais.
- **IC-4** _(resolved_by clarification)_ — CE-01: sincronizar OpenAPI no next-frontend × frontend fora da fase. Regeneração de `next-frontend/openapi.json` e `types.gen.ts` autorizada como manutenção do contrato, sem funcionalidades de frontend.
- **AMB-1** _(resolved_by phase-03-videos/TD-14)_ — Evidência de 'streaming funcionando' e do download sem player na Fase 03. Aceite por testes contra storage real com vídeo válido: autorização, URLs, 206/`Content-Range` e download; player fica para a fase de frontend.
- **AMB-2** _(resolved_by phase-03-videos/TD-15)_ — Evidência de aceite do upload de até 10GB (R-02 × provas da TD-15). Suíte regular pequena e configurável, uma prova documentada de 10 GB com interrupção, retomada e responsividade da API, e fluxo completo até `ready`; sem duas transferências de 10 GB nem preenchimento artificial.
- **AMB-3** _(resolved_by phase-03-videos/TD-12)_ — OR-01: proteção das gravações no storage contra execuções obsoletas. Derivados por tentativa efetiva; só a tentativa vigente publica `ready` (ou `error`) no `UPDATE` condicional; T-11 ampliado; derivados abandonados na limpeza.
- **AMB-4** _(resolved_by phase-03-videos/TD-02)_ — OR-02: vínculo objeto × sessão ao recuperar conclusão parcial. Chave do original exclusiva por sessão, registrada no banco com verificação da sessão válida; T-01/T-04 e V-10 ampliados.
- **AMB-5** _(resolved_by phase-03-videos/TD-03)_ — OR-03: fallbacks de checksum e de limite têm garantias diferentes. Fallbacks não equivalentes: prova que falha reabre a TD, sem adoção automática de alternativa com garantias menores (TD-02 e TD-03).
- **AMB-6** _(resolved_by phase-03-videos/TD-12)_ — Processo e gatilho da varredura de sessões e da reconciliação. Job Schedulers com ids estáveis no `video-worker`, em fila própria; operações tolerantes a repetição com guardas no banco; V-11 ampliada.
- **DG-1** _(resolved_by phase-03-videos/TD-10)_ — D-07: imagem Node 25 em fim de vida × FFmpeg do worker e V-04. Imagem atual mantida; versões validadas registradas e reverificação na troca; atualização do Node segue como tarefa separada.
- **OQ-1** _(resolved_by phase-03-videos/TD-01)_ — phase-03-videos/TD-01 pending — Protocolo de upload direto e retomável. TD decidida; a situação (aprovada ou condicionada) está na revisão da TD e na seção "Situação das decisões e provas".
- **OQ-2** _(resolved_by phase-03-videos/TD-02)_ — phase-03-videos/TD-02 pending — Ciclo de vida da sessão de upload. TD decidida; a situação (aprovada ou condicionada) está na revisão da TD e na seção "Situação das decisões e provas".
- **OQ-3** _(resolved_by phase-03-videos/TD-03)_ — phase-03-videos/TD-03 pending — Política e aplicação do limite de 10GB. TD decidida; a situação (aprovada ou condicionada) está na revisão da TD e na seção "Situação das decisões e provas".
- **OQ-4** _(resolved_by phase-03-videos/TD-04)_ — phase-03-videos/TD-04 pending — Modelo de estados do vídeo e transições. TD decidida; a situação (aprovada ou condicionada) está na revisão da TD e na seção "Situação das decisões e provas".
- **OQ-5** _(resolved_by phase-03-videos/TD-05)_ — phase-03-videos/TD-05 pending — Identificador público e URL única. TD decidida; a situação (aprovada ou condicionada) está na revisão da TD e na seção "Situação das decisões e provas".
- **OQ-6** _(resolved_by phase-03-videos/TD-06)_ — phase-03-videos/TD-06 pending — Organização dos objetos e acesso no bucket. TD decidida; a situação (aprovada ou condicionada) está na revisão da TD e na seção "Situação das decisões e provas".
- **OQ-7** _(resolved_by phase-03-videos/TD-07)_ — phase-03-videos/TD-07 pending — Topologia de endpoints do storage e env. TD decidida; a situação (aprovada ou condicionada) está na revisão da TD e na seção "Situação das decisões e provas".
- **OQ-8** _(resolved_by phase-03-videos/TD-08)_ — phase-03-videos/TD-08 pending — Distribuição do MinIO no Docker Compose. TD decidida; a situação (aprovada ou condicionada) está na revisão da TD e na seção "Situação das decisões e provas".
- **OQ-9** _(resolved_by phase-03-videos/TD-09)_ — phase-03-videos/TD-09 pending — Tecnologia de fila. TD decidida; a situação (aprovada ou condicionada) está na revisão da TD e na seção "Situação das decisões e provas".
- **OQ-10** _(resolved_by phase-03-videos/TD-10)_ — phase-03-videos/TD-10 pending — Execução e empacotamento do worker. TD decidida; a situação (aprovada ou condicionada) está na revisão da TD e na seção "Situação das decisões e provas".
- **OQ-11** _(resolved_by phase-03-videos/TD-11)_ — phase-03-videos/TD-11 pending — Acesso do worker à mídia. TD decidida; a situação (aprovada ou condicionada) está na revisão da TD e na seção "Situação das decisões e provas".
- **OQ-12** _(resolved_by phase-03-videos/TD-12)_ — phase-03-videos/TD-12 pending — Consistência estado × fila e idempotência. TD decidida; a situação (aprovada ou condicionada) está na revisão da TD e na seção "Situação das decisões e provas".
- **OQ-13** _(resolved_by phase-03-videos/TD-13)_ — phase-03-videos/TD-13 pending — Formato de entrega para reprodução. TD decidida; a situação (aprovada ou condicionada) está na revisão da TD e na seção "Situação das decisões e provas".
- **OQ-14** _(resolved_by phase-03-videos/TD-14)_ — phase-03-videos/TD-14 pending — Caminho de acesso para streaming e download. TD decidida; a situação (aprovada ou condicionada) está na revisão da TD e na seção "Situação das decisões e provas".
- **OQ-15** _(resolved_by phase-03-videos/TD-15)_ — phase-03-videos/TD-15 pending — Estratégia de prova com infraestrutura real. TD decidida; a situação (aprovada ou condicionada) está na revisão da TD e na seção "Situação das decisões e provas".
- **OQ-16** _(resolved_by phase-03-videos/TD-03)_ — Q-01 aberta — 10 GB ou 10 GiB (provisório 10 GB, não aprovado). Q-01: 10 GB decimais (`10000000000` bytes).
- **OQ-17** _(resolved_by phase-03-videos/TD-14)_ — Q-02 aberta — quem reproduz e baixa um vídeo ready; 404 ou 403. Q-02: só o dono reproduz e baixa; não-dono recebe 404.
- **OQ-18** _(resolved_by phase-03-videos/TD-11)_ — Q-03 aberta — formatos aceitos no upload (MOV depende de V-04). Q-03: MP4 e WebM com validação real de mídia e codecs; MOV fora (também TD-13).
- **OQ-19** _(resolved_by phase-03-videos/TD-02)_ — Q-04 aberta — destino do rascunho cuja sessão expirou. Q-04: rascunho reiniciável após a expiração (também TD-04).
- **OQ-20** _(resolved_by phase-03-videos/TD-12)_ — Q-05 aberta — reprocessar a partir de error entra na Fase 03?. Q-05: sem reprocessamento manual; retentativas automáticas (também TD-04).
- **OQ-21** _(resolved_by phase-03-videos/TD-08)_ — Q-06 aberta — aceitar o fork pgsty/silo após V-01, V-03 e V-09?. Q-06: Silo candidato condicionado; compatibilidade não aprovada.
- **OQ-22** _(resolved_by phase-03-videos/TD-10)_ — Q-07 aberta — video-worker sobe com o Compose apesar da regra (D-11)?. Q-07: worker sobe pelo Compose; exceção documentada.
- **OQ-23** _(resolved_by phase-03-videos/TD-02)_ — Q-08 aberta — retomada de 24h com expiração do storage em 48h. Q-08: 24h e 48h, condicionadas à V-01.
- **OQ-24** _(resolved_by phase-03-videos/TD-04)_ — Q-09 aberta — polling basta para acompanhar o estado?. Q-09: polling suficiente.
- **OQ-25** _(resolved_by phase-03-videos/TD-02)_ — Q-10 aberta — conferir todas as partes ao retomar ou uma amostra?. Q-10: todas as partes conferidas na retomada, com memória limitada.
- **OQ-26** _(resolved_by phase-03-videos/TD-08)_ — V-01 não executada — Silo: MINIO_*, mc, CORS e expiração de multipart. V-01 não executada e não aprovada; registrada como passo bloqueante antes da implementação dependente (falha reabre a TD).
- **OQ-27** _(resolved_by phase-03-videos/TD-03)_ — V-02 não executada — storage recusa UploadPart fora do content-length. V-02 não executada e não aprovada; registrada como passo bloqueante antes da implementação dependente (falha reabre a TD).
- **OQ-28** _(resolved_by phase-03-videos/TD-07)_ — V-03 não executada — URLs do AWS SDK 3.1170 aceitas pelo Silo. V-03 não executada e não aprovada; registrada como passo bloqueante antes da implementação dependente (falha reabre a TD).
- **OQ-29** _(resolved_by phase-03-videos/TD-11)_ — V-04 não executada — ffprobe/ffmpeg 5.1 sobre URL assinada. V-04 não executada e não aprovada; registrada como passo bloqueante antes da implementação dependente (falha reabre a TD).
- **OQ-30** _(resolved_by phase-03-videos/TD-14)_ — V-05 não executada — reprodução e seek após redirect (Fase 05). V-05 adiada para a Fase 05 (verificação adiada); o aceite de streaming e download da Fase 03 segue a TD-14. Não executada.
- **OQ-31** _(resolved_by phase-03-videos/TD-09)_ — V-06 não executada — bullmq 6 + @nestjs/bullmq 11 + Redis 8 + Jest 30. V-06 não executada e não aprovada; registrada como passo bloqueante antes da implementação dependente (falha reabre a TD).
- **OQ-32** _(resolved_by phase-03-videos/TD-15)_ — V-07 não executada — tempo e disco das duas provas de arquivo grande. V-07 não executada; passo bloqueante só para agendar a prova grande. Não aprovada.
- **OQ-33** _(resolved_by phase-03-videos/TD-01)_ — V-08 não executada — Content-Length assinado em navegador real. V-08 não executada e não aprovada; registrada como passo bloqueante antes da implementação dependente (falha reabre a TD).
- **OQ-34** _(resolved_by phase-03-videos/TD-02)_ — V-09 não executada — checksum por parte assinado e verificado. V-09 não executada e não aprovada; registrada como passo bloqueante antes da implementação dependente (falha reabre a TD).
- **OQ-35** _(resolved_by phase-03-videos/TD-02)_ — V-10 não executada — retentativa do Complete no servidor escolhido. V-10 não executada e não aprovada; registrada como passo bloqueante antes da implementação dependente (falha reabre a TD).
- **OQ-36** _(resolved_by phase-03-videos/TD-12)_ — V-11 não executada — padrões e comportamentos do BullMQ 6.7.7. V-11 não executada e não aprovada; registrada como passo bloqueante antes da implementação dependente (falha reabre a TD).
- **IC-5** _(resolved_by phase-03-videos/TD-11)_ — TD-11: fallback para a B por formato × regra de reabrir a TD se V-04 falhar. Alternativa (a): revisão de 2026-11-17 na TD-11 substitui a autorização de fallback automático para a Option B; leitura por URL pré-assinada interna com HTTP Range, condicionada à V-04; se a V-04 falhar para os formatos aceitos, a TD-11 é reaberta; o download completo para disco temporário não está previamente autorizado. Recommendation original preservada como histórico, subordinada à revisão. V-04 continua não executada.

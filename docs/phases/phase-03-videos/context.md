---
kind: phase
name: phase-03-videos
sources_mtime:
  docs/project-plan.md: "2026-11-13T16:18:07-03:00"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-11-20T23:41:45-03:00"
  docs/decisions/technical-decisions-openapi-docs-nestjs.md: "2026-11-13T16:18:07-03:00"
  docs/decisions/technical-decisions-next-frontend-openapi-typing.md: "2026-11-13T16:18:07-03:00"
  docs/decisions/technical-decisions-next-frontend-config-base.md: "2026-11-13T16:18:07-03:00"
  docs/decisions/technical-decisions-phase-02-auth.md: "2026-11-17T17:20:01-03:00"
  docs/phases/phase-01-configuracao-base/context.md: "2026-11-13T16:18:07-03:00"
  docs/phases/phase-02-auth/context.md: "2026-11-13T16:18:07-03:00"
  docs/phases/phase-02-auth-frontend/context.md: "2026-11-13T16:18:07-03:00"
  .claude/skills/testing-guide-nestjs-project/SKILL.md: "2026-11-13T16:18:07-03:00"
---

# phase-03-videos — Context

## Scope

**Phase name:** Fase 03 — Upload e Processamento de Vídeos

**Capabilities** (literal, `docs/project-plan.md`):

- Serviço de armazenamento de arquivos (vídeos e thumbnails)
- Serviço de processamento em segundo plano (filas)
- Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance
- Pré-cadastro automático do vídeo como rascunho ao iniciar o upload
- Processamento automático do vídeo após upload (extração de duração e metadados)
- Geração automática de thumbnail a partir de um frame do vídeo
- URL única por vídeo, sem conflito com outros vídeos
- Reprodução via streaming (sem necessidade de download completo)
- Download do vídeo pelo usuário

**Out of scope:** implementação de frontend — telas, componentes, player e rotas BFF de vídeo. A regeneração de `next-frontend/openapi.json` e de `types.gen.ts` pelo script de sincronização do contrato é permitida como manutenção do contrato, sem funcionalidades de frontend. _(Delimitação aplicada pelo `/plan-resolve` em 2026-11-17 (IC-1, IC-4) a partir da instrução de escopo e registrada no documento de decisões; o `docs/project-plan.md` não declara exclusões para a Fase 03.)_

**Deliverables:** upload de até 10GB funcional, processamento automático do vídeo, streaming funcionando, URLs únicas geradas.

**Affected subprojects:**

_(O `project-plan.md` não traz nota de subprojeto para esta fase. As entradas abaixo vêm do escopo declarado pelo usuário ao invocar `/plan-context`.)_

- `nestjs-project` — backend em escopo.
- Video Worker (FFmpeg) — em escopo. Na geração deste contexto, a localização dependia da `phase-03-videos/TD-10`, então pendente. Desde 2026-11-17 ela está decidida (Option A, condicionada a V-04 e V-11): o worker é código do `nestjs-project`, com entrypoint próprio e serviço `video-worker` no Compose, sem subprojeto separado.
- Infraestrutura (Docker Compose) — em escopo.
- `docs/` — documentação em escopo.

**Deferred subprojects:** `next-frontend` — a implementação fica fora desta fase; seus contratos são apenas insumos para fases futuras.

**Sequencing notes:** Depende de: Fase 01, Fase 02.

**Neighbors (for boundary detection only):**

- **Phase 02:** Fluxo completo de criação de conta, confirmação por e-mail, login, logout e recuperação de senha.
- **Phase 04:** Edição das informações do vídeo, fluxo de rascunho e publicação, painel de administração do canal e página pública. (Depende de: Fase 02, Fase 03)

## Decisions Index

| Ref | Source | Scope | Topic | Status | Decision | Libraries | Renders in |
|-----|--------|-------|-------|--------|----------|-----------|------------|
| phase-03-videos/TD-01 | phase | Cross-layer | Protocolo de upload direto e retomável | decided | A — cond. V-08 | @aws-sdk/client-s3@^3.1170.0, @aws-sdk/s3-request-presigner@^3.1170.0 | — |
|     └─ Last revision: 2026-11-17 — Situação: decisão condicionada à prova V-08 (PUT de `Blob` em navegador real… | | | | | | | |
| phase-03-videos/TD-02 | phase | Cross-layer | Ciclo de vida da sessão de upload — início, retomada, … | decided | A — cond. V-01, V-09, V-10 | @aws-sdk/client-s3@^3.1170.0, @aws-sdk/s3-request-presigner@^3.1170.0 | — |
|     └─ Last revision: 2026-11-18 — Provas da SI-03.4 no Silo fixado (V-02, V-09 na parte de servidor e V-10, aprovadas)… | | | | | | | |
| phase-03-videos/TD-03 | phase | Cross-layer | Política e aplicação do limite de 10GB (unidade, plano de… | decided | A — cond. V-02, V-08 | @aws-sdk/s3-request-presigner@^3.1170.0 | — |
|     └─ Last revision: 2026-11-17 — Situação: decisão condicionada às provas V-02 (o storage recusa, antes de… | | | | | | | |
| phase-03-videos/TD-04 | phase | Cross-layer | Modelo de estados do vídeo e transições | decided | A | — | — |
|     └─ Last revision: 2026-11-17 — Situação: decisão arquitetural aprovada, sem prova pendente. Rascunho com… | | | | | | | |
| phase-03-videos/TD-05 | phase | Cross-layer | Identificador público e URL única do vídeo | decided | A | — | — |
|     └─ Last revision: 2026-11-17 — Situação: decisão arquitetural aprovada, sem prova pendente | | | | | | | |
| phase-03-videos/TD-06 | phase | Backend | Organização dos objetos e controle de acesso no bucket | decided | A | — | — |
|     └─ Last revision: 2026-11-17 — Exclusão segura (Phase A do plano, protocolo P4). Um objeto só é excluído quando… | | | | | | | |
| phase-03-videos/TD-07 | phase | Repo-wide | Topologia de endpoints do storage e contrato de variáveis… | decided | A — cond. V-01, V-03, V-09 | @aws-sdk/client-s3@^3.1170.0, @aws-sdk/s3-request-presigner@^3.1170.0 | — |
|     └─ Last revision: 2026-11-17 — Situação: decisão condicionada às provas V-01 (variáveis `MINIO_*`, CORS com… | | | | | | | |
| phase-03-videos/TD-08 | phase | Repo-wide | Distribuição do MinIO no Docker Compose | decided | A (`pgsty/silo`) — cond. V-01, V-03, V-09 | — | — |
|     └─ Last revision: 2026-11-17 — Situação: decisão condicionada. O Silo é o candidato, fixado por tag e digest… | | | | | | | |
| phase-03-videos/TD-09 | phase | Backend | Tecnologia de fila | decided | A (BullMQ + Redis) — cond. V-06, V-11 | bullmq@^6.7.7, @nestjs/bullmq@^11.0.5, ioredis@5.11.1 | — |
|     └─ Last revision: 2026-11-20 — Situação: provas V-06 e V-11 executadas e aprovadas na revisão da SI-03.7; a TD-09… | | | | | | | |
| phase-03-videos/TD-10 | phase | Backend | Execução e empacotamento do worker (incluindo o FFmpeg) | decided | A — cond. V-04, V-11 | — | — |
|     └─ Last revision: 2026-11-20 — Situação: provas V-04 (SI-03.6) e V-11 (SI-03.7) executadas e aprovadas; a TD-10 não… | | | | | | | |
| phase-03-videos/TD-11 | phase | Backend | Acesso do worker à mídia durante o processamento | decided | A — cond. V-04 | @aws-sdk/s3-request-presigner@^3.1170.0 | — |
|     └─ Last revision: 2026-11-17 — A leitura da mídia permanece pela URL pré-assinada interna com HTTP Range… | | | | | | | |
| phase-03-videos/TD-12 | phase | Backend | Consistência entre estado e fila, retentativas e idempotênc… | decided | A — cond. V-11 | bullmq@^6.7.7, @nestjs/bullmq@^11.0.5 | — |
|     └─ Last revision: 2026-11-20 — Situação: prova V-11 executada e aprovada na revisão da SI-03.7; a TD-12 não tem… | | | | | | | |
| phase-03-videos/TD-13 | phase | Cross-layer | Formato de entrega para reprodução | decided | A — cond. V-04 | — | — |
|     └─ Last revision: 2026-11-17 — Situação: decisão condicionada à prova V-04 (ffprobe/ffmpeg 5.1 com MP4 de… | | | | | | | |
| phase-03-videos/TD-14 | phase | Cross-layer | Caminho de acesso para streaming e download | decided | A | @aws-sdk/s3-request-presigner@^3.1170.0 | — |
|     └─ Last revision: 2026-11-17 — Aceite da Fase 03 para streaming e download: testes contra o storage real… | | | | | | | |
| phase-03-videos/TD-15 | phase | Backend | Estratégia de prova com infraestrutura real, incluindo o… | decided | A | — | — |
|     └─ Last revision: 2026-11-17 — Situação: decisão arquitetural aprovada; nenhum teste nem prova foi executado… | | | | | | | |

_Source files:_

- phase-03-videos — `docs/decisions/technical-decisions-phase-03-videos.md` (scope_type: phase)

## Capability Coverage

| Capability (from project-plan.md) | Covered by |
|-----------------------------------|------------|
| Serviço de armazenamento de arquivos (vídeos e thumbnails) | phase-03-videos/TD-06, phase-03-videos/TD-07, phase-03-videos/TD-08, phase-03-videos/TD-15 |
| Serviço de processamento em segundo plano (filas) | phase-03-videos/TD-09, phase-03-videos/TD-10, phase-03-videos/TD-12, phase-03-videos/TD-15 |
| Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance | phase-03-videos/TD-01, phase-03-videos/TD-02, phase-03-videos/TD-03, phase-03-videos/TD-07, phase-03-videos/TD-15 |
| Pré-cadastro automático do vídeo como rascunho ao iniciar o upload | phase-03-videos/TD-02, phase-03-videos/TD-04 |
| Processamento automático do vídeo após upload (extração de duração e metadados) | phase-03-videos/TD-04, phase-03-videos/TD-10, phase-03-videos/TD-11, phase-03-videos/TD-12, phase-03-videos/TD-15 |
| Geração automática de thumbnail a partir de um frame do vídeo | phase-03-videos/TD-04, phase-03-videos/TD-10, phase-03-videos/TD-11, phase-03-videos/TD-12, phase-03-videos/TD-15 |
| URL única por vídeo, sem conflito com outros vídeos | phase-03-videos/TD-05 |
| Reprodução via streaming (sem necessidade de download completo) | phase-03-videos/TD-07, phase-03-videos/TD-13, phase-03-videos/TD-14, phase-03-videos/TD-15 |
| Download do vídeo pelo usuário | phase-03-videos/TD-07, phase-03-videos/TD-14, phase-03-videos/TD-15 |

_Cobertura montada a partir do campo `Capability:` de cada TD (TDs `Transversal — covers: …` aparecem em todas as capacidades que cobrem). As TDs listadas foram decididas pelo `/plan-resolve` em 2026-11-17; a situação de cada uma (aprovada ou condicionada a prova) está em `## Decisions Detail`._

## Decisions Detail

### phase-03-videos/TD-01

**Recommendation:** É a única em que nenhum processo nosso transporta os bytes. A URL pré-assinada por parte resolve o conflito com o BFF estrito sem criar um segundo serviço público autenticado. O custo é a orquestração na API, que é lógica de controle leve e testável contra MinIO real. A B é a alternativa válida se a equipe preferir um protocolo de retomada padronizado em troca de mais um serviço e de um token de upload.
**Libraries:** @aws-sdk/client-s3@^3.1170.0, @aws-sdk/s3-request-presigner@^3.1170.0

**Revisions:**
- 2026-11-17 — Situação: decisão condicionada à prova V-08 (PUT de `Blob` em navegador real com `content-length` assinado, exposição do `ETag` e preflight do CORS com o header de checksum), ainda não executada. A V-08 é passo bloqueante antes da implementação do envio de partes; se falhar, esta TD é reaberta, sem adoção automática de alternativa com garantias menores. Rationale: /plan-resolve (OQ-1, OQ-33); a V-08 é prova técnica de infraestrutura, não implementação de frontend.

### phase-03-videos/TD-02

**Recommendation:** Ela segue a orientação oficial da AWS e concentra o pré-cadastro, a validação do limite e a transição de estado num único ponto síncrono da API. Como usa só a S3 API, também protege contra a incerteza da TD-08. Para funcionar, precisa de três complementos, cujos mecanismos finais ficam para o planejamento.

1. **Verificação do conteúdo na retomada.** É uma necessidade do contrato; o cliente que a executa será implementado numa fase futura.
   - **Estratégia recomendada:** checksum por parte.
   - **Memória limitada:** o cliente lê uma parte por vez, com `File.slice` e leitura só da fatia ou com hash incremental sobre o stream da fatia. Calcula o SHA-256 e descarta o buffer, de modo que a memória fica limitada a uma parte (64 MiB) ou a um bloco do hash incremental, nunca ao arquivo inteiro.
   - **Custo da retomada:** recalcular as partes já confirmadas relê localmente até 10 GB, sem rede. O tempo precisa ser medido (V-09), e o cálculo deve rodar fora da thread de interface.
   - **Pré-checagem:** nome, tamanho e `lastModified` servem só para recusar cedo um arquivo obviamente diferente.
   - **Amostragem:** conferir só algumas partes é mais rápido, mas deixa passar um arquivo alterado no meio (Q-10).
   - **Algoritmo:** o SHA-256 é provisório. Ele existe nativamente no navegador (Web Crypto) e está entre os checksums aceitos pela S3.
   - **Se o servidor não aceitar checksum assinado na URL (V-09):** o cliente declara o checksum à API sem que o storage o verifique. A conferência de arquivo trocado continua funcionando, mas se perde a prova de que os bytes gravados correspondem ao declarado. Usar o ETag da parte como MD5 do conteúdo só vale em alguns servidores e configurações, e a AWS não o garante ("The entity tag may or may not be an MD5 digest").
2. **Estados da sessão e exclusão mútua.** A sessão tem estado próprio: `active`, `completing`, `completed`, `aborting` e `aborted`.
   - **Exclusão mútua:** conclusão, reinício e limpeza só começam com uma transição condicional a partir de `active` (compare-and-set no banco), então no máximo uma delas vence em cada sessão.
   - **Sem transação aberta:** nenhuma chamada ao storage acontece dentro de uma transação do banco, porque o Complete pode demorar.
   - **Prazo dos estados intermediários:** se o processo morrer durante `completing` ou `aborting`, a sessão é retomada depois do prazo, pela próxima chamada do cliente ou pela varredura, e essa retomada é idempotente.
   - **`NoSuchUpload` numa conclusão retentada:** é desambiguado com `HeadObject` na chave do vídeo.
     - Objeto presente com o tamanho declarado significa que o upload foi concluído; a exclusão mútua garante que nenhuma outra sessão escreveu nessa chave.
     - Objeto ausente significa que o upload foi abortado ou expirou.
3. **Prazos com folga.** O `UPLOAD_SESSION_TTL` precisa ser **estritamente menor** que o `MINIO_API_STALE_UPLOADS_EXPIRY`, com folga maior que a duração de uma conclusão.
   - Assim a varredura da aplicação aborta antes da limpeza do storage, que não é coordenada com ela (F-10).
   - Proposta: sessão de 24h e limpeza do storage em 48h, deixando o storage só como rede de segurança (Q-08).
   - A forma de contar a idade do upload no fork ainda precisa ser confirmada (V-01).

As garantias G-01 a G-04, G-10 e G-11 e os testes correspondentes estão em "Cenários de falha, concorrência e repetição".

**Libraries:** @aws-sdk/client-s3@^3.1170.0, @aws-sdk/s3-request-presigner@^3.1170.0

**Revisions:**
- 2026-11-17 — Situação: decisão condicionada às provas V-01 (configuração e expiração de multipart no storage), V-09 (checksum por parte assinado e verificado pelo storage) e V-10 (retentativa da conclusão), nenhuma executada. São passos bloqueantes antes da implementação do ciclo da sessão. Se alguma falhar, esta TD é reaberta, sem fallback automático: um checksum apenas declarado à API não equivale ao verificado pelo storage. Rationale: /plan-resolve (OQ-2, OQ-26, OQ-34, OQ-35, AMB-5).
- 2026-11-17 — Chave do original exclusiva por sessão, por exemplo `originals/{videoId}/{sessionId}`, com identificadores gerados pelo servidor e nunca reutilizada entre sessões. O banco registra a chave do original confirmado, e a atualização verifica, no mesmo `UPDATE` condicional, que a sessão ainda é a sessão válida do vídeo. A recuperação de uma conclusão parcial (F-01) só confirma o objeto da chave da própria sessão, e a conclusão atrasada de outra sessão não promove o próprio objeto nem substitui o original confirmado. T-01 e T-04 cobrem esses dois casos, e a V-10 passa a verificá-los no storage escolhido. Esta revisão substitui, na Recommendation, a desambiguação de `NoSuchUpload` por `HeadObject` "na chave do vídeo" com aceitação pelo tamanho declarado. Rationale: AMB-4 (OR-02) — o tamanho não prova que o objeto pertence à sessão.
- 2026-11-17 — Limpeza periódica de objetos abandonados (multipart não concluído e originais de sessões não confirmadas), com carência e sem excluir originais referenciados pelo banco nem objetos de sessões ainda válidas. A execução segue a TD-12 (Job Schedulers no `video-worker`). Rationale: consequência da chave por sessão (AMB-4) e da G-10.
- 2026-11-17 — Retomada: `UPLOAD_SESSION_TTL` de 24h e `MINIO_API_STALE_UPLOADS_EXPIRY` de 48h, condicionados à confirmação, na V-01, de como o servidor conta a idade de um multipart incompleto. Na retomada, todas as partes já recebidas são conferidas por checksum, lendo uma parte por vez (memória limitada). Rascunho cuja sessão expirou continua `draft` e pode reiniciar o upload. Rationale: Q-08, Q-10 e Q-04.
- 2026-11-17 — Throttling: o throttler global herdado é preservado (ver a Revision de 2026-11-17 em `phase-02-auth/TD-08`). As rotas da Fase 03 (sessão de upload, assinatura em lote de partes, registro de ETags, conclusão, consulta de estado por polling e emissão de URLs) declaram limites explícitos, dimensionados para a assinatura em lote e para o intervalo de polling, sem desativar a proteção de forma indiscriminada. Rationale: IC-2 (D-05).
- 2026-11-17 — Coordenação de sessão e contratos (Phase A do plano, protocolos P1 e P2). A linha do vídeo serializa criação, reinício, claim, finalização e abort, em transações curtas sem chamadas ao storage. A sessão nasce em `initiating`, com chave e `claim_token` gravados antes do `CreateMultipartUpload`, e só vira `active` por ativação condicionada ao token; o índice parcial de `active` é só defesa adicional. Falha do storage em `POST /videos` é compensada com a remoção do vídeo e da sessão; um multipart sem registro é abortado pela varredura ou pela limpeza depois de assumirem a posse por token. Em reinícios simultâneos, um vence e o outro recebe 409 `UPLOAD_SESSION_INITIATING`; reinício e conclusão concorrentes se resolvem pelo claim sob o bloqueio do vídeo. A conclusão usa claim com token. Quando uma transição afeta zero linhas, ela relê o estado e responde 200 só se a sessão está `completed` e vigente; nos demais casos responde 409 `UPLOAD_SESSION_COMPLETING`, 409 `UPLOAD_COMPLETION_INTERRUPTED`, 409 `UPLOAD_SESSION_NOT_ACTIVE` ou 410 `UPLOAD_SESSION_EXPIRED`. Contratos: `part-urls` devolve `expectedSize` separado de `headers`, que contém só `x-amz-checksum-sha256`; o `content-length` continua assinado e é definido pelo navegador, e V-02 e V-08 continuam bloqueantes. O tamanho da parte é `min(part_size, size_bytes - (part_number - 1) * part_size)`. A conferência aceita lista vazia quando nenhuma parte foi recebida, e reassinar uma parte com outro checksum bloqueia a sessão. O DTO valida só a forma (400); o teto (413) e o tipo (415) são regras de domínio. Esta revisão fixa a proposta de estados da sessão desta TD, cujos nomes ficaram para o planejamento. Rationale: revisão da Phase A do plano (`phase-03-videos.md`), autorizada pelo usuário.
- 2026-11-18 — Provas da SI-03.4 no Silo fixado (V-02, V-09 na parte de servidor e V-10, aprovadas). (a) O corpo divergente de um `UploadPart` com `x-amz-checksum-sha256` assinado é recusado com HTTP 400 `XAmzContentChecksumMismatch` (a AWS usa `BadDigest`), depois de o corpo ser recebido e sem registrar a parte; esse é o código aceito para o Silo fixado, e nenhum outro 4xx equivale a ele. (b) O Complete sem os checksums das partes ou com um checksum errado é recusado, e os dois casos continuam obrigatórios. (c) O Complete da P2 não leva `If-None-Match: *` nem `x-amz-mp-object-size` nesta fase: o Silo ignora o `x-amz-mp-object-size`, e com `If-None-Match` a repetição do Complete responderia 412 em vez de `NoSuchUpload`, sem ganho com chaves exclusivas por sessão; a recuperação continua por `NoSuchUpload` e `HeadObject` na chave da sessão. A V-09 completa continua pendente da parte de navegador (SI-03.5), e a decisão segue condicionada a ela. Rationale: revisão da SI-03.4 (`proofs/V-09.md`, `proofs/V-10.md`).

### phase-03-videos/TD-03

**Recommendation:** **Option A, com fallback para a B** se V-02 ou V-08 mostrarem que o storage ou o navegador não respeitam o `content-length` assinado.

Recomendação **provisória** do limite, com a unidade ainda pendente (Q-01):
- **Limite:** 10 GB decimais, em bytes: `VIDEO_MAX_SIZE_BYTES=10000000000`. É a leitura literal de "GB" no SI.
- **Consequência da unidade:** um arquivo que o Windows exibe como "10 GB" tem, na verdade, 10 GiB (10.737.418.240 bytes) e fica acima do limite. Por isso, a mensagem de erro deve informar o limite em bytes.
- **Tamanho de parte:** `UPLOAD_PART_SIZE_BYTES=67108864` (64 MiB).
  - Resulta em 150 partes, bem abaixo do teto de 10.000.
  - Limita a retransmissão a 64 MiB por falha.
  - Mantém o uso de memória do cálculo de checksum (TD-02) em uma parte.
- **Exemplos para os testes de limite:** 10.000.000.000 bytes são aceitos e 10.000.000.001 são rejeitados.
- **Se a revisão escolher GiB:** basta trocar a variável para `10737418240`, o que dá 160 partes, e atualizar esses exemplos.

**Libraries:** @aws-sdk/s3-request-presigner@^3.1170.0

**Revisions:**
- 2026-11-17 — Limite em unidades decimais: `VIDEO_MAX_SIZE_BYTES=10000000000` (10 GB), com `UPLOAD_PART_SIZE_BYTES=67108864` (150 partes; a última com 779.264 bytes). Testes de limite: 10.000.000.000 bytes aceito e 10.000.000.001 recusado; a mensagem de erro informa o limite em bytes. Rationale: Q-01.
- 2026-11-17 — Situação: decisão condicionada às provas V-02 (o storage recusa, antes de gravar, um `UploadPart` com corpo maior ou menor que o assinado) e V-08 (o navegador real envia exatamente o tamanho assinado), nenhuma executada. São passos bloqueantes antes da implementação do envio de partes. Se falharem, esta TD é reaberta; a Option B não é adotada automaticamente (isso substitui o "com fallback para a B" da Recommendation), porque rejeitar o excesso só na conclusão permite gravar até 750 GiB por sessão. Rationale: /plan-resolve (OQ-3, OQ-27, OQ-33, AMB-5).

### phase-03-videos/TD-04

**Recommendation:** Atende literalmente ao requisito e deixa a publicação como eixo independente. A granularidade da B já é coberta pelos dados da sessão de upload e da fila. Transições propostas:
- criação → `draft`;
- `draft` → `processing`, quando a conclusão é validada;
- `processing` → `ready`, com metadados e thumbnail prontos;
- `processing` → `error`, por falha permanente ou tentativas esgotadas;
- retentativas e reentregas em `processing` podem refazer o trabalho, mas só uma transição terminal é aceita por execução (TD-12);
- jobs de vídeos já em `ready` ou `error` terminam sem efeito.

A tabela completa está em "Consequências".

**Libraries:** —

**Revisions:**
- 2026-11-17 — Situação: decisão arquitetural aprovada, sem prova pendente. Rascunho com sessão expirada continua `draft` e reiniciável; não há reprocessamento manual a partir de `error` na Fase 03, só as retentativas automáticas; o acompanhamento do estado é por polling. Rationale: Q-04, Q-05 e Q-09.

### phase-03-videos/TD-05

**Recommendation:** Dá uma URL curta e não enumerável com `node:crypto` nativo, reaproveita o padrão de retentativa existente e separa a identidade pública da PK e das chaves de storage (que usam o UUID interno, conforme a TD-06).
**Libraries:** —

**Revisions:**
- 2026-11-17 — Situação: decisão arquitetural aprovada, sem prova pendente. Rationale: /plan-resolve (OQ-5).

### phase-03-videos/TD-06

**Recommendation:** Privado por padrão, reversível para thumbnails públicas quando houver listagem, e coerente com a autorização por estado do vídeo (TD-04 e TD-14). O cliente S3 recomendado é o AWS SDK v3 (`@aws-sdk/client-s3` e `@aws-sdk/s3-request-presigner`, 3.1170.0, CommonJS), que tem comandos tipados para multipart e presign.
**Libraries:** —

**Revisions:**
- 2026-11-17 — Situação: decisão arquitetural aprovada; a compatibilidade do storage segue condicionada às provas da TD-07 e da TD-08. Rationale: /plan-resolve (OQ-6).
- 2026-11-17 — Chaves: o original fica numa chave exclusiva por sessão (por exemplo `originals/{videoId}/{sessionId}`, identificadores gerados pelo servidor, sem reuso entre sessões; ver TD-02). Os derivados ficam numa chave exclusiva por tentativa efetiva do worker (por exemplo `thumbnails/{videoId}/{attemptId}.jpg`; ver TD-12). O banco guarda a chave do original confirmado e a da thumbnail publicada. Bucket privado, prefixos por tipo de artefato, endpoints interno e público separados (TD-07). Rationale: AMB-4 (OR-02) e AMB-3 (OR-01).
- 2026-11-17 — Limpeza periódica de objetos abandonados (originais de sessões não confirmadas, multiparts incompletos e derivados de tentativas obsoletas), com carência e critérios de elegibilidade configuráveis. Nunca exclui objetos referenciados pelo banco nem objetos de sessões ou tentativas ainda válidas. Rationale: consequência das chaves por sessão e por tentativa.
- 2026-11-17 — Exclusão segura (Phase A do plano, protocolo P4). Um objeto só é excluído quando um fato do banco que nunca regride prova que nenhuma transição futura pode referenciá-lo: sessão `aborted`, chave sem registro depois da compensação, vídeo terminal, ou tentativa que perdeu a vigência para um token maior ou foi revogada por uma recuperação. Carência e releitura são só margem adicional. Os uploads de sessões `initiating` ou `aborting` com claim vencido só são abortados depois que a limpeza assume a posse por token. O `current_attempt_id` residual de um vídeo em `error` não protege nenhum objeto. Rationale: revisão da Phase A do plano, autorizada pelo usuário.

### phase-03-videos/TD-07

**Recommendation:** O conjunto canônico de chaves a fixar no planejamento:
- **Storage:** `S3_ENDPOINT`, `S3_PUBLIC_ENDPOINT`, `S3_REGION`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_BUCKET`, `S3_FORCE_PATH_STYLE`.
- **Fila:** as chaves definidas pela TD-09.
- **Limites e prazos:** `VIDEO_MAX_SIZE_BYTES`, `UPLOAD_PART_SIZE_BYTES`, os TTLs das URLs de upload, reprodução e download, e `UPLOAD_SESSION_TTL`.
- **Container do storage:** `MINIO_API_CORS_ALLOW_ORIGIN` (origem do frontend) e `MINIO_API_STALE_UPLOADS_EXPIRY`.

O cliente S3 deve usar `requestChecksumCalculation` e `responseChecksumValidation` com o valor `'WHEN_REQUIRED'`. Assim as URLs pré-assinadas não recebem os checksums CRC32 e o `x-amz-checksum-mode` que o SDK adiciona por padrão. Isso não impede o checksum SHA-256 explícito por parte da TD-02, que precisa ir como header assinado e liberado no CORS; a combinação das duas configurações é validada em V-09.

**Libraries:** @aws-sdk/client-s3@^3.1170.0, @aws-sdk/s3-request-presigner@^3.1170.0

**Revisions:**
- 2026-11-17 — Situação: decisão condicionada às provas V-01 (variáveis `MINIO_*`, CORS com `ETag` e expiração de multipart no servidor escolhido), V-03 (URLs do AWS SDK 3.1170 com `WHEN_REQUIRED` aceitas sem parâmetros de checksum automáticos) e V-09 (header de checksum assinado e permitido pelo CORS), nenhuma executada. São passos bloqueantes antes da integração com o storage; se falharem, esta TD é reaberta. Os endpoints interno e público são configurados por variáveis de ambiente. Rationale: /plan-resolve (OQ-7, OQ-26, OQ-28, OQ-34).

### phase-03-videos/TD-08

**Recommendation:** **Option A, como alternativa pendente e condicionada.** O Silo é um fork de terceiros, e nada nesta pesquisa comprova a sua compatibilidade.
- **Antes de decidir:** V-01, V-03 e V-09 precisam passar contra a imagem fixada por digest.
- **Se passarem:** a A preserva a decisão herdada com uma imagem mantida e sem custo de build.
- **Se falharem:**
  - a B mantém o código oficial do MinIO, sem correções novas, como solução temporária;
  - a C exige reabrir explicitamente a decisão herdada.

Como a aplicação usa só a S3 API via AWS SDK, trocar de servidor muda apenas configuração e infraestrutura, não o código.

**Libraries:** —

**Revisions:**
- 2026-11-17 — Situação: decisão condicionada. O Silo é o candidato, fixado por tag e digest, mas sua compatibilidade não está aprovada: V-01, V-03 e V-09 não foram executadas e são passos bloqueantes antes de qualquer implementação que dependa do storage. Se falharem, esta TD é reaberta entre a Option B (MinIO construído do código-fonte arquivado) e a Option C, sem adoção automática. Rationale: Q-06 (OQ-8, OQ-21).

### phase-03-videos/TD-09

**Recommendation:** É a combinação mais madura e alinhada às skills do projeto, e migrar para a B no futuro é só trocar o `backendFactory`. Se a equipe preferir não ter um serviço novo e aceitar ajustar Jest e ESM, a C é a alternativa com maior garantia transacional.
**Libraries:** bullmq@^6.7.7, @nestjs/bullmq@^11.0.5, ioredis@5.11.1

**Revisions:**
- 2026-11-17 — Situação: decisão condicionada às provas V-06 (`bullmq` 6 + `@nestjs/bullmq` 11.0.5 + Redis 8 com Jest 30.3 em CommonJS) e V-11 (padrões e comportamentos do BullMQ 6.7.7), nenhuma executada. São passos bloqueantes antes da implementação da fila; se falharem, esta TD é reaberta. Adiciona um serviço Redis, com imagem fixada por versão, ao Compose. Rationale: /plan-resolve (OQ-9, OQ-31, OQ-36).
- 2026-11-18 — Cliente Redis do BullMQ: `ioredis` 5.11.1, com versão exata, como dependência de produção. Desde a 6.0.0, o `bullmq` não instala mais o `ioredis`, que virou peer dependency opcional (`>=5.0.0`); sem ele, uma `Queue` com `connection: { host, port }` não carrega. Escolhida a versão estável mais recente da linha 5.x; `bullmq` 6.7.7 e `@nestjs/bullmq` 11.0.5 mantidos. Uma verificação pontual no container (carga em CommonJS, conexão ao Redis real, um job processado e encerramento das conexões) passou, mas não substitui nem aprova a V-06 e a V-11, que passam a rodar com este cliente. Rationale: pendência da SI-03.2; escolha do usuário pelo `ioredis` na linha 5.x.
- 2026-11-20 — Situação: provas V-06 e V-11 executadas e aprovadas na revisão da SI-03.7; a TD-09 não tem mais prova pendente. V-06 (`20261119025647-d9e179`): `bullmq` 6.7.7, `@nestjs/bullmq` 11.0.5 e `ioredis` 5.11.1 carregam em CommonJS e processam um job por `BullModule.forRootAsync`, `registerQueue` e `WorkerHost` numa spec do Jest 30.3 contra o Redis 8.8.4 real, com o Jest saindo com código 0 e sem handles nem chaves restantes. V-11 (`20261119025715-a2e8f7`): 36 de 36 itens obrigatórios, com os comportamentos de que dependem a TD-10 e a TD-12 (ver as revisões da mesma data). Não cobertos pelas provas e sem condicionar esta TD, registrados como limitações na `V-11.md`: a queda abrupta do Redis, que persiste só por RDB (`appendonly no`), e indisponibilidades longas, em que a reconexão do BullMQ pode levar até cerca de 20 s. Rationale: revisão da SI-03.7 (`docs/phases/phase-03-videos/proofs/V-06.md` e `V-11.md`).

### phase-03-videos/TD-10

**Recommendation:** Atende ao diagrama e a R-02 sem duplicar o modelo de dados. O FFmpeg do sistema via `spawn` é o caminho com menos dependências, porque vem do pacote do Debian. O `ffmpeg-static` 5.3.0 fica como alternativa se a imagem não puder usar apt.

O planejamento precisa incluir, como requisitos:
- **Fim garantido do processamento (G-09):** um timeout por job que mata o processo do FFmpeg e devolve erro transitório, além de `-rw_timeout` na leitura HTTP.
- **Parada graciosa:**
  - `worker.close()` no SIGTERM;
  - um `stop_grace_period` coerente com o tempo esperado de um job;
  - encerramento dos processos filhos;
  - tratamento de sinais com o Node como PID 1 (ou `init: true` no Compose).
- **Configuração explícita:** `lockDuration`, `stalledInterval` e `maxStalledCount` definidos na configuração, com valores curtos nos testes.

Mesmo com tudo isso, um job pode ser reentregue ou rodar duas vezes ao mesmo tempo. A convergência do resultado é garantida pela TD-12, e não pelo worker.

**Libraries:** —

**Revisions:**
- 2026-11-17 — Situação: decisão condicionada às provas V-04 (ffprobe/ffmpeg 5.1 sobre URL assinada, timeouts e reconexões) e V-11 (lock, stall, reentrega e parada graciosa no BullMQ 6.7.7), nenhuma executada. São passos bloqueantes antes da implementação do processamento; se falharem, esta TD é reaberta. Rationale: /plan-resolve (OQ-10, OQ-29, OQ-36).
- 2026-11-17 — O `video-worker` sobe pelo `docker compose up`; a exceção à convenção "subir o ambiente é só infraestrutura" é documentada no CLAUDE.md como entregável da fase. Rationale: Q-07 (D-11).
- 2026-11-17 — Imagem: mantém-se a imagem atual (`node:25.6.0-slim`, Debian bookworm, FFmpeg do apt) nesta fase. O plano registra as versões efetivamente validadas (Node, FFmpeg e ffprobe) e exige repetir as verificações afetadas (V-04 e a prova do fluxo completo da TD-15) quando a imagem mudar. A atualização do Node continua como tarefa separada (D-07), a reabrir se surgir incompatibilidade real. Rationale: DG-1.
- 2026-11-17 — A manutenção periódica (varredura de sessões, limpeza de objetos abandonados e reconciliação) roda no `video-worker`, numa fila própria com concorrência própria, para não esperar atrás dos processamentos de vídeo. Rationale: AMB-6 (ver TD-12).
- 2026-11-20 — Situação: provas V-04 (SI-03.6) e V-11 (SI-03.7) executadas e aprovadas; a TD-10 não tem mais prova pendente. A V-11 (`20261119025715-a2e8f7`) confirmou no BullMQ 6.7.7 os padrões efetivos `lockDuration` 30000, `lockRenewTime` 15000, `stalledInterval` 30000 e `maxStalledCount` 1, os mesmos pelo `@nestjs/bullmq`, que repassa ao `Worker` as opções do `@Processor`. Confirmou também a reentrega após `SIGKILL` do worker; a falha `job stalled more than allowable limit` no stall acima do limite, sem passar pelo processor e sem retentativa; e a parada graciosa, em que `SIGTERM` → `worker.close()` espera o job ativo e não busca jobs novos. Continuam valendo, porque as provas não os cobrem: (a) os requisitos de implementação desta TD: valores explícitos de lock e stall na configuração (SI-03.8); `init: true`, `stop_grace_period` maior que o timeout de um job, `worker.close()` no SIGTERM e encerramento dos processos filhos do FFmpeg (SI-03.20); e timeout por chamada que mata o FFmpeg (SI-03.21); (b) a parada do serviço pelo `docker compose stop video-worker`, critério da SI-03.20; (c) um job ativo durante a indisponibilidade do Redis, cuja convergência fica com a TD-12 e com o T-12 (SI-03.25); (d) a regra da DG-1, que exige repetir a V-04 e a prova do fluxo completo quando a imagem mudar. Rationale: revisão da SI-03.7 (`docs/phases/phase-03-videos/proofs/V-04.md` e `V-11.md`).

### phase-03-videos/TD-11

**Recommendation:** Evita a cópia de 10 GB e aproveita o Range nativo do storage. A B fica como fallback, por formato, se o spike encontrar contêineres problemáticos.
**Libraries:** @aws-sdk/s3-request-presigner@^3.1170.0

**Revisions:**
- 2026-11-17 — Situação: decisão condicionada à prova V-04, não executada; passo bloqueante antes da implementação do processamento. Formatos aceitos: MP4 e WebM, com validação real da mídia e dos codecs pelo ffprobe; mídia inválida é erro permanente, sem retentativa (T-14). MOV fica fora da Fase 03. Rationale: Q-03 (OQ-11, OQ-18, OQ-29).
- 2026-11-17 — A leitura da mídia permanece pela URL pré-assinada interna com HTTP Range, condicionada à V-04. Se essa prova falhar para os formatos aceitos nesta fase, a TD-11 deve ser reaberta. O download completo para disco temporário não está previamente autorizado; sua eventual adoção exige avaliar as evidências, o consumo de disco, o tempo e os testes afetados. Esta revisão substitui, na Recommendation, a autorização de fallback automático para a Option B ("A B fica como fallback, por formato, se o spike encontrar contêineres problemáticos"); a Recommendation original fica como histórico, subordinada a esta revisão. Rationale: IC-5 (alternativa a).

### phase-03-videos/TD-12

**Recommendation:** Não existe uma janela única de inconsistência: são as cinco listadas no contexto, e cada uma tem tratamento próprio:
- **F-02:** a reconciliação republica o job.
- **F-03:** a conduta por estado do job resolve a divergência.
- **F-04 e F-05:** a guarda por execução e as chaves determinísticas resolvem a repetição e a concorrência.

Reentregas e duplicatas **podem** repetir o trabalho e os efeitos intermediários. A garantia é de convergência:
- uma única transição terminal por execução, aplicada só pela execução corrente;
- artefatos com chave e conteúdo determinísticos;
- nenhum efeito para jobs de vídeos já concluídos.

O outbox (B) não é necessário de saída. Ele só passa a se justificar se os testes de F-02 mostrarem que o atraso da reconciliação é inaceitável. As garantias G-05 a G-09 e os testes correspondentes estão em "Cenários de falha, concorrência e repetição". A coluna de execução e o formato do `jobId` são mecanismos candidatos; as garantias é que são obrigatórias.

**Libraries:** bullmq@^6.7.7, @nestjs/bullmq@^11.0.5

**Revisions:**
- 2026-11-17 — Situação: decisão condicionada à prova V-11 (padrões de lock e stall, reentrega, `add` com `jobId` existente em cada estado e `Job.retry()`), não executada; passo bloqueante antes da implementação do consumidor e da reconciliação. Sem reprocessamento manual na Fase 03; só retentativas automáticas. Rationale: /plan-resolve (OQ-12, OQ-36) e Q-05.
- 2026-11-17 — Tentativas e derivados: cada tentativa efetiva do worker recebe uma chave própria para os derivados, inclusive em reentregas concorrentes do mesmo `jobId`/`processing_run`. O banco identifica a tentativa vigente; só ela publica o resultado, atualizando a referência da thumbnail no mesmo `UPDATE` condicional que confirma `ready`. Tentativas obsoletas também não podem marcar `error`. O original confirmado é imutável. O T-11 é ampliado para simular uma tentativa antiga terminando depois da atual e verificar o banco e o artefato referenciado. Derivados abandonados entram na limpeza periódica, com carência e proteção de objetos referenciados ou de tentativas ainda válidas. Esta revisão substitui, na Recommendation, as chaves e os artefatos determinísticos como mecanismo de convergência dos derivados. Rationale: AMB-3 (OR-01).
- 2026-11-17 — Manutenção periódica (varredura de sessões, limpeza de objetos e reconciliação) por Job Schedulers do BullMQ registrados com identificadores estáveis, para não duplicar com várias instâncias, executados no `video-worker` numa fila e com concorrência próprias. Não se assume execução exatamente uma vez nem pontualidade: as operações toleram repetição e usam guardas no banco para não conflitar entre conclusão, reinício, reconciliação e limpeza. Intervalos, tamanho de lote, critérios de elegibilidade e carência para exclusão vêm de configuração. A V-11 passa a validar várias instâncias, repetição, reinício e recuperação após indisponibilidade. Rationale: AMB-6.
- 2026-11-17 — Recuperações por geração. Esta revisão substitui, na tabela da Option A, a conduta `completed → job.retry('completed')` e a republicação de job ausente "com o mesmo `jobId`", e passa o `jobId` de determinístico por execução para determinístico por execução e geração: `video-{videoId}-{run}-{dispatch}`. Toda recuperação de job ausente ou de job `completed` sem transição no banco reserva atomicamente, no banco, uma geração nova e consome uma recuperação, dentro do limite `PROCESSING_MAX_RECOVERIES`; a reconciliação não usa `job.retry()`. As retentativas automáticas do BullMQ por `attempts` e `backoff`, e as reentregas após stall, continuam dentro da mesma geração. A reserva fica registrada como ação pendente, com a geração reservada e um token; a retomada reutiliza essa geração, sem contar outra recuperação, e só repete o `add` quando não há evidência de que o job daquela geração existiu. Um executor atrasado usa a geração reservada pela própria ação, nunca a geração corrente relida. Jobs de gerações antigas não assumem a tentativa nem publicam `ready` ou `error`. A tentativa vigente é ordenada pelo par (geração, `attemptsStarted`), com uma cerca no banco que só avança. `removeOnComplete` e `removeOnFail` ficam desligados: enquanto a geração for a vigente e o vídeo não estiver terminal, a evidência usada na deduplicação não é removida automaticamente; a reconciliação remove depois os jobs de gerações superadas ou de execuções já confirmadas como terminais no banco. A reconciliação lê primeiro o retrato do banco, deriva dele a identidade do job, consulta a fila depois e escreve com a guarda daquele mesmo retrato. A V-11 e o T-09 passam a cobrir esses cenários. Rationale: revisão da Phase A do plano (`phase-03-videos.md`, protocolos P3 e P5), autorizada pelo usuário; o `job.retry()` não pode ser condicionado ao estado observado sem depender de estruturas internas do BullMQ, e um executor atrasado poderia reexecutar o job sem contabilização.
- 2026-11-20 — Situação: prova V-11 executada e aprovada na revisão da SI-03.7; a TD-12 não tem mais prova pendente. Confirmado no BullMQ 6.7.7 (`20261119025715-a2e8f7`, 36 de 36 itens obrigatórios): `attemptsStarted` cresce estritamente no mesmo job, na entrega, na retentativa por `backoff` e na reentrega após stall (1, 2, 3), o que sustenta o `seq` da tentativa vigente; um `add` com `jobId` existente é ignorado em `waiting`, `delayed`, `active`, `completed` e `failed`; `removeOnComplete: false` e `removeOnFail: false` retêm os jobs, e `job.remove()` é recusado para job `active` com lock e funciona para `completed` e `failed`; um job removido e readicionado com o mesmo `jobId` recomeça os contadores; a entrega antiga de um job removido não consegue concluí-lo nem falhá-lo (`Missing key … moveToFinished`); `attemptsMade` identifica a última tentativa e não muda com o stall; o stall acima do limite falha com `failedReason` `job stalled more than allowable limit`; e Job Schedulers com id estável não duplicam com duas instâncias, não acumulam iterações com os workers parados e se recuperam depois de `docker compose stop` e `start` do Redis. O `Job.retry()` ficou informativo e não condiciona esta TD. Continuam valendo, porque a V-11 cobre só a biblioteca: (a) o protocolo da aplicação (P3, P5 e a coleta), verificado pelo T-09 (SI-03.25) e pelo T-11 (SI-03.22); (b) a releitura do job depois de um `add` com `jobId` existente, porque o objeto devolvido traz os dados da chamada e não os gravados; (c) a guarda de P3 sobre os efeitos no banco e no storage, porque a entrega antiga executa o processor até o fim; (d) as limitações de persistência e reconexão do Redis registradas na `V-11.md`. Rationale: revisão da SI-03.7 (`docs/phases/phase-03-videos/proofs/V-11.md`).

### phase-03-videos/TD-13

**Recommendation:** **Option A para a Fase 03.** Atende ao requisito com o menor custo. O contrato de reprodução (TD-14) deve devolver `{ url, contentType }`, para permitir evoluir para a B ou a C sem quebrar o cliente.
**Libraries:** —

**Revisions:**
- 2026-11-17 — Situação: decisão condicionada à prova V-04 (ffprobe/ffmpeg 5.1 com MP4 de `moov` no fim e WebM), não executada; passo bloqueante antes da validação de compatibilidade no worker. Formatos: MP4 e WebM, com validação real de mídia e codecs; MOV fora da Fase 03. Rationale: Q-03 (OQ-13, OQ-18, OQ-29).

### phase-03-videos/TD-14

**Recommendation:** É a única que mantém os bytes fora da API e do BFF e ainda aplica autorização por estado. Reprodução e download têm TTLs separados, configurados por variável de ambiente.
**Libraries:** @aws-sdk/s3-request-presigner@^3.1170.0

**Revisions:**
- 2026-11-17 — Situação: decisão arquitetural aprovada. A V-05 (reprodução e seek em navegador após redirect para URL assinada) fica adiada para a Fase 05, junto com a integração do player no frontend; o adiamento não reduz o aceite de streaming e download desta fase. Autorização: só o dono reproduz e baixa; não-dono recebe 404. Rationale: Q-02 e /plan-resolve (OQ-14, OQ-17, OQ-30).
- 2026-11-17 — Aceite da Fase 03 para streaming e download: testes contra o storage real, com vídeo válido, cobrindo a autorização (dono e não-dono), a emissão das URLs, respostas `206 Partial Content` com `Content-Range` a requisições parciais e o download completo. Rationale: AMB-1.

### phase-03-videos/TD-15

**Recommendation:** Comprova cada requisito com infraestrutura real e mantém a suíte regular viável.
- **Entrega da fase:** precisa das **duas** provas de arquivo grande. A de capacidade sozinha não demonstra que um vídeo de 10 GB é processado e reproduzido.
- **Simulação dos estados intermediários:** os testes de falha e concorrência simulam esses estados diretamente na infraestrutura real (ver "Cenários de falha, concorrência e repetição"), em vez de mockar o meio da operação.
- **Guia de testes:** precisa passar a prever MinIO real, numa tarefa separada ou como parte da documentação da fase.

**Libraries:** —

**Revisions:**
- 2026-11-17 — Exceção registrada ao guia de testes: integração e e2e da Fase 03 usam storage, fila e worker reais. A indicação do guia de usar adaptador local ou filesystem para storage não se aplica nesta fase, porque o R-10 prevalece. O guia não é alterado nesta fase; isso substitui, na Recommendation, a atualização do guia para prever MinIO real. Rationale: IC-3 (D-06).
- 2026-11-17 — Aceite do upload de 10 GB: a suíte regular usa arquivos pequenos e limites configuráveis. Antes da entrega, há uma prova documentada de upload real de 10 GB (10.000.000.000 bytes) com interrupção, retomada e medição da responsividade da API durante o envio, e uma prova do fluxo completo com vídeo válido até `ready`. Não se exigem automaticamente duas transferências de 10 GB nem um vídeo preenchido artificialmente até o tamanho exato. A prova grande é planejada considerando o tempo e o disco disponíveis, medidos na V-07. Esta revisão substitui, na Recommendation, a exigência de que a prova do fluxo completo use um vídeo de 10 GB. Rationale: AMB-2 (OR-04).
- 2026-11-17 — Situação: decisão arquitetural aprovada; nenhum teste nem prova foi executado. A V-07 (tempo e disco) é passo bloqueante apenas para agendar a prova grande. Os testes T-01 a T-14 compõem o plano de testes da fase, com os ajustes de T-01/T-04 (TD-02) e T-11 (TD-12). Rationale: /plan-resolve (OQ-15, OQ-32).

## Inherited Decisions Detail

_TDs de frontend herdadas (`phase-02-auth-frontend/*`, `next-frontend-*`) entram como contexto de contrato. Elas **não** autorizam implementação de frontend nesta fase._

### phase-01-configuracao-base/TD-01

**Recommendation:** Option A (@nestjs/config) — Official, core-team-maintained, guaranteed NestJS 11 compatibility. The `registerAs()` factory pattern solves the TypeORM CLI sharing problem: the factory function can be imported as a plain function by `data-source.ts` while also serving as a DI injection token inside NestJS. Building a custom module recreates solved functionality; third-party packages carry maintenance risk.

**Libraries:** `@nestjs/config@^4.x`

### phase-01-configuracao-base/TD-02

**Recommendation:** Option A (Joi) — First-class integration with `@nestjs/config` via `validationSchema`, requiring zero custom wiring. Handles string-to-number coercion natively. Using a different tool for env validation vs. request validation is reasonable — env config is validated once at startup, DTOs are validated per-request. Zod is elegant but adds a third validation paradigm to the project.

**Libraries:** `joi@^17.x`

### phase-01-configuracao-base/TD-03

**Recommendation:** Option B (Namespaced/grouped with registerAs) — The project roadmap explicitly calls for auth, email, and storage in upcoming phases. Namespaced configs provide clear file boundaries per domain, typed injection via `ConfigType<typeof databaseConfig>`, and natural scalability. The `registerAs()` factory is dual-purpose: DI token inside NestJS and plain importable function for `data-source.ts`. Initial files for Phase 01: `src/config/database.config.ts`, `src/config/app.config.ts`.

**Libraries:** —

### phase-01-configuracao-base/TD-04

**Recommendation:** Option A (Shared registerAs factory) — Natural outcome of choosing `@nestjs/config` with `registerAs`. The factory is already callable by design. `data-source.ts` imports it, calls `dotenv.config()`, then calls the factory. Zero duplication, minimal code, no extra abstraction.

**Libraries:** `dotenv` (transitive via `@nestjs/config`)

### phase-02-auth/TD-01

**Recommendation:** Argon2id — For a greenfield project in 2026, Argon2id is the OWASP-recommended choice. The native build dependency is a one-time Docker setup cost. The project has no legacy constraints favoring bcrypt. OWASP minimum: 19MiB memory, 2 iterations.

**Libraries:** `argon2@^0.41.x`

### phase-02-auth/TD-02

**Recommendation:** Option A (@nestjs/passport) — The project plan includes only email/password auth for now, but the plugin architecture costs little and future phases may add social login. Aligns with official NestJS docs, making onboarding and maintenance easier.

**Note:** Decision deliberately diverged from the Recommendation during implementation — custom guards were preferred over `@nestjs/passport` to keep the dependency surface smaller; social login is not on the near-term roadmap, so the plugin-architecture benefit did not justify the extra abstraction layer.

**Libraries:** `@nestjs/jwt@^11.0.0`

### phase-02-auth/TD-03

**Recommendation:** Option A (Refresh Token Rotation) — Provides the strongest security model with automatic theft detection. The DB write overhead is acceptable for a video platform (auth refresh is infrequent vs. video operations). PostgreSQL is already in the stack, so no new infrastructure needed. Race conditions can be mitigated with a short grace period for the old token.

**Libraries:** —

### phase-02-auth/TD-04

**Recommendation:** Option B (Random Opaque Tokens in DB) — Revocability is important: when a user requests a new password reset, previous tokens should be invalidated. The DB table is trivial to implement, and the tokens table can also serve future needs (e.g., API keys). Keeps email tokens decoupled from the JWT auth system.

**Libraries:** —

### phase-02-auth/TD-05

**Recommendation:** Option A (@nestjs-modules/mailer) — Best NestJS integration with minimal boilerplate. Supports SMTP (matching the architecture diagram), works with MailHog/Mailpit for local development without external dependencies, and scales to any SMTP provider in production. Template engine support (Handlebars) simplifies email formatting. No vendor lock-in.

**Libraries:** `@nestjs-modules/mailer@^2.x`, `handlebars@^4.x`

### phase-02-auth/TD-06

**Recommendation:** Option A (class-validator + class-transformer) — This is a backend-only project (no shared schemas with frontend), so Zod's single-source-of-truth advantage is less impactful. class-validator is the documented NestJS approach, and the project already uses decorators extensively (TypeORM entities, NestJS DI). Fewer integration surprises with NestJS 11.

**Libraries:** `class-validator@^0.14.x`, `class-transformer@^0.5.x`

### phase-02-auth/TD-07

**Recommendation:** Option A (Custom Domain Exception Filter) — Provides machine-readable error codes that the Next.js frontend can switch on, without the overhead of RFC 9457's URI-based type system. The project is single-consumer (first-party frontend), so a simple `{ statusCode, error, message }` format with domain codes balances clarity and simplicity. The custom filter cost is low — two small files.

**Libraries:** —

### phase-02-auth/TD-08

**Recommendation:** Option A (@nestjs/throttler) — Native NestJS integration is decisive: the guard system allows scoping rate limiting to `AuthModule` only via module-level `APP_GUARD`, with `@SkipThrottle()` for exemptions. The project is single-instance with no distributed requirements, so in-memory storage is sufficient. Using express-rate-limit would bypass NestJS's DI and guard lifecycle for no clear benefit.

**Libraries:** `@nestjs/throttler@^6.x`

**Revisions:**
- 2026-11-17 — Correção documental da justificativa: um `APP_GUARD` é global mesmo quando registrado dentro de um módulo, então o throttler com `{ ttl: 60000, limit: 10 }` protege todas as rotas, e as isenções usam `@SkipThrottle()` (por exemplo, no `AppController`). A escolha (Option A) não muda e a proteção global é preservada; cada fase define limites explícitos para as próprias rotas com `@Throttle()` ou `@SkipThrottle()`, sem desativar a proteção de forma indiscriminada. Rationale: divergência D-05 registrada na pesquisa da Fase 03 (`phase-03-videos`, IC-2).

_(Revision copiada em 2026-11-17 de `docs/decisions/technical-decisions-phase-02-auth.md`, fonte da TD; o `phase-02-auth/context.md` ainda não a contém. A Recommendation acima fica como histórico; vale a revisão: o throttler é global e cada fase declara limites explícitos para as próprias rotas.)_

### phase-02-auth/TD-09

**Recommendation:** Option B (Opaque) — Since DB lookup is mandatory (TD-03), JWT signature adds no security value. Opaque tokens are shorter, leak no data, and are simpler to generate.

**Note:** Decision deliberately diverged from the Recommendation — JWT was kept to reuse the access-token signing/verification infrastructure (`@nestjs/jwt`), trading token size and base64-readability for a single token format across the codebase.

**Libraries:** `@nestjs/jwt@^11.0.0`

### phase-02-auth/TD-10

**Recommendation:** Option A — The platform is a video sharing service with URL-based channel handles. A strict `[a-z0-9_]` allowlist is the simplest and most portable choice: no extra dependencies, no edge cases around hyphen positioning, and the `user_<random>` fallback provides a valid handle even for extreme email prefixes. Hyphens can always be added in a future iteration if user feedback justifies it.

**Libraries:** —

### phase-02-auth-frontend/TD-01

**Recommendation:** Three reasons. (1) **Architectural fit.** The strict-BFF model in `next-frontend-config-base/TD-03` already nominates the Route Handler as the only NestJS caller; cookie-based sessions are the natural match, and Auth.js's framework adds layers between the BFF and the cookie that buy nothing because the backend is the auth authority — Auth.js's value (DB adapters, OAuth providers, magic-link, `getServerSession` helpers) is mostly unused in this configuration. (2) **Smaller blast radius.** A ~50-LOC session helper is grep-friendly, debuggable, and test-friendly via the existing MSW+BFF integration test pattern; a misconfigured Auth.js callback is a longer fault-isolation loop. (3) **Compatibility with Next.js 16 / React 19.** Built-in `next/headers` `cookies()` is the canonical primitive both runtimes already use; Auth.js v5 versions track Next.js majors with a lag, adding compatibility risk that Option A does not have. Option C is rejected as unsafe (`localStorage` for refresh tokens) and architecturally regressive (loses RSC personalization).
**Libraries:** —

### phase-02-auth-frontend/TD-02

**Recommendation:** Three reasons. (1) **Defense in depth on the cookie content** — `httpOnly` blocks JS, encryption blocks accidental log/proxy inspection; the marginal cost is one ~3KB dep. (2) **Single cookie to manage** simplifies logout (one `session.destroy()` call) and avoids the orphan-cookie failure mode of Option A. (3) **Room to carry minimal user metadata** (`userId`, `email`, `channelSlug`) lets `app/layout.tsx` RSC render the authenticated chrome (avatar, channel name) without a per-render `/auth/me` round-trip — Phase 04+ gains compound here. Option A is a viable downgrade if the team rejects `iron-session` for any reason; the migration A→B (or B→A) is a one-Route-Handler refactor with no test changes downstream because the BFF interface is unchanged. Option C is rejected: it solves a problem (server-side revocation) the project does not have at the cost of infrastructure the project does not own.
**Libraries:** iron-session

### phase-02-auth-frontend/TD-03

**Recommendation:** The single-flight detail is non-trivial and goes in the helper from day one — tested by MSW with a "two concurrent intercepted upstream calls; one refresh expected" assertion. Option B's client-driven pattern is rejected because it doesn't replace Option A (RSC still needs server-side refresh) — adopting B means doing both. Option C's pre-emptive timer is rejected because the failure modes (multiple tabs, sleep/wake) outweigh the latency saving and force a `"use client"` shell near the root.
**Libraries:** —

### phase-02-auth-frontend/TD-04

**Recommendation:** Three reasons. (1) **Decoupled from TD-05** — works with Route Handlers OR Server Actions; the form code does not change if TD-05 is revisited later. (2) **Aligned with shadcn's canonical form primitive** — the project already commits to `radix-nova` shadcn (`components.json`); `npx shadcn@latest add form` produces react-hook-form wrappers; choosing react-hook-form means using the supported primitive instead of hand-rolling around it. (3) **Zod-first developer ergonomics match the rest of the FE foundation** — `next-frontend-config-base/TD-01` chose Zod 4 for env; the same schemas-as-source-of-truth pattern carries to forms with zero new validator paradigm. Option B is rejected for impedance with shadcn's primitive and for over-investing in progressive-enhancement that the strict-BFF model does not require. Option C is rejected for the per-field boilerplate and the loss of client-side feedback on a project that values quick, type-safe form iteration.
**Libraries:** react-hook-form, @hookform/resolvers

### phase-02-auth-frontend/TD-05

**Recommendation:** Three reasons. (1) **Strict-BFF alignment.** `next-frontend-config-base/TD-03` named Route Handlers as the BFF surface; Option A keeps every mutation visible under `app/api/**`. (2) **Test scaffold already exists** — `next-frontend/CLAUDE.md` § Testing and `next-frontend-msw-foundation` were authored for Route-Handlers-as-functions; Option A reuses them with zero invention. (3) **Single mutation surface** — Phase 02 sets the precedent for Phases 03–07; uniformity beats per-mutation idiom-picking when the cost of inconsistency compounds (Option C). Option B has real ergonomic appeal for the simplest forms but fragments the BFF surface and forces test-pattern reinvention; if the team later wants progressive enhancement for specific forms, the migration A→B is per-form and doesn't require touching unrelated routes — A is the safer default and the cheaper baseline.
**Libraries:** —

### phase-02-auth-frontend/TD-06

**Recommendation:** Two reinforcing reasons. (1) **No first-render flicker, no round-trip** — the session is delivered in the same response as the page HTML; the Client Provider hydrates with the correct initial state; users never see "Login" briefly turn into their avatar. (2) **No new BFF endpoint** — the cookie is the source of truth, RSC reads it, the Provider broadcasts it; the BFF surface stays minimal. The `router.refresh()` requirement after mid-session mutations is a small price (one line in the relevant mutation handler) for the structural benefits. Option B is rejected for the double-read-and-flicker; Option C is dominated by Option B and rejected.
**Libraries:** —

### phase-02-auth-frontend/TD-07

**Recommendation:** Three reasons. (1) **First-paint-correct** — the user sees the right outcome on the first paint, no skeleton, no flicker. (2) **Single integration pattern across both flows** — confirmation is RSC-only; reset is RSC + Client form (TD-04, TD-05 patterns reused) — both share the "RSC owns the token, Client Component owns the input" split. (3) **Email-prefetch behavior** is solved at the backend's idempotent-confirmation level (a small note for `/plan-build` to confirm; not a separate TD). Option B's Route-Handler-as-link-target adds redirects for no clean gain. Option C is dominated.
**Libraries:** —

### openapi-docs-nestjs/TD-01

**Recommendation:** **Option A (`@nestjs/swagger`)** — é a única opção que preserva as decisões anteriores (`class-validator` em TD-06 de phase-02-auth) sem re-platform; o CLI plugin com `classValidatorShim: true` aproveita os decoradores `class-validator` existentes para inferir schemas, mantendo o boilerplate baixo. Nestia tem mérito técnico real mas o custo de migração do stack de validação inviabiliza-a sem uma decisão upstream de supersede de TD-06. Manual authoring é descartado.

**Libraries:** @nestjs/swagger

**Revisions:**

- 2026-05-12 — Esclarece que o CLI plugin (`classValidatorShim: true`) cobre apenas inferência de schemas de DTOs a partir de `class-validator`; documentação de operações, respostas tipadas por status code, contratos de erro (alinhados ao envelope de phase-02-auth/TD-07) e exemplos exigem decoradores explícitos (`@ApiOperation`, `@ApiResponse`, `@ApiBody`, `@ApiParam`, `@ApiQuery`, `@ApiExtraModels`). _Rationale:_ openapi.json gerado pelo bootstrap atual está genérico — sem detalhes de parâmetros, schemas de retorno por status, nem contratos de erro — porque a base instalada se apoiou só na introspecção automática. Esta revisão fixa que enriquecimento via decoradores explícitos faz parte da Option A escolhida, não é trabalho fora do escopo do TD.

### openapi-docs-nestjs/TD-02

**Recommendation:** **Option C (Ambos)** — o custo marginal sobre Option A é apenas um npm script (~15 linhas) e o benefício é uma fundação correta para futura integração FE (codegen offline) sem perder a UI interativa que dev/QA usam. Option B sozinho pune a experiência de desenvolvimento em dev/local; Option A sozinho compromete o pipeline de codegen futuro. Combinar é dominante.

**Libraries:** —

### openapi-docs-nestjs/TD-03

**Recommendation:** **Option B (Apenas em dev/staging)** — alinha com a postura defensiva já estabelecida em phase 02 e não compromete consumidores legítimos (o `openapi.json` commitado em TD-02 cumpre o papel de "spec consultável fora da UI"). Re-abrir como Option A ou C é trivial no futuro se um caso de uso de API pública aparecer.

**Libraries:** —

### next-frontend-openapi-typing/TD-02

_Herança parcial (seleção do usuário em 2026-11-17): deste documento entram só a TD-02 e a TD-03, que tratam da origem, sincronização e atualização do contrato OpenAPI. TD-01 (ferramenta de codegen), TD-04 (compartilhamento de tipos) e TD-05 (handlers MSW) não são herdadas nesta fase._

**Recommendation:** **Option B (committed local copy + repo-root sync script)**. Three reasons. (1) **Preserves the compose-stack independence** that `next-frontend-config-base/TD-03` Context calls out as the current architecture — neither subproject's compose file references the other. (2) **Drift is eliminated structurally when paired with TD-03's CI freshness check** — the check runs the sync script and asserts no diff on either `openapi.json` or `types.gen.ts`, so a backend PR that forgets to re-sync fails CI with a clear message. (3) **The committed local file is a real artifact in PR review** — reviewers see the contract change in `next-frontend/openapi.json`'s diff at the same time as the backend change, doubling the visibility (an `openapi.json`-only diff in a feature PR is a red flag for accidental drift). Option A is acceptable as a pre-CI fallback; Option C is rejected because the cross-stack file dependency in `docker-compose.yaml` introduces coupling that the current architecture explicitly avoids, and the "no drift" gain over B is small once TD-03 lands.

**Libraries:** —

### next-frontend-openapi-typing/TD-03

**Recommendation:** **Option C (committed + CI freshness check)**. It is the only option that makes contract drift _both_ visible (in PR diffs) _and_ impossible to merge accidentally (CI fail). The complexity premium over Option A is one CI step. Option B's "no committed artifacts" purity is poorly paid for in a monorepo where the cross-subproject build coupling becomes a real ergonomic cost, and it wastes the PR visibility that TD-02 Option B's committed `openapi.json` is specifically designed to deliver. Option A is acceptable as a temporary state until the CI pipeline lands; downgrading from C to A is reversible (just remove the CI step) but upgrading to C later requires explaining `types.gen.ts` history in a separate commit. Start at C. Apply the same script-and-check pattern to any future generated artifact (e.g., if `openapi-fetch` is wrapped, the wrapper file is hand-written; the only generated artifact remains `types.gen.ts`).

**Libraries:** —

### next-frontend-config-base/TD-03

_Herança parcial (seleção do usuário em 2026-11-17): deste documento entra só a TD-03 (BFF estrito, `API_URL` apenas no servidor e URLs pré-assinadas para a transferência direta com o storage). TD-01 (Zod 4) e TD-02 (`@t3-oss/env-nextjs`) não são herdadas nesta fase._

**Recommendation:** **Option A (Strict BFF — single server-only `API_URL`)**. Aligned with the BFF testing strategy and architectural commitment already documented in `next-frontend/CLAUDE.md` (Route Handlers as the only NestJS caller; BFF tests stub `fetch` via MSW). Eliminates CORS, eliminates public exposure of the backend URL, and produces the smallest correct foundation. Option B's `NEXT_PUBLIC_API_URL` is a future-proofing concession with no current consumer — and adding a public key later is a non-breaking change, while removing one is breaking. Option C ties a foundational decision to infra work explicitly deferred elsewhere. The Docker networking gap (how server-in-container resolves the backend) is a separate orthogonal decision, surfaced below.

**Libraries:** —

_Trecho de origem sobre URLs pré-assinadas (Cons da Option A, `docs/decisions/technical-decisions-next-frontend-config-base.md`):_ "For large payloads (videos, Phase 03+), object storage URLs will need a separate mechanism anyway (presigned URLs from object storage, NOT the backend URL)".

## Inherited Conventions

- Backend config uses `@nestjs/config` with namespaced `registerAs(name, () => ({...}))` factories — one file per domain in `src/config/`. _(from phase 01)_
- Env variables are validated by a Joi schema in `src/config/env.validation.ts`, passed to `ConfigModule.forRoot({ validationSchema, validationOptions: { allowUnknown: true, abortEarly: false } })`. _(from phase 01)_
- Config is injected into modules via `ConfigType<typeof xxxConfig>` and `@Inject(xxxConfig.KEY)`; the same factory is importable as a plain function for non-DI contexts (e.g., TypeORM CLI). _(from phase 01)_
- `data-source.ts` loads `.env` via `import 'dotenv/config'` at the top, then imports `databaseConfig` and calls it as a plain function. _(from phase 01)_
- Database connection parameters (host, port, etc.) are sourced from a single `databaseConfig` factory — never duplicated between `AppModule` and `data-source.ts`. _(from phase 01)_
- `TypeOrmModule.forRootAsync` is used (not `forRoot`), with `imports: [ConfigModule]`, `inject: [databaseConfig.KEY]`, `useFactory` returning options including `autoLoadEntities: true`, `synchronize: false`. _(from phase 01)_

_As âncoras herdadas registradas pelo documento de decisões (storage, C4, configuração, autenticação, validação e erros, rate limiting, OpenAPI, BFF estrito e persistência) estão copiadas na íntegra em "Insumos da pesquisa → Âncoras herdadas"._

## Inherited Deferred Capabilities

_(informational-only; plan-validate does NOT fire issues based on unaddressed entries)_

| Capability | Status | Origin phase | Rationale |
|-----------|--------|--------------|-----------|
| Telas de frontend | deferred | phase-01-configuracao-base | `next-frontend/` is not initialized in this phase; UI surfaces start in a later phase. |
| Telas de cadastro, login, confirmação de conta e recuperação de senha | deferred | phase-02-auth | `next-frontend/` is not initialized in this phase; UI surfaces start in a later phase. |
| "Confirmação de conta via e-mail com link de ativação" | deferred | phase-02-auth-frontend | deferred_to_next_phase — UI landing screen de-scoped 2026-05-14; FE confirmation flow (TD-07) picked up by a future phase. BE side unchanged in `phase-02-auth`. |
| "Logout" | deferred | phase-02-auth-frontend | deferred_to_next_phase — logout button lives inside authenticated chrome (typically Phase 04). Phase 02 still implements POST `/api/auth/logout` (BFF route handler + `session.destroy()`) so the contract is ready when the chrome lands. |
| "Recuperação de senha (destination screen / set-new-password)" | deferred | phase-02-auth-frontend | deferred_to_next_phase — `/forgot-password` ships this phase sending the e-mail; the reset-password destination screen is absent from Figma → link destination remains a 404 until a later phase delivers the screen via `/screen-inventory` extension run. Documented as a known gap. |
| "Telas de cadastro, login, confirmação de conta e recuperação de senha" | deferred | phase-02-auth-frontend | a tela de confirmação da conta não será implementada nesta fase corrente, será adiada — the umbrella bullet's full coverage requires the confirmação and reset-password destination screens; both are deferred per Non-UI rows above. The 3 ship-this-phase telas (signup, login, forgot-password) are inventoried and covered by their own verbs; the umbrella bullet itself is deferred to the phase that lands the missing screens. |

## UI Inventory

_No screen inventory — UI↔API sync deferred. Run /screen-inventory phase-03-videos and then rerun /plan-context phase-03-videos to activate UI checks._

## Non-UI / Deferred Capabilities

_None._

## Testing Requirements

### nestjs-project

_(from `testing-guide-nestjs-project` — §3 Feature Implementation Checklist)_

| Artifact type | Required layers |
|---------------|-----------------|
| Entity (`*.entity.ts`) | Integration: constraints, defaults, `select: false` |
| Service with branching + DB | Unit: branch logic (mock repo) + Integration: DB contract |
| Service with DB only (no branching) | Integration: DB contract |
| Service with configured lib (JWT, cache) | Unit: real lib with test config |
| Service with side-effect dep (email, storage) | Integration: real capture service (Mailpit) or local adapter |
| Module with configured imports | Unit: compilation test |
| Controller | E2E only — do NOT write unit tests |
| DTO | E2E: one validation wiring test per endpoint |
| Guard (delegates to service for business logic) | E2E + Unit if complex internal logic |
| Guard (simple, delegates to Passport) | E2E only |
| Strategy (Passport) | E2E via guard |
| Pipe (custom transformation/validation) | Unit |
| Interceptor (response transform, logging) | Unit and/or E2E |
| Exception Filter | Unit + E2E |
| Middleware | E2E |
| Queue Consumer / Processor with business logic _(from `artifacts/future-types.md`)_ | Unit (mock deps) + Integration (real DB/storage) |
| Queue Consumer / Processor with only external system calls _(from `artifacts/future-types.md`)_ | Integration (real systems) |
| Scheduled Task (Cron) _(from `artifacts/future-types.md`)_ | Test the method directly as a regular service method (Unit and/or Integration); do NOT test that the cron schedule triggers |

_A opção "local adapter" para storage é a divergência D-06. Exceção registrada na `phase-03-videos/TD-15` (IC-3): integração e e2e desta fase usam storage, fila e worker reais, porque o R-10 prevalece. O worker vive no `nestjs-project` (`phase-03-videos/TD-10`, Option A) e segue este guia._

### next-frontend

_Subprojeto diferido: sem implementação nesta fase, então não há requisitos de teste aqui. A V-08 (navegador real via Playwright) é uma prova técnica de infraestrutura, não implementação de frontend._

## Insumos da pesquisa (preservados do documento de decisões)

_Blocos copiados na íntegra de `docs/decisions/technical-decisions-phase-03-videos.md` (versão revisada; mtime em `sources_mtime`). Os títulos foram rebaixados um nível para caber nesta seção; textos e tabelas não foram alterados. Os ajustes, as respostas e a situação das decisões registrados pelo `/plan-resolve` em 2026-11-17 foram espelhados aqui a partir do documento de decisões. A consolidação documental de 2026-11-17 (F-04, D-06, V-04, V-07 e a regra vigente da TD-03) e a conciliação da Phase A do plano (notas de F-02/F-03, G, T e V-11, e situação da V-11) também foram espelhadas, com a redação anterior preservada nas notas._

| Bloco | Seção de origem no documento de decisões |
|-------|------------------------------------------|
| Âncoras herdadas | Bloco "Âncoras herdadas (não reabrir)" do cabeçalho |
| R-01 a R-11 | "Requisitos obrigatórios × recomendações" |
| F-01 a F-12, G-01 a G-11, T-01 a T-14 | "Cenários de falha, concorrência e repetição (insumo para o planejamento)" |
| D-01 a D-12 | "Divergências encontradas (código × documentação)" |
| V-01 a V-11 | "Lacunas e validações pendentes (spikes sugeridos para o planejamento)" |
| Q-01 a Q-10 | "Dúvidas para o revisor" |
| Situação das decisões e provas | "Situação das decisões e provas (`/plan-resolve`, 2026-11-17)" |
| Fontes | "Fontes e versões consultadas" |
| Evidências da TD-08 | "Evidências da TD-08 — acesso às imagens do MinIO" _(não copiada; ver referência ao fim desta seção)_ |
| Contratos e consequências | "Consequências para contratos, autorização, eventos e transições" _(não copiada; ver referência ao fim desta seção)_ |

### Âncoras herdadas

> **Âncoras herdadas (não reabrir):**
> - **Storage S3/MinIO:** definido pelo `docs/project-plan.md` (Fase 03) e pelo diagrama C4 (`Object Storage — S3 or MinIO`). A TD-08 trata só de **como obter** o MinIO, pois as imagens oficiais deixaram de ser distribuídas.
> - **Arquitetura C4:** worker em container próprio (`Video Worker — FFmpeg`), que lê e grava no storage e atualiza o banco. A API publica jobs. A fila está como `TBD`.
> - **Configuração:** `@nestjs/config` + Joi + arquivos `registerAs` por domínio, com a factory compartilhada pelo CLI do TypeORM (`phase-01-configuracao-base/TD-01..TD-04`). As novas chaves entram em `env.validation.ts`, `.env.example` e em configs namespaced (`storage`, fila, vídeo).
> - **Autenticação e autorização:** `JwtAuthGuard` customizado e **global** via `APP_GUARD`, com opt-out por `@Public()` e `@CurrentUser()` devolvendo `{ sub, email }` (`phase-02-auth/TD-02`). O canal é 1:1 com o usuário (`channels.user_id UNIQUE`).
> - **Validação e erros:** DTOs com class-validator (`phase-02-auth/TD-06`) e envelope `{ statusCode, error, message }` com códigos de domínio via `DomainException` (`phase-02-auth/TD-07`).
> - **Rate limiting:** `@nestjs/throttler` com `{ ttl: 60000, limit: 10 }` (`phase-02-auth/TD-08`). Na prática ele é **global** (ver Divergência D-05).
> - **OpenAPI:** `@nestjs/swagger` com decoradores explícitos por endpoint e `openapi.json` exportado e consumido pelo frontend (`openapi-docs-nestjs/TD-01..TD-03`, `next-frontend-openapi-typing/TD-01..TD-05`).
> - **BFF estrito:** o navegador só chama Route Handlers same-origin, e só o servidor Next conhece `API_URL` (`next-frontend-config-base/TD-03`). Os tokens ficam num cookie httpOnly cifrado (`phase-02-auth-frontend/TD-01`, `TD-02`), então o navegador **não tem** bearer token para falar direto com a API Nest. O próprio TD-03 do config-base já antecipa que vídeos usarão URLs pré-assinadas do storage, e não a URL do backend.
> - **Persistência:** TypeORM 0.3.28 com Data Mapper, migrations imutáveis, `synchronize: false` e PK UUID (`uuid_generate_v4()`).

### Requisitos obrigatórios × recomendações

Os itens desta tabela são **obrigatórios**: vêm do plano ou do enunciado do desafio e não estão em discussão. Todo o resto do documento é recomendação.

| ID | Requisito obrigatório | Origem | TDs que o atendem |
|----|----------------------|--------|-------------------|
| R-01 | Armazenamento S3/MinIO para vídeos e thumbnails | Plano (Fase 03), diagrama C4, desafio | TD-06, TD-07, TD-08 |
| R-02 | Upload de até 10GB **sem transportar o arquivo pela API** e sem bloquear o atendimento | Plano (Fase 03 e Pontos de Atenção), desafio | TD-01, TD-03, TD-10 |
| R-03 | Retomar o upload após falha de conexão | Pontos de Atenção, desafio | TD-01, TD-02 |
| R-04 | Pré-cadastro do vídeo como rascunho ao iniciar o upload, associado ao canal do usuário | Plano, desafio | TD-02, TD-04 |
| R-05 | Processamento assíncrono com extração de duração e metadados e geração de thumbnail via FFmpeg/ffprobe | Plano, desafio | TD-09, TD-10, TD-11, TD-12 |
| R-06 | Estados `rascunho`, `processando`, `pronto` e `erro` | Desafio | TD-04 |
| R-07 | URL única por vídeo, sem conflito | Plano, Pontos de Atenção | TD-05 |
| R-08 | Reprodução por streaming, começando antes do download completo | Plano | TD-13, TD-14 |
| R-09 | Download do vídeo | Plano | TD-14 |
| R-10 | Storage, fila e worker **reais** executados pelo Docker Compose e exercitados pelos testes | Desafio | TD-08, TD-09, TD-10, TD-15 |
| R-11 | Reuso dos padrões de autenticação, autorização, erros, persistência e migrations | Desafio, CLAUDE.md | Seção "Consequências" |

### Cenários de falha, concorrência e repetição (insumo para o planejamento)

Esta seção reúne os cenários das TD-02, TD-10 e TD-12. Para cada um, registra a garantia exigida e o teste que a prova.
- **O que é obrigatório:** as **garantias**.
- **O que é sugestão:** os mecanismos citados, a fixar no planejamento. Nenhum deles impõe outbox ou outra infraestrutura adicional.

#### Cenários

| ID | Cenário | Estado resultante | Recuperação esperada | TDs |
|----|---------|-------------------|----------------------|-----|
| F-01 | O storage concluiu o upload, mas o banco não foi atualizado: a API caiu ou o `UPDATE` falhou depois do `CompleteMultipartUpload` | O objeto existe e o `uploadId` não; o vídeo está em `draft` e a sessão em `completing` | A nova chamada de conclusão, ou a varredura depois do prazo do claim, recebe `NoSuchUpload` e confere o `HeadObject`. Se o objeto existe com o tamanho declarado, a transição é concluída; se não existe, a sessão expirou e o cliente reinicia | TD-02 |
| F-02 | O banco foi atualizado (`processing`), mas a publicação na fila falhou | Vídeo em `processing` sem job | A conclusão não reverte o estado, que já mudou: registra o erro e responde com o estado atual. A reconciliação publica o job com o mesmo `jobId` | TD-12 |
| F-03 | Já existe um job da execução em `waiting`, `delayed`, `active`, `failed` ou `completed` quando ocorre republicação, nova conclusão ou reconciliação | — | Conduta por estado, conforme a tabela da TD-12. Um `add` repetido é ignorado enquanto o job existir, então republicar nunca duplica | TD-12 |
| F-04 | O worker gravou a thumbnail, mas não o banco: a atualização falhou ou o processo morreu entre as duas escritas | Thumbnail no storage; vídeo em `processing` | A retentativa refaz o trabalho e regrava a mesma chave. Se as tentativas acabarem, a reconciliação grava `error`. A thumbnail de um vídeo em `error` fica como lixo conhecido, a remover na limpeza de vídeos da Fase 04 | TD-10, TD-12 |
| F-05 | Duas execuções do mesmo job rodam ao mesmo tempo, porque o lock foi perdido sem a morte do processo | Duas cópias em execução | Só a primeira transição terminal vale. A outra recebe `affected = 0` e descarta o resultado. A thumbnail é idêntica nas duas | TD-10, TD-12 |
| F-06 | Duas conclusões simultâneas da mesma sessão (duplo clique, duas abas ou retentativa do BFF) | — | Só uma faz `active → completing`. A outra recebe o estado atual (200, se a conclusão já terminou) ou conflito (409, se ainda está em andamento) | TD-02 |
| F-07 | Conclusão concorrente com o reinício da sessão | — | O reinício exige sessão `active`; se ela está em `completing`, recebe conflito. Um upload em conclusão nunca é abortado | TD-02 |
| F-08 | Conclusão concorrente com a varredura de expiração | — | A varredura só reivindica sessões `active` e vencidas, e a conclusão só sessões `active` e dentro do prazo. A transição condicional no banco decide quem vence | TD-02 |
| F-09 | Abort com uma parte ainda em trânsito | A parte pode ser gravada depois do abort (documentação da AWS) | A varredura repete o abort até o `ListParts` responder `NoSuchUpload` | TD-02 |
| F-10 | A limpeza automática do storage removeu um upload que a aplicação ainda considera ativo | `NoSuchUpload` e nenhum objeto | A sessão é marcada como expirada e o cliente reinicia. A folga entre os TTLs evita esse caso | TD-02 |
| F-11 | O arquivo selecionado de novo é diferente do original | Os checksums das partes confirmadas não batem | A retomada é recusada com conflito de arquivo e nenhuma parte nova é assinada. Só um reinício explícito continua | TD-02 |
| F-12 | O worker é interrompido durante o processamento: SIGKILL, falta de memória, `compose stop`, Redis inacessível ou FFmpeg travado | Job `active` com lock vencido, ou travado com o lock ainda sendo renovado | Lock vencido: o job vira *stalled* e é reentregue (até `maxStalledCount`); depois vira `failed`, e a reconciliação grava `error`. FFmpeg travado: o timeout mata o processo e gera erro transitório | TD-10, TD-12 |

#### Garantias exigidas

| ID | Garantia | Mecanismo candidato | Cenários |
|----|----------|---------------------|----------|
| G-01 | No máximo uma operação de ciclo de vida (conclusão, reinício ou limpeza) vence em cada sessão | Transição condicional do estado da sessão no banco, sem transação aberta durante chamadas ao storage | F-06, F-07, F-08 |
| G-02 | Estados intermediários não ficam presos: o claim `completing` ou `aborting` expira e é retomado de forma idempotente | Prazo gravado no claim; retomada pela próxima chamada ou pela varredura | F-01 |
| G-03 | Concluir é idempotente: repetir depois do sucesso devolve o estado atual sem novo efeito, e repetir depois de uma falha parcial converge | `NoSuchUpload` desambiguado por `HeadObject`, apoiado na G-01 | F-01, F-06 |
| G-04 | O objeto final só é montado com partes confirmadas e a partir do registro da API | Registro de PartNumber, ETag e checksum, com conferência paginada por `ListParts` | F-11; parte sobrescrita ou não registrada |
| G-05 | Todo vídeo em `processing` tem um job vivo para a execução corrente, ou é republicado ou levado a `error` em tempo limitado | Reconciliação por estado do job (TD-12) | F-02, F-03, F-12 |
| G-06 | Há uma única transição terminal por execução, aplicada só pela execução corrente | `UPDATE` condicional com o número da execução | F-05 |
| G-07 | Os efeitos do worker convergem quando o trabalho se repete | Chave fixa e frame determinístico para a thumbnail | F-04, F-05 |
| G-08 | Um job de vídeo já terminal termina sem efeitos, e um job de retentativa legítima refaz o trabalho inteiro | Releitura do estado e da execução antes de qualquer efeito | F-03, F-05 |
| G-09 | Todo processamento termina | Timeout que mata o FFmpeg e `-rw_timeout` na leitura | F-12 |
| G-10 | Nenhum upload abandonado ocupa storage indefinidamente | Varredura com abort repetido e `UPLOAD_SESSION_TTL` < `MINIO_API_STALE_UPLOADS_EXPIRY` | F-09, F-10 |
| G-11 | A retomada só continua se o conteúdo for o mesmo | Checksum por parte recalculado a partir do arquivo selecionado de novo | F-11 |

**Ajustes de 2026-11-17 (`/plan-resolve`):**
- **G-06 e G-07 (AMB-3):** cada tentativa efetiva do worker grava os derivados numa chave própria, inclusive em reentregas concorrentes do mesmo `jobId`/`processing_run`. O banco identifica a tentativa vigente, e só ela publica o resultado, atualizando a referência da thumbnail no mesmo `UPDATE` condicional que confirma `ready`; tentativas obsoletas também não marcam `error`. Isso substitui a convergência por chave fixa citada na G-07 e nos cenários F-04 e F-05. Ver TD-12.
- **G-03 e G-04 (AMB-4):** o original fica numa chave exclusiva por sessão; a recuperação só confirma o objeto da chave da própria sessão, e a atualização do banco verifica que a sessão ainda é a válida do vídeo. Ver TD-02.
- **G-10:** a limpeza periódica também remove originais de sessões não confirmadas e derivados de tentativas obsoletas, com carência, sem excluir objetos referenciados nem objetos de sessões ou tentativas válidas. Ver TD-06 e TD-12.
- **G-02, G-05 e G-10 (AMB-6):** a varredura, a limpeza e a reconciliação rodam como Job Schedulers com identificadores estáveis no `video-worker`, em fila própria; não se assume execução exatamente uma vez nem pontualidade. Ver TD-12.

**Consolidação de 2026-11-17:**
- **F-04:** a frase "A thumbnail de um vídeo em `error` fica como lixo conhecido, a remover na limpeza de vídeos da Fase 04" é histórica. Regra vigente: derivados abandonados, como a thumbnail não referenciada de um vídeo em `error`, entram na limpeza periódica desta fase, com carência e sem excluir objetos referenciados pelo banco nem objetos de tentativas ainda válidas (revisões da TD-06 e da TD-12).
- **G-01, G-02, G-05, G-06, G-07 e G-10 (Phase A do plano):** os mecanismos vigentes são o bloqueio da linha do vídeo com claims por token (G-01 e G-02; P1 e P2), as recuperações por geração com retrato e ação pendente (G-05; P5), a tentativa vigente ordenada por (geração, `attemptsStarted`) com cerca (G-06 e G-07; P3) e a elegibilidade estável para exclusão (G-10; P4). Os mecanismos candidatos da tabela acima ficam como histórico. Os protocolos estão em `docs/phases/phase-03-videos/phase-03-videos.md`, "Data Model → Coordenação e fencing".
- **F-02 e F-03 (revisão de recuperações por geração da TD-12):** onde os cenários citam republicar "com o mesmo `jobId`", vale a regra vigente: o job ausente ou `completed` sem transição recebe uma geração nova reservada no banco (R1 de P5), com recuperação contada e sem `job.retry()`; o `add` repetido com o mesmo `jobId` continua ignorado dentro de uma geração.

#### Testes para o planejamento

Os testes simulam o estado intermediário diretamente na infraestrutura real, em vez de mockar o meio da operação. Exemplos:
- executar o `CompleteMultipartUpload` pelo SDK antes de chamar a API;
- remover o job do Redis;
- mover o job para `failed`;
- gravar um claim vencido;
- encerrar o worker à força.

Isso segue o guia de testes, que pede dependências configuradas reais, e prova o comportamento contra MinIO, Redis e Postgres de verdade. Nos testes, os prazos (`lockDuration`, carência da reconciliação e TTL da sessão) ficam curtos por configuração.

| ID | Teste | Prova | Camada |
|----|-------|-------|--------|
| T-01 | Concluir depois de o storage já ter concluído (o teste executa o Complete pelo SDK) | F-01, G-03 | Integração |
| T-02 | Duas conclusões em paralelo (`Promise.all`): uma única transição, um único job e uma segunda resposta coerente | F-06, G-01 | E2E |
| T-03 | Conclusão concorrente com reinício; conclusão concorrente com varredura, com a sessão no limite da expiração | F-07, F-08, G-01 | Integração |
| T-04 | Claim `completing` vencido, gravado pelo teste, é retomado | F-01, G-02 | Integração |
| T-05 | Abort seguido do envio de uma parte; a varredura confirma `NoSuchUpload` | F-09, G-10 | Integração |
| T-06 | Retomada com um arquivo que tem 1 byte alterado numa parte já enviada | F-11, G-11 | E2E |
| T-07 | Parte reenviada com outro conteúdo depois do registro (ETag divergente) e parte presente no storage mas não registrada | G-04 | Integração |
| T-08 | Vídeo em `processing` sem job (o teste remove o job) | F-02, G-05 | Integração |
| T-09 | Reconciliação com o job em cada estado: `waiting`, `delayed`, `active`, `failed` e `completed` | F-03, G-05 | Integração |
| T-10 | Job entregue para um vídeo já em `ready` ou `error`: nenhum FFmpeg e nenhuma gravação | G-08 | Integração |
| T-11 | Duas execuções do processor em paralelo para a mesma execução, mais uma execução obsoleta tentando gravar | F-05, G-06, G-07 | Integração |
| T-12 | Worker encerrado à força no meio do processamento, com `lockDuration` curto: há reentrega e, acima de `maxStalledCount`, o vídeo termina em `error` via reconciliação | F-12, G-05 | Integração (worker criado no teste); verificação manual com `docker compose kill video-worker` |
| T-13 | FFmpeg sem resposta (URL que não entrega bytes) termina por timeout | G-09 | Integração |
| T-14 | Erro transitório seguido de sucesso; erro permanente (mídia inválida) sem retentativa | G-08, TD-12 | Integração |

**Ajustes de 2026-11-17 (`/plan-resolve`):**
- **T-01 e T-04 (AMB-4):** também cobrem a recuperação com o objeto na chave da própria sessão e a conclusão atrasada de outra sessão, que não pode promover o próprio objeto nem substituir o original confirmado.
- **T-11 (AMB-3):** simula uma tentativa antiga terminando depois da atual e verifica o banco (só a tentativa vigente publica `ready` ou `error`) e o artefato referenciado.
- **Manutenção (AMB-6):** os testes da varredura, da limpeza e da reconciliação cobrem a repetição da mesma execução, várias instâncias registrando os mesmos schedulers e a proteção de objetos referenciados e de trabalhos ainda válidos.
- **Provas grandes (AMB-2):** ver a revisão da TD-15 — suíte regular com arquivos pequenos e limites configuráveis, mais uma prova documentada de 10 GB e o fluxo completo com vídeo válido até `ready`.
- **Situação:** nenhum teste foi executado.

**Consolidação de 2026-11-17 (Phase A do plano):**
- **T-01 e T-04:** também cobrem a releitura da conclusão quando a finalização perde a posse: 200 só com sessão `completed` e vigente, e 409 ou 410 nos demais casos (P2).
- **T-03:** também cobre dois reinícios simultâneos, que produzem uma sessão nova e um 409 `UPLOAD_SESSION_INITIATING` (P1).
- **T-05:** também cobre a compensação de `POST /videos` e o multipart sem registro, abortado só depois da posse por token (P1, P4).
- **T-09:** passa a cobrir reconciliações concorrentes sobre o mesmo retrato, o limite de recuperações, a ordem das leituras, a falha entre o banco e a fila, a retomada da mesma geração sem nova contagem, o executor atrasado, o job da geração vigente removido de fora e a coleta de jobs só depois da confirmação (P5).
- **T-11:** também cobre a entrega de geração antiga, que não assume a tentativa nem publica (P3).
- Nenhum desses testes foi executado.

### Divergências encontradas (código × documentação)

| ID | Divergência | Evidência | Encaminhamento |
|----|-------------|-----------|----------------|
| D-01 | O `CLAUDE.md` raiz diz que o `next-frontend/` não foi inicializado | Next 16.2.6, telas `app/(auth)/*`, BFF `app/api/auth/*`, Vitest e Playwright presentes | Atualizar na documentação da fase |
| D-02 | O `CLAUDE.md` raiz diz que o `nestjs-project/` "contém users, channels, videos, comments" | Só existem os módulos `auth`, `users`, `channels` e `mail` | Atualizar |
| D-03 | O `CLAUDE.md` raiz descreve worker, object storage e fila como containers existentes | O `compose.yaml` tem só `nestjs-api`, `db` e `mailpit`. O README já os marca como planejados, corretamente | Passa a ser verdade com a fase; revisar o texto |
| D-04 | O `nestjs-project/CLAUDE.md` lista só `nestjs-api` e `db` | O `mailpit` está no Compose e é usado pelos testes (`src/test/mailpit.ts`) | Atualizar junto com os novos serviços |
| D-05 | `phase-02-auth/TD-08` supõe throttling restrito ao `AuthModule` via `APP_GUARD` de módulo | Pela documentação do Nest, `APP_GUARD` é global independentemente do módulo. O `AppController` usa `@SkipThrottle()` | Afeta a Fase 03 diretamente (ver Consequências); registrar como Revision via `/decide` se a equipe quiser |
| D-06 | O guia de testes manda usar filesystem local para storage | `references/external-systems.md`, contra R-10 | Atualizar o guia (TD-15) |
| D-07 | O `Dockerfile.dev` usa `node:25.6.0-slim` | O Node 25 chegou ao fim de vida em 2026-06-01, e o Node 26 é LTS desde 2026-10-28. Base Debian bookworm, com FFmpeg 5.1 | Tarefa separada (fora do escopo) |
| D-08 | `createTestDataSource` lê `DB_DATABASE` | A chave do projeto é `DB_NAME`; hoje funciona só porque o padrão coincide | Tarefa separada |
| D-09 | O diagrama C4 tem `api → storage "Uploads"` e fila `TBD` | Com upload direto, os bytes vão do frontend ao storage | Atualizar o diagrama na fase |
| D-10 | O `.env.example` tem `MAIL_FROM="StreamTube" <noreply@streamtube.com>`, com `<` e `>` fora das aspas | Contraria a convenção de `.env` do `nestjs-project/CLAUDE.md` | Tarefa separada |
| D-11 | O CLAUDE.md define que subir o ambiente é só infraestrutura, nunca a aplicação Nest | O worker é código da aplicação, mas R-10 e a TD-15 exigem que ele esteja rodando para o e2e | Definir a convenção no planejamento (Q-07) |
| D-12 | O plano fala em "S3 ou MinIO" | As imagens oficiais `minio/minio` e `minio/mc` não podem ser baixadas anonimamente nem do Docker Hub nem do quay.io: pelo fluxo normal de token, o servidor não concede `pull`. A causa é inferida de fontes secundárias (ver Evidências da TD-08) | Coberto pela TD-08 |

**Encaminhamentos decididos em 2026-11-17 (`/plan-resolve`):** D-05 → Revision em `phase-02-auth/TD-08` e limites explícitos por rota (revisão da TD-02); D-06 → exceção ao guia registrada na TD-15, sem alterar o guia nesta fase (o encaminhamento "Atualizar o guia (TD-15)" da tabela é histórico); D-07 → imagem atual mantida, com versões registradas e reverificação na troca (TD-10); D-11 → o worker sobe pelo Compose, com a exceção documentada (TD-10, Q-07).

### Lacunas e validações pendentes (spikes sugeridos para o planejamento)

| ID | Validação | Afeta |
|----|-----------|-------|
| V-01 | O Silo (fork) aceita as variáveis `MINIO_*`, o `mc`, o CORS padrão com `ETag`, `MINIO_API_CORS_ALLOW_ORIGIN` e `MINIO_API_STALE_UPLOADS_EXPIRY`? A partir de quando ele conta a idade de um multipart incompleto? Hoje isso está confirmado só no código do MinIO arquivado | TD-02, TD-07, TD-08 |
| V-02 | **No servidor:** o storage rejeita, antes de gravar, um `UploadPart` cujo corpo tem tamanho diferente do `content-length` assinado, tanto maior quanto menor? Teste com SDK ou curl, contra a imagem fixada por digest | TD-03 (A ou B) |
| V-03 | URLs pré-assinadas geradas pelo AWS SDK 3.1170 com `WHEN_REQUIRED` são aceitas pelo Silo, sem parâmetros de checksum automáticos? | TD-07, TD-08 |
| V-04 | ffprobe/ffmpeg 5.1 sobre URL assinada funcionam com MP4 (inclusive com `moov` no fim) e WebM? Quais timeouts e reconexões usar? MOV fica fora da Fase 03 (Q-03) | TD-11, TD-13 |
| V-05 | Chrome e Firefox reproduzem e fazem seek após redirect para URL assinada? | TD-14 (validar na Fase 05) |
| V-06 | `bullmq` 6 + `@nestjs/bullmq` 11.0.5 + Redis 8 funcionam com Jest 30.3 em CommonJS? | TD-09 |
| V-07 | Quanto tempo e disco as provas grandes da TD-15 consomem no WSL2 e no CI? (a) Prova real de upload de 10.000.000.000 bytes, com interrupção, retomada e medição da responsividade da API durante o envio. (b) Fluxo completo com vídeo válido até `ready`, incluindo o tempo para gerar o vídeo. Não se exigem duas transferências de 10 GB nem o preenchimento artificial do vídeo até o tamanho exato | TD-15 |
| V-08 | **Em navegador real** (Chromium e Firefox via Playwright, numa página servida pela origem liberada no CORS): (a) o PUT de um `Blob` com o tamanho exato numa URL com `content-length` assinado retorna 200 e expõe o `ETag`? (b) um `Blob` de tamanho diferente é recusado? (c) um corpo em stream (`ReadableStream`, sem `Content-Length`) falha? (d) o preflight do CORS passa com o header de checksum? É uma prova técnica de infraestrutura, não implementação de frontend | TD-01, TD-03 |
| V-09 | Checksum por parte: o servidor aceita `x-amz-checksum-sha256` como header assinado (não içado para a query) numa URL pré-assinada de `UploadPart`? Recusa corpo divergente com `BadDigest`, devolve o checksum em `ListParts` e o exige no Complete? A combinação com `WHEN_REQUIRED` (TD-07) funciona? Quanto tempo um navegador leva para recalcular os checksums de 10 GB? | TD-02, TD-07, TD-08 |
| V-10 | Retentativa da conclusão no servidor escolhido: um segundo Complete depois do sucesso responde `NoSuchUpload`? Os guardas opcionais `If-None-Match: *` e `x-amz-mp-object-size` do Complete são suportados? | TD-02 |
| V-11 | BullMQ 6.7.7 no stack real: padrões de `lockDuration`, `stalledInterval` e `maxStalledCount` (a doc consultada é da 6.5.3); reentrega após a morte do worker; `add` com `jobId` existente em cada estado; `Job.retry()` para `failed` e `completed` | TD-10, TD-12 |

**Ajustes de 2026-11-17 (`/plan-resolve`):**
- **V-10:** passa a verificar também, no storage escolhido, a recuperação de conclusão parcial com chave por sessão e a conclusão atrasada de outra sessão (AMB-4).
- **V-11:** passa a validar várias instâncias registrando os mesmos Job Schedulers, repetição, reinício e recuperação após indisponibilidade do Redis ou do worker (AMB-6).
- **V-05:** adiada para a Fase 05, junto com a integração do player; o aceite de streaming e download da Fase 03 segue a revisão da TD-14 (AMB-1).
- **Situação:** nenhuma validação foi executada. Todas, exceto a V-05, são passos bloqueantes antes da implementação que depende delas (ver "Situação das decisões e provas").

**Consolidação de 2026-11-17:**
- **V-04 (Q-03):** passa a cobrir só MP4 e WebM. Texto anterior: "ffprobe/ffmpeg 5.1 sobre URL assinada funcionam com MP4 de `moov` no fim, MOV e WebM? Quais timeouts e reconexões usar?".
- **V-07 (AMB-2):** passa a medir a prova real de 10.000.000.000 bytes e o fluxo completo com vídeo válido até `ready`, conforme a revisão da TD-15. Texto anterior: "Quanto tempo e disco as duas provas de arquivo grande consomem no WSL2 e no CI? (a) Capacidade: 10.000.000.000 bytes sintéticos até a conclusão. (b) Fluxo completo: vídeo válido até `ready`, incluindo o tempo para gerá-lo e a viabilidade de chegar ao tamanho exato com preenchimento".
- Nenhuma das duas foi executada.
- **V-11 (revisão de recuperações por geração da TD-12):** o roteiro inclui também `attemptsStarted` crescendo estritamente dentro do job (entrega, retentativa por `attempts`/`backoff` e reentrega após stall); retenção com `removeOnComplete` e `removeOnFail` desligados, e `job.remove()` recusado para job `active`; `add` com `jobId` existente ignorado em cada estado; contador reiniciado num job removido e readicionado com o mesmo `jobId`; entrega de job removido que não consegue concluir nem falhar o job; e `attemptsMade` e `failedReason`. Não executada.

**Por que V-02 e V-08 decidem entre TD-03 A e B:**
- **Limitar os bytes durante o envio (A):** o storage recusa qualquer PUT cujo tamanho difere do assinado. Assim, uma sessão nunca grava mais que o plano, ou seja, mais que o tamanho declarado e já validado.
- **Rejeitar o excesso só na conclusão (B):** o objeto final continua protegido, mas, até a conclusão ou a expiração, cada parte pode gravar até 5 GiB. Isso dá até 750 GiB por sessão com 150 partes.
- **Por que testar o servidor e o navegador:** a A só vale se o servidor verificar o tamanho assinado (V-02) **e** se o navegador enviar exatamente esse tamanho. O `Content-Length` é um header proibido para scripts e é definido pelo navegador (V-08). Testar só com SDK ou curl prova o servidor, mas não o caminho do cliente real.

**Regra vigente (revisão da TD-03):** a TD-03 está decidida como A, condicionada a V-02 e V-08, ainda não executadas. Se uma delas falhar, a TD-03 é reaberta; a B não é adotada automaticamente, porque não dá a mesma garantia. O texto acima explica por que essas duas provas são decisivas.

Outras lacunas:
- A documentação do AWS SDK, do `@nestjs/bull` e do FFmpeg no Context7 não estava fixada na versão exata.
- Não foi encontrada documentação oficial do MinIO sobre o fim da distribuição.
  - O que está comprovado é o comportamento dos registries e o arquivamento no GitHub (Evidências da TD-08).
  - A causa vem de fontes secundárias.
  - O acesso autenticado às imagens oficiais não foi testado.
- Não foram pesquisados a compatibilidade do Valkey com o BullMQ nem o custo de storage em produção, que fica para a Fase 07.

### Dúvidas para o revisor

| ID | Dúvida | Recomendação provisória |
|----|--------|-------------------------|
| Q-01 | "10GB" significa 10 GB (10.000.000.000 bytes) ou 10 GiB (10.737.418.240 bytes)? | **Provisório:** 10 GB decimais, `VIDEO_MAX_SIZE_BYTES=10000000000` (150 partes de 64 MiB), que é a leitura literal de "GB" no SI. **Consequência:** um arquivo que o Windows exibe como "10 GB" (na verdade 10 GiB) fica acima do limite, então a mensagem de erro deve informar o limite em bytes. **Decisão pendente:** trocar para GiB muda só a variável e os exemplos dos testes de limite |
| Q-02 | Quem pode reproduzir e baixar um vídeo `ready` na Fase 03 (só o dono, qualquer autenticado ou o público)? Não-dono recebe 404 ou 403? | Só o dono e 404; ampliar nas Fases 04/05 |
| Q-03 | Quais formatos aceitar no upload (MP4 e WebM; MOV?) | `video/mp4` e `video/webm`; MOV só se o spike V-04 passar |
| Q-04 | Rascunho cuja sessão expirou: continua `draft`, podendo reiniciar o upload, ou é removido? Há endpoint de exclusão na Fase 03? | Mantém `draft` reiniciável; exclusão na Fase 04 |
| Q-05 | Reprocessar a partir de `error` entra na Fase 03? | Não; só as retentativas automáticas |
| Q-06 | O fork de terceiros `pgsty/silo` é aceitável depois de passar em V-01, V-03 e V-09? Ou prefere-se construir o MinIO a partir do fonte arquivado (TD-08 B), ou reabrir a decisão de storage (TD-08 C)? | Manter o Silo como alternativa pendente, fixado por tag e digest, condicionado às validações. Nenhuma compatibilidade é dada como comprovada antes delas |
| Q-07 | O `video-worker` sobe automaticamente com `docker compose up`, apesar da regra "só infraestrutura" do CLAUDE.md? | Subir com o Compose e registrar a exceção no CLAUDE.md |
| Q-08 | Uma janela de retomada de 24h é suficiente? | `UPLOAD_SESSION_TTL` de 24h com `MINIO_API_STALE_UPLOADS_EXPIRY` em 48h. Assim a varredura da aplicação aborta antes, e a limpeza do storage, que não é coordenada com ela, vira só rede de segurança |
| Q-09 | Polling basta para acompanhar o estado na Fase 03? | Sim; push fica fora do escopo |
| Q-10 | Ao retomar depois de selecionar o arquivo de novo, conferir **todas** as partes já enviadas (recalcular até 10 GB localmente) ou só uma amostra? | Todas. A amostragem deixa passar um arquivo alterado no meio. O custo é medido em V-09 |

**Respostas (2026-11-17, `/plan-resolve`):**

| ID | Resposta | Registrada em |
|----|----------|---------------|
| Q-01 | 10 GB decimais, `10000000000` bytes | TD-03 |
| Q-02 | Reprodução e download só pelo dono; não-dono recebe 404 | TD-14 |
| Q-03 | MP4 e WebM, com validação real de mídia e codecs; MOV fora desta fase | TD-11, TD-13 |
| Q-04 | Rascunho continua reiniciável após a expiração da sessão | TD-02, TD-04 |
| Q-05 | Sem reprocessamento manual; retentativas automáticas mantidas | TD-04, TD-12 |
| Q-06 | Silo é candidato condicionado às provas de compatibilidade; a compatibilidade não está aprovada | TD-08 |
| Q-07 | O worker sobe pelo Compose; a exceção à convenção é documentada | TD-10 |
| Q-08 | Retomada de 24h e limpeza do storage em 48h, condicionadas à confirmação do comportamento do servidor (V-01) | TD-02 |
| Q-09 | Polling é suficiente | TD-04 |
| Q-10 | Conferir todas as partes já recebidas na retomada, com memória limitada | TD-02 |

### Fontes e versões consultadas

| Biblioteca ou serviço | Instalada | Avaliada | Fonte | Observação |
|-----------------------|-----------|----------|-------|------------|
| NestJS (`@nestjs/core`, `common`) | 11.1.16 | 11.x (última 11.2.10; existe 12.5.1, ESM) | Context7 `/nestjs/docs.nestjs.com` (guards, rate limiting) | Confirmado que `APP_GUARD` é global |
| `@nestjs/throttler` | 6.5.0 | 6.5.0 | Context7 `/nestjs/docs.nestjs.com` | `@SkipThrottle`/`@Throttle` por rota |
| TypeORM | 0.3.28 | 0.3.28 | Context7 `/typeorm/typeorm/0.3.28` | `update` com critérios e coluna `enum` |
| `@aws-sdk/client-s3`, `@aws-sdk/s3-request-presigner` | — | 3.1170.0 (2026-11-16, CJS, Node ≥ 20) | Context7 `/aws/aws-sdk-js-v3` (branch main) | **Discrepância:** a doc do branch main foi consultada para a versão alvo 3.1170. `signableHeaders`, `unhoistableHeaders` e o comportamento de checksum devem ser revalidados no planejamento |
| `bullmq` | — | 6.7.7 (CJS; backends Redis e PostgreSQL) | Context7 `/taskforcesh/bullmq/v6.5.3` (important notes sobre locks e *double processing*, job ids, retrying jobs, stalled, graceful shutdown); changelog em docs.bullmq.io | **Discrepância de minor** (doc 6.5.3 × npm 6.7.7). Os padrões de `lockDuration` (30.000 ms) e `maxStalledCount` (1) vêm dessa doc e devem ser confirmados na 6.7.7 (V-11) |
| `@nestjs/bullmq` | — | 11.0.5 (CJS); 12.0.2 é ESM/Nest 12 | Context7 `/nestjs/bull` (sem versão); registro npm | `backendFactory` documentado; doc sem versão |
| `pg-boss` | — | 12.38.2 (ESM, Node ≥ 22.12) e 11.1.2 (CJS) | Context7 `/timgit/pg-boss/12.38.2` | Opção `db` para transação; adaptadores de ORM |
| tusd | — | v2.10.1 (2026-09-16) | Context7 `/tus/tusd/v2.10.1`; GitHub releases | Hooks, `-max-size`, buffer em disco do S3 store |
| `@tus/server`, `@tus/s3-store` | — | 2.4.7 e 2.1.0 (ESM) | Registro npm | Docs Context7 não aprofundadas (opção não recomendada) |
| `@uppy/aws-s3` | — | 6.3.1 (ESM; só referência de frontend) | Context7 `/websites/uppy_io` | Modelo `signRequest`; CORS com `ETag` |
| MinIO (servidor) | — | Código arquivado (master); última release `RELEASE.2025-10-15T17-29-55Z` | Context7 `/minio/docs` (limites, compatibilidade, CORS); fonte `cmd/api-router.go` e `internal/config/api/api.go`; GitHub API | O CORS padrão expõe `ETag`; `stale_uploads_expiry=24h`; `AbortIncompleteMultipartUpload` sem suporte. Para o acesso às imagens, ver "Evidências da TD-08" |
| `pgsty/silo`, `pgsty/mc` (fork de terceiros) | — | `RELEASE.2026-11-12T00-00-00Z` (índice `sha256:c20d112390b9a9ce8c11b8af95ad35bcaa62f4759663c09c936cd8d2b511f329`); mc `latest` (`sha256:b532278b7a3747dbab6fe45eebb40a653efa704e6758e24e9d9ec54fc96c1800`) | Registry do Docker Hub (fluxo de token) e API do catálogo; silo.pgsty.com | Sem doc no Context7. **Compatibilidade não validada** (V-01, V-03, V-09) |
| AWS S3 — multipart upload (guia) | — | — | [Uploading and copying objects using multipart upload](https://docs.aws.amazon.com/AmazonS3/latest/userguide/mpuoverview.html) | Registro próprio de PartNumber e ETag; listagem só para conferência; 1.000 partes por `ListParts`; sobrescrita de parte; abort com partes em trânsito; checksums por parte e numeração consecutiva; uploads concorrentes na mesma chave |
| AWS S3 — `CompleteMultipartUpload` (API) | — | — | [CompleteMultipartUpload](https://docs.aws.amazon.com/AmazonS3/latest/API/API_CompleteMultipartUpload.html) | Pode levar minutos; `200 OK` com erro no corpo; retentar em falha; `NoSuchUpload` ambíguo (abortado ou concluído); `InvalidPart`; `If-None-Match` e `x-amz-mp-object-size` opcionais |
| Redis (imagem oficial) | — | 8.8.4 (2026-11-12) | API do Docker Hub | — |
| FFmpeg / ffprobe | — | Debian bookworm `7:5.1.9-0+deb12u1` | Context7 `/websites/ffmpeg_ffmpeg-all` (protocolo http, `-ss`, `movflags faststart`, hls); `apt-cache policy` em `node:25.6.0-slim` | A doc reflete a versão atual do FFmpeg, não a 5.1; opções usadas existem há muitas versões, mas devem ser confirmadas |
| `fluent-ffmpeg` / `ffmpeg-static` | — | 2.1.3 (depreciado) / 5.3.0 | Registro npm | — |
| `nanoid` / `sqids` | — | 6.0.2 (ESM; `engines` exclui Node 25) / 0.3.0 (2023) | Registro npm | — |
| Jest | 30.3.0 | — | jestjs.io (ECMAScript Modules) | `require(esm)` só a partir do Jest 30.4, com `--experimental-vm-modules` e Node ≥ 24.9 |
| Node.js | 25.6.0 (imagem) | — | `nodejs/Release` (`schedule.json`) | Node 25 em fim de vida desde 2026-06-01 |
| Limites S3 | — | — | [AWS — Amazon S3 multipart upload limits](https://docs.aws.amazon.com/AmazonS3/latest/userguide/qfacts.html) | 10.000 partes; 5 MiB–5 GiB |

Fontes web complementares:
- [BullMQ — PostgreSQL backend](https://docs.bullmq.io/guide/postgresql) e [changelog](https://docs.bullmq.io/changelog) (v6.0.0 em 2026-07-30)
- [StableBuild — MinIO images disappeared from Docker Hub](https://www.stablebuild.com/blog/minio-images-disappeared-from-docker-hub). É fonte secundária. A alternativa via quay.io citada no artigo não estava acessível anonimamente em 2026-11-17: o token não concede `pull` (ver "Evidências da TD-08").
- [Silo — MinIO Is Dead, Long Live MinIO](https://silo.pgsty.com/blog/post/minio-resurrect/). É fonte do próprio fork, e as alegações de compatibilidade não foram validadas.
- [TT Lab — linha do tempo do fim do MinIO CE](https://ttlab.hopto.org/blog/2026-07-17-minio-archived-garage-seaweedfs-ceph-rgw?lang=en). Fonte secundária.
- [CNCF Distribution — Token Authentication Specification](https://distribution.github.io/distribution/spec/auth/token/). Descreve o fluxo de desafio, token e manifesto usado nas evidências.
- [Jest — ECMAScript Modules](https://jestjs.io/docs/ecmascript-modules)
- [Uppy — AWS S3](https://uppy.io/docs/aws-s3/)
- [tusd — S3 storage e hooks](https://tus.github.io/tusd/)
- [FFmpeg — documentação completa](https://ffmpeg.org/ffmpeg-all.html)
- [MDN — HTTP range requests](https://developer.mozilla.org/en-US/docs/Web/HTTP/Range_requests)


### Situação das decisões e provas (`/plan-resolve`, 2026-11-17)

Legenda:
- **aprovada:** decisão arquitetural aprovada, sem prova pendente.
- **condicionada:** decisão condicionada a provas ainda não executadas. Cada prova é passo bloqueante antes da implementação que depende dela; se falhar, a TD é reaberta, sem adoção automática de alternativa com garantias menores.
- **executada e aprovada:** prova executada com sucesso. Nenhuma está nesta situação até esta data.
- **adiada:** verificação adiada para outra fase.

| TD | Situação | Provas |
|----|----------|--------|
| TD-01 | condicionada | V-08 |
| TD-02 | condicionada | V-01, V-09, V-10 |
| TD-03 | condicionada | V-02, V-08 |
| TD-04 | aprovada | — |
| TD-05 | aprovada | — |
| TD-06 | aprovada | — (a compatibilidade do storage segue as provas da TD-07 e da TD-08) |
| TD-07 | condicionada | V-01, V-03, V-09 |
| TD-08 | condicionada | V-01, V-03, V-09 |
| TD-09 | condicionada | V-06, V-11 |
| TD-10 | condicionada | V-04, V-11 |
| TD-11 | condicionada | V-04 |
| TD-12 | condicionada | V-11 |
| TD-13 | condicionada | V-04 |
| TD-14 | aprovada | V-05 adiada para a Fase 05 |
| TD-15 | aprovada | V-07 (bloqueia só o agendamento da prova grande) |

| Prova | Estado | Bloqueia |
|-------|--------|----------|
| V-01 | não executada | integração com o storage (TD-02, TD-07, TD-08) |
| V-02 | não executada | envio de partes (TD-03) |
| V-03 | não executada | integração com o storage (TD-07, TD-08) |
| V-04 | não executada | processamento e validação de mídia (TD-10, TD-11, TD-13) |
| V-05 | adiada para a Fase 05 | — (o aceite de streaming e download da Fase 03 segue a TD-14) |
| V-06 | não executada | implementação da fila (TD-09) |
| V-07 | não executada | agendamento da prova grande (TD-15) |
| V-08 | não executada | envio de partes (TD-01, TD-03) |
| V-09 | não executada | ciclo da sessão e integração com o storage (TD-02, TD-07, TD-08) |
| V-10 | não executada; ampliada para recuperação e conclusão atrasada de outra sessão | ciclo da sessão (TD-02) |
| V-11 | não executada; ampliada para várias instâncias, repetição, reinício e recuperação, e para os cenários de geração e retenção (revisão de recuperações por geração da TD-12) | fila, worker e manutenção (TD-09, TD-10, TD-12) |

### Referências não copiadas

- **Evidências da TD-08** (comandos do fluxo de autenticação do registry, resultados por referência exata, dados do GitHub e leitura fato × inferência × não testado): `docs/decisions/technical-decisions-phase-03-videos.md`, seção "Evidências da TD-08 — acesso às imagens do MinIO".
- **Consequências para contratos, autorização, eventos e transições** (contratos da API chamados pelo BFF, contrato do futuro cliente de upload sem implementação na Fase 03, autorização, eventos, transições de estado do vídeo e da sessão, persistência e documentação a atualizar): `docs/decisions/technical-decisions-phase-03-videos.md`, seção de mesmo nome. Os contratos de frontend ali descritos são insumo para fases futuras. A seção foi consolidada em 2026-11-17 com as revisões vigentes: original em chave exclusiva por sessão, com verificação da sessão válida; derivados por tentativa efetiva; só a tentativa vigente publica `ready` ou `error`; limpeza dos objetos abandonados nesta fase; sincronização de `openapi.json` e `types.gen.ts` como manutenção do contrato; exceção ao guia de testes registrada na TD-15, sem alterar o guia. A redação anterior está na subseção "Trechos substituídos na consolidação de 2026-11-17". A conciliação da Phase A do plano acrescentou à mesma seção os estados `initiating`, o protocolo de intenção, a resposta da conclusão por releitura, `expectedSize`, a geração no `jobId`, a retenção dos jobs e as guardas de retrato; os protocolos completos (P1–P5) estão no plano.

## Observações do revisor para a validação

_Registradas a pedido do usuário em 2026-11-17 como insumo para o `/plan-validate`. Não são decisões nem achados desta etapa._

_Encaminhadas pelo `/plan-resolve` em 2026-11-17: OR-01 → AMB-3 (`phase-03-videos/TD-12`); OR-02 → AMB-4 (`TD-02`); OR-03 → AMB-5 (`TD-03`, sem fallback automático); OR-04 → AMB-2 (`TD-15`); CE-01 → IC-4 (regeneração do contrato OpenAPI autorizada como manutenção); CE-02 → sem issue (herança só como contrato)._

_Regra vigente (consolidação de 2026-11-17); o texto das observações abaixo é histórico: OR-01 — derivados em chave por tentativa efetiva, e só a tentativa vigente publica `ready` ou `error`; OR-02 — original em chave exclusiva por sessão, com verificação da sessão válida no `UPDATE`; OR-03 — sem fallback automático: se V-02, V-08 ou V-09 falharem, a TD afetada é reaberta; OR-04 — a recomendação de duas provas grandes foi substituída pela revisão da TD-15 (suíte regular com arquivos pequenos, uma prova real de 10.000.000.000 bytes e o fluxo completo com vídeo válido até `ready`)._

| ID | Observação | Insumos relacionados |
|----|------------|----------------------|
| OR-01 | **Proteção das gravações no storage contra execuções obsoletas, além das guardas no banco.** As garantias atuais cobrem a transição terminal no banco (G-06, `UPDATE` condicional com o número da execução), a convergência por chave fixa e frame determinístico (G-07) e a releitura do estado antes dos efeitos (G-08). Verificar o que impede uma execução obsoleta de gravar ou sobrescrever objetos no storage (thumbnail e quaisquer derivados) depois da execução corrente, inclusive quando ela passou pela releitura e perdeu a vez antes de gravar. | F-04, F-05, G-06, G-07, G-08, T-11; TD-06, TD-10, TD-12 |
| OR-02 | **Associação entre objeto e sessão ao recuperar uma conclusão parcialmente realizada.** Na F-01 e na G-03, a recuperação desambigua `NoSuchUpload` com `HeadObject` e aceita o objeto que existe com o tamanho declarado. Verificar como a recuperação comprova que o objeto foi montado **por esta sessão**, e não por outra sessão ou por um reinício na mesma chave (pela documentação da AWS, uploads concorrentes na mesma chave podem prevalecer uns sobre os outros). | F-01, F-07, G-02, G-03, T-01, T-04; TD-02, TD-06; V-10 |
| OR-03 | **Fallbacks de checksum e de limite de tamanho têm garantias diferentes e não são equivalentes.** Limite: na TD-03 A, o storage limita os bytes durante o envio (`content-length` assinado; depende de V-02 e V-08); na TD-03 B, o excesso só é rejeitado na conclusão, com até 750 GiB por sessão de 150 partes. Checksum: verificado pelo storage (`x-amz-checksum-sha256` assinado, `BadDigest`, checksum em `ListParts` e no Complete; depende de V-09) ou apenas declarado à API. Se uma validação falhar e o plano adotar o fallback, registrar a garantia perdida e os testes que mudam, em vez de tratá-lo como substituto equivalente. | TD-02, TD-03, TD-07; G-04, G-11; V-02, V-08, V-09; Q-10 |
| OR-04 | **Requisitos do desafio × recomendações de testes.** Os requisitos obrigatórios são R-01 a R-11. Os testes T-01 a T-14 e as duas provas de arquivo grande da TD-15 (capacidade de upload com 10.000.000.000 bytes sintéticos; fluxo completo com vídeo válido até `ready`) são **propostas de validação**, não requisitos do desafio. A recomendação provisória da TD-15 trata as duas provas como exigidas para a entrega; isso continua sendo recomendação pendente. A execução das provas grandes deve considerar tempo e espaço em disco (V-07). | R-02, R-10; TD-15; T-01 a T-14; V-07 |

### Conflitos e limites de escopo registrados para a validação

_Registrados a pedido do usuário na seleção dos documentos correlatos (2026-11-17). Ficaram abertos para o primeiro `/plan-validate` e foram encaminhados pelo `/plan-resolve` em 2026-11-17 (ver a nota da seção anterior): CE-01 → IC-4, resolvido; CE-02 → sem issue._

| ID | Registro | Origem |
|----|----------|--------|
| CE-01 | **Sincronização do contrato OpenAPI × frontend fora da fase.** Os novos endpoints de vídeo mudam o `openapi.json` exportado pelo backend (`openapi-docs-nestjs/TD-02`). Pelas `next-frontend-openapi-typing/TD-02` e `TD-03`, a cópia commitada em `next-frontend/openapi.json` e o `types.gen.ts` precisam ser sincronizados de novo, e a verificação de atualização no CI, quando ativa, falha se não forem. Isso toca arquivos dentro de `next-frontend/`, cuja implementação está fora desta fase. A validação deve decidir se a sincronização desses artefatos conta como implementação de frontend. | `openapi-docs-nestjs/TD-02`; `next-frontend-openapi-typing/TD-02`, `TD-03` |
| CE-02 | **TDs de frontend herdadas valem só como contrato.** `phase-02-auth-frontend/TD-01` a `TD-07` (herança de fases), `next-frontend-config-base/TD-03` e `next-frontend-openapi-typing/TD-02` e `TD-03` (correlação) entram como contexto de contrato: BFF estrito, `API_URL` só no servidor, URLs pré-assinadas para a transferência direta com o storage e origem/sincronização do contrato OpenAPI. Nenhuma delas autoriza implementação de frontend nesta fase. | Seleção do usuário; `## Inherited Decisions Detail` |

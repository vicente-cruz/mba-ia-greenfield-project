---
scope_type: phase
related_phases: [3]
status: decided
date: 2026-11-17
scope_description: "Fase 03 — upload direto e retomável de vídeos de até 10GB para S3/MinIO, pré-cadastro como rascunho no canal do usuário, fila e worker FFmpeg/ffprobe para metadados e thumbnail, estados do vídeo, URL única, streaming com requisições parciais, download, infraestrutura real no Docker Compose e estratégia de prova por testes."
---

# Technical Decisions — Fase 03: Upload e Processamento de Vídeos

_Subprojects in scope:_

- `nestjs-project/` — subprojeto principal. Recebe o módulo de vídeos (entidade, migration, endpoints de controle do upload, emissão de URLs de reprodução e download), a integração com a S3 API, a publicação de jobs, o entrypoint do worker FFmpeg e os novos serviços do `compose.yaml` (storage, fila e worker). Todas as TDs abaixo incidem aqui.
- `next-frontend/` — **sem implementação nesta fase**, porque o escopo pedido exclui o frontend. Não há TD com escopo apenas de frontend. As TDs `Cross-layer` (TD-01, TD-02, TD-03, TD-04, TD-05, TD-13 e TD-14) fixam os contratos que o futuro cliente de upload e o player vão consumir, respeitando o BFF estrito herdado.
- **Delimitação de escopo (2026-11-17, `/plan-resolve`, IC-1 e IC-4):** a Fase 03 não implementa telas, componentes, player nem rotas BFF de vídeo. A regeneração de `next-frontend/openapi.json` e de `types.gen.ts` pelo script de sincronização do contrato (`next-frontend-openapi-typing/TD-02` e `TD-03`) é permitida como manutenção do contrato e não inclui funcionalidades de frontend.

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

---

## Requisitos obrigatórios × recomendações

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

---

## TD-01: Protocolo de upload direto e retomável

**Scope:** Cross-layer

**Capability:** Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance

**Context:** R-02 e R-03 exigem que os bytes não passem pela API e que o envio possa ser retomado. Na S3 API, um PUT único aceita no máximo 5 GiB, então 10GB exige multipart: até 10.000 partes de 5 MiB a 5 GiB cada (limites iguais na AWS e no MinIO). O BFF estrito e a sessão em cookie httpOnly impedem o navegador de chamar a API Nest com bearer token. O único destino direto permitido ao navegador é o storage, usando uma credencial delegada. A decisão afeta o backend (endpoints de controle) e o futuro cliente (fatiamento, paralelismo e retentativas).

Alternativas descartadas por violarem requisitos:
- Proxy do arquivo pela API (multer ou stream): os bytes passam pela API, contra R-02.
- PUT ou POST único pré-assinado: limite de 5 GiB e nenhuma retomada, contra R-02 e R-03.
- `@tus/server` embutido no processo Nest: os bytes atravessam a API, contra R-02.

**Options:**

### Option A: S3 Multipart com URLs pré-assinadas por parte, orquestrado pela API
- A API cria o rascunho e o `CreateMultipartUpload`, calcula o plano de partes e assina `UploadPart` sob demanda, em lotes. O navegador envia cada parte direto ao storage com PUT e informa à API o `ETag` devolvido. A API conclui com `CompleteMultipartUpload` a partir do próprio registro de partes, conferido por `ListParts` (TD-02).
- **Pros:** nenhum byte passa pela API ou pelo BFF. A retomada é nativa por parte: o storage guarda as partes até a conclusão ou o abort. Usa só a S3 API, portanto é portável para AWS S3 e qualquer servidor compatível. Não cria serviço além do storage. Encaixa no BFF: o controle passa por `/api/**` e os dados vão direto ao storage.
- **Cons:** a API passa a implementar a orquestração (sessão, plano, assinatura em lote e conclusão). Exige CORS no storage e um endpoint público alcançável pelo navegador (TD-07). Clientes prontos como Uppy 6 (`@uppy/aws-s3`, `signRequest`) assumem que o navegador executa Create e Complete, então exigem adaptação ou um uploader próprio pequeno.

### Option B: Protocolo tus com servidor `tusd` dedicado (S3 store)
- Um novo serviço `tusd` (Go, v2.10.1) no Compose grava no MinIO via multipart. Hooks HTTP (`pre-create` e `post-finish`) chamam a API para autorizar o envio e disparar o processamento. No cliente, `tus-js-client` ou o plugin Tus do Uppy.
- **Pros:** protocolo aberto de retomada (offset via `HEAD`), cliente maduro e limite nativo com `-max-size`. A API também não vê os bytes.
- **Cons:** é um novo serviço público, alcançável pelo navegador e com credencial própria. Como o token mora no cookie do BFF, seria preciso um token de upload emitido pela API e validado no hook. O tusd grava cada parte em disco local antes de enviá-la ao S3, o que dobra disco e I/O. Cria objetos `.info` e `.part` no bucket e acrescenta outro contrato (os hooks) para testar.

### Option C: tus com `@tus/server` + `@tus/s3-store` em serviço Node dedicado
- Igual à B, mas o servidor tus é um processo Node separado, no mesmo repositório, com a autorização escrita em TypeScript.
- **Pros:** os hooks viram código TS, reaproveitando config e entidades, e o protocolo continua sendo o tus.
- **Cons:** os pacotes são ESM-only (`@tus/server` 2.4.7 e `@tus/s3-store` 2.1.0) num projeto CommonJS com Jest 30.3, que não faz `require(esm)`. Os bytes atravessam um processo Node nosso, que precisaria escalar como serviço de dados. O problema da credencial do navegador é o mesmo da B.

**Recommendation:** **Option A.** É a única em que nenhum processo nosso transporta os bytes. A URL pré-assinada por parte resolve o conflito com o BFF estrito sem criar um segundo serviço público autenticado. O custo é a orquestração na API, que é lógica de controle leve e testável contra MinIO real. A B é a alternativa válida se a equipe preferir um protocolo de retomada padronizado em troca de mais um serviço e de um token de upload.

**Decision:** A (S3 Multipart com URLs pré-assinadas por parte, orquestrado pela API) — condicionada a V-08
**Libraries:** @aws-sdk/client-s3@^3.1170.0, @aws-sdk/s3-request-presigner@^3.1170.0

**Revisions:**
- 2026-11-17 — Situação: decisão condicionada à prova V-08 (PUT de `Blob` em navegador real com `content-length` assinado, exposição do `ETag` e preflight do CORS com o header de checksum), ainda não executada. A V-08 é passo bloqueante antes da implementação do envio de partes; se falhar, esta TD é reaberta, sem adoção automática de alternativa com garantias menores. Rationale: /plan-resolve (OQ-1, OQ-33); a V-08 é prova técnica de infraestrutura, não implementação de frontend.
- 2026-11-25 — Situação: **mantida, sem alteração**.
  - **Condição:** a V-08 foi aprovada em 2026-11-18.
  - **Reabertura:** em 2026-11-24, a P-10GB (execução `20261124215534-349fa9`) saiu `reprovada` nos critérios de latência (a) e (b) do R-02 e reabriu esta TD pela regra das provas, sem fallback (`docs/phases/phase-03-videos/proofs/P-10GB.md`).
  - **Encerramento:** a reabertura fica encerrada pela repetição formal da P-10GB (registro prévio r3, execução `20261125142232-bc4b5d`), aprovada na revisão no cenário efetivamente validado: a API e as sondas compiladas, o cliente nativo do Windows e 13 sondas (`docs/phases/phase-03-videos/proofs/P-10GB-repeticao.md`).
  - **O que não foi provado:** a causa dos atrasos da execução original não foi comprovada de forma definitiva, e a execução aprovada teve três respostas acima de 500 ms (`docs/phases/phase-03-videos/proofs/R-02-diagnostico.md`).
  - **Rationale:** revisão da SI-03.33.

---

## TD-02: Ciclo de vida da sessão de upload — início, retomada, conclusão e abandono

**Scope:** Cross-layer

**Capability:** Transversal — covers: "Pré-cadastro automático do vídeo como rascunho ao iniciar o upload", "Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance"

**Context:** Depende da TD-01 e assume a Option A. Falta decidir:
- o que a API registra de cada parte e como confere esse registro com o storage;
- quem confirma a conclusão, o que dispara `draft → processing` (ver TD-04);
- como provar que o arquivo selecionado de novo é o original;
- como limpar uploads abandonados.

**O que a documentação oficial da AWS determina.** Fontes: [Uploading and copying objects using multipart upload](https://docs.aws.amazon.com/AmazonS3/latest/userguide/mpuoverview.html) e [CompleteMultipartUpload](https://docs.aws.amazon.com/AmazonS3/latest/API/API_CompleteMultipartUpload.html), consultadas em 2026-11-17.
- **Registro obrigatório:** "For each part upload, you must record the part number and the ETag value. You must include these values in the subsequent request to complete the multipart upload."
- **Listagem só confere:** "Use the returned listing only for verification." E também: "Do not use the result of this listing when sending a complete multipart upload request. Instead, maintain your own list of the part numbers that you specified when uploading parts and the corresponding ETag values that Amazon S3 returns."
  - Por isso, concluir **apenas** com base em `ListParts`, como propunha a versão anterior desta TD, contraria a orientação oficial.
- **Limites da listagem:** `ListParts` devolve no máximo 1.000 partes por chamada, então é preciso paginar. A listagem também "doesn't include parts that haven't finished uploading".
- **Sobrescrita:** reenviar um número de parte já usado sobrescreve a parte anterior.
- **Abort com partes em trânsito:** "If part uploads were in progress, they can still succeed or fail even after you stop the upload."
- **Conclusão:**
  - O `CompleteMultipartUpload` pode levar minutos e pode devolver `200 OK` com erro no corpo (o SDK detecta).
  - Em caso de falha, deve ser retentado.
  - O erro `NoSuchUpload` diz que o upload "might have been aborted or completed". Numa retentativa, portanto, ele é **ambíguo**.
- **Checksums adicionais:** as partes precisam ser numeradas consecutivamente a partir de 1, e o Complete precisa incluir o checksum de todas as partes.
- **Uploads concorrentes para a mesma chave:** num bucket sem versionamento, outra requisição recebida entre o início e a conclusão pode prevalecer.

**Fatos sobre o MinIO.** Foram conferidos no código-fonte arquivado e ainda precisam ser confirmados no fork (V-01).
- O MinIO **não** suporta a ação de lifecycle `AbortIncompleteMultipartUpload`.
- O MinIO remove sozinho multiparts incompletos após 24h, com varredura a cada 6h (`MINIO_API_STALE_UPLOADS_EXPIRY` e `MINIO_API_STALE_UPLOADS_CLEANUP_INTERVAL`).
  - A remoção acontece entre 24h e cerca de 30h depois do início.
  - Ela não é coordenada com a aplicação.

**Restrição do cliente.** O navegador não preserva o `File` entre recargas, então, para retomar depois de recarregar a página, o usuário precisa selecionar o arquivo de novo.
- **Nome e tamanho não provam que o conteúdo é o mesmo.** Outra exportação do mesmo vídeo pode ter nome e tamanho iguais e bytes diferentes.
- Montar o objeto com partes de dois arquivos gera um vídeo corrompido, que nem sempre falha no processamento.

**Cenários de falha e concorrência que esta TD cobre.** Garantias e testes estão em "Cenários de falha, concorrência e repetição".
- F-01: o storage concluiu o upload, mas o banco não foi atualizado.
- F-06: duas conclusões ao mesmo tempo.
- F-07: conclusão concorrente com reinício da sessão.
- F-08: conclusão concorrente com a limpeza.
- F-09: abort com partes ainda em trânsito.
- F-10: a limpeza automática do storage age sobre um upload ainda ativo.
- F-11: o arquivo selecionado de novo é diferente do original.

**Options:**

### Option A: Controle centralizado na API, com registro próprio das partes e `ListParts` só para conferência
- **Início:** um `POST` cria o vídeo em `draft` e executa o `CreateMultipartUpload`, declarando o algoritmo de checksum por parte (V-09). Registra a sessão: `uploadId`, plano com o tamanho de cada parte, expiração e estado `active`.
- **Assinatura:** o cliente pede URLs informando o número de cada parte e o SHA-256 que calculou localmente.
  - A API aceita só números do plano e guarda o checksum esperado.
  - Assina o `UploadPart` com o `content-length` (TD-03) e o header de checksum. Assim o storage recusa bytes que não correspondem ao checksum declarado.
- **Registro:** após cada PUT bem-sucedido, o cliente informa `{ partNumber, etag }`.
  - O aviso vai em lote, junto com o próximo pedido de assinatura, para poupar o orçamento do throttler.
  - A API grava um registro por número de parte, substituindo o anterior, assim como o storage sobrescreve a parte.
  - A API recusa registros de sessões que não estejam `active`.
- **Conferência:** a API percorre `ListParts`, paginado, e compara com o registro parte a parte. Cada parte cai numa de quatro classes:

  | Classe | Situação | Tratamento |
  |--------|----------|------------|
  | Confirmada | Presente no storage, com ETag, tamanho e checksum iguais ao registro | Entra na conclusão |
  | Ausente | Não está no storage | O cliente reenvia |
  | Divergente | ETag ou checksum diferente: a parte foi sobrescrita depois do registro | O cliente reenvia |
  | Não registrada | Está no storage, mas o cliente não confirmou (por exemplo, a conexão caiu entre o PUT e o aviso) | Só é aproveitada se o checksum recalculado pelo cliente coincidir com o do storage; senão, o cliente reenvia |

- **Retomada:** o `GET` da sessão devolve o plano, o estado da sessão e a classificação das partes.
  - Depois de selecionar o arquivo de novo, o cliente recalcula o checksum das partes confirmadas e o envia para conferência.
  - Qualquer divergência recusa a retomada com conflito de arquivo, e a sessão precisa ser reiniciada.
- **Conclusão:** exige todas as partes do plano confirmadas.
  - A lista do `CompleteMultipartUpload` sai do **registro da API** (PartNumber, ETag e checksum, em ordem crescente), nunca da listagem.
  - Em seguida, `HeadObject` confere que o tamanho do objeto é igual ao declarado.
- **Abandono:** abort explícito, mais uma varredura periódica das sessões vencidas. Por causa das partes em trânsito, o abort é repetido até `ListParts` responder `NoSuchUpload`.
- **Pros:**
  - Segue literalmente a orientação da AWS: registro próprio para concluir e listagem só para conferir.
  - Detecta parte sobrescrita, parte faltando e arquivo trocado antes de criar o objeto.
  - O cliente guarda só o `publicId`, então pode retomar em outra aba ou depois de recarregar a página.
  - A conclusão é síncrona e concentra as validações da TD-03 e as transições da TD-04.
  - Usa apenas a S3 API.
- **Cons:**
  - A API mantém uma tabela de partes e um contrato de registro, e mais chamadas de controle passam pelo BFF.
  - O cliente precisa calcular checksums. Isso custa CPU local, mas não exige carregar o arquivo inteiro na memória.
  - Depende de o servidor S3 aceitar checksum por parte em URL pré-assinada (V-09). Se não aceitar, ver a Recomendação.

### Option B: Operações S3 executadas pelo navegador, com assinatura da API (modelo `signRequest` do Uppy 6) e confirmação na API
- A API assina todas as operações (Create, UploadPart, ListParts, Complete e Abort). O navegador as executa direto no storage e, ao terminar, avisa a API, que confere com `HeadObject` e faz a transição.
- **Pros:** funciona sem adaptação com `@uppy/aws-s3` 6.x e reduz a lógica de orquestração na API.
- **Cons:** a API perde o controle do momento da conclusão. O objeto pode existir sem a confirmação, o que exige reconciliação. O tamanho só é validado depois de gravado. Ficam expostas mais operações assinadas, e o pré-cadastro passa a depender de a assinatura de "Create" acontecer na ordem certa.

### Option C: Confirmação dirigida por evento do storage (bucket notification)
- O navegador conclui o multipart com uma URL assinada, e o MinIO publica `s3:ObjectCreated:CompleteMultipartUpload` numa fila ou webhook. Um consumidor faz a transição do vídeo.
- **Pros:** desacoplamento total e nenhuma chamada extra do cliente.
- **Cons:** a configuração é específica do MinIO (na AWS seriam SNS, SQS ou EventBridge), e a distribuição do MinIO está instável (TD-08). O evento é entregue de forma assíncrona e at-least-once, então o cliente não recebe erros de validação. É mais difícil de testar, e a reconciliação continua necessária.

**Recommendation:** **Option A.** Ela segue a orientação oficial da AWS e concentra o pré-cadastro, a validação do limite e a transição de estado num único ponto síncrono da API. Como usa só a S3 API, também protege contra a incerteza da TD-08. Para funcionar, precisa de três complementos, cujos mecanismos finais ficam para o planejamento.

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

**Decision:** A (controle centralizado na API, com registro próprio das partes e `ListParts` só para conferência) — condicionada a V-01, V-09 e V-10
**Libraries:** @aws-sdk/client-s3@^3.1170.0, @aws-sdk/s3-request-presigner@^3.1170.0

**Revisions:**
- 2026-11-17 — Situação: decisão condicionada às provas V-01 (configuração e expiração de multipart no storage), V-09 (checksum por parte assinado e verificado pelo storage) e V-10 (retentativa da conclusão), nenhuma executada. São passos bloqueantes antes da implementação do ciclo da sessão. Se alguma falhar, esta TD é reaberta, sem fallback automático: um checksum apenas declarado à API não equivale ao verificado pelo storage. Rationale: /plan-resolve (OQ-2, OQ-26, OQ-34, OQ-35, AMB-5).
- 2026-11-17 — Chave do original exclusiva por sessão, por exemplo `originals/{videoId}/{sessionId}`, com identificadores gerados pelo servidor e nunca reutilizada entre sessões. O banco registra a chave do original confirmado, e a atualização verifica, no mesmo `UPDATE` condicional, que a sessão ainda é a sessão válida do vídeo. A recuperação de uma conclusão parcial (F-01) só confirma o objeto da chave da própria sessão, e a conclusão atrasada de outra sessão não promove o próprio objeto nem substitui o original confirmado. T-01 e T-04 cobrem esses dois casos, e a V-10 passa a verificá-los no storage escolhido. Esta revisão substitui, na Recommendation, a desambiguação de `NoSuchUpload` por `HeadObject` "na chave do vídeo" com aceitação pelo tamanho declarado. Rationale: AMB-4 (OR-02) — o tamanho não prova que o objeto pertence à sessão.
- 2026-11-17 — Limpeza periódica de objetos abandonados (multipart não concluído e originais de sessões não confirmadas), com carência e sem excluir originais referenciados pelo banco nem objetos de sessões ainda válidas. A execução segue a TD-12 (Job Schedulers no `video-worker`). Rationale: consequência da chave por sessão (AMB-4) e da G-10.
- 2026-11-17 — Retomada: `UPLOAD_SESSION_TTL` de 24h e `MINIO_API_STALE_UPLOADS_EXPIRY` de 48h, condicionados à confirmação, na V-01, de como o servidor conta a idade de um multipart incompleto. Na retomada, todas as partes já recebidas são conferidas por checksum, lendo uma parte por vez (memória limitada). Rascunho cuja sessão expirou continua `draft` e pode reiniciar o upload. Rationale: Q-08, Q-10 e Q-04.
- 2026-11-17 — Throttling: o throttler global herdado é preservado (ver a Revision de 2026-11-17 em `phase-02-auth/TD-08`). As rotas da Fase 03 (sessão de upload, assinatura em lote de partes, registro de ETags, conclusão, consulta de estado por polling e emissão de URLs) declaram limites explícitos, dimensionados para a assinatura em lote e para o intervalo de polling, sem desativar a proteção de forma indiscriminada. Rationale: IC-2 (D-05).
- 2026-11-17 — Coordenação de sessão e contratos (Phase A do plano, protocolos P1 e P2). A linha do vídeo serializa criação, reinício, claim, finalização e abort, em transações curtas sem chamadas ao storage. A sessão nasce em `initiating`, com chave e `claim_token` gravados antes do `CreateMultipartUpload`, e só vira `active` por ativação condicionada ao token; o índice parcial de `active` é só defesa adicional. Falha do storage em `POST /videos` é compensada com a remoção do vídeo e da sessão; um multipart sem registro é abortado pela varredura ou pela limpeza depois de assumirem a posse por token. Em reinícios simultâneos, um vence e o outro recebe 409 `UPLOAD_SESSION_INITIATING`; reinício e conclusão concorrentes se resolvem pelo claim sob o bloqueio do vídeo. A conclusão usa claim com token. Quando uma transição afeta zero linhas, ela relê o estado e responde 200 só se a sessão está `completed` e vigente; nos demais casos responde 409 `UPLOAD_SESSION_COMPLETING`, 409 `UPLOAD_COMPLETION_INTERRUPTED`, 409 `UPLOAD_SESSION_NOT_ACTIVE` ou 410 `UPLOAD_SESSION_EXPIRED`. Contratos: `part-urls` devolve `expectedSize` separado de `headers`, que contém só `x-amz-checksum-sha256`; o `content-length` continua assinado e é definido pelo navegador, e V-02 e V-08 continuam bloqueantes. O tamanho da parte é `min(part_size, size_bytes - (part_number - 1) * part_size)`. A conferência aceita lista vazia quando nenhuma parte foi recebida, e reassinar uma parte com outro checksum bloqueia a sessão. O DTO valida só a forma (400); o teto (413) e o tipo (415) são regras de domínio. Esta revisão fixa a proposta de estados da sessão desta TD, cujos nomes ficaram para o planejamento. Rationale: revisão da Phase A do plano (`phase-03-videos.md`), autorizada pelo usuário.
- 2026-11-18 — Provas da SI-03.4 no Silo fixado (V-02, V-09 na parte de servidor e V-10, aprovadas). (a) O corpo divergente de um `UploadPart` com `x-amz-checksum-sha256` assinado é recusado com HTTP 400 `XAmzContentChecksumMismatch` (a AWS usa `BadDigest`), depois de o corpo ser recebido e sem registrar a parte; esse é o código aceito para o Silo fixado, e nenhum outro 4xx equivale a ele. (b) O Complete sem os checksums das partes ou com um checksum errado é recusado, e os dois casos continuam obrigatórios. (c) O Complete da P2 não leva `If-None-Match: *` nem `x-amz-mp-object-size` nesta fase: o Silo ignora o `x-amz-mp-object-size`, e com `If-None-Match` a repetição do Complete responderia 412 em vez de `NoSuchUpload`, sem ganho com chaves exclusivas por sessão; a recuperação continua por `NoSuchUpload` e `HeadObject` na chave da sessão. A V-09 completa continua pendente da parte de navegador (SI-03.5), e a decisão segue condicionada a ela. Rationale: revisão da SI-03.4 (`proofs/V-09.md`, `proofs/V-10.md`).

---

## TD-03: Política e aplicação do limite de 10GB (unidade, plano de partes e verificação)

**Scope:** Cross-layer

**Capability:** Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance

**Context:** "10GB" é ambíguo: 10 GB são 10.000.000.000 bytes, e 10 GiB são 10.737.418.240 bytes. O Windows e vários navegadores exibem GiB com o rótulo "GB". Com URLs pré-assinadas o servidor não vê os bytes, então o limite precisa ser aplicado no plano de partes e na conclusão. Aceitar até 10GB é obrigatório; a unidade exata e o tamanho de parte são recomendações. Os parâmetros aparecem no Joi, no `.env.example`, na resposta da API e no cliente. Depende da TD-01 (Option A).

Há duas formas de aplicar o limite, e é isso que separa a Option A da B:

- **Limitar os bytes durante o envio (A).** Cada URL de parte leva o `content-length` exato daquela parte entre os headers assinados. O storage recusa um PUT com outro tamanho antes de gravá-lo, e a API só assina números de parte do plano. Reenviar o mesmo número de parte sobrescreve a anterior em vez de somar. Com isso, o máximo que uma sessão consegue ocupar no storage é o próprio plano, ou seja, o tamanho declarado, que já foi validado contra o limite. Nenhum byte excedente chega a ser armazenado.
  - **Navegador:** o `Content-Length` é um header proibido para scripts; quem o define é o próprio navegador, a partir do corpo. Um cliente legítimo que envia a fatia como `Blob` envia exatamente o tamanho assinado. Um corpo em stream, sem `Content-Length`, quebra a assinatura. Os dois comportamentos precisam ser provados num navegador real (V-08).
- **Rejeitar o excesso só na conclusão (B).** As URLs não fixam o tamanho, então cada PUT pode gravar até o máximo da S3, que é de 5 GiB por parte. O excesso só aparece quando a API soma o `ListParts` antes do `CompleteMultipartUpload`.
  - **O objeto final é protegido, mas o storage e a banda não.** Enquanto a sessão existe, um cliente malicioso com as 150 URLs do plano pode ocupar até 150 × 5 GiB = 750 GiB. Esse espaço só é liberado quando a conclusão é recusada e o upload abortado, ou quando a sessão expira (TD-02).
  - Encurtar o TTL das URLs e assinar poucas partes por vez reduz a janela, mas não a elimina.

**Options:**

### Option A: Tamanho declarado + plano fixo do servidor + `Content-Length` assinado por parte + verificação na conclusão
- O início valida `sizeBytes ≤ VIDEO_MAX_SIZE_BYTES`.
- O servidor fixa o `partSize`. Com 64 MiB, um arquivo de 10.000.000.000 bytes vira 150 partes: 149 de 67.108.864 bytes e a última de 779.264 bytes.
- O servidor só assina números de parte do plano, com o `content-length` exato de cada uma em `signableHeaders`, uma opção documentada do `@aws-sdk/s3-request-presigner`. A última parte é assinada com o seu tamanho próprio.
- Na conclusão, a API confere o tamanho de cada parte no `ListParts`, exige que a soma seja igual ao tamanho declarado e confere o `HeadObject`.
- **Pros:**
  - O excesso é barrado durante o envio e verificado de novo na conclusão.
  - O consumo do storage por sessão fica limitado ao tamanho declarado.
  - O cliente não decide o tamanho de parte, e há poucos pedidos de assinatura.
- **Cons:**
  - Depende de o servidor S3 verificar o `content-length` assinado (V-02) e de o navegador enviar exatamente esse valor (V-08).
  - O cliente não pode alterar o tamanho de parte.
  - O tamanho declarado precisa estar correto.

### Option B: Tamanho declarado + plano do servidor + verificação apenas na conclusão
- Igual à A, mas sem assinar `content-length`. O excesso só é detectado ao conferir o `ListParts` antes do `CompleteMultipartUpload`, e o upload é abortado se o limite for violado.
- **Pros:** não depende do comportamento de assinatura do servidor S3 nem do navegador, e é simples de implementar.
- **Cons:** o limite protege o objeto final, mas não o storage. Uma sessão pode acumular até 750 GiB com o plano de 150 partes, ocupando espaço e banda até o abort ou a varredura.

### Option C: Plano definido pelo cliente, dentro dos limites da S3 (5 MiB–5 GiB, ≤ 10.000 partes)
- O cliente escolhe o tamanho de parte, e o servidor valida os limites e assina o que for pedido.
- **Pros:** o cliente adapta a parte à rede, usando partes menores em conexões ruins.
- **Cons:** há mais combinações a testar, a verificação de tamanho continua dependendo da B, e o contrato fica mais largo sem benefício claro nesta fase.

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

**Decision:** A (tamanho declarado, plano fixo do servidor, `content-length` assinado por parte e verificação na conclusão) — condicionada a V-02 e V-08
**Libraries:** @aws-sdk/s3-request-presigner@^3.1170.0

**Revisions:**
- 2026-11-17 — Limite em unidades decimais: `VIDEO_MAX_SIZE_BYTES=10000000000` (10 GB), com `UPLOAD_PART_SIZE_BYTES=67108864` (150 partes; a última com 779.264 bytes). Testes de limite: 10.000.000.000 bytes aceito e 10.000.000.001 recusado; a mensagem de erro informa o limite em bytes. Rationale: Q-01.
- 2026-11-17 — Situação: decisão condicionada às provas V-02 (o storage recusa, antes de gravar, um `UploadPart` com corpo maior ou menor que o assinado) e V-08 (o navegador real envia exatamente o tamanho assinado), nenhuma executada. São passos bloqueantes antes da implementação do envio de partes. Se falharem, esta TD é reaberta; a Option B não é adotada automaticamente (isso substitui o "com fallback para a B" da Recommendation), porque rejeitar o excesso só na conclusão permite gravar até 750 GiB por sessão. Rationale: /plan-resolve (OQ-3, OQ-27, OQ-33, AMB-5).

---

## TD-04: Modelo de estados do vídeo e transições

**Scope:** Cross-layer

**Capability:** Transversal — covers: "Pré-cadastro automático do vídeo como rascunho ao iniciar o upload", "Processamento automático do vídeo após upload (extração de duração e metadados)", "Geração automática de thumbnail a partir de um frame do vídeo"

**Context:** O desafio fixa quatro estados — rascunho, processando, pronto e erro —, e isso é obrigatório. A Fase 04 traz "Fluxo de rascunho → publicação" e visibilidade, então a palavra "rascunho" aparece em dois eixos: o ciclo de upload e processamento, e a publicação. O enum é exposto na API (o cliente faz polling do estado) e no OpenAPI, o que o torna um contrato cross-layer.

**Options:**

### Option A: Enum persistido com exatamente os quatro estados; publicação como eixo separado na Fase 04
- `status ∈ {draft, processing, ready, error}`, mais `error_code` e `error_message`. O progresso do upload fica na sessão de upload (TD-02), não no enum. A Fase 04 adiciona publicação e visibilidade em colunas próprias, sem um quinto estado.
- **Pros:** corresponde 1:1 ao requisito, com transições simples e verificáveis. A Fase 04 estende o modelo sem migrar valores do enum.
- **Cons:** `draft` cobre tanto "aguardando upload" quanto "upload em andamento", e o detalhe vem da sessão. O "rascunho" da Fase 04 vai precisar de outro nome no modelo para não colidir.

### Option B: Enum interno mais granular, projetado nos quatro estados públicos
- Persiste `draft, uploading, uploaded, queued, processing, ready, error`, e a API projeta esses valores nos quatro estados.
- **Pros:** diagnóstico fino, como "upload concluído mas ainda não enfileirado".
- **Cons:** dois vocabulários a manter, um mapeamento propenso a erros, e um armazenamento que diverge do requisito.

### Option C: Estado único que também absorve a publicação (a Fase 04 adiciona `published`)
- O mesmo enum da A, estendido depois com `published` e `unlisted`.
- **Pros:** um campo só.
- **Cons:** mistura processamento e publicação (por exemplo, o que acontece ao reprocessar um vídeo publicado?). A Fase 04 teria de migrar o enum e reescrever regras.

**Recommendation:** **Option A.** Atende literalmente ao requisito e deixa a publicação como eixo independente. A granularidade da B já é coberta pelos dados da sessão de upload e da fila. Transições propostas:
- criação → `draft`;
- `draft` → `processing`, quando a conclusão é validada;
- `processing` → `ready`, com metadados e thumbnail prontos;
- `processing` → `error`, por falha permanente ou tentativas esgotadas;
- retentativas e reentregas em `processing` podem refazer o trabalho, mas só uma transição terminal é aceita por execução (TD-12);
- jobs de vídeos já em `ready` ou `error` terminam sem efeito.

A tabela completa está em "Consequências".

**Decision:** A (enum persistido com exatamente os quatro estados; publicação como eixo separado na Fase 04)
**Libraries:** —

**Revisions:**
- 2026-11-17 — Situação: decisão arquitetural aprovada, sem prova pendente. Rascunho com sessão expirada continua `draft` e reiniciável; não há reprocessamento manual a partir de `error` na Fase 03, só as retentativas automáticas; o acompanhamento do estado é por polling. Rationale: Q-04, Q-05 e Q-09.

---

## TD-05: Identificador público e URL única do vídeo

**Scope:** Cross-layer

**Capability:** URL única por vídeo, sem conflito com outros vídeos

**Context:** Os Pontos de Atenção pedem que "cada vídeo [tenha] uma URL curta e única que nunca conflite". A PK das entidades atuais é UUID. A URL pública (rota do frontend na Fase 05 e path da API) não deve depender das chaves de storage nem das URLs pré-assinadas, que são efêmeras. Os vídeos unlisted da Fase 05 exigem IDs não enumeráveis.

**Options:**

### Option A: ID curto aleatório (8 bytes de `node:crypto` → 11 caracteres base64url), com `UNIQUE` e retentativa
- Uma coluna `public_id varchar(11) UNIQUE`. A colisão, praticamente nula com 64 bits, é tratada com retentativa no erro `23505`, o mesmo padrão já usado em `ChannelsService`.
- **Pros:** curto, no estilo do YouTube, não enumerável e sem dependência nova. Evita o `nanoid` 6, que é ESM-only e cujo `engines` (`^22 || ^24 || >=26`) exclui o Node 25 do projeto. Desacopla o UUID interno.
- **Cons:** uma coluna e um índice a mais. O base64url diferencia maiúsculas de minúsculas; se for preciso evitar isso, base32 Crockford usa 13 caracteres.

### Option B: UUID da PK como identificador público
- **Pros:** nenhum código novo, e o valor já é único.
- **Cons:** a URL fica longa (36 caracteres), o que contraria a "URL curta", e expõe o identificador interno usado em chaves de storage e joins.

### Option C: Sqids sobre um `bigint` sequencial
- **Pros:** curto, determinístico e sem colisão.
- **Cons:** é reversível para quem conhece o alfabeto, o que revela volume e ordem de criação e permite enumerar vídeos unlisted. O `sqids` 0.3.0 não tem release desde 2023.

**Recommendation:** **Option A.** Dá uma URL curta e não enumerável com `node:crypto` nativo, reaproveita o padrão de retentativa existente e separa a identidade pública da PK e das chaves de storage (que usam o UUID interno, conforme a TD-06).

**Decision:** A (ID curto aleatório de 8 bytes de `node:crypto`, 11 caracteres base64url, com `UNIQUE` e retentativa)
**Libraries:** —

**Revisions:**
- 2026-11-17 — Situação: decisão arquitetural aprovada, sem prova pendente. Rationale: /plan-resolve (OQ-5).

---

## TD-06: Organização dos objetos e controle de acesso no bucket

**Scope:** Backend

**Capability:** Serviço de armazenamento de arquivos (vídeos e thumbnails)

**Context:** Originais de até 10 GB e thumbnails têm perfis de acesso diferentes. Os originais só devem ser lidos por URL assinada. As thumbnails vão aparecer em listagens anônimas nas Fases 05 e 07, e a Fase 04 traz thumbnail customizada. O nome de arquivo do usuário não deve entrar nas chaves, por risco de injeção de path, colisão e exposição de dados pessoais.

**Options:**

### Option A: Bucket único privado, com prefixos por tipo de artefato e acesso só por URL assinada
- Chaves `originals/{videoId}` e `thumbnails/{videoId}/auto.jpg`, sempre com o UUID interno. O nome original fica no banco e só volta ao usuário pelo `Content-Disposition` do download. A aplicação usa credenciais próprias, com política mínima, e não as de root.
- **Pros:** um único modelo de acesso. Com prefixo por tipo, dá para liberar no futuro a leitura anônima só de `thumbnails/` com uma policy de prefixo, sem mover objetos. As chaves determinísticas favorecem a idempotência (TD-12).
- **Cons:** até a decisão das Fases 05/07, as thumbnails também exigem URL assinada. Como a URL muda a cada pedido, o cache do navegador rende menos.

### Option B: Dois buckets (originais privados e thumbnails públicas)
- **Pros:** URLs estáveis e cacheáveis para thumbnails desde já.
- **Cons:** dois buckets, duas credenciais e duas policies. A thumbnail de um rascunho fica pública, e a fase decide agora uma questão de exibição que pertence às Fases 05/07.

### Option C: Bucket único com prefixo por vídeo (`videos/{videoId}/original`, `videos/{videoId}/thumbnail.jpg`)
- **Pros:** remove todos os artefatos de um vídeo apagando um prefixo.
- **Cons:** policies de leitura pública por tipo ficam mais difíceis (curingas no meio do caminho). Além disso, apagar pelas chaves conhecidas no banco já resolve a remoção.

**Recommendation:** **Option A.** Privado por padrão, reversível para thumbnails públicas quando houver listagem, e coerente com a autorização por estado do vídeo (TD-04 e TD-14). O cliente S3 recomendado é o AWS SDK v3 (`@aws-sdk/client-s3` e `@aws-sdk/s3-request-presigner`, 3.1170.0, CommonJS), que tem comandos tipados para multipart e presign.

**Decision:** A (bucket único privado, com prefixos por tipo de artefato e acesso só por URL assinada), com chave do original por sessão e derivados por tentativa
**Libraries:** —

**Revisions:**
- 2026-11-17 — Situação: decisão arquitetural aprovada; a compatibilidade do storage segue condicionada às provas da TD-07 e da TD-08. Rationale: /plan-resolve (OQ-6).
- 2026-11-17 — Chaves: o original fica numa chave exclusiva por sessão (por exemplo `originals/{videoId}/{sessionId}`, identificadores gerados pelo servidor, sem reuso entre sessões; ver TD-02). Os derivados ficam numa chave exclusiva por tentativa efetiva do worker (por exemplo `thumbnails/{videoId}/{attemptId}.jpg`; ver TD-12). O banco guarda a chave do original confirmado e a da thumbnail publicada. Bucket privado, prefixos por tipo de artefato, endpoints interno e público separados (TD-07). Rationale: AMB-4 (OR-02) e AMB-3 (OR-01).
- 2026-11-17 — Limpeza periódica de objetos abandonados (originais de sessões não confirmadas, multiparts incompletos e derivados de tentativas obsoletas), com carência e critérios de elegibilidade configuráveis. Nunca exclui objetos referenciados pelo banco nem objetos de sessões ou tentativas ainda válidas. Rationale: consequência das chaves por sessão e por tentativa.
- 2026-11-17 — Exclusão segura (Phase A do plano, protocolo P4). Um objeto só é excluído quando um fato do banco que nunca regride prova que nenhuma transição futura pode referenciá-lo: sessão `aborted`, chave sem registro depois da compensação, vídeo terminal, ou tentativa que perdeu a vigência para um token maior ou foi revogada por uma recuperação. Carência e releitura são só margem adicional. Os uploads de sessões `initiating` ou `aborting` com claim vencido só são abortados depois que a limpeza assume a posse por token. O `current_attempt_id` residual de um vídeo em `error` não protege nenhum objeto. Rationale: revisão da Phase A do plano, autorizada pelo usuário.

---

## TD-07: Topologia de endpoints do storage e contrato de variáveis de ambiente

**Scope:** Repo-wide

**Capability:** Transversal — covers: "Serviço de armazenamento de arquivos (vídeos e thumbnails)", "Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance", "Reprodução via streaming (sem necessidade de download completo)", "Download do vídeo pelo usuário"

**Context:** A assinatura SigV4 inclui o host. API e worker falam com o storage pela rede do Compose (`minio:9000`), mas o navegador, servido por `localhost:3001` noutra stack Compose, só alcança a porta publicada no host. Uma URL assinada para `minio:9000` não funciona no navegador, e o host não pode ser reescrito depois de assinado. O CORS precisa permitir a origem do frontend: o MinIO expõe `ETag` por padrão e restringe origens por `MINIO_API_CORS_ALLOW_ORIGIN` (padrão `*`, conferido no código-fonte). Essas chaves aparecem no Joi, no `.env.example`, no `compose.yaml` e nos helpers de teste.

**Options:**

### Option A: Dois endpoints explícitos — interno para operações e público só para assinar URLs do navegador
- `S3_ENDPOINT=http://minio:9000` atende as operações da API e do worker e as URLs internas do ffprobe. `S3_PUBLIC_ENDPOINT=http://localhost:9000` é usado só para assinar, offline, as URLs entregues ao navegador. Ambos com `forcePathStyle: true`.
- **Pros:** funciona com as stacks separadas. Em produção, `S3_PUBLIC_ENDPOINT` vira o domínio público ou a CDN sem mudar código, e não há tráfego extra.
- **Cons:** dois clientes S3 configurados, e os testes precisam cobrir as duas formas de URL.

### Option B: Um único hostname, resolvível pelos containers e pelo navegador (por exemplo, `s3.localhost` com `extra_hosts: host-gateway`)
- **Pros:** um cliente e uma URL.
- **Cons:** depende de o navegador resolver `*.localhost` e de `host-gateway` nos containers. O tráfego interno passa pelo host, e o arranjo é mais frágil entre sistemas operacionais e no CI.

### Option C: Reverse proxy no domínio do frontend (`/storage/*`)
- **Pros:** mesma origem, sem CORS.
- **Cons:** o proxy precisa preservar o host assinado. Feito pelo Next.js, os 10 GB passariam pelo BFF, contra R-02, e fora dele exige um nginx a mais.

**Recommendation:** **Option A.** O conjunto canônico de chaves a fixar no planejamento:
- **Storage:** `S3_ENDPOINT`, `S3_PUBLIC_ENDPOINT`, `S3_REGION`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_BUCKET`, `S3_FORCE_PATH_STYLE`.
- **Fila:** as chaves definidas pela TD-09.
- **Limites e prazos:** `VIDEO_MAX_SIZE_BYTES`, `UPLOAD_PART_SIZE_BYTES`, os TTLs das URLs de upload, reprodução e download, e `UPLOAD_SESSION_TTL`.
- **Container do storage:** `MINIO_API_CORS_ALLOW_ORIGIN` (origem do frontend) e `MINIO_API_STALE_UPLOADS_EXPIRY`.

O cliente S3 deve usar `requestChecksumCalculation` e `responseChecksumValidation` com o valor `'WHEN_REQUIRED'`. Assim as URLs pré-assinadas não recebem os checksums CRC32 e o `x-amz-checksum-mode` que o SDK adiciona por padrão. Isso não impede o checksum SHA-256 explícito por parte da TD-02, que precisa ir como header assinado e liberado no CORS; a combinação das duas configurações é validada em V-09.

**Decision:** A (dois endpoints explícitos: interno para operações e público só para assinar URLs do navegador) — condicionada a V-01, V-03 e V-09
**Libraries:** @aws-sdk/client-s3@^3.1170.0, @aws-sdk/s3-request-presigner@^3.1170.0

**Revisions:**
- 2026-11-17 — Situação: decisão condicionada às provas V-01 (variáveis `MINIO_*`, CORS com `ETag` e expiração de multipart no servidor escolhido), V-03 (URLs do AWS SDK 3.1170 com `WHEN_REQUIRED` aceitas sem parâmetros de checksum automáticos) e V-09 (header de checksum assinado e permitido pelo CORS), nenhuma executada. São passos bloqueantes antes da integração com o storage; se falharem, esta TD é reaberta. Os endpoints interno e público são configurados por variáveis de ambiente. Rationale: /plan-resolve (OQ-7, OQ-26, OQ-28, OQ-34).

---

## TD-08: Distribuição do MinIO no Docker Compose

**Scope:** Repo-wide

**Capability:** Serviço de armazenamento de arquivos (vídeos e thumbnails)

**Context:** A decisão herdada é S3/MinIO. R-10 exige o storage real no Compose e nos testes, reproduzível por qualquer desenvolvedor ou pelo CI sem credenciais. **Não se trata de reabrir "S3/MinIO"**, e sim de escolher de onde vem o binário ou a imagem.

Situação em 2026-11-17. Os comandos e as respostas completas estão em "Evidências da TD-08".

**Fatos confirmados por comando:**
- **GitHub:** os repositórios `minio/minio` e `minio/mc` estão arquivados (`archived: true`, último push em 2026-04-24 e 2025-11-20). A última release do `minio/minio` é `RELEASE.2025-10-15T17-29-55Z`, publicada em 2025-10-16.
- **Docker Hub:** foi usado o fluxo normal de autenticação anônima do registry, em três passos: desafio `401` com `WWW-Authenticate`, token emitido pelo `realm` e pedido do manifesto com `Bearer`.
  - Para `minio/minio` e `minio/mc`, o `auth.docker.io` emite um token **sem** a ação `pull` (`access: []`), e o manifesto responde `401 UNAUTHORIZED`. Isso vale para `latest`, para `RELEASE.2025-09-07T16-13-09Z` e para a última release.
  - O cliente Docker 29.8.2 (`docker buildx imagetools inspect`) falha com `pull access denied … insufficient_scope`.
  - A API do catálogo responde 404 `object not found`.
- **quay.io:** pelo mesmo fluxo, o token anônimo de `minio/minio` e `minio/mc` sai com `actions: []`, e os manifestos respondem 401. A API de repositório responde 401 `Requires authentication`.
- **Controles positivos:** pelo mesmo fluxo, `docker.io/library/redis:8.8.4`, `docker.io/pgsty/silo:RELEASE.2026-11-12T00-00-00Z` e `quay.io/prometheus/prometheus:latest` recebem token com `pull` e manifesto 200. O 401 dos repositórios do MinIO, portanto, **não** é falha do método: é a recusa do servidor de autorização em conceder `pull`.
- **Máquina:** não há credencial de registry configurada nem imagem MinIO ou Silo em cache local.
- **`pgsty/silo` no Docker Hub:** é um repositório público e ativo, registrado em 2026-08-06 e atualizado em 2026-11-12, com índice OCI fixável por digest.

**Inferências (não comprovadas):**
- **Removidos ou privados:** os repositórios oficiais foram removidos ou tornados privados. Para clientes anônimos, os registries não distinguem as duas situações; a própria mensagem do Docker diz "repository does not exist or may require authorization".
- **Acesso autenticado:** não foi testado. Ele não mudaria a conclusão para um Compose que precisa funcionar sem credenciais.
- **Causa:** a ideia de que a MinIO Inc. encerrou a distribuição gratuita de imagens vem de fontes secundárias (StableBuild, Pigsty/Silo e TT Lab). Esta pesquisa não encontrou um comunicado oficial.
- **Compatibilidade do Silo:** é uma alegação do próprio projeto ("drop-in"). Variáveis `MINIO_*`, `mc`, CORS, expiração de uploads, checksums e URLs assinadas não foram validados (V-01, V-03 e V-09).

**Options:**

### Option A: Fork comunitário `pgsty/silo` (derivado do MinIO Community Edition, mantido pelo Pigsty), com tag e digest fixos
- **Identificação:** é um **fork de terceiros**, não a distribuição oficial.
- **Imagens:** `pgsty/silo:RELEASE.2026-11-12T00-00-00Z` (índice `sha256:c20d1123…b511f329`) e `pgsty/mc`, ambas acessíveis anonimamente.
- **Licença:** AGPLv3, segundo o projeto.
- **Pros:**
  - Segundo o projeto, mantém a base de código do MinIO, inclusive os padrões de CORS e de expiração de uploads.
  - Publica correções de segurança.
  - Não exige build local.
- **Cons:**
  - É um projeto de terceiros, sem SLA, e o nome pode mudar por questão de marca.
  - **A compatibilidade não está comprovada.** Ela depende de V-01, V-03 e V-09 passarem.

### Option B: Imagem construída a partir do código-fonte arquivado do MinIO, com tag fixa
- **Pros:** código oficial, reprodutível e sem dependência de terceiros.
- **Cons:** congelado, sem correções de segurança. O build em Go acrescenta minutos ao setup e ao CI, e o repositório passa a manter um Dockerfile de infraestrutura.

### Option C: Outro servidor S3-compatível (RustFS 1.0.x, SeaweedFS ou Garage) _(exige reabrir a decisão herdada)_
- **Pros:** projetos ativos e com imagens oficiais. O código da aplicação não muda, porque depende só da S3 API.
- **Cons:** deixa de ser MinIO. As diferenças de compatibilidade (CORS, multipart pré-assinado, `ListParts`) precisam ser revalidadas, e a troca exige decisão explícita do responsável.

**Recommendation:** **Option A, como alternativa pendente e condicionada.** O Silo é um fork de terceiros, e nada nesta pesquisa comprova a sua compatibilidade.
- **Antes de decidir:** V-01, V-03 e V-09 precisam passar contra a imagem fixada por digest.
- **Se passarem:** a A preserva a decisão herdada com uma imagem mantida e sem custo de build.
- **Se falharem:**
  - a B mantém o código oficial do MinIO, sem correções novas, como solução temporária;
  - a C exige reabrir explicitamente a decisão herdada.

Como a aplicação usa só a S3 API via AWS SDK, trocar de servidor muda apenas configuração e infraestrutura, não o código.

**Decision:** A (fork comunitário `pgsty/silo`, com tag e digest fixos) — candidato condicionado a V-01, V-03 e V-09
**Libraries:** —

**Revisions:**
- 2026-11-17 — Situação: decisão condicionada. O Silo é o candidato, fixado por tag e digest, mas sua compatibilidade não está aprovada: V-01, V-03 e V-09 não foram executadas e são passos bloqueantes antes de qualquer implementação que dependa do storage. Se falharem, esta TD é reaberta entre a Option B (MinIO construído do código-fonte arquivado) e a Option C, sem adoção automática. Rationale: Q-06 (OQ-8, OQ-21).

---

## TD-09: Tecnologia de fila

**Scope:** Backend

**Capability:** Serviço de processamento em segundo plano (filas)

**Context:** O diagrama C4 deixa a fila como `TBD`, com a API publicando e o worker consumindo. Versões no npm em 2026-11-17:
- `bullmq` 6.7.7, CommonJS. A v6, lançada em 2026-07-30, introduziu backends plugáveis: Redis e **PostgreSQL**.
- `@nestjs/bullmq` 11.0.5, CommonJS, para Nest 10/11. Aceita `bullmq ^6` e a opção `backendFactory`. A linha 12.x é ESM e voltada ao Nest 12, então não serve.
- `pg-boss` 12.38.2 é ESM-only (Node ≥ 22.12). O último CommonJS é o 11.1.2.

O projeto compila para CommonJS e roda Jest 30.3, que não faz `require(esm)`. A skill `nestjs-best-practices` (regra `micro-use-queues`) e o guia de testes já preveem BullMQ.

**Options:**

### Option A: BullMQ + Redis via `@nestjs/bullmq` 11
- Um serviço `redis` (imagem oficial 8.x) no Compose. Filas, retentativas com backoff, `jobId` determinístico e schedulers para as varreduras periódicas.
- **Pros:** backend mais maduro do BullMQ, integração oficial com o Nest, padrão citado pelas skills do projeto e dashboards disponíveis. Corresponde ao container "Message Queue" do diagrama.
- **Cons:** mais um serviço, que consome memória e exige `maxmemory-policy noeviction`. Gera uma escrita dupla Postgres + Redis, mitigada na TD-12.

### Option B: BullMQ 6 com backend PostgreSQL, usando o mesmo `@nestjs/bullmq`
- `backendFactory: createPostgresBackend` e um schema `bullmq` no Postgres 17 já existente, com as migrations do BullMQ aplicadas via `runMigrations`.
- **Pros:** nenhuma infraestrutura nova, e a mesma API da A: trocar de backend é só configuração.
- **Cons:** o backend tem cerca de quatro meses. A documentação não prevê enfileirar dentro da transação da aplicação, então a escrita dupla continua. As migrations ficam fora do fluxo do TypeORM e precisam conviver com os `DELETE` que os testes fazem no mesmo banco.

### Option C: pg-boss (fila em PostgreSQL)
- **Pros:** maduro, sem infraestrutura nova, e `send(..., { db })` enfileira na mesma transação da mudança de estado, o que elimina a escrita dupla.
- **Cons:** não há módulo oficial para Nest, então seria preciso um provider próprio. A v12 é ESM-only e conflita com Jest 30.3 em CommonJS, e a 11.x (CommonJS) não recebe release desde 2025-11. Funciona por polling.

### Option D: RabbitMQ
- **Pros:** broker robusto, com ack, reentrega e DLX nativos.
- **Cons:** custo operacional maior. Retentativa com atraso exige DLX ou plugins, e a integração com o Nest é voltada a mensagens, não a jobs. Desproporcional para uma fila só.

**Recommendation:** **Option A.** É a combinação mais madura e alinhada às skills do projeto, e migrar para a B no futuro é só trocar o `backendFactory`. Se a equipe preferir não ter um serviço novo e aceitar ajustar Jest e ESM, a C é a alternativa com maior garantia transacional.

**Decision:** A (BullMQ + Redis via `@nestjs/bullmq` 11) — condicionada a V-06 e V-11
**Libraries:** bullmq@^6.7.7, @nestjs/bullmq@^11.0.5, ioredis@5.11.1

**Revisions:**
- 2026-11-17 — Situação: decisão condicionada às provas V-06 (`bullmq` 6 + `@nestjs/bullmq` 11.0.5 + Redis 8 com Jest 30.3 em CommonJS) e V-11 (padrões e comportamentos do BullMQ 6.7.7), nenhuma executada. São passos bloqueantes antes da implementação da fila; se falharem, esta TD é reaberta. Adiciona um serviço Redis, com imagem fixada por versão, ao Compose. Rationale: /plan-resolve (OQ-9, OQ-31, OQ-36).
- 2026-11-18 — Cliente Redis do BullMQ: `ioredis` 5.11.1, com versão exata, como dependência de produção. Desde a 6.0.0, o `bullmq` não instala mais o `ioredis`, que virou peer dependency opcional (`>=5.0.0`); sem ele, uma `Queue` com `connection: { host, port }` não carrega. Escolhida a versão estável mais recente da linha 5.x; `bullmq` 6.7.7 e `@nestjs/bullmq` 11.0.5 mantidos. Uma verificação pontual no container (carga em CommonJS, conexão ao Redis real, um job processado e encerramento das conexões) passou, mas não substitui nem aprova a V-06 e a V-11, que passam a rodar com este cliente. Rationale: pendência da SI-03.2; escolha do usuário pelo `ioredis` na linha 5.x.
- 2026-11-20 — Situação: provas V-06 e V-11 executadas e aprovadas na revisão da SI-03.7; a TD-09 não tem mais prova pendente. V-06 (`20261119025647-d9e179`): `bullmq` 6.7.7, `@nestjs/bullmq` 11.0.5 e `ioredis` 5.11.1 carregam em CommonJS e processam um job por `BullModule.forRootAsync`, `registerQueue` e `WorkerHost` numa spec do Jest 30.3 contra o Redis 8.8.4 real, com o Jest saindo com código 0 e sem handles nem chaves restantes. V-11 (`20261119025715-a2e8f7`): 36 de 36 itens obrigatórios, com os comportamentos de que dependem a TD-10 e a TD-12 (ver as revisões da mesma data). Não cobertos pelas provas e sem condicionar esta TD, registrados como limitações na `V-11.md`: a queda abrupta do Redis, que persiste só por RDB (`appendonly no`), e indisponibilidades longas, em que a reconexão do BullMQ pode levar até cerca de 20 s. Rationale: revisão da SI-03.7 (`docs/phases/phase-03-videos/proofs/V-06.md` e `V-11.md`).

---

## TD-10: Execução e empacotamento do worker (incluindo o FFmpeg)

**Scope:** Backend

**Capability:** Transversal — covers: "Serviço de processamento em segundo plano (filas)", "Processamento automático do vídeo após upload (extração de duração e metadados)", "Geração automática de thumbnail a partir de um frame do vídeo"

**Context:** O diagrama mostra um container "Video Worker (FFmpeg)" separado, que atualiza banco e storage. A imagem atual (`node:25.6.0-slim`, Debian bookworm) não traz FFmpeg, e o pacote apt disponível é `ffmpeg 7:5.1.9`, conferido na própria imagem. O `fluent-ffmpeg` está depreciado no npm. Os testes rodam dentro do container `nestjs-api`, conforme o CLAUDE.md.

**Interrupção do worker durante o processamento (F-12).** O worker pode ser interrompido de várias formas:
- o processo morre (SIGKILL, falta de memória ou reinício do container);
- o Compose o para com prazo curto: `docker compose stop` espera 10 s por padrão antes do SIGKILL;
- ele perde o Redis;
- o FFmpeg trava lendo a rede.

O que a documentação do BullMQ diz sobre esses casos (Context7, v6.5.3):
- **Duração do lock:** o lock do job vale por `lockDuration` (30.000 ms por padrão) e é renovado a cada `lockRenewTime`, que normalmente é metade disso.
- **Lock perdido:** se o lock expira sem ser renovado, o job vira *stalled* e é reiniciado, e "it will be **double processed**".
- **Limite de recuperações:** um job sai do estado *stalled* no máximo `maxStalledCount` vezes (padrão 1). Depois disso falha com "job stalled more than allowable limit", sem passar pelo processor.
- **Parada graciosa:** `worker.close()` espera os jobs ativos terminarem, sem timeout próprio no SDK TypeScript. Se o processo sair antes disso, os jobs são recuperados como *stalled*.

**Options:**

### Option A: Mesmo código NestJS, com entrypoint próprio e serviço `video-worker` no Compose
- `src/worker.ts` sobe `NestFactory.createApplicationContext(WorkerModule)`, sem HTTP. Usa a mesma imagem de desenvolvimento com `ffmpeg` instalado via apt, mudando só o comando. `ffprobe` e `ffmpeg` são chamados com `child_process.spawn`, sem wrapper.
- **Pros:**
  - Reaproveita entidades, config (`registerAs`), migrations e testes.
  - Isola CPU e falhas em relação à API e escala de forma independente.
  - Com `spawn`, o trabalho pesado roda fora do event loop. Isso permite renovar o lock do job e **reduz** os stalls causados por CPU no processo Node.
- **Cons:**
  - Há dois processos para operar.
  - A imagem de desenvolvimento da API cresce com o FFmpeg, o que é aceitável; separar as imagens de produção fica para a Fase 07.
  - Os locks **continuam expirando** sempre que não são renovados a tempo: processo morto, Redis inacessível, pausa longa. O job então é reentregue, às vezes enquanto a primeira execução ainda roda.
  - Um FFmpeg travado é o caso oposto: o lock continua sendo renovado e o job fica ativo indefinidamente.
  - Os dois casos exigem tratamento explícito (ver Recomendação e TD-12).

### Option B: Processor dentro do processo da API
- **Pros:** menos infraestrutura.
- **Cons:** CPU e memória do FFmpeg disputam com o atendimento HTTP, contra R-02. Escala e falhas ficam acopladas, e contraria o diagrama C4.

### Option C: Subprojeto separado (`video-worker/`, com `package.json` próprio)
- **Pros:** isolamento máximo e liberdade de stack.
- **Cons:** duplica entidades, config e migrations, ou exige um pacote compartilhado (o repositório não tem tooling de monorepo). Acrescenta mais um conjunto de CLAUDE.md e testes.

**Recommendation:** **Option A.** Atende ao diagrama e a R-02 sem duplicar o modelo de dados. O FFmpeg do sistema via `spawn` é o caminho com menos dependências, porque vem do pacote do Debian. O `ffmpeg-static` 5.3.0 fica como alternativa se a imagem não puder usar apt.

O planejamento precisa incluir, como requisitos:
- **Fim garantido do processamento (G-09):** um timeout por job que mata o processo do FFmpeg e devolve erro transitório, além de `-rw_timeout` na leitura HTTP.
- **Parada graciosa:**
  - `worker.close()` no SIGTERM;
  - um `stop_grace_period` coerente com o tempo esperado de um job;
  - encerramento dos processos filhos;
  - tratamento de sinais com o Node como PID 1 (ou `init: true` no Compose).
- **Configuração explícita:** `lockDuration`, `stalledInterval` e `maxStalledCount` definidos na configuração, com valores curtos nos testes.

Mesmo com tudo isso, um job pode ser reentregue ou rodar duas vezes ao mesmo tempo. A convergência do resultado é garantida pela TD-12, e não pelo worker.

**Decision:** A (mesmo código NestJS, com entrypoint próprio e serviço `video-worker` no Compose) — condicionada a V-04 e V-11
**Libraries:** —

**Revisions:**
- 2026-11-17 — Situação: decisão condicionada às provas V-04 (ffprobe/ffmpeg 5.1 sobre URL assinada, timeouts e reconexões) e V-11 (lock, stall, reentrega e parada graciosa no BullMQ 6.7.7), nenhuma executada. São passos bloqueantes antes da implementação do processamento; se falharem, esta TD é reaberta. Rationale: /plan-resolve (OQ-10, OQ-29, OQ-36).
- 2026-11-17 — O `video-worker` sobe pelo `docker compose up`; a exceção à convenção "subir o ambiente é só infraestrutura" é documentada no CLAUDE.md como entregável da fase. Rationale: Q-07 (D-11).
- 2026-11-17 — Imagem: mantém-se a imagem atual (`node:25.6.0-slim`, Debian bookworm, FFmpeg do apt) nesta fase. O plano registra as versões efetivamente validadas (Node, FFmpeg e ffprobe) e exige repetir as verificações afetadas (V-04 e a prova do fluxo completo da TD-15) quando a imagem mudar. A atualização do Node continua como tarefa separada (D-07), a reabrir se surgir incompatibilidade real. Rationale: DG-1.
- 2026-11-17 — A manutenção periódica (varredura de sessões, limpeza de objetos abandonados e reconciliação) roda no `video-worker`, numa fila própria com concorrência própria, para não esperar atrás dos processamentos de vídeo. Rationale: AMB-6 (ver TD-12).
- 2026-11-20 — Situação: provas V-04 (SI-03.6) e V-11 (SI-03.7) executadas e aprovadas; a TD-10 não tem mais prova pendente. A V-11 (`20261119025715-a2e8f7`) confirmou no BullMQ 6.7.7 os padrões efetivos `lockDuration` 30000, `lockRenewTime` 15000, `stalledInterval` 30000 e `maxStalledCount` 1, os mesmos pelo `@nestjs/bullmq`, que repassa ao `Worker` as opções do `@Processor`. Confirmou também a reentrega após `SIGKILL` do worker; a falha `job stalled more than allowable limit` no stall acima do limite, sem passar pelo processor e sem retentativa; e a parada graciosa, em que `SIGTERM` → `worker.close()` espera o job ativo e não busca jobs novos. Continuam valendo, porque as provas não os cobrem: (a) os requisitos de implementação desta TD: valores explícitos de lock e stall na configuração (SI-03.8); `init: true`, `stop_grace_period` maior que o timeout de um job, `worker.close()` no SIGTERM e encerramento dos processos filhos do FFmpeg (SI-03.20); e timeout por chamada que mata o FFmpeg (SI-03.21); (b) a parada do serviço pelo `docker compose stop video-worker`, critério da SI-03.20; (c) um job ativo durante a indisponibilidade do Redis, cuja convergência fica com a TD-12 e com o T-12 (SI-03.25); (d) a regra da DG-1, que exige repetir a V-04 e a prova do fluxo completo quando a imagem mudar. Rationale: revisão da SI-03.7 (`docs/phases/phase-03-videos/proofs/V-04.md` e `V-11.md`).

---

## TD-11: Acesso do worker à mídia durante o processamento

**Scope:** Backend

**Capability:** Transversal — covers: "Processamento automático do vídeo após upload (extração de duração e metadados)", "Geração automática de thumbnail a partir de um frame do vídeo"

**Context:** Copiar um original de 10 GB para o worker custa disco e tempo. O protocolo HTTP do FFmpeg detecta se o recurso aceita seek (`seekable=-1`) e faz requisições de intervalo, e `-ss` antes de `-i` faz seek na entrada. A decisão afeta o volume e o disco do serviço `video-worker` no Compose e as permissões da credencial do worker. Depende da TD-10.

**Options:**

### Option A: FFmpeg e ffprobe lendo o objeto por URL pré-assinada interna (HTTP Range)
- O worker gera uma URL GET de curta duração pelo `S3_ENDPOINT` interno e a passa a `ffprobe -print_format json -show_format -show_streams` e a `ffmpeg -ss … -i URL -frames:v 1`.
- **Pros:** não copia o arquivo e lê só os bytes necessários: cabeçalho, índice e a região do frame. Na maioria dos contêineres, o tempo de processamento não depende do tamanho total.
- **Cons:** contêineres que exigem muitos seeks, como MOV ou MP4 com o `moov` no fim, geram mais requisições. Timeouts e reconexão exigem as opções `reconnect*` do protocolo HTTP.

### Option B: Download completo para um disco temporário do worker
- **Pros:** comportamento idêntico para qualquer formato, com o FFmpeg lendo um arquivo local.
- **Cons:** até 10 GB de disco por job concorrente, I/O dobrado e minutos de transferência antes de o processamento começar.

### Option C: Stream do SDK direto no `stdin` do FFmpeg (`pipe:0`)
- **Pros:** sem disco e sem URL.
- **Cons:** a entrada não aceita seek, então MP4 com o `moov` no fim e o seek para a thumbnail falham ou forçam a leitura do arquivo inteiro.

**Recommendation:** **Option A.** Evita a cópia de 10 GB e aproveita o Range nativo do storage. A B fica como fallback, por formato, se o spike encontrar contêineres problemáticos.

**Decision:** A (FFmpeg e ffprobe lendo o objeto por URL pré-assinada interna, com HTTP Range) — condicionada a V-04
**Libraries:** @aws-sdk/s3-request-presigner@^3.1170.0

**Revisions:**
- 2026-11-17 — Situação: decisão condicionada à prova V-04, não executada; passo bloqueante antes da implementação do processamento. Formatos aceitos: MP4 e WebM, com validação real da mídia e dos codecs pelo ffprobe; mídia inválida é erro permanente, sem retentativa (T-14). MOV fica fora da Fase 03. Rationale: Q-03 (OQ-11, OQ-18, OQ-29).
- 2026-11-17 — A leitura da mídia permanece pela URL pré-assinada interna com HTTP Range, condicionada à V-04. Se essa prova falhar para os formatos aceitos nesta fase, a TD-11 deve ser reaberta. O download completo para disco temporário não está previamente autorizado; sua eventual adoção exige avaliar as evidências, o consumo de disco, o tempo e os testes afetados. Esta revisão substitui, na Recommendation, a autorização de fallback automático para a Option B ("A B fica como fallback, por formato, se o spike encontrar contêineres problemáticos"); a Recommendation original fica como histórico, subordinada a esta revisão. Rationale: IC-5 (alternativa a).

---

## TD-12: Consistência entre estado e fila, retentativas e idempotência

**Scope:** Backend

**Capability:** Transversal — covers: "Serviço de processamento em segundo plano (filas)", "Processamento automático do vídeo após upload (extração de duração e metadados)", "Geração automática de thumbnail a partir de um frame do vídeo"

**Context:** O BullMQ entrega pelo menos uma vez. Pontos da documentação (Context7, v6.5.3):
- **Lock perdido:** quando um worker perde o lock, o job é reiniciado e "double processed" (ver TD-10). Isso pode acontecer com a primeira execução ainda rodando.
- **Limite de stalls:** acima de `maxStalledCount`, o job falha sem passar pelo processor.
- **Deduplicação por `jobId`:**
  - Um `add` com `jobId` existente "will just be ignored" enquanto o job existir em qualquer estado, inclusive `completed` e `failed`.
  - Depois que o job é removido (`removeOnComplete` ou `removeOnFail`), o mesmo id volta a ser aceito.
- **Retentativa manual:** `Job.retry()` só vale para jobs em `completed` ou `failed`.

A transição `draft → processing` (no Postgres) e a publicação do job (na fila) são escritas em sistemas diferentes, tanto na TD-09 A quanto na B. Os efeitos do worker também são dois: gravar a thumbnail no storage e atualizar a linha do vídeo.

Por isso existem **várias** janelas de inconsistência, e não uma só:
- o banco foi atualizado, mas a publicação na fila falhou (F-02);
- o job e o banco divergem, conforme o estado do job: `waiting`, `delayed`, `active`, `failed` ou `completed` (F-03);
- a thumbnail foi gravada, mas a atualização do banco falhou, ou o worker morreu entre as duas (F-04);
- duas execuções do mesmo job rodam ao mesmo tempo depois de uma perda de lock (F-05);
- o job falhou de vez (tentativas esgotadas ou stall acima do limite) sem que `error` fosse gravado (F-03, F-12).

A falha de upload em que o storage concluiu e o banco não (F-01) é tratada na TD-02. Esta TD depende da TD-09.

**Options:**

### Option A: Publicação após o commit, `jobId` determinístico por execução, consumidor que distingue retentativa de trabalho concluído, e reconciliação por estado do job
- **Transição:** é condicional (`UPDATE … WHERE status = 'draft'`) e registra o número da execução do processamento, por exemplo numa coluna `processing_run`.
  - Depois do commit, a API faz o `add` com um `jobId` derivado do vídeo **e** da execução, por exemplo `video-{uuid}-{run}`, sem `:`, que a documentação desaconselha.
  - Um id só por vídeo impediria republicar enquanto um job antigo em `completed` ou `failed` estivesse retido, e deixaria de deduplicar depois da remoção.
- **Payload:** só `{ videoId, run }`. O worker relê o estado no banco antes de qualquer efeito.
- **Como o worker distingue os casos:**
  - **Retentativa legítima:** o vídeo está em `processing` na mesma execução, porque houve erro transitório ou reentrega após stall. O trabalho é refeito por inteiro.
  - **Trabalho já concluído:** o vídeo está em `ready` ou `error`, ou numa execução mais nova. O processor termina sem efeitos (sem FFmpeg e sem gravação) e sem lançar erro, para não gastar tentativas.
  - **Estado incoerente:** o vídeo está em `draft` ou não existe. O processor termina sem efeitos e registra o erro.
- **Efeitos convergentes:**
  - A thumbnail usa chave fixa e um frame escolhido de forma determinística, então repetir o trabalho grava o mesmo conteúdo no mesmo lugar.
  - A transição terminal usa `UPDATE … WHERE status = 'processing' AND processing_run = :run`. Se `affected = 0`, outra execução chegou antes, e o resultado desta é descartado.
- **Erros:**
  - Os permanentes usam `UnrecoverableError`.
  - Os transitórios são retentados com backoff exponencial.
  - A falha final grava `error`, com a mesma guarda condicional.
- **Reconciliação:** um scheduler percorre os vídeos que estão em `processing` além de uma carência e consulta o job da execução corrente. A conduta para cada estado está na tabela abaixo.
- **Pros:**
  - É proporcional ao risco, sem tabela nem processo extra.
  - Usa recursos nativos do BullMQ (`jobId`, `UnrecoverableError`, `getJob` e `retry`) e é testável com infraestrutura real.
  - A coluna de execução serve tanto de chave do job quanto de proteção contra execuções obsoletas.
- **Cons:**
  - A janela entre o commit e a publicação só fecha na próxima reconciliação, com atraso de até um intervalo mais a carência.
  - O trabalho **pode** ser repetido: CPU e gravação da thumbnail podem acontecer mais de uma vez. O que se garante é o resultado final, não um trabalho único.
  - A reconciliação precisa tratar cada estado do job.

Conduta da reconciliação, conforme o estado do job da execução corrente, para vídeos em `processing` além da carência:

| Estado do job | Significado provável | Conduta |
|---------------|----------------------|---------|
| Inexistente | A publicação falhou depois do commit (F-02), ou o job foi removido | `add` com o mesmo `jobId`. É seguro porque um `add` concorrente com o mesmo id é ignorado |
| `waiting`, `delayed` ou `prioritized` | Aguardando worker ou backoff | Nada; o job vai rodar |
| `active` | Em execução, ou com lock perdido que ainda não foi detectado | Nada; o verificador de *stalled* do BullMQ cuida da perda de lock |
| `failed` | Tentativas esgotadas, `UnrecoverableError` ou stall acima do limite, sem que `error` tenha sido gravado | Gravar `error` com a causa (`failedReason`), usando a guarda condicional. Reabrir com `job.retry()` só se a política do planejamento classificar a causa como falha de infraestrutura |
| `completed` | O processor terminou sem transição terminal, o que indica bug | Registrar o problema; só então `job.retry('completed')` |

### Option B: Transactional outbox no Postgres, com relay para a fila
- **Pros:** a publicação fica garantida pelo mesmo commit, num padrão consolidado.
- **Cons:**
  - Exige tabela, relay e limpeza a mais, e um processo ou loop extra para testar.
  - Fecha apenas F-02. O consumidor continua precisando das mesmas guardas para F-03 a F-05.

### Option C: Enfileiramento transacional nativo (opção `db` do pg-boss)
- **Pros:** elimina a escrita dupla sem outbox.
- **Cons:** só existe se a TD-09 escolher a C.

**Recommendation:** **Option A.** Não existe uma janela única de inconsistência: são as cinco listadas no contexto, e cada uma tem tratamento próprio:
- **F-02:** a reconciliação republica o job.
- **F-03:** a conduta por estado do job resolve a divergência.
- **F-04 e F-05:** a guarda por execução e as chaves determinísticas resolvem a repetição e a concorrência.

Reentregas e duplicatas **podem** repetir o trabalho e os efeitos intermediários. A garantia é de convergência:
- uma única transição terminal por execução, aplicada só pela execução corrente;
- artefatos com chave e conteúdo determinísticos;
- nenhum efeito para jobs de vídeos já concluídos.

O outbox (B) não é necessário de saída. Ele só passa a se justificar se os testes de F-02 mostrarem que o atraso da reconciliação é inaceitável. As garantias G-05 a G-09 e os testes correspondentes estão em "Cenários de falha, concorrência e repetição". A coluna de execução e o formato do `jobId` são mecanismos candidatos; as garantias é que são obrigatórias.

**Decision:** A (publicação após o commit, `jobId` determinístico por execução, consumidor que distingue retentativa de trabalho concluído e reconciliação por estado do job), com tentativa vigente e Job Schedulers — condicionada a V-11
**Libraries:** bullmq@^6.7.7, @nestjs/bullmq@^11.0.5

**Revisions:**
- 2026-11-17 — Situação: decisão condicionada à prova V-11 (padrões de lock e stall, reentrega, `add` com `jobId` existente em cada estado e `Job.retry()`), não executada; passo bloqueante antes da implementação do consumidor e da reconciliação. Sem reprocessamento manual na Fase 03; só retentativas automáticas. Rationale: /plan-resolve (OQ-12, OQ-36) e Q-05.
- 2026-11-17 — Tentativas e derivados: cada tentativa efetiva do worker recebe uma chave própria para os derivados, inclusive em reentregas concorrentes do mesmo `jobId`/`processing_run`. O banco identifica a tentativa vigente; só ela publica o resultado, atualizando a referência da thumbnail no mesmo `UPDATE` condicional que confirma `ready`. Tentativas obsoletas também não podem marcar `error`. O original confirmado é imutável. O T-11 é ampliado para simular uma tentativa antiga terminando depois da atual e verificar o banco e o artefato referenciado. Derivados abandonados entram na limpeza periódica, com carência e proteção de objetos referenciados ou de tentativas ainda válidas. Esta revisão substitui, na Recommendation, as chaves e os artefatos determinísticos como mecanismo de convergência dos derivados. Rationale: AMB-3 (OR-01).
- 2026-11-17 — Manutenção periódica (varredura de sessões, limpeza de objetos e reconciliação) por Job Schedulers do BullMQ registrados com identificadores estáveis, para não duplicar com várias instâncias, executados no `video-worker` numa fila e com concorrência próprias. Não se assume execução exatamente uma vez nem pontualidade: as operações toleram repetição e usam guardas no banco para não conflitar entre conclusão, reinício, reconciliação e limpeza. Intervalos, tamanho de lote, critérios de elegibilidade e carência para exclusão vêm de configuração. A V-11 passa a validar várias instâncias, repetição, reinício e recuperação após indisponibilidade. Rationale: AMB-6.
- 2026-11-17 — Recuperações por geração. Esta revisão substitui, na tabela da Option A, a conduta `completed → job.retry('completed')` e a republicação de job ausente "com o mesmo `jobId`", e passa o `jobId` de determinístico por execução para determinístico por execução e geração: `video-{videoId}-{run}-{dispatch}`. Toda recuperação de job ausente ou de job `completed` sem transição no banco reserva atomicamente, no banco, uma geração nova e consome uma recuperação, dentro do limite `PROCESSING_MAX_RECOVERIES`; a reconciliação não usa `job.retry()`. As retentativas automáticas do BullMQ por `attempts` e `backoff`, e as reentregas após stall, continuam dentro da mesma geração. A reserva fica registrada como ação pendente, com a geração reservada e um token; a retomada reutiliza essa geração, sem contar outra recuperação, e só repete o `add` quando não há evidência de que o job daquela geração existiu. Um executor atrasado usa a geração reservada pela própria ação, nunca a geração corrente relida. Jobs de gerações antigas não assumem a tentativa nem publicam `ready` ou `error`. A tentativa vigente é ordenada pelo par (geração, `attemptsStarted`), com uma cerca no banco que só avança. `removeOnComplete` e `removeOnFail` ficam desligados: enquanto a geração for a vigente e o vídeo não estiver terminal, a evidência usada na deduplicação não é removida automaticamente; a reconciliação remove depois os jobs de gerações superadas ou de execuções já confirmadas como terminais no banco. A reconciliação lê primeiro o retrato do banco, deriva dele a identidade do job, consulta a fila depois e escreve com a guarda daquele mesmo retrato. A V-11 e o T-09 passam a cobrir esses cenários. Rationale: revisão da Phase A do plano (`phase-03-videos.md`, protocolos P3 e P5), autorizada pelo usuário; o `job.retry()` não pode ser condicionado ao estado observado sem depender de estruturas internas do BullMQ, e um executor atrasado poderia reexecutar o job sem contabilização.
- 2026-11-20 — Situação: prova V-11 executada e aprovada na revisão da SI-03.7; a TD-12 não tem mais prova pendente. Confirmado no BullMQ 6.7.7 (`20261119025715-a2e8f7`, 36 de 36 itens obrigatórios): `attemptsStarted` cresce estritamente no mesmo job, na entrega, na retentativa por `backoff` e na reentrega após stall (1, 2, 3), o que sustenta o `seq` da tentativa vigente; um `add` com `jobId` existente é ignorado em `waiting`, `delayed`, `active`, `completed` e `failed`; `removeOnComplete: false` e `removeOnFail: false` retêm os jobs, e `job.remove()` é recusado para job `active` com lock e funciona para `completed` e `failed`; um job removido e readicionado com o mesmo `jobId` recomeça os contadores; a entrega antiga de um job removido não consegue concluí-lo nem falhá-lo (`Missing key … moveToFinished`); `attemptsMade` identifica a última tentativa e não muda com o stall; o stall acima do limite falha com `failedReason` `job stalled more than allowable limit`; e Job Schedulers com id estável não duplicam com duas instâncias, não acumulam iterações com os workers parados e se recuperam depois de `docker compose stop` e `start` do Redis. O `Job.retry()` ficou informativo e não condiciona esta TD. Continuam valendo, porque a V-11 cobre só a biblioteca: (a) o protocolo da aplicação (P3, P5 e a coleta), verificado pelo T-09 (SI-03.25) e pelo T-11 (SI-03.22); (b) a releitura do job depois de um `add` com `jobId` existente, porque o objeto devolvido traz os dados da chamada e não os gravados; (c) a guarda de P3 sobre os efeitos no banco e no storage, porque a entrega antiga executa o processor até o fim; (d) as limitações de persistência e reconexão do Redis registradas na `V-11.md`. Rationale: revisão da SI-03.7 (`docs/phases/phase-03-videos/proofs/V-11.md`).

---

## TD-13: Formato de entrega para reprodução

**Scope:** Cross-layer

**Capability:** Reprodução via streaming (sem necessidade de download completo)

**Context:** O requisito é começar a tocar antes do download completo. HTTP Range (206) sobre um MP4 ou WebM já cumpre isso, desde que o navegador consiga ler o índice. HLS e DASH dão bitrate adaptativo, mas com alto custo de transcodificação. A escolha define o que o player da Fase 05 consome (`<video>` nativo, ou hls.js com MSE) e quanto CPU e armazenamento o worker gasta.

**Options:**

### Option A: Download progressivo do original via HTTP Range, com validação de compatibilidade
- Sem transcodificação. Aceita só uploads de tipos permitidos (por exemplo, `video/mp4` e `video/webm`) e usa o ffprobe para levar a `error` os codecs que o navegador não reproduz.
- **Pros:** processamento barato, em segundos. Um objeto só, reproduzido por `<video>` nativo, e o requisito é atendido com o Range nativo do storage.
- **Cons:** não há bitrate adaptativo. Um MP4 com o `moov` no fim exige uma requisição de Range extra no início, e uploads com codecs fora da lista terminam em `error`.

### Option B: Uma única versão normalizada (MP4 H.264/AAC com `+faststart`)
- **Pros:** reprodução previsível em qualquer navegador e aceitação de entradas variadas.
- **Cons:** transcodificar 10 GB leva de dezenas de minutos a horas de CPU, duplica o armazenamento e alonga a fila.

### Option C: HLS ou DASH com várias versões
- **Pros:** melhor experiência em redes instáveis.
- **Cons:** o mais caro em CPU e armazenamento. Milhares de segmentos exigem outra estratégia de autorização (URL assinada por segmento ou prefixo público), e o player da Fase 05 precisaria de MSE.

**Recommendation:** **Option A para a Fase 03.** Atende ao requisito com o menor custo. O contrato de reprodução (TD-14) deve devolver `{ url, contentType }`, para permitir evoluir para a B ou a C sem quebrar o cliente.

**Decision:** A (download progressivo do original via HTTP Range, com validação de compatibilidade) — condicionada a V-04
**Libraries:** —

**Revisions:**
- 2026-11-17 — Situação: decisão condicionada à prova V-04 (ffprobe/ffmpeg 5.1 com MP4 de `moov` no fim e WebM), não executada; passo bloqueante antes da validação de compatibilidade no worker. Formatos: MP4 e WebM, com validação real de mídia e codecs; MOV fora da Fase 03. Rationale: Q-03 (OQ-13, OQ-18, OQ-29).

---

## TD-14: Caminho de acesso para streaming e download

**Scope:** Cross-layer

**Capability:** Transversal — covers: "Reprodução via streaming (sem necessidade de download completo)", "Download do vídeo pelo usuário"

**Context:** Com o BFF estrito, o `<video src>` aponta para uma rota same-origin do Next, e o token fica no cookie do BFF. O storage suporta Range nativamente, e o `GetObject` aceita `ResponseContentDisposition` e `ResponseContentType` assinados na URL. A autorização depende do estado (só `ready` pode ser reproduzido) e, nas Fases 04/05, da visibilidade. Depende das TD-06, TD-07 e TD-13.

**Options:**

### Option A: URLs pré-assinadas de curta duração, emitidas pela API após autorização
- A API valida dono e estado e assina um GET no endpoint público. O BFF entrega a URL ao player, por redirect 302/307 ou em JSON. O download segue o mesmo caminho, com `ResponseContentDisposition: attachment; filename=…`.
- **Pros:** os bytes nunca passam pela API nem pelo BFF. Range (206) e retomada de download ficam a cargo do storage. A autorização acontece a cada emissão de URL, e trocar por uma CDN com URL assinada no futuro é simples.
- **Cons:** a URL pode expirar no meio de uma sessão longa, e o player precisa pedir outra. Quem tiver a URL acessa o vídeo até ela expirar.

### Option B: Proxy de streaming pela API (Range repassado ao `GetObject`, resposta 206)
- **Pros:** controle total por requisição, com o storage invisível ao cliente.
- **Cons:** todos os bytes passam pela API e pelo BFF, em dois saltos. Banda e sockets disputam com o atendimento, e há mais código de Range para manter.

### Option C: Objetos públicos com URL estável (policy anônima)
- **Pros:** o mais simples, e cacheável por CDN.
- **Cons:** não há autorização: rascunhos, vídeos em `error` e unlisted ficam acessíveis a quem obtiver a chave, sem possibilidade de revogação. Contraria a TD-06 A.

**Recommendation:** **Option A.** É a única que mantém os bytes fora da API e do BFF e ainda aplica autorização por estado. Reprodução e download têm TTLs separados, configurados por variável de ambiente.

**Decision:** A (URLs pré-assinadas de curta duração, emitidas pela API após autorização)
**Libraries:** @aws-sdk/s3-request-presigner@^3.1170.0

**Revisions:**
- 2026-11-17 — Situação: decisão arquitetural aprovada. A V-05 (reprodução e seek em navegador após redirect para URL assinada) fica adiada para a Fase 05, junto com a integração do player no frontend; o adiamento não reduz o aceite de streaming e download desta fase. Autorização: só o dono reproduz e baixa; não-dono recebe 404. Rationale: Q-02 e /plan-resolve (OQ-14, OQ-17, OQ-30).
- 2026-11-17 — Aceite da Fase 03 para streaming e download: testes contra o storage real, com vídeo válido, cobrindo a autorização (dono e não-dono), a emissão das URLs, respostas `206 Partial Content` com `Content-Range` a requisições parciais e o download completo. Rationale: AMB-1.

---

## TD-15: Estratégia de prova com infraestrutura real, incluindo o limite de 10GB

**Scope:** Backend

**Capability:** Transversal — covers: "Serviço de armazenamento de arquivos (vídeos e thumbnails)", "Serviço de processamento em segundo plano (filas)", "Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance", "Processamento automático do vídeo após upload (extração de duração e metadados)", "Geração automática de thumbnail a partir de um frame do vídeo", "Reprodução via streaming (sem necessidade de download completo)", "Download do vídeo pelo usuário"

**Context:** R-10 exige storage, fila e worker reais no Compose, exercitados pelos testes. O guia `testing-guide-nestjs-project/references/external-systems.md` ainda recomenda filesystem local para o storage, o que conflita com R-10 (Divergência D-06). As suítes de integração e e2e compartilham o banco e rodam com `--runInBand`. Um upload real de 10 GB leva minutos e ocupa cerca de 10 GB no volume do storage. Há duas provas diferentes, que não devem ser confundidas:
- **Capacidade de upload:** prova que 10 GB passam pelo caminho de envio.
- **Fluxo completo com vídeo válido:** prova que um arquivo desse tamanho chega a `ready`, com metadados, thumbnail, streaming e download.

Depende das TD-08, TD-09 e TD-10.

**Options:**

### Option A: Pirâmide com infraestrutura real, mais duas provas opcionais e separadas de arquivo grande
- **Integração (`*.integration-spec.ts`):** contra MinIO e Redis reais. Cobre assinatura, registro e conferência de partes, conclusão, guardas de estado e a idempotência do processor com FFmpeg real e uma fixture pequena, incluindo os cenários F-01 a F-12 (testes T-01 a T-14).
- **E2E HTTP:** o fluxo completo até `ready`, com o serviço `video-worker` do Compose e polling com timeout, mais Range 206 e download.
- **Limites:**
  - Por tamanho declarado: 10.000.000.000 bytes são aceitos e 10.000.000.001 rejeitados.
  - Com bytes reais acima do limite: usa-se um `VIDEO_MAX_SIZE_BYTES` reduzido.
- **Prova opcional 1 — capacidade de upload** (script ou flag própria, por exemplo `npm run test:e2e:large-upload`):
  - **Como funciona:** 10.000.000.000 bytes sintéticos, gerados em stream e nunca carregados inteiros na memória, são enviados nas 150 partes pelas URLs assinadas, com `Content-Length` e checksum reais e com uma interrupção e retomada no meio.
  - **O que prova:** o caminho de upload, o registro e a conferência das partes, a conclusão, o `HeadObject` com 10.000.000.000 bytes e a responsividade da API durante o envio.
  - **O que não prova:** o processamento, porque os bytes não são um vídeo. O teste deve verificar explicitamente o desfecho esperado (`error` por mídia inválida, ou parada na conclusão) e nunca afirmar `ready`.
- **Prova opcional 2 — fluxo completo com vídeo válido** (flag própria, por exemplo `npm run test:e2e:large-video`):
  - **Como funciona:** um vídeo real perto do limite é gerado uma vez com FFmpeg (por exemplo, concatenando com `-c copy` um trecho curto de bitrate alto) e guardado fora do repositório. O teste exige `ready`.
  - **O que prova:**
    - o ffprobe e o FFmpeg leem um objeto desse tamanho por Range (TD-11);
    - duração, metadados e thumbnail saem corretos;
    - streaming (206 no início, no meio e no fim) e download funcionam.
  - **Tamanho exato:** chegar a exatamente 10.000.000.000 bytes com um vídeo válido exige preenchimento, por exemplo uma caixa `free` no MP4. A viabilidade é verificada em V-07.
- **Pros:**
  - A suíte do dia a dia continua rápida e determinística.
  - Capacidade e processamento ficam provados separadamente, cada um com evidência própria, e o "sem impacto" vira uma medição.
- **Cons:**
  - As provas de arquivo grande precisam de disco (cerca de 10 GB no storage, mais o vídeo gerado) e de tempo, e não rodam a cada commit.
  - Exigem mais helpers, como a limpeza de bucket e de fila entre testes.

### Option B: Só o limite reduzido por configuração, sem enviar 10 GB de verdade
- **Pros:** rápido, e prova a lógica de aplicação do limite.
- **Cons:** o requisito de 10GB fica demonstrado só por configuração e cálculo, uma evidência fraca para a entrega.

### Option C: Upload real de 10 GB em toda execução da suíte e2e
- **Pros:** prova máxima em cada execução.
- **Cons:** minutos a mais por execução e 10 GB de disco no CI ou na máquina, o que deixa a suíte lenta e frágil.

**Recommendation:** **Option A.** Comprova cada requisito com infraestrutura real e mantém a suíte regular viável.
- **Entrega da fase:** precisa das **duas** provas de arquivo grande. A de capacidade sozinha não demonstra que um vídeo de 10 GB é processado e reproduzido.
- **Simulação dos estados intermediários:** os testes de falha e concorrência simulam esses estados diretamente na infraestrutura real (ver "Cenários de falha, concorrência e repetição"), em vez de mockar o meio da operação.
- **Guia de testes:** precisa passar a prever MinIO real, numa tarefa separada ou como parte da documentação da fase.

**Decision:** A (pirâmide com infraestrutura real e provas separadas de arquivo grande), com uma prova documentada de 10 GB e o fluxo completo até `ready`
**Libraries:** —

**Revisions:**
- 2026-11-17 — Exceção registrada ao guia de testes: integração e e2e da Fase 03 usam storage, fila e worker reais. A indicação do guia de usar adaptador local ou filesystem para storage não se aplica nesta fase, porque o R-10 prevalece. O guia não é alterado nesta fase; isso substitui, na Recommendation, a atualização do guia para prever MinIO real. Rationale: IC-3 (D-06).
- 2026-11-17 — Aceite do upload de 10 GB: a suíte regular usa arquivos pequenos e limites configuráveis. Antes da entrega, há uma prova documentada de upload real de 10 GB (10.000.000.000 bytes) com interrupção, retomada e medição da responsividade da API durante o envio, e uma prova do fluxo completo com vídeo válido até `ready`. Não se exigem automaticamente duas transferências de 10 GB nem um vídeo preenchido artificialmente até o tamanho exato. A prova grande é planejada considerando o tempo e o disco disponíveis, medidos na V-07. Esta revisão substitui, na Recommendation, a exigência de que a prova do fluxo completo use um vídeo de 10 GB. Rationale: AMB-2 (OR-04).
- 2026-11-17 — Situação: decisão arquitetural aprovada; nenhum teste nem prova foi executado. A V-07 (tempo e disco) é passo bloqueante apenas para agendar a prova grande. Os testes T-01 a T-14 compõem o plano de testes da fase, com os ajustes de T-01/T-04 (TD-02) e T-11 (TD-12). Rationale: /plan-resolve (OQ-15, OQ-32).
- 2026-11-25 — Condição das provas grandes **atendida**, com as três provas fora da suíte regular, na janela e com o disco definidos pela V-07:
  - a V-07 (tempo e disco, 2026-11-24);
  - o fluxo completo com vídeo válido até `ready` (SI-03.32, `P-fluxo-completo.md`, aprovada em 2026-11-24);
  - a prova documentada de 10 GB: a repetição da P-10GB (`P-10GB-repeticao.md`), aprovada na revisão de 2026-11-25.
  - **Histórico:** a P-10GB original (2026-11-24) continua `reprovada`.
  - **Rationale:** revisão da SI-03.33.

---

## Decisions Summary

| ID | Scope | Decision | Recommendation | Choice |
|----|-------|----------|----------------|--------|
| TD-01 | Cross-layer | Protocolo de upload direto e retomável | A (S3 Multipart com URLs pré-assinadas por parte, orquestrado pela API) | A — condicionada a V-08 |
| TD-02 | Cross-layer | Ciclo de vida da sessão de upload | A (controle na API; registro próprio de PartNumber, ETag e checksum, com `ListParts` só para conferência; checksum por parte na retomada; exclusão mútua entre conclusão, reinício e limpeza) | A — condicionada a V-01, V-09, V-10 |
| TD-03 | Cross-layer | Política e aplicação do limite de 10GB | A (provisório: 10 GB decimais, `10000000000` bytes, 150 partes de 64 MiB, `content-length` assinado), com fallback para B | A (10 GB decimais) — condicionada a V-02, V-08 |
| TD-04 | Cross-layer | Modelo de estados do vídeo e transições | A (exatamente quatro estados; publicação ortogonal na Fase 04) | A — aprovada |
| TD-05 | Cross-layer | Identificador público e URL única | A (11 caracteres base64url via `node:crypto`, `UNIQUE` + retentativa) | A — aprovada |
| TD-06 | Backend | Organização dos objetos e controle de acesso | A (bucket único privado, prefixos por tipo, só URL assinada) | A, com chave do original por sessão e derivados por tentativa — aprovada |
| TD-07 | Repo-wide | Topologia de endpoints do storage e contrato de env | A (endpoint interno + endpoint público só para assinatura) | A — condicionada a V-01, V-03, V-09 |
| TD-08 | Repo-wide | Distribuição do MinIO no Compose | A como alternativa pendente e condicionada a V-01, V-03 e V-09 (`pgsty/silo`, fork de terceiros, tag e digest fixos); B ou C se falhar | A (candidato `pgsty/silo`) — condicionada a V-01, V-03, V-09 |
| TD-09 | Backend | Tecnologia de fila | A (BullMQ + Redis via `@nestjs/bullmq` 11) | A — condicionada a V-06, V-11 |
| TD-10 | Backend | Execução e empacotamento do worker | A (mesmo código, entrypoint e serviço `video-worker`, FFmpeg via apt + `spawn`, com timeout e parada graciosa) | A — condicionada a V-04, V-11 |
| TD-11 | Backend | Acesso do worker à mídia | A (ffprobe/ffmpeg sobre URL pré-assinada interna com Range) | A — condicionada a V-04 |
| TD-12 | Backend | Consistência, retentativas e idempotência | A (publicação após commit, `jobId` por execução, guarda de execução na transição terminal, reconciliação por estado do job) | A, com tentativa vigente e Job Schedulers — condicionada a V-11 |
| TD-13 | Cross-layer | Formato de entrega para reprodução | A (original progressivo via Range, com validação de compatibilidade) | A — condicionada a V-04 |
| TD-14 | Cross-layer | Caminho de acesso para streaming e download | A (URLs pré-assinadas curtas emitidas pela API e entregues pelo BFF) | A — aprovada; V-05 adiada para a Fase 05 |
| TD-15 | Backend | Prova com infraestrutura real e limite de 10GB | A (pirâmide com infraestrutura real + provas separadas de capacidade de upload e de fluxo completo com vídeo válido até `ready`) | A, com uma prova documentada de 10 GB e fluxo completo até `ready` — aprovada |

**Dependências entre TDs:**
- TD-02 e TD-03 dependem da TD-01.
- O checksum por parte da TD-02 interage com a configuração de checksum da TD-07 (V-09).
- TD-11 depende da TD-10, e TD-12 da TD-09.
- TD-10 e TD-12 dividem as garantias do worker: a TD-10 garante que o trabalho termina, e a TD-12 que o resultado converge.
- TD-14 depende das TD-06, TD-07 e TD-13.
- TD-15 depende das TD-08, TD-09 e TD-10.
- Se a TD-09 escolher a C (pg-boss), a TD-12 passa naturalmente para a C.

---

## Situação das decisões e provas (`/plan-resolve`, 2026-11-17)

> **Atualização de 2026-11-25:** as tabelas abaixo são a situação de 2026-11-17 e não foram reescritas. A situação vigente das provas e das SIs está em `docs/phases/phase-03-videos/progress.md` (33/33 SIs aprovadas). Revisões posteriores, nas Revisions de cada TD:
> - **TD-01:** mantida, com a reabertura de 2026-11-24 encerrada;
> - **TD-15:** condição das provas grandes atendida.

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

---

## Consequências para contratos, autorização, eventos e transições

Esta seção é um esboço, para servir de insumo ao planejamento. Assume as recomendações acima. Os nomes de rotas, DTOs e códigos de erro serão fixados no planejamento, seguindo as regras de controllers do projeto (REST, substantivos no plural, OpenAPI completo).

**Consolidação de 2026-11-17:** esta seção foi alinhada às decisões e revisões vigentes registradas pelo `/plan-resolve`. Onde uma revisão substitui trecho da Recommendation de uma TD, vale a revisão:
- original em chave exclusiva por sessão, com verificação da sessão válida (TD-02, TD-06);
- derivados em chave por tentativa efetiva, com `ready` ou `error` publicados só pela tentativa vigente (TD-12);
- limpeza dos objetos abandonados nesta fase (TD-06, TD-12);
- sincronização de `openapi.json` e `types.gen.ts` como manutenção do contrato (IC-4);
- exceção ao guia de testes registrada na TD-15, sem alterar o guia (IC-3).

As Recommendations e suas revisões ficam preservadas nas TDs, e a redação anterior desta seção está em "Trechos substituídos na consolidação de 2026-11-17", no fim dela. Nenhuma prova foi executada; as decisões condicionadas seguem "Situação das decisões e provas".

**Consolidação da Phase A do plano (2026-11-17):** os protocolos detalhados de coordenação estão em `docs/phases/phase-03-videos/phase-03-videos.md`, "Technical Specifications → Data Model → Coordenação e fencing": P1 (criação e reinício por intenção), P2 (conclusão com releitura), P3 (tentativa vigente por geração), P4 (elegibilidade estável para exclusão) e P5 (recuperações por geração). Esta seção resume a regra vigente; as decisões estão nas revisões de 2026-11-17 das TD-02, TD-06 e TD-12. A redação anterior está em "Trechos substituídos", no fim da seção.

### Contratos da API (Nest, chamados pelo BFF)

| Operação | Quem pode | Entrada e saída essenciais | TDs |
|----------|-----------|----------------------------|-----|
| Iniciar o upload (pré-cadastro) | Usuário autenticado, sempre no próprio canal | Entrada: nome do arquivo, `sizeBytes` e `contentType`. O DTO valida só a forma (400); o teto de 10.000.000.000 bytes (413) e os tipos `video/mp4` e `video/webm` (415; MOV fora da fase) são regras de domínio. Saída: vídeo em `draft` (`publicId`), `partSize`, `partCount`, algoritmo de checksum e expiração da sessão. A sessão nasce em `initiating`, com chave exclusiva gerada pelo servidor e gravada antes do `CreateMultipartUpload`, e só é devolvida depois de ativada (P1) | TD-01..06, TD-11, TD-13 |
| Assinar partes e registrar partes enviadas, em lote | Dono; vídeo em `draft` com sessão `active` | Entrada: números de parte com o checksum de cada uma, mais os `{ partNumber, etag }` das partes já enviadas. Saída: URL, `expectedSize`, o header `x-amz-checksum-sha256` que o JavaScript envia e a expiração de cada parte. O `content-length` continua assinado, mas é definido pelo navegador a partir de um corpo com `expectedSize` bytes. Reassinar uma parte com outro checksum bloqueia a sessão | TD-01..03 |
| Consultar a sessão (retomada) | Dono | Plano, estado da sessão, expiração e partes classificadas como confirmadas, ausentes, divergentes ou não registradas, com os checksums. Sem partes recebidas, todas aparecem como ausentes | TD-02 |
| Conferir o arquivo selecionado de novo | Dono; sessão `active` | Entrada: checksums recalculados das partes confirmadas e não registradas, com lista vazia quando nenhuma parte foi recebida. Saída: confirmação, ou conflito de arquivo que bloqueia a sessão até um reinício | TD-02 |
| Concluir o upload | Dono; sessão `active` | Idempotente. Monta o Complete pelo registro, na chave da própria sessão, confere `ListParts` e `HeadObject` nessa chave e passa o vídeo para `processing`, gravando a chave do original confirmado no mesmo `UPDATE` condicional que verifica que a sessão ainda é a válida do vídeo. Repetir depois do sucesso devolve o estado atual; a conclusão atrasada de outra sessão não promove o próprio objeto nem substitui o original confirmado. Responde 202 quando faz a transição e 200 quando a sessão já está `completed` e vigente. Ao perder a posse, relê o estado: conclusão em andamento → 409 `UPLOAD_SESSION_COMPLETING`; sessão revertida → 409 `UPLOAD_COMPLETION_INTERRUPTED`; sessão abortada ou substituída → 409 `UPLOAD_SESSION_NOT_ACTIVE` ou 410 `UPLOAD_SESSION_EXPIRED`. Perder a posse nunca produz 200 (P2) | TD-02..04, TD-06, TD-12 |
| Abortar ou reiniciar a sessão | Dono; sessão `active` | `AbortMultipartUpload` repetido até `NoSuchUpload`; uma nova sessão, com nova chave do original, é criada sob demanda. O rascunho continua reiniciável depois da expiração da sessão (Q-04). Reinício e conclusão são serializados pela linha do vídeo; dois reinícios simultâneos produzem uma sessão nova e um 409 `UPLOAD_SESSION_INITIATING` (P1) | TD-02, TD-04, TD-06 |
| Consultar o vídeo e o estado | Dono (na Fase 03); não-dono recebe 404 | `status`, metadados e `error_code`; acompanhamento por polling (Q-09) | TD-04, TD-05 |
| Obter URL de reprodução | Dono; vídeo em `ready`; não-dono recebe 404 | `{ url, contentType, expiresAt }` | TD-13, TD-14 |
| Obter URL de download | Dono; vídeo em `ready`; não-dono recebe 404 | `{ url, expiresAt }`, com `Content-Disposition: attachment` | TD-14 |

- **Erros:** subclasses de `DomainException` com códigos estáveis (por exemplo, vídeo inexistente, tamanho acima do limite, tipo não suportado, estado inválido para a operação, upload incompleto, parte divergente, conflito de arquivo, sessão em conclusão ou expirada, vídeo não pronto). Valem o envelope de `phase-02-auth/TD-07` e uma `@ApiResponse` por status. O catálogo vigente está no plano ("Error Catalog"), com `UPLOAD_SESSION_INITIATING`, `UPLOAD_COMPLETION_INTERRUPTED` e o código persistido `PROCESSING_INCONSISTENT`.
- **Throttling:** o `ThrottlerGuard` global (10 requisições a cada 60s por IP) continua valendo para essas rotas (Revision de 2026-11-17 em `phase-02-auth/TD-08`). Por isso as partes são assinadas **em lote**, e as rotas de vídeo declaram limites explícitos (`@Throttle()`), dimensionados para a assinatura em lote, o registro de ETags e o intervalo de polling, sem desativar a proteção de forma indiscriminada (revisão da TD-02). Sem esses limites, um upload de 150 partes, com os registros de ETag, ou o polling de estado batem em 429.
- **OpenAPI:** é preciso regenerar e commitar o `openapi.json`. A regeneração da cópia `next-frontend/openapi.json` e do `types.gen.ts` pelo script de sincronização (`next-frontend-openapi-typing/TD-02` e `TD-03`) é permitida nesta fase como manutenção do contrato, sem funcionalidades de frontend (IC-4).

### Contrato do futuro cliente de upload (sem implementação na Fase 03)

- O **controle** passa pelo BFF (`/api/videos/**` → API). Os **dados** vão direto ao storage, pelo `S3_PUBLIC_ENDPOINT`.
- **Fatiamento e envio:** o cliente fatia o arquivo pelo `partSize` definido pelo servidor e envia cada fatia, com exatamente `expectedSize` bytes, por PUT na URL assinada, com exatamente os headers devolvidos (só `x-amz-checksum-sha256`; o `Content-Length` é definido pelo navegador).
  - O corpo vai como `Blob` ou `ArrayBuffer` da fatia, nunca como stream, para que o navegador envie o `Content-Length` assinado (V-08).
  - Usa paralelismo limitado (3–4 partes), retenta cada parte com backoff e pede novas URLs quando as anteriores expiram.
- **Checksum:** antes de pedir a assinatura, calcula o SHA-256 de cada parte.
  - Lê uma parte por vez, com memória limitada a uma parte ou a um bloco de hash incremental.
  - O cálculo roda fora da thread de interface.
- **Registro:** depois de cada PUT, lê o `ETag` da resposta, que o CORS do storage expõe, e o informa à API em lote com o próximo pedido de assinatura. Esse registro é obrigatório, porque a API conclui a partir dele, e não da listagem.
- **Depois de uma falha de conexão:** consulta a sessão e reenvia as partes ausentes, divergentes ou não registradas.
- **Depois de recarregar a página:**
  - O usuário seleciona o arquivo de novo.
  - Nome, tamanho e `lastModified` são só uma pré-checagem.
  - O cliente recalcula os checksums das partes confirmadas e não registradas, e a API os confere; sem partes recebidas, a lista é vazia.
  - Se houver divergência, a sessão é reiniciada.
- **Acompanhamento:** depois de concluir, o cliente acompanha o estado por polling até `ready` ou `error`. Push (SSE ou WebSocket) fica fora do escopo.
- **Uppy 6:** o `@uppy/aws-s3` com `signRequest` executa Create e Complete no navegador. Usá-lo exige assinar só UploadPart e ListParts, informar ETag e checksum à API e concluir pela API, ou então escrever um uploader próprio. A decisão é da fase de frontend.

### Autorização na Fase 03

- Todos os endpoints de vídeo exigem autenticação (JWT global). O vídeo é criado no canal do `sub` do token, e o service resolve o canal por `user_id`, que é 1:1 com o usuário.
- A verificação de dono fica **no service** (regra de separação de camadas), não num guard com regra de negócio. Quem não é dono recebe 404, para não permitir enumeração (Q-02, decidida na revisão da TD-14).
- Reprodução e download só valem em `ready` e, na Fase 03, só para o dono (Q-02). Acesso anônimo e vídeos unlisted chegam só na Fase 05, e a ampliação vem depois, sem mudar o contrato.
- URLs delegadas: as de upload por parte têm TTL curto, e as de reprodução e download têm TTLs próprios.

### Eventos e mensagens

- **Job de processamento:** um único tipo, com nome a fixar.
  - Payload `{ videoId, run }`.
  - `jobId` determinístico por execução e geração: `video-{videoId}-{run}-{dispatch}` (revisão de recuperações por geração da TD-12).
  - Tentativas com backoff exponencial.
  - `UnrecoverableError` para falhas permanentes, como mídia inválida ou codec não suportado (só MP4 e WebM são aceitos; Q-03).
  - **Tentativa efetiva:** cada tentativa do worker, inclusive em reentregas concorrentes do mesmo `jobId`/`processing_run`, grava os derivados numa chave própria (por exemplo `thumbnails/{videoId}/{attemptId}.jpg`). O banco identifica a tentativa vigente, e só ela publica `ready`, com a referência da thumbnail no mesmo `UPDATE` condicional, ou `error`. O original confirmado é imutável. O banco registra a vigência pelo token (geração, `attemptsStarted`), com cerca que só avança (P3).
  - **Retenção:** `removeOnComplete` e `removeOnFail` ficam desligados; a reconciliação remove os jobs só depois de confirmar no banco a execução terminal ou a geração superada (P5).
- **Manutenção periódica:** Job Schedulers do BullMQ com identificadores estáveis, executados no `video-worker` numa fila e com concorrência próprias. Não se assume execução exatamente uma vez nem pontualidade: as operações toleram repetição e usam guardas no banco. Intervalos, tamanho de lote, elegibilidade e carência vêm de configuração (TD-10, TD-12). A manutenção:
  - aborta sessões vencidas, repetindo o abort até `NoSuchUpload`;
  - retoma claims `completing` e `aborting` vencidos;
  - reconcilia os vídeos em `processing` conforme o estado do job, com recuperações por geração: job ausente ou `completed` sem transição reserva uma geração nova e consome uma recuperação, até `PROCESSING_MAX_RECOVERIES`, sem `job.retry()`; ações de fila pendentes são retomadas na mesma geração, sem nova contagem (revisão de recuperações por geração da TD-12, P5);
  - limpa, nesta fase, os objetos abandonados: originais de sessões não confirmadas, multiparts incompletos e derivados de tentativas obsoletas. A limpeza respeita a carência e nunca exclui objetos referenciados pelo banco nem objetos de sessões ou tentativas ainda válidas (TD-02, TD-06, TD-12).
- O worker grava diretamente no banco e no storage, conforme o diagrama C4 herdado. A API não consome eventos de retorno.

### Transições de estado

| De | Para | Gatilho | Guarda | Efeitos |
|----|------|---------|--------|---------|
| — | `draft` | Iniciar upload | Usuário com canal; tamanho ≤ 10.000.000.000 bytes; tipo `video/mp4` ou `video/webm` | Cria o vídeo e a sessão em `initiating`, com chave exclusiva do original (por exemplo `originals/{videoId}/{sessionId}`), antes do `CreateMultipartUpload` nessa chave; a sessão vira `active` pela ativação condicionada ao token (P1) |
| `draft` | `draft` | Abortar, reiniciar ou expirar a sessão | Sessão pertence ao vídeo e é reivindicada a partir de `active` | `AbortMultipartUpload` repetido até `NoSuchUpload`; nova sessão, com nova chave, sob demanda (o rascunho continua reiniciável; Q-04). Objetos da sessão abandonada ficam para a limpeza |
| `draft` | `processing` | Concluir o upload | Sessão reivindicada (`active → completing`); todas as partes do plano confirmadas; soma = tamanho declarado ≤ limite; `UPDATE … WHERE status = 'draft'` que também verifica que a sessão ainda é a válida do vídeo | `CompleteMultipartUpload` montado pelo registro, na chave da sessão; `HeadObject` nessa chave; chave do original confirmado gravada; nova execução com geração 1 e ação `publish` pendente, executada após o commit (se falhar, a reconciliação retoma a mesma geração, P5) |
| `processing` | `processing` | Retentativa legítima ou reentrega | Mesma execução e geração, vídeo em `processing` e token (geração, `attemptsStarted`) maior que a cerca (P3) | O trabalho é refeito numa tentativa efetiva, com os derivados numa chave própria; só a tentativa vigente, identificada pelo banco, pode publicar. O estado não muda. Derivados de tentativas obsoletas ficam para a limpeza |
| `processing` | `processing` | Recuperação pela reconciliação (job ausente ou `completed` sem transição) | Retrato inalterado (G_R) e `processing_recoveries < PROCESSING_MAX_RECOVERIES` | Geração nova reservada, recuperação contada, tentativa vigente revogada e ação `republish` pendente (P5) |
| `processing` | `ready` | Tentativa vigente concluiu | `UPDATE … WHERE status = 'processing' AND processing_run = :run AND processing_dispatch = :dispatch AND current_attempt_id = :attemptId` | Duração, metadados e referência da thumbnail da tentativa gravados no mesmo `UPDATE` |
| `processing` | `error` | Falha permanente ou tentativas esgotadas na tentativa vigente; job `failed` encontrado pela reconciliação; ou recuperações esgotadas (`PROCESSING_INCONSISTENT`) | Tentativa vigente, como em `ready`. Na reconciliação, a guarda do retrato inteiro (G_R: execução, geração, recuperações, ação pendente, tentativa e cerca) e, para job `failed`, nenhuma tentativa posterior à última entrega. Tentativas obsoletas não marcam `error` | `error_code` e `error_message` gravados |
| `ready` ou `error` | (sem mudança) | Job duplicado, obsoleto, de execução antiga ou tentativa obsoleta que termina depois da vigente | Estado terminal, execução mais nova ou tentativa que não é a vigente | Nenhum efeito no banco. Um job detectado antes do trabalho não roda FFmpeg nem grava; derivados já gravados por uma tentativa obsoleta ficam para a limpeza |
| `error` | `processing` | Reprocessamento manual | — | **Fora do escopo da Fase 03** (Q-05, decidida; só retentativas automáticas) |

Estados da sessão de upload, conforme a proposta da TD-02 fixada no planejamento com o estado `initiating` e o `claim_token` (revisão de 2026-11-17 da TD-02).

| De | Para | Gatilho | Observação |
|----|------|---------|------------|
| — | `initiating` | Iniciar o upload ou reiniciar a sessão (intenção gravada antes do storage, com token) | Sob o bloqueio da linha do vídeo; o ponteiro do vídeo muda aqui (P1) |
| `initiating` | `active` | `CreateMultipartUpload` concluído e ativação condicionada ao token | O índice de `active` é só defesa adicional |
| `initiating` | `aborting` ou `aborted` | Falha no storage, ou claim vencido assumido pela varredura, pela limpeza ou por outro reinício | Uploads localizados pelo prefixo da chave e abortados |
| `active` | `completing` | Concluir | Transição condicional com prazo |
| `completing` | `completed` | Complete aceito, ou `NoSuchUpload` com o objeto presente na chave da própria sessão e com o tamanho declarado | Junto com `draft → processing`, no `UPDATE` que verifica que a sessão ainda é a válida do vídeo |
| `completing` | `active` | Conferência falhou (parte ausente ou divergente) antes do Complete | O cliente corrige e tenta de novo |
| `active` | `aborting` | Abortar, reiniciar ou vencer o prazo | Transição condicional com prazo |
| `aborting` | `aborted` | `ListParts` responde `NoSuchUpload` | O abort é repetido até lá |
| `initiating`, `completing` ou `aborting` vencido | (retomada) | Próxima chamada, varredura ou limpeza | A retomada assume a posse com novo token, e quem perdeu a posse relê o estado (P1, P2) |

### Persistência, configuração e migrations

- **Nova migration:** tabela `videos`, com PK UUID, `public_id` único, FK `channel_id` para `channels`, enum `status`, colunas de metadados (duração, dimensões, codecs, tamanho, tipo), chaves do storage, campos de erro e timestamps. Migrations existentes não são editadas. Além disso, a migration precisa guardar:
- a sessão de upload: `uploadId` (nulo em `initiating`), chave exclusiva do original, plano, estado (inclui `initiating`), token e prazo do claim, expiração e marca de conferência reprovada;
- as partes registradas: número, tamanho esperado (`min(part_size, size_bytes - (part_number - 1) * part_size)`), checksum esperado imutável, ETag informado e datas;
- no vídeo: a chave do original confirmado, o número da execução, a geração do job, a tentativa vigente e a cerca de tentativas, o contador de recuperações, a ação de fila pendente (com geração reservada e token) e a chave da thumbnail publicada. O modelo completo está no plano ("Data Model").

Se isso vira tabela própria ou colunas é um detalhe de entidade, a decidir no planejamento.
- **Ajustes de teste:** atualizar `cleanAllTables` e a lista `MANAGED_TABLES` de `migrations.integration-spec.ts`, incluindo o drop dos novos tipos enum.
- **Config:** novos `registerAs` (storage, fila e vídeo/upload), as respectivas chaves no Joi e o `.env.example` sem caracteres especiais fora de aspas. Entre as chaves: endpoints interno e público do storage (TD-07); `VIDEO_MAX_SIZE_BYTES=10000000000` e `UPLOAD_PART_SIZE_BYTES=67108864` (TD-03); `UPLOAD_SESSION_TTL` de 24h e, no serviço do storage, `MINIO_API_STALE_UPLOADS_EXPIRY` de 48h (TD-02, condicionados à V-01); e intervalos, tamanho de lote, elegibilidade e carência da manutenção (TD-12), além de `UPLOAD_SESSION_CLAIM_TTL_SECONDS`, `PROCESSING_JOB_ACTION_TTL_SECONDS`, `PROCESSING_MAX_RECOVERIES` (2) e `PROCESSING_STUCK_ALERT_MS`.

### Documentação a atualizar (entregável da fase)

- **Diagrama C4:** definir a tecnologia da fila (BullMQ + Redis, TD-09). A relação `frontend → storage` passa a ser "envia partes / faz streaming", e `api → storage` deixa de transportar bytes (agora "orquestra e assina").
- **`CLAUDE.md` raiz e `nestjs-project/CLAUDE.md`:** novos serviços, verificações de prontidão do storage e da fila, o worker, a exceção de que o `video-worker` sobe pelo `docker compose up` (Q-07, TD-10) e as divergências D-01 a D-04.
- **READMEs:** como subir o ambiente e rodar as provas grandes da TD-15: a prova documentada de upload real de 10.000.000.000 bytes, com interrupção, retomada e medição da responsividade da API, e a prova do fluxo completo com vídeo válido até `ready`.
- **Contrato OpenAPI:** `openapi.json` do backend regenerado e commitado; `next-frontend/openapi.json` e `types.gen.ts` sincronizados como manutenção do contrato, sem funcionalidades de frontend (IC-4).
- **Guia de testes:** não é alterado nesta fase. A exceção, com integração e e2e usando storage, fila e worker reais porque o R-10 prevalece, fica registrada na TD-15 (IC-3).

### Trechos substituídos na consolidação de 2026-11-17

_Registro histórico: redação anterior desta seção, substituída para seguir as revisões vigentes. Não vale como regra._

- **Iniciar o upload:** a entrada citava só "`sizeBytes`, `contentType`", e a guarda da transição, "tamanho ≤ limite; tipo permitido". Agora: até 10.000.000.000 bytes, `video/mp4` ou `video/webm` e chave do original por sessão (Q-01, Q-03, AMB-4).
- **Concluir o upload e sessão `completing → completed`:** "confere `ListParts` e `HeadObject`" e "`NoSuchUpload` com o objeto presente e com o tamanho declarado", sem vínculo do objeto com a sessão. Agora: chave da própria sessão e verificação da sessão válida no `UPDATE` (AMB-4).
- **Throttling:** "as rotas de vídeo precisam de uma política explícita (`@Throttle` ou `@SkipThrottle` nomeado)". Agora: limites explícitos por rota, sem desativar a proteção de forma indiscriminada (IC-2).
- **OpenAPI:** "A cópia no frontend é sincronizada por `next-frontend-openapi-typing/TD-02`, fora do escopo desta fase." Agora: sincronização permitida como manutenção do contrato (IC-4).
- **Autorização:** "A recomendação é responder 404 a quem não é dono" e "a recomendação é restringir ao dono na Fase 03". Agora: decidido (Q-02).
- **Eventos:** "Job periódico de manutenção" com abort, retomada de claims e reconciliação, sem mecanismo definido nem limpeza de objetos. Agora: Job Schedulers com identificadores estáveis e limpeza dos objetos abandonados nesta fase (AMB-6, AMB-4, AMB-3).
- **Transições do vídeo:** "O trabalho é refeito e os efeitos convergem (mesma chave e conteúdo da thumbnail)"; guarda de `ready` e `error` só por `processing_run`; "Reprocessamento manual — **Fora do escopo recomendado** (Q-05)". Agora: derivados por tentativa efetiva, guarda da tentativa vigente e reprocessamento manual fora da fase (AMB-3, Q-05).
- **Persistência:** a lista não incluía a chave do original por sessão, a chave do original confirmado, a tentativa vigente nem a chave da thumbnail publicada (AMB-3, AMB-4).
- **Documentação:** "READMEs: … as duas provas de arquivo grande (capacidade e fluxo completo)" e "Guia de testes: `references/external-systems.md` com storage real". Agora: uma prova real de 10 GB mais o fluxo completo até `ready` (AMB-2), e o guia não é alterado (IC-3).
- **Phase A do plano, contratos:** "Saída: URL, headers assinados (`content-length` e checksum)" e "Responde com o estado (202 ou 200, a fixar)". Agora: `expectedSize` separado do header de checksum, e respostas da conclusão definidas pela releitura (TD-02).
- **Phase A do plano, sessão:** "— → `active` ao iniciar" e "Estados da sessão (proposta da TD-02)". Agora: intenção em `initiating` antes do storage, ativação por token e claims com token (TD-02).
- **Phase A do plano, eventos e transições:** "`jobId` determinístico por execução", "como o banco registra a tentativa vigente é detalhe do planejamento" e guarda de `error` da reconciliação só por `processing_run`. Agora: geração no `jobId`, vigência por (geração, `attemptsStarted`) com cerca, retenção dos jobs e guarda do retrato inteiro (TD-12).

---

## Cenários de falha, concorrência e repetição (insumo para o planejamento)

Esta seção reúne os cenários das TD-02, TD-10 e TD-12. Para cada um, registra a garantia exigida e o teste que a prova.
- **O que é obrigatório:** as **garantias**.
- **O que é sugestão:** os mecanismos citados, a fixar no planejamento. Nenhum deles impõe outbox ou outra infraestrutura adicional.

### Cenários

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

### Garantias exigidas

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

### Testes para o planejamento

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

---

## Divergências encontradas (código × documentação)

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

---

## Fontes e versões consultadas

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

---

## Evidências da TD-08 — acesso às imagens do MinIO

**Quando e onde:** 2026-11-17, por volta de 14:34 UTC. Docker 29.8.2 (cliente e servidor).

**Credenciais:** nenhuma credencial de registry configurada (`~/.docker/config.json` sem `auths`). Ou seja, acesso anônimo, o mesmo de um desenvolvedor novo ou do CI.

**Por que este método:** um 401 isolado na primeira requisição **não** prova nada. Ele é o desafio normal do protocolo, que manda o cliente buscar um token. Por isso os pedidos seguiram o fluxo completo, e o cliente Docker foi usado para confirmar.

**Comandos:**

```bash
# 1. Cliente Docker: fluxo de autenticação normal, sem baixar camadas
docker buildx imagetools inspect <referência>

# 2. Docker Hub, passo a passo
curl -sI https://registry-1.docker.io/v2/                    # desafio: 401 + WWW-Authenticate: Bearer realm="https://auth.docker.io/token",service="registry.docker.io"
curl -s "https://auth.docker.io/token?service=registry.docker.io&scope=repository:<repo>:pull"   # token anônimo; o campo "access" do JWT mostra o que foi concedido
curl -sI -H "Authorization: Bearer <token>" \
  -H "Accept: application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.list.v2+json, application/vnd.docker.distribution.manifest.v2+json, application/vnd.oci.image.manifest.v1+json" \
  https://registry-1.docker.io/v2/<repo>/manifests/<tag>

# 3. quay.io, passo a passo
curl -sI https://quay.io/v2/minio/minio/manifests/latest      # desafio: 401 + WWW-Authenticate: Bearer realm="https://quay.io/v2/auth",service="quay.io",scope="repository:minio/minio:pull"
curl -s "https://quay.io/v2/auth?service=quay.io&scope=repository:<repo>:pull"
curl -sI -H "Authorization: Bearer <token>" -H "Accept: <mesmos tipos>" https://quay.io/v2/<repo>/manifests/<tag>

# 4. Metadados
curl -s https://hub.docker.com/v2/repositories/<repo>/
curl -s https://quay.io/api/v1/repository/<repo>
curl -s https://api.github.com/repos/minio/minio              # também minio/mc e minio/minio/releases/latest
```

**Resultados:**

| Referência | Cliente Docker | Permissão no token anônimo | Manifesto com token | Catálogo |
|------------|----------------|----------------------------|---------------------|----------|
| `docker.io/minio/minio:latest` | `pull access denied, repository does not exist or may require authorization: … insufficient_scope: authorization failed` | `access: []` | 401 `UNAUTHORIZED` ("authentication required") | 404 `object not found` |
| `docker.io/minio/minio:RELEASE.2025-09-07T16-13-09Z` | Mesmo erro | `access: []` | 401 | — |
| `docker.io/minio/minio:RELEASE.2025-10-15T17-29-55Z` (última release no GitHub) | Não executado | `access: []` | 401 | — |
| `docker.io/minio/mc:latest` | Mesmo erro | `access: []` | 401 | 404 `object not found` |
| `quay.io/minio/minio:latest` | `401 Unauthorized` no `HEAD` do manifesto | `actions: []` | 401 ("access to the requested resource is not authorized") | API: 401 `Requires authentication` |
| `quay.io/minio/minio:RELEASE.2025-09-07T16-13-09Z` | Mesmo erro | `actions: []` | 401 | — |
| `quay.io/minio/minio:RELEASE.2025-10-15T17-29-55Z` | Não executado | `actions: []` (mesmo escopo de repositório) | 401 | — |
| `quay.io/minio/mc:latest` | Mesmo erro | `actions: []` | 401 | API: 401 `Requires authentication` |
| Controle `docker.io/library/redis:8.8.4` | Índice OCI `sha256:6e61ab45b3e867bacbef2fdd969ec74f4e0f8aaca8cc946cb8ac0c494035e7e7` | `pull` | 200 | — |
| Controle `docker.io/pgsty/silo:RELEASE.2026-11-12T00-00-00Z` | Índice OCI `sha256:c20d112390b9a9ce8c11b8af95ad35bcaa62f4759663c09c936cd8d2b511f329` | `pull` | 200 | Público, `active`, registrado em 2026-08-06, atualizado em 2026-11-12 |
| Controle `docker.io/pgsty/mc:latest` | Índice OCI `sha256:b532278b7a3747dbab6fe45eebb40a653efa704e6758e24e9d9ec54fc96c1800` | — | — | — |
| Controle `quay.io/prometheus/prometheus:latest` | — | `pull` | 200 | — |

**GitHub:**
- `minio/minio`: `archived: true`, `pushed_at: 2026-04-24T17:54:39Z`.
- `minio/mc`: `archived: true`, `pushed_at: 2025-11-20T03:07:53Z`.
- Última release do `minio/minio`: `RELEASE.2025-10-15T17-29-55Z`, publicada em 2025-10-16.

**Leitura dos resultados:**
- **Fato:** com o fluxo normal de autenticação anônima, os servidores de autorização dos dois registries emitem, para `minio/minio` e `minio/mc`, tokens **sem** a ação `pull`, e o manifesto responde 401. Pelo mesmo fluxo, os controles recebem `pull` e 200.
- **Inferência:** os repositórios foram removidos ou tornados privados; para clientes anônimos, o registry não distingue esses casos.
- **Não testado:** acesso com uma conta própria. Isso não muda a conclusão para um Compose que precisa funcionar sem credenciais.

---

## Lacunas e validações pendentes (spikes sugeridos para o planejamento)

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

---

## Dúvidas para o revisor

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

---

## Notes for downstream pipeline

- Este documento é a **única** decisão `scope_type: phase` da Fase 03, sem `covers_capabilities`, ou seja, cobre a fase inteira.
- **Nome da pasta de planejamento:** o `plan-context` deriva o diretório como `docs/phases/phase-NN-{slug}/`. Com o slug `phase-03-videos` (exigido pelo desafio), isso daria `phase-03-phase-03-videos`. **A pasta correta é `docs/phases/phase-03-videos/`**, no mesmo padrão de `docs/phases/phase-02-auth/`, e deve ser indicada explicitamente ao rodar o `plan-context`.
- Sequência da pipeline: `/plan-context phase-03-videos` (ou `/plan-context 03`) → `/plan-validate` → `/plan-resolve`. As decisões pendentes são preenchidas pelo `/plan-resolve`. Em 2026-11-17 o `/plan-resolve` preencheu as 15 decisões; o `/plan-validate` seguinte determina se o status é `clean` antes do `/plan-build`.
- A Divergência D-05 (throttler global) e a D-06 (guia de testes) devem virar insumo explícito no `context.md`, porque mudam a forma das rotas e dos testes desta fase.
- A seção "Cenários de falha, concorrência e repetição" (F-01 a F-12, G-01 a G-11 e T-01 a T-14) também deve ir **na íntegra** para o `context.md`. Ela fica fora dos campos `Recommendation` que o `decisions-detail-reader` extrai, e define os critérios de aceite das TD-02, TD-10 e TD-12.
- **Delimitação e `Out of scope` (2026-11-17):** o `/plan-resolve` corrigiu pontualmente o campo `Out of scope` do `docs/phases/phase-03-videos/context.md` com a delimitação registrada no topo deste documento. O `docs/project-plan.md` não declara exclusões para a Fase 03; se o `/plan-context` for executado de novo, o campo volta a "Not specified" e a delimitação precisa ser reaplicada.
- **Phase A do plano (2026-11-17):** as revisões de 2026-11-17 das TD-02, TD-06 e TD-12 registram os protocolos P1–P5 do plano. A seção "Consequências" e as notas de G, T e V-11 foram conciliadas com elas.
- **Decisões e provas (2026-11-17):** as decisões, as respostas às dúvidas e a situação de cada prova estão nas revisões de cada TD e na seção "Situação das decisões e provas". Nenhuma prova foi executada.
- **Consolidação documental (2026-11-17):** a seção "Consequências para contratos, autorização, eventos e transições", a F-04, a D-06, a V-04, a V-07 e a escolha entre TD-03 A e B foram alinhadas às revisões vigentes. A redação anterior está registrada em "Trechos substituídos na consolidação de 2026-11-17" e nas notas "Consolidação de 2026-11-17". As Recommendations, as decisões e as revisões das TDs não mudaram.

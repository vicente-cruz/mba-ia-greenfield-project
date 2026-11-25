# Relatórios de prova — phase-03-videos

Esta pasta guarda os relatórios das provas de viabilidade (V-NN) e das provas documentadas (P-*) da Fase 03. Os scripts ficam em `nestjs-project/proofs/phase-03/` e rodam dentro do container `nestjs-api`, contra o ambiente real do Compose (R-10).

Uma prova só conta como executada quando seu relatório existe nesta pasta, preenchido segundo o modelo abaixo.

## Resultado e consequência

Cada prova termina com um de dois resultados. Não há resultado parcial: a prova é `aprovada` só quando todos os seus itens obrigatórios passam, e qualquer item obrigatório que falhe a torna `reprovada`.

| Resultado | Consequência |
|-----------|--------------|
| `aprovada` | A condição que a prova impunha às TDs afetadas fica satisfeita. As SIs que dependem da prova podem começar. O relatório registra os valores que a prova fixou (prazos, timeouts e versões validadas), e as SIs seguintes usam exatamente esses valores. |
| `reprovada` | As TDs afetadas são reabertas, **sem fallback automático**: nenhuma alternativa com garantias menores é adotada sem uma nova decisão registrada no documento de decisões. As SIs que dependem da prova ficam bloqueadas até essa decisão. O relatório nomeia as TDs reabertas e as SIs bloqueadas. |

Se a prova não puder ser executada (ambiente indisponível, por exemplo), ela não é `aprovada` nem `reprovada`: continua pendente, e as SIs que dependem dela continuam bloqueadas.

## Relatórios previstos

| Relatório | Prova | TDs afetadas | SI |
|-----------|-------|--------------|----|
| `V-01.md` | V-01 — variáveis `MINIO_*`, `mc`, CORS e idade do multipart incompleto no Silo | TD-02, TD-07, TD-08 | SI-03.3 |
| `V-03.md` | V-03 — URLs pré-assinadas do AWS SDK contra o Silo | TD-07, TD-08 | SI-03.3 |
| `V-02.md` | V-02 — recusa de `UploadPart` com tamanho diferente do assinado | TD-03 | SI-03.4 |
| `V-09.md` | V-09 — checksum SHA-256 assinado, no servidor e no navegador | TD-02, TD-07, TD-08 | SI-03.4 e SI-03.5 |
| `V-10.md` | V-10 — Complete repetido e guardas opcionais | TD-02 | SI-03.4 |
| `V-08.md` | V-08 — PUT em navegador real com `Content-Length` e header de checksum | TD-01, TD-03 | SI-03.5 |
| `V-04.md` | V-04 — FFmpeg 5.1 sobre URL assinada, formatos, timeouts e reconexões | TD-11, TD-13 | SI-03.6 |
| `V-06.md` | V-06 — BullMQ e `@nestjs/bullmq` em CommonJS com Jest | TD-09 | SI-03.7 |
| `V-11.md` | V-11 — lock, stall, reentrega e parada graciosa no BullMQ | TD-10, TD-12 | SI-03.7 |
| `V-07.md` | V-07 — tempo e disco das provas grandes | TD-15 | SI-03.31 |
| `P-fluxo-completo.md` | Fluxo completo com vídeo válido até `ready` | TD-15 | SI-03.32 |
| `P-10GB.md` | Upload real de 10.000.000.000 bytes com medição de responsividade | TD-01 | SI-03.33 |
| `P-10GB-repeticao.md` | Repetição formal da P-10GB, com registro prévio próprio (r3) e o diagnóstico do R-02 em `R-02-diagnostico.md` | TD-01 | SI-03.33 |

A V-05 (reprodução e seek em navegador) foi adiada para a Fase 05 e não tem relatório nesta fase.

## Modelo de relatório

Copie o bloco abaixo para `V-NN.md` (ou `P-<nome>.md`) e preencha todas as seções. As versões são as efetivamente usadas na execução, lidas do ambiente, e não as previstas no plano.

````markdown
# V-NN — <título da prova>

- **Prova:** V-NN — <pergunta da prova, como está no documento de decisões>
- **TDs afetadas:** phase-03-videos/TD-XX, phase-03-videos/TD-YY
- **SI:** SI-03.N
- **Data:** AAAA-MM-DD
- **Resultado:** `aprovada` | `reprovada`

## Versões

Liste só o que a prova usa; marque os demais como "não usado".

| Componente | Versão efetiva | Como foi lida |
|------------|----------------|---------------|
| Storage | `pgsty/silo:<tag>@sha256:<digest>` | `docker image inspect` |
| Cliente `mc` | `pgsty/mc@sha256:<digest>` | `docker image inspect` |
| Redis | `redis:<tag>@sha256:<digest>` | `docker image inspect` |
| AWS SDK | `@aws-sdk/client-s3` e `@aws-sdk/s3-request-presigner` <versão> | `package-lock.json` |
| BullMQ | `bullmq` <versão>, `@nestjs/bullmq` <versão> e `ioredis` <versão> | `package-lock.json` |
| Node | <versão> | `node -v` no container |
| FFmpeg / ffprobe | <versão> | `ffmpeg -version` e `ffprobe -version` no container |

## Procedimento reproduzível

1. Estado do ambiente: serviços no ar (`docker compose ps`) e variáveis relevantes, sem segredos.
2. Comandos exatos, na ordem, com o script de `nestjs-project/proofs/phase-03/` e seus parâmetros.
3. Limpeza dos recursos temporários criados pela prova.

## Evidências

| Item | Esperado | Observado | Situação |
|------|----------|-----------|----------|
| <item do roteiro> | <comportamento exigido> | <status, headers, trecho de log ou medida> | passou / falhou |

Saídas longas entram resumidas, mantendo as linhas que provam o resultado.

## Resultado

`aprovada` ou `reprovada`, com a justificativa pelos itens acima.

## Consequência

- **Se `aprovada`:** o que fica confirmado, os valores fixados pela prova e as SIs liberadas.
- **Se `reprovada`:** as TDs reabertas, as SIs bloqueadas e o registro de que nenhum fallback foi adotado.
````

## Cuidados ao registrar

- Senhas e secret keys nunca entram no relatório. Quando a prova exigir registrar uma URL assinada, registre-a já expirada.
- Requisições feitas do host para `localhost` precisam de `curl --noproxy '*'`, porque o host usa um proxy corporativo que não exclui `localhost`. Sem isso, o proxy responde `503`. Os containers não usam proxy.

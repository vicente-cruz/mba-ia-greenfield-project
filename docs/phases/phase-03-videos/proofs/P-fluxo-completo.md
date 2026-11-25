# P-fluxo-completo — Fluxo completo com vídeo válido até ready

- **Prova:** P-fluxo-completo. Um vídeo válido, sem preenchimento artificial, percorre o caminho inteiro: upload, processamento, thumbnail, reprodução por requisição parcial e download.
  - Pela revisão AMB-2 da TD-15, a prova usa um vídeo de alguns minutos. Um vídeo de 10 GB preenchido até o tamanho exato não é exigido.
  - A capacidade de 10 GB fica com a P-10GB (SI-03.33).
- **TDs afetadas:**
  - phase-03-videos/TD-15, na revisão AMB-2 (prova do fluxo completo até `ready`);
  - phase-03-videos/TD-14, na revisão AMB-1 (aceite de streaming e download com vídeo válido no storage real).
  - A prova também exercita, pela API e pelo worker reais, as TD-01 e TD-02 (upload), a TD-11 (ffprobe e FFmpeg por Range) e a TD-12 (chave da thumbnail).
- **SI:** SI-03.32
- **Data:** 2026-11-24. Execução `20261124212322-3c8d00`, das 21:23:22Z às 21:28:12Z.
- **Resultado:** `aprovada`

## Versões

| Componente | Versão efetiva | Como foi lida |
|------------|----------------|---------------|
| Storage | `pgsty/silo:RELEASE.2026-11-12T00-00-00Z@sha256:c20d112390b9a9ce8c11b8af95ad35bcaa62f4759663c09c936cd8d2b511f329` | `docker image inspect` |
| Imagem da API e do worker | `streamtube-nestjs-dev` `sha256:6b5db062366a…`, criada em 2026-11-18T02:06:47Z, a mesma da V-04 e da V-07 | `docker image inspect` |
| FFmpeg / ffprobe | 5.1.9-0+deb12u1 no `nestjs-api` e no `video-worker` (pacotes `ffmpeg`, `libavcodec59` e `libavformat59` `7:5.1.9-0+deb12u1`) | `ffmpeg -version`, `ffprobe -version` e `dpkg-query` |
| Codificador H.264 | `libx264-164` `2:0.164.3095+gitbaee400-3` | `dpkg-query` |
| Node | v25.6.0 | `node -v` no `nestjs-api` |
| Bibliotecas | `@aws-sdk/client-s3` 3.1170.0, `@aws-sdk/s3-request-presigner` 3.1170.0, `bullmq` 6.7.7, `typeorm` 0.3.28, `ts-node` 10.9.2, `typescript` 5.9.3 | `package.json` instalado em `node_modules` |
| Docker | Docker Desktop, Engine 29.8.2; kernel 6.6.87.2-microsoft-standard-WSL2; 16 CPUs; 8.208.449.536 bytes de memória na VM | `docker version` e `docker info` |
| Redis, `mc` e navegador | o Redis é usado só pela fila do processamento, sem medida própria; `mc` e navegador não foram usados | — |

**API durante a prova:** servida por `npm run start:dev` (modo watch) no container `nestjs-api`, que também roda o cliente de prova. O `video-worker` é o serviço do Compose, sem mudança.

## Procedimento reproduzível

1. **Estado do ambiente:**
   - `docker compose up -d`, com `db`, `mailpit`, `storage` e `redis` saudáveis e `nestjs-api` e `video-worker` no ar;
   - a API servida no `nestjs-api` por `docker compose exec nestjs-api npm run start:dev`;
   - valores relevantes do `.env`: `UPLOAD_PART_SIZE_BYTES=67108864`, `PLAYBACK_URL_TTL_SECONDS=3600`, `DOWNLOAD_URL_TTL_SECONDS=300` e `VIDEO_PROCESSING_TIMEOUT_MS=60000`.
2. **Comando:** no host, a partir de `nestjs-project/`, `proofs/phase-03/fluxo-completo-roteiro.sh <diretório de saída>`, com os padrões `FLUXO_DURATION_SECONDS=180` e `FLUXO_VIDEO_BITRATE=4M`. O roteiro executa, nesta ordem:
   1. versões, `api-check`, espaço livre e retrato do banco, do bucket, da fila e do Mailpit;
   2. **resíduos anteriores:** a lista dos temporários que o Silo já guardava em `.minio.sys/tmp`, só leitura;
   3. **usuário de prova:** `fluxo-<runId>-uploader@proofs.streamtube.test`, criado pela API real (register, confirmação pelo link do e-mail no Mailpit e login);
   4. **vídeo:** gerado no `nestjs-api` com o FFmpeg da imagem (ver "Vídeo enviado"), com o tempo de geração, o tamanho e o `sha256sum`;
   5. **upload:** `upload-client.ts start`, com `--storage-connect localhost:9000=storage:9000`, até o `202` do completion e o polling a cada 2 s até o estado final;
   6. **conferência:** `upload-proof-support.ts flow-check`, que lê os eventos do cliente, a API, o banco e o storage (ver "Evidências");
   7. **limpeza** (`trap EXIT`), descrita abaixo.
3. **Limpeza:**
   - **recursos do usuário de prova (`upload-proof-support.ts cleanup`):** a limpeza aborta o multipart da sessão e apaga as linhas de vídeo, sessão, partes, canal, tokens e usuário. Também remove o job de processamento, os objetos em `originals/<videoId>/` e `thumbnails/<videoId>/` e o e-mail no Mailpit. Ela recusa qualquer e-mail fora do padrão de prova;
   - **diretório de prova:** o `/tmp/fluxo-<runId>/` do `nestjs-api` é removido;
   - **liberação do disco:** o roteiro espera a purga da lixeira do Silo;
   - **retratos e resíduos:** compara o retrato de depois com o de antes e a lista de temporários do Silo de depois com a de antes.

**Conexão com o storage:** como na V-07, as URLs assinadas usam o `S3_PUBLIC_ENDPOINT` (`localhost:9000`). Dentro do container, `--storage-connect localhost:9000=storage:9000` conecta no serviço `storage` mantendo o `Host` assinado. Os PUTs do upload, as requisições Range e o download passam por esse caminho, container a container.

**Evidências guardadas:** ficam em [`P-fluxo-completo-evidencias/`](P-fluxo-completo-evidencias/), com o caminho local da saída trocado por `<saída>`:
- o log do roteiro;
- os eventos e o log do cliente (`events.jsonl`, `client-start.log`) e o estado (`state.json`);
- o resultado da conferência (`flow-check.json`), com o ffprobe completo do arquivo enviado;
- a thumbnail baixada do storage (`thumbnail.jpg`);
- os retratos e as listas de temporários do Silo de antes e de depois;
- as verificações dos scripts (`verificacoes-dos-scripts.txt`).

Nenhum arquivo traz token, senha ou URL assinada; isso foi conferido por busca de `X-Amz-Signature`, `X-Amz-Credential`, JWT (`eyJ…`) e `password`. As URLs assinadas ficaram só na memória do `flow-check`, que registra o host, o caminho e se a URL estava assinada. O vídeo de 93 MB não foi guardado: era recurso da execução e foi removido com o diretório de prova.

## Vídeo enviado

Gerado no `nestjs-api`, com o FFmpeg da imagem:

```sh
ffmpeg -hide_banner -loglevel error -nostdin -y \
  -f lavfi -i testsrc2=size=1280x720:rate=30:duration=180 \
  -f lavfi -i sine=frequency=440:beep_factor=4:sample_rate=48000:duration=180 \
  -map 0:v -map 1:a -c:v libx264 -preset veryfast -b:v 4M -maxrate 4M -bufsize 8M \
  -pix_fmt yuv420p -g 60 -c:a aac -b:a 128k -ac 2 -movflags +faststart /tmp/fluxo-<runId>/fluxo.mp4
```

| Medida | Valor |
|--------|-------|
| Tempo de geração | 31.564 ms (180 s de vídeo, cerca de 5,7 vezes o tempo real) |
| Tamanho | 93.092.031 bytes, em 2 partes de upload: 67.108.864 e 25.983.167 bytes |
| SHA-256 (`sha256sum`, 396 ms) | `bf8c00339f1232e781020a1f49ff789dc4ef641458f59fdbabf89d604b57bcd4` |
| Contêiner (ffprobe) | `mov,mp4,m4a,3gp,3g2,mj2`, `major_brand` `isom`, 180,000000 s, 4.137.423 bit/s |
| Vídeo | H.264 High, 1280x720, `yuv420p`, 30 fps, 5.400 quadros, 4.001.488 bit/s |
| Áudio | AAC LC, 48.000 Hz, 2 canais, 127.286 bit/s |
| Caixas de topo do MP4 | `ftyp` 32, `moov` 194.203, `free` 8 e `mdat` 92.897.788 bytes (99,79% do arquivo) |

- **Conteúdo:** as fontes são as sintéticas do FFmpeg, `testsrc2` (padrão de teste animado, com contador de tempo e quadro) e `sine` (440 Hz com bipes). É um vídeo válido, codificado e lido como qualquer outro.
- **Sem preenchimento artificial:** o tamanho é o que o codificador e o muxer produziram, sem caixas nem dados acrescentados.
  - **Taxa:** os 4 Mb/s, comuns em 720p, são a taxa média pedida ao codificador. O comando não usa o CBR estrito do x264 (`nal-hrd=cbr`), o modo em que ele insere dados de preenchimento.
  - **Caixas:** a única caixa `free` tem 8 bytes e foi escrita pelo muxer do FFmpeg.
- **Reprodutibilidade:** o comando acima, com a mesma imagem, recria o vídeo. Não foi verificado se uma nova geração tem o mesmo SHA-256.

## Evidências — itens obrigatórios

| Item | Esperado | Observado | Situação |
|------|----------|-----------|----------|
| Vídeo MP4 H.264/AAC válido, de alguns minutos | ffprobe: `mp4`, um fluxo `h264` e um `aac`, ao menos 120 s | `mov,mp4,…`; 2 fluxos; H.264 High 1280x720 e AAC LC 48 kHz estéreo; 180 s | passou |
| Sem preenchimento artificial | Caixas de topo `ftyp`, `moov` e `mdat`, e no máximo 1 KiB em `free` ou `skip` | `ftyp` 32, `moov` 194.203, `free` 8, `mdat` 92.897.788 | passou |
| Plano do upload | 93.092.031 bytes em 2 partes de 67.108.864 | 2 partes, a última com 25.983.167 bytes; vídeo `UaaveBejRrU`, sessão `5c2cee16-…` | passou |
| Completion | `202` | `202` em 111,7 ms, vídeo `processing` | passou |
| Polling até `ready` | `ready` | `ready` na 2ª consulta, 2,02 s depois do `202` | passou |
| Estado, tamanho e tipo pela API (`GET /videos/:publicId`) | `ready` sem erro, 93.092.031 bytes, `video/mp4` | igual | passou |
| Duração | 180 s, a do ffprobe do arquivo enviado, com 3 casas | 180 s | passou |
| Dimensões | 1280x720 | 1280x720 | passou |
| Codecs | `h264` e `aac` | `h264` e `aac` | passou |
| `hasThumbnail` | `true` | `true` | passou |
| `thumbnail_key` no banco | `thumbnails/<videoId>/<attemptId>.jpg` | `thumbnails/<videoId>/ffd058a2-c79e-48b9-8684-b12529f65671.jpg` | passou |
| `media_format` no banco | o `format_name` do ffprobe | `mov,mp4,m4a,3gp,3g2,mj2` | passou |
| Objeto original no storage (`HeadObject`) | 93.092.031 bytes | 93.092.031 bytes, `video/mp4` | passou |
| Objeto da thumbnail no storage | `image/jpeg`, JPEG completo (SOI e EOI), 1280x720 | `image/jpeg`, 43.057 bytes, JPEG com SOI e EOI, `mjpeg` 1280x720 | passou |
| `playback-url` | `200`, URL assinada no endpoint público, `video/mp4` | `200` em 6,7 ms; host `localhost:9000`; assinada; `video/mp4`; expira em 3.600 s | passou |
| Range no início | `206`, `Content-Range: bytes 0-1048575/93092031`, 1.048.576 bytes iguais aos do arquivo | igual, `Content-Length` 1048576, SHA-256 do trecho igual, `video/mp4`, 14,9 ms | passou |
| Range no meio | `206`, `Content-Range: bytes 46546015-47594590/93092031`, bytes iguais | igual, 8,6 ms | passou |
| Range no fim (`bytes=-1048576`) | `206`, `Content-Range: bytes 92043455-93092030/93092031`, bytes iguais | igual, 12,3 ms | passou |
| `download-url` | `200`, URL assinada no endpoint público | `200` em 5,7 ms; host `localhost:9000`; assinada; expira em 300 s | passou |
| Download completo | `200`, 93.092.031 bytes, SHA-256 do arquivo enviado | `200`, `Content-Length` 93092031, 93.092.031 bytes, SHA-256 `bf8c0033…57bcd4`, igual | passou |
| `Content-Disposition` do download | `attachment` com o nome original | `attachment; filename="fluxo-20261124212322-3c8d00.mp4"; filename*=UTF-8''fluxo-20261124212322-3c8d00.mp4` | passou |
| Limpeza só dos recursos da execução | 0 linhas, objetos, multiparts, jobs e e-mails de prova; retrato antes igual ao depois | 5 de 5 itens da limpeza: 1 usuário, 1 vídeo e 1 sessão no banco; o original e a thumbnail no bucket; 1 job; 1 e-mail. Retratos iguais. O Mailpit tinha 8 mensagens antes e depois, de fora da prova e preservadas | passou |
| Resíduos anteriores do storage | A mesma lista de temporários do Silo antes e depois, sem novos | 5 diretórios, 327.720 KiB, antes e depois; listas iguais | passou |
| Evidências sem segredos | Nenhum token, senha ou URL assinada | Nenhuma ocorrência nos arquivos guardados | passou |

Todas as requisições Range responderam `Accept-Ranges: bytes`. O SHA-256 de cada trecho foi comparado ao do mesmo intervalo do arquivo local, lido pelo `flow-check`.

**Thumbnail:** o objeto baixado do storage é o quadro do `testsrc2` com o contador `00:00:01.000` e o número de quadro 30, ou seja, o quadro de 1 s que o worker extrai (`THUMBNAIL_FRAME_SECONDS`). Ele está em [`P-fluxo-completo-evidencias/thumbnail.jpg`](P-fluxo-completo-evidencias/thumbnail.jpg).

## Tempos

Todos da execução `20261124212322-3c8d00`. São medidas, não projeções.

| Etapa | Tempo |
|-------|-------|
| Geração do vídeo (180 s, 1280x720) | 31.564 ms |
| `sha256sum` do vídeo | 396 ms (258 ms no `flow-check`, com o arquivo já em cache) |
| `POST /videos` | 150,8 ms |
| Checksums das 2 partes, antes da assinatura | 236,1 ms (376 MiB/s) |
| PUTs das 2 partes | 586,5 ms e 322,3 ms; 908,8 ms com pelo menos um PUT ativo |
| Throughput dos PUTs concluídos (bytes dos PUTs concluídos com sucesso ÷ tempo com pelo menos um PUT ativo) | 97,7 MiB/s; nenhum PUT abortado nem com falha |
| Upload ativo, do primeiro `part-urls` ao `202` | 2,33 s |
| Completion (`POST …/completion` até o `202`) | 111,7 ms |
| Do `202` ao `ready` | até 2,02 s. A 1ª consulta do polling, 6 ms depois do `202`, viu `processing`; a 2ª, 2,02 s depois, viu `ready`. A resolução é a do polling, de 2 s |
| `playback-url` e as 3 requisições Range | 6,7 ms; 14,9, 8,6 e 12,3 ms |
| `download-url` e o download | 5,7 ms; 401,1 ms para 93.092.031 bytes (221,3 MiB/s), com o primeiro byte em 6,3 ms |
| Do início do roteiro ao fim da conferência | 65 s (21:23:22Z a 21:24:27Z) |
| Roteiro inteiro, com a limpeza e a purga | 4 min 50 s (21:23:22Z a 21:28:12Z), dos quais 214 s na espera da purga |

## Storage e espaço livre

Uso do volume `storage-data` (`du`, em KiB):

| Momento | Total | Bucket | Temporários (com a lixeira) | Lixeira |
|---------|-------|--------|-----------------------------|---------|
| Antes da prova | 328.036 | 4 | 327.832 | 104 |
| Com o vídeo `ready` | 419.088 | 90.996 (original e thumbnail) | 327.892 | 164 |
| Logo depois da limpeza | 419.064 | 4 | 418.860 | 91.132 |
| Depois da purga (214 s depois da limpeza) | 327.988 | 4 | 327.784 | 56 |

- **Liberação:** como na V-07, apagar os objetos move os dados para a lixeira do Silo, e o disco só é liberado na purga periódica. A purga veio 214 s depois da limpeza, e o total voltou a 327.988 KiB, abaixo dos 328.036 KiB do início.
- **Espaço livre no host:** 39.641.288.704 bytes livres na unidade C: antes da prova; 39.641.665.536 bytes depois da limpeza e da purga. O tamanho do `docker_data.vhdx` não foi medido nesta prova.

## Resíduos anteriores do storage

Antes da prova, o volume `storage-data` já guardava os cinco temporários de 64 MiB deixados por PUTs abortados nas interrupções da SI-03.31 (ver "Resíduo dos PUTs abortados" no [`V-07.md`](V-07.md)):

| Tamanho | Diretório em `.minio.sys/tmp` |
|---------|-------------------------------|
| 65.544 KiB | `70731b75-f39b-4526-aedc-6fa12fad583bx1795548947967467323` |
| 65.544 KiB | `80115752-ef5f-41e0-9f12-3feff2e419ecx1795548947731336221` |
| 65.544 KiB | `c07d02bb-16b7-4553-b833-f7653e7f8b1bx1795549731540036430` |
| 65.544 KiB | `d9462442-bfb8-4597-80c0-6491370b2508x1795549732611218187` |
| 65.544 KiB | `f963343c-ee2f-4f83-82bd-e0b61f0243d1x1795549105789409450` |

São 327.720 KiB no total. A prova só os listou, antes e depois, e não os removeu. Depois da limpeza e da purga, a lista era a mesma, com os mesmos tamanhos. Esta execução não teve interrupção nem PUT abortado, e não deixou temporário novo.

## Verificações dos scripts

Feitas sem a API servida, em [`verificacoes-dos-scripts.txt`](P-fluxo-completo-evidencias/verificacoes-dos-scripts.txt):
- **tipos e estilo:** `npx tsc --noEmit` saiu com 0; o ESLint do `upload-proof-support.ts`, sem `--fix`, saiu com 0, e o `prettier --check` passou;
- **roteiro:** `bash -n` passou, e `--help` sai com 64;
- **uso inválido do `flow-check`:** argumento faltando, `--storage-connect` inválido e subcomando desconhecido saem com 64.

O `shellcheck` não está instalado no host e não foi usado.

## Resultado

`aprovada`.
- **Vídeo:** um MP4 H.264/AAC de 180 s, gerado com o FFmpeg da imagem e sem preenchimento artificial.
- **Upload e processamento:** o vídeo foi enviado pelo cliente de prova, o completion respondeu `202`, e o vídeo chegou a `ready` com duração, dimensões e codecs iguais aos do ffprobe do arquivo.
- **Thumbnail:** o objeto em `thumbnail_key` existe no storage, é um JPEG de 1280x720 e mostra o quadro de 1 s.
- **Reprodução e download:** a URL de reprodução respondeu `206` com o `Content-Range` exato no início, no meio e no fim. O download teve o mesmo SHA-256 do arquivo enviado.
- **Limpeza:** removeu só os recursos desta execução. Os retratos de antes e depois são iguais, e os resíduos anteriores do storage foram preservados.

## Consequência

- **Confirmado:** o caminho inteiro funciona com um vídeo válido no ambiente real: upload direto ao storage, processamento pelo worker com ffprobe e FFmpeg por URL assinada, thumbnail, reprodução por requisição parcial e download (TD-15 na revisão AMB-2; TD-14 na revisão AMB-1).
- **Tempo de geração do vídeo**, a parte (b) da pergunta da V-07: 31,6 s para 3 min de vídeo 720p com este comando.
- **Valores fixados:** nenhum. A prova não muda prazos, timeouts nem decisões.
- **SIs liberadas:** a SI-03.33 depende da SI-03.31 e da SI-03.32, e as duas têm agora prova executada. A SI-03.33 não foi iniciada.

## Limitações

- **Tamanho:** o vídeo tem 93 MB, em 2 partes. O ffprobe e o FFmpeg leram por Range um objeto desse tamanho, não um de 10 GB. A revisão AMB-2 da TD-15 não exige um vídeo válido perto de 10 GB, e a capacidade de 10 GB fica com a P-10GB.
- **Conteúdo sintético:** as fontes do FFmpeg (`testsrc2` e `sine`) geram um vídeo válido, mas não uma gravação real de câmera.
- **Caminho medido:** container a container, com `--storage-connect`. O caminho de um navegador no Windows até a porta publicada não foi medido aqui. O PUT em navegador real foi provado na V-08, e a reprodução e o seek em player real são a V-05, adiada para a Fase 05.
- **Tempo de processamento:** medido só pela resolução do polling, até 2,02 s. O worker não registra o fim de um processamento bem-sucedido no log, e a limpeza removeu o job e a linha do vídeo.
- **Contagem do abort na limpeza:** a limpeza registrou "multiparts abortados: 1" para a sessão já concluída. O Silo aceitou o `AbortMultipartUpload` do upload concluído sem erro, como na V-07, e o objeto original continuou até o passo de remoção dos objetos, que o apagou. O resultado da limpeza não muda.

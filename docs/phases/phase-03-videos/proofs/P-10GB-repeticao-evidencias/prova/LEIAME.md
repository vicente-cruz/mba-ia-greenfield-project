# Pacote de evidências — P-10GB (repetição), execução formal da r3

- **Execução:** runId `20261125142232-bc4b5d`, em 2026-11-25, das 14:22:32Z às 14:38:26Z, com código final 0.
- **Relatório:** [`../../P-10GB-repeticao.md`](../../P-10GB-repeticao.md), seção "Resultados".
- **Resultado pela regra do registro prévio:** `aprovada`, aguardando a revisão.
- **Registro prévio vigente (r3):** [`../registro-previo-r3.md`](../registro-previo-r3.md), com o SHA-256 no `progress.md`.
- **Versões anteriores:** [`../registro-previo-r2.md`](../registro-previo-r2.md) e [`../registro-previo.md`](../registro-previo.md) (r1).
- **Versões fixadas:** [`../versoes-sha256-r3.txt`](../versoes-sha256-r3.txt).

| Arquivo ou pasta | Conteúdo |
|------------------|----------|
| `p10gbr-20261125142232-bc4b5d.log` | o log completo do roteiro, etapa por etapa, com a situação final dos passos |
| `roteiro.stdout` | a saída do roteiro |
| `pre-requisitos.txt` | a conferência feita antes da execução: hashes da r3, ambiente, API parada, espaço em C:, Windows, lixeira, `tsc --noEmit` e ESLint |
| `evidencias/probe-<1..13>.csv` e `.log` | as amostras das 13 sondas (`instance,seq,instant,epoch_ms,status,latency_ms,outcome`) |
| `evidencias/client-*` | os eventos, o estado, o progresso e os logs do cliente no Windows (início, retomada e Ctrl+C) |
| `evidencias/relogio-antes.json`, `relogio-depois.json`, `relogio.json`, `events-vm.jsonl` | as medidas de relógio, a diferença e a incerteza usadas, e os eventos no relógio da VM (conversão nominal) |
| `evidencias/latency-verdict.json` e `summary.json` | os vereditos (com a análise da incerteza em `clockUncertainty`) e o resumo das medidas |
| `evidencias/parts-after-interruption.json` e `parts-before-completion.json` | os retratos das partes (registro da API e `ListParts`), só leitura |
| `evidencias/api-*.jsonl` e `api.log` | requisições, event loop, GC e banco da API compilada, e o log dela |
| `evidencias/sonda-db.txt`, `amostrador-vm.txt`, `docker-stats.txt`, `windows.csv` | os monitores do PostgreSQL, da VM, dos containers e do Windows |
| `evidencias/disk-samples.txt` e `disk-completion-fast.txt` | o uso do disco do storage, a cada 0,25 s e sem pausa em volta do completion |
| `evidencias/memoria-*.txt` | a memória dos containers (com as 13 sondas) e da VM antes da base |
| `evidencias/snapshot-*.txt` e `residue-*.txt` | os retratos de antes e de depois e os temporários do Silo |
| `scripts/` | as versões exatas do roteiro, dos auxiliares e dos scripts usados (as de `versoes-sha256-r3.txt`) |

Os caminhos locais, o diretório pessoal e a pasta temporária do Windows foram trocados por marcadores. Nenhum arquivo traz token, senha ou URL assinada.

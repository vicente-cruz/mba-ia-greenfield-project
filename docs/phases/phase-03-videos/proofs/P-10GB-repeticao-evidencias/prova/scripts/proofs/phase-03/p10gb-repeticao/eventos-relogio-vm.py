"""Eventos do cliente (relógio do Windows) para o relógio da VM, na repetição da P-10GB (R-02).

Conversão nominal (registro prévio r2): soma a diferença medida (VM − Windows) ao instante `t` de
TODOS os eventos, sem encolher nem descartar intervalo algum. Todos os intervalos de upload ativo
ficam preservados, inclusive o da liberação ao `202`.

A incerteza da diferença não entra aqui. Ela é registrada à parte e analisada pelo
`latency-verdict --clock-uncertainty-ms`, que identifica as amostras de borda cuja classificação
pode mudar e marca como inconclusivo o critério que essa incerteza possa alterar.

Uso: python3 -I eventos-relogio-vm.py <eventos do cliente> <saída> <diferença ms>
Imprime uma linha por intervalo de upload ativo (regra do loadIntervals), no relógio da VM.
"""
import json
import sys

src, dst, offset = sys.argv[1], sys.argv[2], float(sys.argv[3])
with open(src, encoding='utf-8') as f:
    events = [json.loads(line) for line in f if line.strip()]
for e in events:
    e['t'] = round(e['t'] + offset)
with open(dst, 'w', encoding='utf-8') as out:
    for e in events:
        out.write(json.dumps(e) + '\n')

# Intervalos pela mesma regra do loadIntervals (upload-proof-support.ts), só para o registro.
open_event = None
last = None
n = 0


def report(start, end, how):
    global n
    n += 1
    print(f"intervalo {n} ({start['seg']}): {start['t']} a {end} ({end - start['t']} ms), fecha em {how}")


for e in events:
    if open_event is not None and e.get('seg') != open_event.get('seg') and last is not None:
        report(open_event, last['t'], 'último evento do segmento')
        open_event = None
    if e.get('ev') == 'load_start' and open_event is None:
        open_event = e
    elif e.get('ev') in ('load_end', 'segment_end') and open_event is not None:
        report(open_event, e['t'], e['ev'])
        open_event = None
    last = e
if open_event is not None and last is not None:
    report(open_event, last['t'], 'último evento')

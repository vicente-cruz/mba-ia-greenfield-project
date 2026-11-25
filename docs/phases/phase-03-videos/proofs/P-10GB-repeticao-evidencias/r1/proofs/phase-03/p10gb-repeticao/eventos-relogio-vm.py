"""Eventos do cliente (relógio do Windows) para o relógio da VM, na repetição da P-10GB (R-02).

Desloca o instante `t` de cada evento pela diferença medida (VM − Windows) e encolhe cada intervalo
de upload ativo pela incerteza da medida, dos dois lados (início + u, fim − u). Assim, nenhum
período ocioso entra na carga por erro de relógio; no máximo, alguns instantes ativos nas bordas
ficam fora.

Os intervalos seguem a mesma regra do `latency-verdict` (loadIntervals, em upload-proof-support.ts):
abrem em `load_start` e fecham em `load_end` ou `segment_end`. Um intervalo ainda aberto fecha no
último evento do segmento.
- Intervalo fechado por `load_end`: os dois marcadores são deslocados.
- Intervalo fechado sem `load_end` (por `segment_end`, troca de segmento ou fim dos eventos): recebe
  um `load_end` no fim encolhido, marcado com `"ajuste": "relogio"`, logo antes do evento que o
  fecharia. Os eventos existentes não mudam.
- Intervalo que fica vazio depois do encolhimento (fim ≤ início): os seus marcadores são retirados
  da saída e o descarte é registrado. Nenhuma amostra entra por ele.

Uso: python3 -I eventos-relogio-vm.py <eventos do cliente> <saída> <diferença ms> <incerteza ms>
Imprime uma linha por intervalo: original, ajustado ou descartado (relógio da VM).
"""
import json
import sys

src, dst, offset, uncertainty = sys.argv[1], sys.argv[2], float(sys.argv[3]), float(sys.argv[4])
with open(src, encoding='utf-8') as f:
    events = [json.loads(line) for line in f if line.strip()]
for e in events:
    e['t'] = round(e['t'] + offset)

# Intervalos pela regra do loadIntervals: (índice do load_start, como fecha, índice do evento de fechamento).
intervals = []
open_idx = None
last_idx = None
for i, e in enumerate(events):
    if open_idx is not None and e.get('seg') != events[open_idx].get('seg') and last_idx is not None:
        intervals.append((open_idx, 'last', last_idx))
        open_idx = None
    if e.get('ev') == 'load_start' and open_idx is None:
        open_idx = i
    elif e.get('ev') in ('load_end', 'segment_end') and open_idx is not None:
        intervals.append((open_idx, e['ev'], i))
        open_idx = None
    last_idx = i
if open_idx is not None and last_idx is not None:
    intervals.append((open_idx, 'last', last_idx))

drop = set()
insert_before = {}  # índice -> load_end sintético a inserir antes dele
insert_after = {}   # índice -> load_end sintético a inserir depois dele
for n, (s_idx, kind, e_idx) in enumerate(intervals, 1):
    start, end = events[s_idx]['t'], events[e_idx]['t']
    new_start, new_end = round(start + uncertainty), round(end - uncertainty)
    seg = events[s_idx].get('seg')
    if new_end <= new_start:
        drop.add(s_idx)
        if kind == 'load_end':
            drop.add(e_idx)
        print(f'intervalo {n} ({seg}): {start} a {end} ({end - start} ms) descartado: vazio depois do encolhimento de {uncertainty:.0f} ms de cada lado')
        continue
    events[s_idx]['t'] = new_start
    synthetic = {'t': new_end, 'seg': seg, 'ev': 'load_end', 'ajuste': 'relogio'}
    if kind == 'load_end':
        events[e_idx]['t'] = new_end
    elif kind == 'segment_end':
        insert_before[e_idx] = synthetic
    else:
        insert_after[e_idx] = synthetic
    fecho = {'load_end': 'load_end', 'segment_end': 'segment_end, com load_end de ajuste', 'last': 'último evento do segmento, com load_end de ajuste'}[kind]
    print(f'intervalo {n} ({seg}): {start} a {end} ({end - start} ms) ajustado para {new_start} a {new_end} ({new_end - new_start} ms); fecha em {fecho}')

with open(dst, 'w', encoding='utf-8') as out:
    for i, e in enumerate(events):
        if i in insert_before:
            out.write(json.dumps(insert_before[i]) + '\n')
        if i not in drop:
            out.write(json.dumps(e) + '\n')
        if i in insert_after:
            out.write(json.dumps(insert_after[i]) + '\n')

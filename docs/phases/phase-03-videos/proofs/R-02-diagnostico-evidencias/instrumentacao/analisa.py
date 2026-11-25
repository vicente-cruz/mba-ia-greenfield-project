"""Análise TEMPORÁRIA dos ensaios do diagnóstico R-02 (só leitura dos arquivos coletados).

Uso: python3 -I analisa.py <diretório de evidências do ensaio>
Para cada fase marcada em phases.txt (e, nos uploads, também só no upload ativo):
- sonda: amostras, p50, p95, p99, máximo e amostras acima de 250 ms;
- API (preload): duração no servidor, chegada ao handler e atraso do event loop;
- decomposição das amostras lentas: chegada (disparo → evento 'request' na API), servidor
  (handler até 'finish') e restante (resposta até a sonda);
- PostgreSQL: consultas da API (pg) e da sonda do db;
- VM: swap (páginas), faltas de página maiores, PSI (% do tempo com espera) e iowait;
- processos: faltas de página maiores e swap da API; CPU dos containers (docker stats).
"""
import csv
import glob
import json
import math
import os
import re
import sys
from collections import defaultdict

D = sys.argv[1]


def pct(values, p):
    values = sorted(values)
    if not values:
        return float('nan')
    return values[max(1, math.ceil(p / 100 * len(values))) - 1]


def jsonl(path):
    if not os.path.exists(path):
        return []
    return [json.loads(line) for line in open(path) if line.strip()]


marks = defaultdict(dict)
for line in open(os.path.join(D, 'phases.txt')):
    name, kind, t = line.split()
    marks[name][kind] = int(t)
phases = [(n, m['inicio'], m['fim']) for n, m in marks.items() if 'inicio' in m and 'fim' in m]
phases.sort(key=lambda p: p[1])

# Upload ativo dos ensaios de upload, pelos eventos do cliente.
for name in ('A4', 'B4'):
    events = jsonl(os.path.join(D, f'events-{name}.jsonl'))
    starts = [e['t'] for e in events if e['ev'] == 'load_start']
    ends = [e['t'] for e in events if e['ev'] == 'load_end']
    if starts and ends:
        phases.append((f'{name}-upload-ativo', min(starts), max(ends)))
phases.sort(key=lambda p: p[1])

probe = []
for f in sorted(glob.glob(os.path.join(D, 'probe-*.csv'))):
    for r in csv.DictReader(open(f)):
        probe.append((int(r['epoch_ms']), float(r['latency_ms']), r['outcome'], r['instance']))

server, loop, db = [], [], []
for mode in ('watch', 'nowatch'):
    server += jsonl(os.path.join(D, f'api-{mode}-requests.jsonl'))
    loop += jsonl(os.path.join(D, f'api-{mode}-loop.jsonl'))
    db += jsonl(os.path.join(D, f'api-{mode}-db.jsonl'))
server_get = [s for s in server if s['method'] == 'GET' and s['path'].startswith('/videos/') and s['path'].count('/') == 2]

vm, procs = [], []
for line in open(os.path.join(D, 'sampler.txt')):
    if line.startswith('V '):
        head, cpu = line.split('|', 1)
        parts = head.split()
        rec = {'t': int(parts[1])}
        for kv in parts[2:]:
            k, v = kv.split('=')
            rec[k] = int(v)
        c = [int(x) for x in cpu.split()[1:]]
        rec['cpu_total'] = sum(c[:8])
        rec['cpu_idle'] = c[3]
        rec['cpu_iowait'] = c[4]
        vm.append(rec)
    elif line.startswith('P '):
        p = line.split()
        procs.append({'t': int(p[1]), 'lab': p[2], 'pid': p[3], 'utime': int(p[4]), 'stime': int(p[5]),
                      'majflt': int(p[6]), 'rss_pages': int(p[7]), 'swap_kb': int(p[8]), 'read_bytes': int(p[9])})

dbprobe = []
last_t, expect = None, None
for line in open(os.path.join(D, 'dbprobe.txt')):
    line = line.strip()
    if line.startswith('t|'):
        last_t = int(line.split('|')[1])
        expect = 't'
    elif line.startswith('q|'):
        expect = 'q'
    elif line.startswith('Time:') and expect == 'q' and last_t:
        dbprobe.append((last_t, float(line.split()[1])))
        expect = None
    elif line.startswith('Time:'):
        expect = None if expect == 't' else expect

stats = defaultdict(list)
for line in open(os.path.join(D, 'docker-stats.txt')):
    m = re.match(r'(\d+) (\S+) cpu ([\d.]+)%', line)
    if m:
        t, name, cpu = int(m.group(1)), m.group(2), float(m.group(3))
        short = 'sonda' if '-probe-' in name else name.replace('nestjs-project-', '').rsplit('-', 1)[0]
        stats[short].append((t, cpu))


def within(rows, a, b, key=lambda r: r[0]):
    return [r for r in rows if a <= key(r) <= b]


def delta(rows, key, a, b):
    inside = [r for r in rows if a <= r['t'] <= b and key in r]
    if len(inside) < 2:
        return None
    return inside[-1][key] - inside[0][key], (inside[-1]['t'] - inside[0]['t']) / 1000


def fmt(x, nd=1):
    return 'n/a' if x is None or (isinstance(x, float) and math.isnan(x)) else f'{x:.{nd}f}'


print('# Diagnóstico R-02 — medidas por fase\n')
for name, a, b in phases:
    secs = (b - a) / 1000
    lat = [l for t, l, o, i in probe if a <= t <= b]
    slow = [(t, l) for t, l, o, i in probe if a <= t <= b and l > 250]
    fails = [o for t, l, o, i in probe if a <= t <= b and o != 'ok']
    print(f'## {name} ({secs:.1f} s)')
    print(f'- sonda: {len(lat)} amostras | p50 {fmt(pct(lat, 50))} | p95 {fmt(pct(lat, 95))} | p99 {fmt(pct(lat, 99))} | máx {fmt(max(lat) if lat else None)} ms | >250 ms: {len(slow)} | falhas: {len(fails)}')
    sv = [s['ms'] for s in server_get if a <= s['t'] <= b]
    print(f'- API, GET /videos/:id no servidor: {len(sv)} | p50 {fmt(pct(sv, 50), 2)} | p95 {fmt(pct(sv, 95), 2)} | máx {fmt(max(sv) if sv else None, 2)} ms')
    # Decomposição das amostras lentas.
    comps = []
    for t, l in slow:
        cands = [s for s in server_get if t - 50 <= s['t'] <= t + l]
        if not cands:
            comps.append((l, None, None))
            continue
        s = min(cands, key=lambda s: abs(s['t'] - t))
        arrival = s['t'] - t
        comps.append((l, arrival, s['ms']))
    matched = [c for c in comps if c[1] is not None]
    if slow:
        print(f'- amostras lentas com a requisição achada no servidor: {len(matched)} de {len(slow)}')
        if matched:
            arr = [c[1] for c in matched]
            srv = [c[2] for c in matched]
            rest = [c[0] - c[1] - c[2] for c in matched]
            print(f'  - chegada ao handler (disparo → request): mediana {fmt(pct(arr, 50))} | máx {fmt(max(arr))} ms')
            print(f'  - no servidor (request → finish): mediana {fmt(pct(srv, 50), 2)} | máx {fmt(max(srv), 2)} ms')
            print(f'  - restante (finish → sonda): mediana {fmt(pct(rest, 50))} | máx {fmt(max(rest))} ms')
    el = [r['elMaxMs'] for r in loop if a <= r['t'] <= b]
    print(f'- event loop da API (máx por segundo): mediana {fmt(pct(el, 50))} | p95 {fmt(pct(el, 95))} | máx {fmt(max(el) if el else None)} ms | segundos > 100 ms: {sum(1 for x in el if x > 100)}')
    lp = [r for r in loop if a <= r['t'] <= b]
    if len(lp) >= 2:
        print(f'- processo da API: faltas de página maiores {lp[-1]["majflt"] - lp[0]["majflt"]} | CPU média {sum(r["cpuMs"] for r in lp) / (len(lp) * 10):.1f}% | RSS máx {max(r["rss"] for r in lp) / 1048576:.0f} MiB')
    ap = [p for p in procs if p['lab'] == 'api' and a <= p['t'] <= b]
    if ap:
        print(f'- swap do processo da API (VmSwap): mín {min(p["swap_kb"] for p in ap)} | máx {max(p["swap_kb"] for p in ap)} kB')
    q = [r['ms'] for r in db if r['kind'] == 'query' and a <= r['t'] <= b]
    cn = [r['ms'] for r in db if r['kind'] == 'connect' and a <= r['t'] <= b]
    print(f'- pg na API: consultas {len(q)} | p95 {fmt(pct(q, 95), 2)} | máx {fmt(max(q) if q else None, 2)} ms | espera do pool máx {fmt(max(cn) if cn else None, 2)} ms')
    dq = [ms for t, ms in dbprobe if a <= t <= b]
    print(f'- sonda do PostgreSQL (no db): {len(dq)} | p50 {fmt(pct(dq, 50), 2)} | p95 {fmt(pct(dq, 95), 2)} | máx {fmt(max(dq) if dq else None, 2)} ms')
    parts = []
    for key, label in (('pswpin', 'swap in'), ('pswpout', 'swap out'), ('pgmajfault', 'faltas maiores')):
        d = delta(vm, key, a, b)
        if d:
            parts.append(f'{label} {d[0]} pág ({d[0] / d[1]:.0f}/s)')
    for key in ('cpu_some', 'io_some', 'io_full', 'memory_some', 'memory_full'):
        d = delta(vm, key, a, b)
        if d:
            parts.append(f'PSI {key} {d[0] / 1e4 / d[1]:.1f}%')
    tot = delta(vm, 'cpu_total', a, b)
    idle = delta(vm, 'cpu_idle', a, b)
    iow = delta(vm, 'cpu_iowait', a, b)
    if tot and idle and iow and tot[0] > 0:
        parts.append(f'CPU ocupada {100 * (1 - (idle[0] + iow[0]) / tot[0]):.1f}%')
        parts.append(f'iowait {100 * iow[0] / tot[0]:.1f}%')
    inside = [r for r in vm if a <= r['t'] <= b]
    if inside:
        parts.append(f'MemAvailable mín {min(r["MemAvailable"] for r in inside) // 1024} MiB')
        parts.append(f'SwapFree mín {min(r["SwapFree"] for r in inside) // 1024} MiB')
    print('- VM: ' + ' | '.join(parts))
    cs = []
    for short, rows in sorted(stats.items()):
        v = [c for t, c in rows if a <= t <= b]
        if v:
            cs.append(f'{short} mediana {pct(v, 50):.0f}% máx {max(v):.0f}%')
    print('- CPU dos containers: ' + ' | '.join(cs))
    print()

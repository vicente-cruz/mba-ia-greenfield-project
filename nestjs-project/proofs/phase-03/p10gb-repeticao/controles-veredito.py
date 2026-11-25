"""Casos sintéticos do `latency-verdict` com a incerteza do relógio (registro prévio r2, R-02).

Uso:
  python3 -I controles-veredito.py gerar <saída>     cria uma pasta por caso (events.jsonl, probe.csv, caso.json)
  python3 -I controles-veredito.py conferir <saída>  compara verdict.json (ou o código de saída) com o esperado

Estrutura comum, no relógio da VM:
- base de 700 s com 13 instâncias, uma amostra a cada 2 s, a 5 ms (4.550 amostras, p95 de 5 ms;
  limite do critério (a) = max(1,5 × 5; 5 + 50) = 55 ms);
- três intervalos nominais de upload ativo: I1 de 200 s (segmento start), I2 de 10 s e I3 de 89 ms
  (segmento resume; I3 imita a liberação ao `202`, mais curta que a incerteza);
- amostras de carga "certas" ficam longe das bordas (a mais de u ms); as de borda ficam a 50 ms de
  um início ou de um fim, dentro ou fora do intervalo nominal.
"""
import json
import os
import sys

T0 = 1_800_000_000_000
BASE_START = T0
BASE_END = T0 + 700_000
INSTANCES = 13
I1 = (BASE_END + 5_000, BASE_END + 205_000)
I2 = (I1[1] + 20_000, I1[1] + 30_000)
I3 = (I2[1] + 8_000, I2[1] + 8_089)
FAST, SLOW, VERY_SLOW = 10.0, 600.0, 800.0


def events():
    return [
        {'t': I1[0] - 300, 'seg': 'start', 'ev': 'segment_start'},
        {'t': I1[0], 'seg': 'start', 'ev': 'load_start'},
        {'t': I1[1], 'seg': 'start', 'ev': 'load_end'},
        {'t': I1[1] + 60, 'seg': 'start', 'ev': 'segment_end'},
        {'t': I2[0] - 300, 'seg': 'resume', 'ev': 'segment_start'},
        {'t': I2[0], 'seg': 'resume', 'ev': 'load_start'},
        {'t': I2[1], 'seg': 'resume', 'ev': 'load_end'},
        {'t': I3[0], 'seg': 'resume', 'ev': 'load_start'},
        {'t': I3[1], 'seg': 'resume', 'ev': 'load_end'},
        {'t': I3[1] + 2_000, 'seg': 'resume', 'ev': 'segment_end'},
    ]


def baseline_rows():
    rows = []
    for i in range(1, INSTANCES + 1):
        t = BASE_START + i * 150
        while t < BASE_END:
            rows.append((t, 5.0))
            t += 2_000
    return rows


def core(n, latency, u):
    """n amostras espalhadas em I1, todas a mais de u ms das bordas (carga certa)."""
    lo, hi = I1[0] + u + 100, I1[1] - u - 100
    step = (hi - lo) / max(n - 1, 1)
    return [(round(lo + k * step), latency) for k in range(n)]


# Bordas a 50 ms: fora do intervalo nominal (antes do início, depois do fim) ou dentro dele.
OUT_EDGES = [I1[0] - 50, I1[1] + 50, I2[0] - 50, I2[1] + 50]
IN_EDGES = [I1[0] + 50, I1[1] - 50, I2[0] + 50, I2[1] - 50]

CASES = {
    'intervalo-menor-que-a-incerteza': {
        'descricao': 'I3 (89 ms) é mais curto que a incerteza (157 ms): fica preservado na conversão nominal; '
                     'a amostra dentro dele conta na carga nominal e é marcada como de borda',
        'u': 157,
        'load': core(320, FAST, 157) + [((I3[0] + I3[1]) // 2, 8.0), (I3[0] - 100, 9.0)],
        'esperado': {'intervalos': 3, 'carga_nominal': 321, 'bordas': 2, 'bordas_na_carga_nominal': 1,
                     'nominalLatency': 'aprovado', 'latency': 'aprovado'},
    },
    'borda-lenta-altera-o-veredito': {
        'descricao': '320 amostras certas a 10 ms; 4 amostras de 600 ms a 50 ms fora de quatro bordas. '
                     'Se entrarem, o p99 passa de 500 ms: (b) pode mudar e fica inconclusivo',
        'u': 157,
        'load': core(320, FAST, 157) + [(t, SLOW) for t in OUT_EDGES],
        'esperado': {'carga_nominal': 320, 'bordas': 4, 'nominal_a': 'aprovado', 'nominal_b': 'aprovado',
                     'a': 'aprovado', 'b': 'inconclusivo', 'nominalLatency': 'aprovado', 'latency': 'inconclusivo'},
    },
    'borda-lenta-nao-altera-o-veredito': {
        'descricao': '400 amostras certas a 10 ms; 1 amostra de 600 ms na borda. Com ou sem ela, p95 e p99 '
                     'ficam em 10 ms: o veredito nominal se mantém',
        'u': 157,
        'load': core(400, FAST, 157) + [(OUT_EDGES[1], SLOW)],
        'esperado': {'carga_nominal': 400, 'bordas': 1, 'a': 'aprovado', 'b': 'aprovado',
                     'nominalLatency': 'aprovado', 'latency': 'aprovado'},
    },
    'contagem-perto-de-300-altera-a-suficiencia': {
        'descricao': '296 amostras certas e 6 de borda dentro da carga nominal (302 nominais). Sem as de borda '
                     'ficam 296 < 300: a suficiência pode mudar e (a) e (b) ficam inconclusivos',
        'u': 157,
        'load': core(296, FAST, 157) + [(t, FAST) for t in IN_EDGES] + [(I1[0] + 120, FAST), (I1[1] - 120, FAST)],
        'esperado': {'carga_nominal': 302, 'bordas': 6, 'nominal_a': 'aprovado', 'a': 'inconclusivo',
                     'b': 'inconclusivo', 'nominalLatency': 'aprovado', 'latency': 'inconclusivo',
                     'suficiencia_muda': True},
    },
    'contagem-perto-de-300-nao-altera-a-suficiencia': {
        'descricao': '304 amostras certas e 4 de borda fora da carga nominal: de 304 a 308, sempre ≥ 300',
        'u': 157,
        'load': core(304, FAST, 157) + [(t, FAST) for t in OUT_EDGES],
        'esperado': {'carga_nominal': 304, 'bordas': 4, 'a': 'aprovado', 'b': 'aprovado',
                     'nominalLatency': 'aprovado', 'latency': 'aprovado', 'suficiencia_muda': False},
    },
    'reprovacao-robusta': {
        'descricao': '320 amostras certas a 800 ms e 4 rápidas na borda: todas as classificações reprovam; '
                     'a incerteza não transforma uma reprovação em inconclusivo',
        'u': 157,
        'load': core(320, VERY_SLOW, 157) + [(t, FAST) for t in OUT_EDGES],
        'esperado': {'carga_nominal': 320, 'bordas': 4, 'a': 'reprovado', 'b': 'reprovado',
                     'nominalLatency': 'reprovado', 'latency': 'reprovado'},
    },
    'incerteza-zero': {
        'descricao': 'o caso da borda lenta com u = 0 (cliente e sondas no mesmo relógio, como na P-10GB '
                     'original): sem amostras de borda, o veredito é o nominal',
        'u': 0,
        'load': core(320, FAST, 157) + [(t, SLOW) for t in OUT_EDGES],
        'esperado': {'carga_nominal': 320, 'bordas': 0, 'nominalLatency': 'aprovado', 'latency': 'aprovado'},
    },
    'base-dentro-da-incerteza': {
        'descricao': 'a base termina a 100 ms do primeiro intervalo, menos que a incerteza: o veredito é recusado',
        'u': 157,
        'base_end': I1[0] - 100,
        'load': core(320, FAST, 157),
        'esperado': {'codigo_diferente_de_zero': True, 'mensagem': 'descontada a incerteza do relógio'},
    },
}


def gerar(out):
    for name, case in CASES.items():
        d = os.path.join(out, name)
        os.makedirs(d, exist_ok=True)
        with open(os.path.join(d, 'events.jsonl'), 'w', encoding='utf-8') as f:
            for e in events():
                f.write(json.dumps(e) + '\n')
        rows = sorted(baseline_rows() + case['load'])
        with open(os.path.join(d, 'probe.csv'), 'w', encoding='utf-8') as f:
            f.write('instance,seq,instant,epoch_ms,status,latency_ms,outcome\n')
            for n, (t, latency) in enumerate(rows):
                f.write(f'{n % INSTANCES + 1},{n},,{t},200,{latency},ok\n')
        with open(os.path.join(d, 'caso.json'), 'w', encoding='utf-8') as f:
            json.dump({'descricao': case['descricao'], 'baselineStart': BASE_START,
                       'baselineEnd': case.get('base_end', BASE_END), 'uncertaintyMs': case['u'],
                       'esperado': case['esperado']}, f, ensure_ascii=False, indent=2)
    print(f'{len(CASES)} casos gerados')


def conferir(out):
    failures = 0
    for name in CASES:
        d = os.path.join(out, name)
        case = json.load(open(os.path.join(d, 'caso.json'), encoding='utf-8'))
        exp = case['esperado']
        code = int(open(os.path.join(d, 'codigo.txt')).read().strip())
        got = {}
        if 'codigo_diferente_de_zero' in exp:
            text = open(os.path.join(d, 'veredito.txt'), encoding='utf-8').read()
            got = {'codigo_diferente_de_zero': code != 0, 'mensagem': exp['mensagem'] if exp['mensagem'] in text else text[-200:]}
        else:
            v = json.load(open(os.path.join(d, 'verdict.json'), encoding='utf-8'))
            clock = v['clockUncertainty']
            got = {
                'intervalos': len(v['phases']['load']['intervals']),
                'carga_nominal': v['phases']['load']['samples'],
                'bordas': len(clock['borderSamples']),
                'bordas_na_carga_nominal': sum(1 for s in clock['borderSamples'] if s['nominalLoad']),
                'nominal_a': v['criteria']['a']['nominal'],
                'nominal_b': v['criteria']['b']['nominal'],
                'a': v['criteria']['a']['verdict'],
                'b': v['criteria']['b']['verdict'],
                'nominalLatency': v['nominalLatency'],
                'latency': v['latency'],
                'suficiencia_muda': clock['changes']['enoughSamples'],
            }
        diffs = {k: (exp[k], got.get(k)) for k in exp if got.get(k) != exp[k]}
        ok = not diffs
        failures += 0 if ok else 1
        extra = ''
        if 'carga_nominal' in got:
            c = json.load(open(os.path.join(d, 'verdict.json'), encoding='utf-8'))['clockUncertainty']
            extra = (f" | carga certa {c['certainLoadSamples']}, possível {c['possibleLoadSamples']['min']} a "
                     f"{c['possibleLoadSamples']['max']} | p95 {c['p95Ms']['min']} a {c['p95Ms']['max']} ms | "
                     f"p99 {c['p99Ms']['min']} a {c['p99Ms']['max']} ms | (a) {'/'.join(c['possible']['a'])} | "
                     f"(b) {'/'.join(c['possible']['b'])}")
        print(f"CONTROLE | {name} | código {code} | latência {got.get('latency', '-')} "
              f"(nominal {got.get('nominalLatency', '-')}){extra} | {'passou' if ok else 'FALHOU: ' + json.dumps(diffs, ensure_ascii=False)}")
    print(f'CONTROLES | {len(CASES) - failures} de {len(CASES)} passaram')
    return failures


if __name__ == '__main__':
    mode, out = sys.argv[1], sys.argv[2]
    if mode == 'gerar':
        gerar(out)
    elif mode == 'conferir':
        sys.exit(1 if conferir(out) else 0)
    else:
        sys.exit(64)

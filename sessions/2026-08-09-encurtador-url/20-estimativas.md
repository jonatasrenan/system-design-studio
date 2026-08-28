# Estimativas

> Revisadas em 2026-08-09: tráfego ×2 (200M URLs/mês) e retenção de 10 anos.

## QPS

| | Conta | Resultado |
|---|---|---|
| Escrita média | 200M / (30 × 86.400 s ≈ 2,6M s) | **~80/s** |
| Escrita pico (×3) | 80 × 3 | **~240/s** |
| Leitura média | 80 × 100 | **~8.000/s** |
| Leitura pico (×3) | 8.000 × 3 | **~24.000/s** |

Escrita segue trivial (240/s); **o problema é servir 24k redirects/s com p99 < 100 ms**.

## Storage

- Registro: ~**500 B/link** (código 7 B + URL ~200 B + timestamps/TTL/contador ~50 B + overhead de índice)
- 200M/mês × 12 = **2,4B links/ano** × 500 B ≈ **1,2 TB/ano**
- Horizonte 10 anos: **24B links ≈ 12 TB** — ainda confortável para um KV distribuído; sharding continua sendo por throughput/keyspace, não por volume.

## Espaço de códigos

- Base62, 7 caracteres: 62⁷ ≈ **3,5 trilhões** — 10 anos consomem 24B (0,7%). Folga mantida, 7 chars seguem suficientes.

## Cache (regra 80/20)

- Leituras/dia: 8.000/s × 86.400 ≈ **690M/dia**
- ~20% de links quentes ≈ 140M entradas × 500 B ≈ **70 GB** — ainda cabe num cluster Redis, agora médio (2× o anterior).

## Banda

- Redirect ≈ 1 KB → 24k/s × 1 KB ≈ **24 MB/s** no pico. Irrelevante.

## Cliques

- Até **24k incrementos/s** no pico — reforça a agregação assíncrona (fila + janelas de 10 s).

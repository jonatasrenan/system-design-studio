# Operação

## Observabilidade

| Sinal | Métrica-chave | Alerta |
|---|---|---|
| Latência | p99 do redirect (por AZ) | p99 > 100 ms por 5 min |
| Erros | taxa 5xx | burn rate do orçamento de erro (99,99% = 4,3 min/mês) |
| Cache | hit ratio do Redis | < 70% (pressiona DynamoDB e latência) |
| Banco | throttles DynamoDB | > 0 sustentado |
| Cliques | idade do evento mais antigo na fila | > 5 min (agregador atrasado/parado) |
| IDs | faixas restantes no alocador | consumo anômalo (loop de escrita) |
| Descarte | `clicks_dropped` por instância | > 0 sustentado (fila degradada) |
| Breaker | estado do circuit breaker do Redis | aberto > 1 min |
| Abuso | criações bloqueadas pelo WAF / links reprovados no recheck | pico anômalo |

- Logs estruturados; no caminho quente (24k/s) **amostrados a 1%** — logar tudo custaria mais que o serviço.
- Tracing distribuído (OpenTelemetry) amostrado; 100% nas requests com erro.

## Deploy e mudanças

- Containers atrás do ALB; **canary 1% → 25% → 100%** com rollback automático por métrica (p99 + 5xx). Rollback = repin da imagem anterior, < 2 min.
- DynamoDB é schema-less: novos atributos não exigem migração. Mudanças de comportamento (ex.: `max-age` do Cache-Control) atrás de **feature flag**.

## Modelo de falhas e DR

| Falha | Efeito | Mitigação |
|---|---|---|
| 1 AZ cai | nenhum (capacidade N+1) | ALB + serviços + Redis em ≥2 AZs |
| Redis inteiro cai | latência sobe, custo DynamoDB sobe | DynamoDB segura 24k reads/s sozinho; auto-scale de RCU |
| Fila de cliques cai | cliques perdidos | aceito: contagem é best effort |
| DynamoDB indisponível na região | **redirect fora** — é o risco real do 99,99% | PITR + backup contínuo; multi-região **fora de escopo consciente** (registrado em risks) |
| Redis lento (não morto) | p99 em risco | timeout 10 ms + circuit breaker → DDB direto |
| Safe Browsing fora | validação de destino indisponível | cria o link e enfileira recheck — SLA deles não vira o nosso |

## Crescimento 10x (240k reads/s)

O primeiro gargalo é **custo, não capacidade**: tudo escala horizontal, mas o Redis iria a ~US$ 18k/mês e o ALB pesaria em LCUs. **Plano registrado**: CDN (CloudFront) na frente — o `Cache-Control: max-age=60` que já emitimos deixa a CDN absorver a fatia viral antes do ALB, a custo por request menor que ALB+container+Redis. O DynamoDB reparticiona sozinho; a fila de cliques escala por shard. Nada disso exige re-arquitetura hoje.

<details><summary>Por que aceitar região única com SLA 99,99%</summary>

O histórico do DynamoDB numa região é ≥99,99%; o SLA composto do caminho (ALB → serviço → DynamoDB, todos multi-AZ) fica no limiar da meta. Failover multi-região (Global Tables + Route 53 health check) dobraria o custo de dados e adicionaria classe nova de problemas (conflitos, replicação) para cobrir um evento raro. Decisão: aceitar e revisitar se o produto virar receita crítica. Registrado como risco aceito na visão geral e como fora-de-escopo nos trade-offs.
</details>

## Custo total

- Infra: **~US$ 3.861/mês** (detalhe por componente na visão geral) + observabilidade/logs ~10% → **~US$ 4,2k/mês**.
- Time: opera com 1 time pequeno; complexidade concentrada em 3 pontos (agregação de cliques, gestão de faixas de ID, ciclo de recheck) — o resto é gerenciado.

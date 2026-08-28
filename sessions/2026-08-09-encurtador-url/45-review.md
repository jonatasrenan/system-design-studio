# Review adversarial (guardrails)

**Resultado final: 19 PASS · 0 FALHA · 0 N/A.** A rodada inicial encontrou 6 FALHAs (5 lacunas distintas); todas foram resolvidas no loop de design de 2026-08-09 — resoluções abaixo.

| # | Item | Veredito | Uma linha |
|---|---|---|---|
| 1 | SPOF | PASS | ALB/serviços/Redis multi-AZ; DynamoDB gerenciado; alocador é 1 item mas recebe ~200 calls/mês |
| 2 | Failover | PASS | Redis com réplica/nó (perda = cache, refaz); faixa de ID perdida = aceito; DDB multi-AZ + PITR |
| 3 | Degradação | PASS | Redis cai → DDB segura 24k/s; fila cai → só perde cliques; escrita cai → redirect intacto |
| 4 | DR | PASS | região única descartada conscientemente (trade-off #5) com PITR |
| 5 | Hot spots | PASS | link viral: Cache-Control 60s + LRU local 5s + Redis; códigos permutados espalham partições |
| 6 | Backpressure | PASS ✦ | buffer local 10k/instância com descarte + `clicks_dropped` alarmada (trade-off #7) |
| 7 | Stampede | PASS | pior caso (Redis inteiro frio) é absorvido pelo DDB por construção; expiração escalonada natural |
| 8 | Limites 10x | PASS ✦ | seção "Crescimento 10x" na aba Operação: gargalo é custo (Redis ~US$ 18k); plano = CDN na frente |
| 9 | Idempotência | PASS ✦ | `Idempotency-Key` opcional → tabela `requests` TTL 24 h; retry devolve o mesmo code (trade-off #8) |
| 10 | Consistência | PASS | leitura-após-escrita via populate do Redis na criação; eventual global declarado e tolerado |
| 11 | Perda de dados | PASS | ack do link só após PutItem durável; única perda possível é clique (best effort declarado) |
| 12 | Migrações | PASS | DDB schema-less; repartição gerenciada; flags para mudança de comportamento |
| 13 | Retry storm | PASS ✦ | DDB 50 ms + 1 retry c/ backoff+jitter; breaker corta o Redis degradado (trade-off #9) |
| 14 | Timeouts | PASS ✦ | budget explícito: Redis 10 ms sem retry · DDB 50 ms · ~30 ms de folga dentro do p99 < 100 ms |
| 15 | Contratos externos | PASS | AWS: SLA do DDB aceito no trade-off #5; Safe Browsing com fallback criar-e-rechecar (trade-off #10) |
| 16 | Observabilidade | PASS | métricas cobrem cada modo de falha, incluindo `clicks_dropped`, estado do breaker e bloqueios do WAF |
| 17 | Deploy/rollback | PASS | canary 1→25→100% com rollback automático <2 min; schema-less desacopla dados de código |
| 18 | Custo | PASS | mais caro identificado (Redis US$ 1.800/mês); 10x custa ~US$ 18k → plano CDN registrado |
| 19 | Segurança | PASS ✦ | WAF 10 criações/min/IP + Safe Browsing na criação + recheck assíncrono (410) + TLS via ACM |

✦ = resolvido no loop pós-review.

**Cobertura do diagrama**: 12/12 nós de infraestrutura/externos com entrada em `components` e `costs.items` ✓ (`Browser` é ator externo, sem custo próprio).

<details><summary>Histórico: as 5 FALHAs originais e como foram fechadas</summary>

- **F1 · Backpressure (item 6)**: publish fire-and-forget sem limite podia acumular memória até OOM com fila degradada. → Buffer 10k/instância, descarte do mais antigo, métrica `clicks_dropped`.
- **F2 · Crescimento 10x (item 8)**: não documentado. → Seção na aba Operação: gargalo é custo, plano é CDN aproveitando o `Cache-Control` já emitido.
- **F3 · Idempotência (item 9)**: retry do POST duplicava código; alias devolvia 409 enganoso. → `Idempotency-Key` + tabela `requests` (TTL 24 h); sem key, duplicata documentada.
- **F4 · Timeouts/retry storm (itens 13+14)**: sem budget nem breaker, Redis lento estourava o p99 e dobrava carga no DDB. → Budget 10/50 ms + breaker com sonda de 5 s.
- **F5 · Abuso (item 19)**: borda aberta permitia bot de phishing queimar o domínio em blocklists. → WAF 10/min/IP, Safe Browsing + recheck (→410), TLS declarado.
</details>

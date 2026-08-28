# Guardrails — portão de qualidade do design

Nenhuma sessão pode ser marcada `concluido` sem passar por esta checklist (via `/review` ou fase de fechamento do `/design`). Cada item recebe **PASS** (endereçado com justificativa), **FALHA** (lacuna real — precisa de decisão ou registro consciente de fora-de-escopo) ou **N/A** (não se aplica, com motivo).

## Disponibilidade & Falhas
1. **SPOF**: existe algum componente único cuja queda derruba o sistema? (LB, banco primário, broker, scheduler…)
2. **Failover**: para cada componente com estado, o que acontece quando ele cai? Quanto tempo e quanta perda (RTO/RPO)?
3. **Modos de degradação**: o sistema degrada graciosamente (read-only, fila crescendo, feature off) ou quebra inteiro?
4. **DR**: perda de uma zona/região inteira foi considerada ou descartada conscientemente?

## Tráfego & Escala
5. **Hot spots**: existe chave/partição/usuário quente que concentra carga? (celebrity problem, partição por data…)
6. **Backpressure**: quando um consumidor fica lento, o que segura a fila? Há limite, shedding ou o sistema afoga?
7. **Thundering herd / cache stampede**: expiração em massa de cache ou reconexão em massa foram tratadas (jitter, lock de regeneração, TTL escalonado)?
8. **Limites de crescimento**: o design aguenta 10x? Qual componente estoura primeiro e qual seria o plano?

## Dados & Consistência
9. **Idempotência**: toda escrita que pode ser retried (retry de cliente, redelivery de fila) é idempotente ou deduplicada?
10. **Consistência declarada**: onde é forte, onde é eventual — e o produto tolera as anomalias do eventual (leitura do próprio write, ordenação)?
11. **Perda de dados**: caminho de escrita tem ack antes ou depois da durabilidade? Réplica assíncrona pode perder o quê?
12. **Migrações**: mudança de schema/particionamento em produção tem caminho sem downtime?

## Integrações & Retries
13. **Retry storm**: retries têm backoff exponencial + jitter + limite? Circuit breaker onde dependência externa pode apodrecer?
14. **Timeouts**: toda chamada de rede tem timeout explícito menor que o timeout de quem chamou?
15. **Contratos externos**: dependências de terceiros têm fallback ou o SLA delas vira o seu?

## Operação
16. **Observabilidade mínima**: as 3-4 métricas que detectam cada modo de falha acima existem? Tracing atravessa os hops async?
17. **Deploy/rollback**: dá para reverter em minutos? Mudança de dados acompanha rollback de código?
18. **Custo**: o componente mais caro foi identificado e o custo em 10x é aceitável?

## Segurança (baseline)
19. **AuthN/AuthZ** nos limites do sistema; dados sensíveis criptografados em trânsito e repouso; rate limiting nas bordas públicas.

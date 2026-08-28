# Trade-offs

## 1. Redirect: 302 + Cache-Control 60 s

- **Opções**: 301 (permanente, browser cacheia para sempre) · 302 puro (todo clique nos atinge) · **302 + max-age=60**.
- **Ganha**: amortece hot links virais no browser/CDN sem perder controle — expiração e troca de destino propagam em ≤60 s.
- **Perde**: subcontagem de cliques repetidos na janela de 60 s. Aceito: contagem é best effort.

## 2. Geração de código: contador + faixas + base62

- **Opções**: hash do URL (dedup grátis, mas colisão exige verificar-e-repetir) · aleatório + verificação (1 leitura/escrita) · **contador com faixas de 1M**.
- **Ganha**: zero colisão por construção, zero leitura por escrita, 1 chamada ao alocador por milhão de links.
- **Perde**: códigos enumeráveis (mitigado com permutação bijetiva); alocador é ponto central (mitigado: 1 acesso/milhão, faixas sobrevivem a restart).

## 3. Storage: DynamoDB (KV gerenciado)

- **Opções**: PostgreSQL + réplicas (familiar, mas 24k QPS exige tuning e sharding manual) · Cassandra (throughput, custo operacional alto) · **DynamoDB**.
- **Ganha**: lookup por chave é o modelo nativo; multi-AZ gerenciado (sustenta o 99,99%); escala sem re-arquitetura; TTL nativo para expiração.
- **Perde**: lock-in AWS; custo por request (mitigado: cache absorve ~80% das leituras); queries analíticas ricas ficam difíceis (fora de escopo mesmo).

## 4. Disponibilidade 99,99% (escolha do usuário, acima da recomendação)

- **Ganha**: link quebrado é quebra de confiança direta no produto.
- **Perde**: redundância em todas as camadas e failover testado; ~4 min/mês de erro exige operação disciplinada. Custo aceito conscientemente.

## 5. Região única (multi-região fora de escopo consciente)

- **Opções**: Global Tables + failover Route 53 (cobre queda de região) · **região única multi-AZ**.
- **Ganha**: metade do custo de dados, zero conflitos de replicação, operação simples.
- **Perde**: indisponibilidade regional do DynamoDB derruba o redirect — é o evento que pode estourar o 99,99% no mês. Aceito conscientemente; revisitar se o produto virar receita crítica.

## 6. Contagem de cliques assíncrona

- **Opções**: `UPDATE` síncrono por clique (hot key a 24k/s, latência no caminho crítico) · **fila + agregação em janelas de 10 s**.
- **Ganha**: caminho de redirect intocado; 24k incrementos/s viram centenas de writes/s.
- **Perde**: contador atrasa ~10 s e pode perder eventos em falha da fila. Aceito: best effort declarado.

## 7. Backpressure de cliques: buffer limitado com descarte

- **Opções**: buffer ilimitado (OOM em fila degradada) · bloquear o redirect (fila derruba o caminho crítico) · **buffer 10k/instância + descarte do mais antigo**.
- **Ganha**: falha da fila nunca toca o redirect; descarte é visível (`clicks_dropped` alarmada).
- **Perde**: subcontagem extra em incidente de fila — coerente com o best effort já declarado.

## 8. Idempotência opt-in via `Idempotency-Key`

- **Opções**: dedup automático por URL (vira hash — rejeitado no trade-off 2) · nada (duplicata em todo retry) · **header opcional + tabela `requests` com TTL 24 h**.
- **Ganha**: retry devolve o mesmo code (inclusive alias, sem 409 enganoso); custa 1 PutItem condicional por criação.
- **Perde**: cliente que não manda a key segue sujeito a duplicata — documentado como comportamento esperado.

## 9. Timeouts curtos + circuit breaker no Redis

- **Opções**: confiar nos defaults do SDK (segundos de espera) · **budget explícito (Redis 10 ms sem retry · DDB 50 ms + 1 retry c/ jitter) + breaker que corta o Redis degradado**.
- **Ganha**: Redis lento nunca custa mais que Redis morto; p99 protegido por construção; sem retry storm no DDB.
- **Perde**: breaker aberto = 100% das leituras no DDB (custo sobe temporariamente); mais um estado para operar e testar.

## 10. Anti-abuso: WAF + Safe Browsing com fallback

- **Opções**: borda aberta (bot de phishing queima o domínio em blocklists — mata todos os links) · exigir contas (fora de escopo) · **WAF 10 criações/min/IP + Safe Browsing na criação + recheck assíncrono**.
- **Ganha**: spam limitado na borda; phishing barrado na entrada e caçado depois (link reprovado → 410); SB fora do ar não bloqueia criação (fallback: cria e rechecka).
- **Perde**: primeira dependência externa de terceiro (mitigada pelo fallback); 10/min/IP pode atritar integradores legítimos atrás de NAT — revisitar se houver reclamação.

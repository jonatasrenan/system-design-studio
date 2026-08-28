# Avaliação

**Nota geral: 3,1 / 4** — sessão sólida como material de referência; veredito de prontidão no final.

| # | Critério | Nota | Uma linha |
|---|---|---|---|
| 1 | Problem-Solving | 3 | escopo fechado cedo, mudança de premissa propagada com disciplina |
| 2 | Fundamentos | 3 | cache em 3 camadas, particionamento, replicação — todos justificados |
| 3 | Conhecimento Técnico | 3 | DynamoDB/TTL, WAF, Safe Browsing, ElastiCache — sempre conceito antes da ferramenta |
| 4 | Modelagem de Dados | 3 | KV correto para o acesso; tabelas counter/requests bem desenhadas; contas de keyspace explícitas |
| 5 | Escalabilidade & Perf | 3 | números antes das caixas; 10x planejado; backpressure só entrou via review |
| 6 | Tolerância a Falhas | 3 | estado final forte (breaker, idempotência, DR consciente) — mas 4 das 5 falhas do review eram desta área |
| 7 | Trade-offs & Decisão | 4 | 10 decisões registradas com ganha/perde; nenhum "depende" ficou sem fechar |
| 8 | Criatividade | 3 | permutação bijetiva, 302+max-age híbrido, recheck com fallback — bons toques, nada inédito |

<details><summary>Evidências e lacunas por critério</summary>

**1. Problem-Solving (3)** — Evidência: loop de requisitos fechou escopo/NFRs antes de qualquer caixa; premissa ×2/10 anos propagada com disciplina por todas as etapas (números recalculados, não só tocados). Lacuna: a decomposição foi majoritariamente conduzida pelo assistente de estudo; falta demonstrar a condução autônoma.

**2. Fundamentos (3)** — Evidência: defesa de hot key em 3 camadas (Cache-Control → LRU local → Redis); permutação espalhando partições. Lacuna: consistência do populate do Redis na criação (se falhar, criador pode ver 404 breve) não foi discutida.

**3. Conhecimento Técnico (3)** — Evidência: TTL nativo do DynamoDB com a ressalva das 48 h de atraso (detalhe que entrevistador valoriza). Lacuna: mensageria ficou genérica ("Kinesis/SQS") — a escolha entre elas nunca foi fechada.

**4. Modelagem (3)** — Evidência: SQL vs. NoSQL com números (24k QPS); tabela `requests` com TTL para idempotência. Lacuna: sem diagrama ER/sequência auxiliar; índice para "listar links por dono" nem discutido (aceitável: sem contas).

**5. Escalabilidade (3)** — Evidência: toda estimativa com aritmética visível; seção 10x com gargalo nomeado (custo do Redis) e plano (CDN). Lacuna: buffer/backpressure do publish só apareceu quando o review cobrou — em entrevista real seria o entrevistador cobrando.

**6. Tolerância a Falhas (3)** — Evidência: tabela de modos de falha com mitigação por linha; breaker com budget numérico; DR descartado com argumento de SLA composto. Lacuna: timeouts, idempotência e retry storm não existiam no primeiro passe — a área inteira dependeu do review adversarial.

**7. Trade-offs (4)** — Evidência: 10 entradas com opções/escolha/ganha-perde; até o ajuste fino (30→10 req/min) veio de decisão do usuário; riscos aceitos registrados na visão geral.

**8. Criatividade (3)** — Evidência: permutação bijetiva evita sorteio+verificação; fallback criar-e-rechecar impede que o SLA do Safe Browsing vire nosso. Lacuna: nada que surpreenda um entrevistador calejado — nem precisava.
</details>

## Boas práticas & diagrama

Conceito antes de ferramenta ✓ · trade-offs explícitos ✓ (10 entradas) · operação ✓ (métricas por modo de falha, canary, DR) · custo total ✓ (US$ 3.861/mês + 10x). Diagrama reflete o design final, agrupado em 6 subgraphs com arestas rotuladas ✓ — faltou um diagrama de sequência da criação (Idempotency-Key + Safe Browsing) como apoio.

## Plano de estudo

1. **Resiliência fina do caminho crítico** (timeouts por hop, budget de latência, circuit breaker) — foi a maior lacuna do primeiro passe. Estudar "The Tail at Scale" e praticar: para todo SLO, escrever o budget por hop *no mesmo momento*.
2. **Backpressure e filas** — fire-and-forget sem política de descarte é o erro clássico que o review pegou. Estudar Little's Law e load shedding; gatilho: toda seta assíncrona no diagrama precisa de resposta para "e quando enche?".
3. **Abuso em bordas públicas** — não apareceu no design inicial. Estudar token bucket vs. sliding window e o caso real de blocklist de encurtadores; tratar como requisito funcional, não como "segurança depois".
4. **Conduzir sozinho** — o item mais importante: este estudo foi co-construído. Fazer um simulado de entrevista completo (sem apoio) num problema similar — paste bin, feed — e medir quanto sai espontaneamente.

## Veredito

Os artefatos estão em nível de aprovação (3+ em tudo, um 4). Mas neste estudo o assistente propôs e o autor validou — o sinal de prontidão real é limitado. **Prontidão estimada: "sólido com ressalva"** — os três aprendizados registrados (backpressure, budget de timeouts, anti-abuso) precisam sair espontaneamente na próxima sessão para se consolidarem. Próximo passo recomendado: um simulado de entrevista completo, conduzindo sozinho.

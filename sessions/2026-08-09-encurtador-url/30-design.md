# Design

## A história de uma request

1. Usuário clica em `short.ly/aB3xK9p`. Se clicou nos últimos 60 s, o próprio browser/cache intermediário resolve (Cache-Control) e nem chegamos a ser consultados.
2. Request passa pelo **WAF** (rate limit atua só na criação, não aqui) e chega ao **ALB** (multi-AZ), que roteia para uma instância do **Serviço de Redirect** (stateless).
3. O serviço consulta o **Redis** (`GET code`). **~80% hit** → resposta imediata.
4. Miss → lookup por chave no **DynamoDB** (tabela `links`); popula o Redis (TTL 24 h).
5. Valida `expires_at`; vencido ou inexistente → `404` (com cache negativo curto no Redis).
6. Responde **`302` + `Location` + `Cache-Control: max-age=60`** — p99 < 100 ms.
7. Em paralelo (fora do caminho crítico), publica evento de clique na **fila**.
8. O **Agregador** consome, soma em janelas de ~10 s e incrementa `clicks` em lote no DynamoDB.

## API

```
POST /api/links   { "url": "...", "alias"?: "minha-promo", "ttl_days"?: 30 }
                  Header opcional: Idempotency-Key: <uuid>
                  → 201 { "code": "aB3xK9p", "short_url": "https://short.ly/aB3xK9p" }
                  → 200 + mesmo code se retry com a mesma Idempotency-Key
                  → 409 se alias já existe (de outra request)
GET  /{code}      → 302 Location: <url>   | 404 | 410 (expirado)
GET  /api/links/{code}/stats → { "clicks": 12345 }
```

## Modelo de dados (DynamoDB)

**Tabela `links`** — partition key: `code` (string)

| Atributo | Tipo | Nota |
|---|---|---|
| `code` | S | PK — código gerado (7 chars base62) ou alias |
| `url` | S | destino |
| `created_at` | N | epoch |
| `expires_at` | N | opcional; também vira TTL nativo do DynamoDB |
| `clicks` | N | incrementado em lote pelo agregador |

**Tabela `counter`** — 1 item; `UpdateItem` atômico aloca faixas de 1M IDs por instância do serviço de escrita.

**Tabela `requests`** — PK: `idempotency_key` → `code`; TTL 24 h. `PutItem` condicional: retry com a mesma key devolve o mesmo code (inclusive alias — sem 409 enganoso). Sem a key, duplicata é possível (documentado).

## Geração de código

Contador distribuído: cada instância pega uma **faixa de 1M IDs** (1 chamada atômica por milhão de escritas), consome localmente e converte para base62. Sem colisão por construção, sem leitura por escrita.

<details><summary>Previsibilidade e alias — detalhes</summary>

- **Códigos sequenciais são enumeráveis** → aplica-se uma permutação bijetiva antes do base62 (multiplicação por constante ímpar mod 62⁷): contador 1000001 e 1000002 viram códigos sem relação aparente, sem sorteio nem verificação.
- **Alias customizado**: `PutItem` condicional (`attribute_not_exists(code)`) na mesma tabela — 409 em colisão. O mesmo condicional protege o caso raríssimo de código gerado colidir com alias existente (retry com próximo ID da faixa).
- Faixa perdida (instância morre) = até 1M códigos desperdiçados — irrelevante contra 3,5T de espaço.
</details>

## Deep dives

<details><summary>Cache e hot keys (link viral)</summary>

- Redis read-through, TTL 24 h, ~70 GB (cluster 6 nós, réplica por nó).
- **Cache negativo**: 404 entra no Redis com TTL 60 s — protege o DynamoDB de scan de códigos inexistentes.
- **Hot key** (link viral com milhões de cliques/min): 3 camadas — `Cache-Control: max-age=60` amortece no browser/CDN; cache local em memória no próprio serviço de redirect (LRU pequeno, TTL 5 s) absorve o resto; Redis só vê o vazamento. Nenhuma request de hot link precisa chegar ao banco.
</details>

<details><summary>Contagem de cliques</summary>

- Incremento síncrono no banco a 24k/s = hot key no contador → **fila + agregação**.
- Redirect publica evento *fire-and-forget* (não bloqueia o 302). Agregador soma por código em janelas de ~10 s e faz `ADD clicks N` — reduz 24k writes/s para centenas.
- **Backpressure**: buffer local por instância limitado a **10k eventos**; fila degradada → descarta o mais antigo e incrementa `clicks_dropped` (alarmada). A fila nunca derruba o redirect; perda é aceitável por declaração.
- Perda aceitável: contagem é *best effort* (já subcontamos pelo Cache-Control). Precisão exata está fora de escopo.
</details>

<details><summary>Resiliência do caminho crítico (budget de timeouts + circuit breaker)</summary>

- **Budget dentro do p99 < 100 ms**: Redis **10 ms de timeout, sem retry** (estourou → trata como miss e segue ao banco); DynamoDB **50 ms, 1 retry com backoff+jitter**; sobram ~30 ms para rede/ALB/serviço.
- **Circuit breaker no Redis**: p99 > 20 ms ou erro > 10% na janela → abre, e o serviço vai **direto ao DynamoDB** (que aguenta 24k reads/s por construção), sondando o Redis a cada 5 s. Redis *lento* nunca custa mais que Redis *morto*.
</details>

<details><summary>Anti-abuso e segurança da borda pública</summary>

- **WAF na frente do ALB**: rate limit de **10 criações/min/IP** no `POST /api/links`. O `GET /{code}` fica fora do rate limit — redirect é público por natureza.
- **Validação de destino**: URL checado contra **Google Safe Browsing** na criação + **recheck assíncrono** dos links existentes (phishing muda depois de criado; link reprovado vira `410`). Se a API do SB estiver fora, **cria o link e enfileira o recheck** — o SLA deles não vira o nosso.
- **TLS ponta a ponta**: ACM no ALB; sem tráfego em claro.
</details>

<details><summary>Expiração e consistência</summary>

- **Expiração**: TTL nativo do DynamoDB apaga o item (lazy, até 48 h de atraso) — por isso o serviço **sempre valida `expires_at` na leitura**; o TTL do Redis é limitado por `expires_at`.
- **Leitura-após-escrita**: ao criar, o serviço grava no DynamoDB **e** popula o Redis — o criador testa o link e funciona na hora. Resto do mundo: eventual (segundos), conforme requisito.
- **99,99%**: ALB, serviços e Redis em ≥2 AZs; DynamoDB é multi-AZ nativo. Sem SPOF no caminho de redirect; se o Redis cair inteiro, o DynamoDB segura 24k reads/s sozinho (degradação de latência, não de disponibilidade).
</details>

---
name: review
description: Revisão adversarial de um system design contra os guardrails (classes de falha clássicas) — marca PASS/FALHA/N-A por item e bloqueia conclusão com falhas abertas. Use quando o usuário digitar /review ou antes de fechar um design.
---

# /review — revisão adversarial (guardrails)

Você é um staff engineer cético fazendo design review. Objetivo: encontrar falhas antes que o design seja dado como pronto.

## Dois modos

- **Leve** (`--leve` explícito; o fechamento da passada 1 da skill `design` roda este procedimento inline, sem invocar esta skill): rode `node tools/check.mjs <slug> --lint` e trate a saída como vereditos prontos; depois percorra a checklist rápido reportando em detalhe **só as 3-5 falhas que um entrevistador cobraria** — as demais viram veredito de uma linha. **Sem portão**: falha não bloqueia compartilhar; o usuário corrige as baratas (proposta default por item) e manda as caras para "Decisões adiadas" no trade-offs com defesa de 30s. Pule a fiscalização de cobertura fina (ficha completa, "Defesa em 30s", custo com premissa) — isso é assunto do modo completo. `45-review.md` **não se auto-descreve**: nenhum preâmbulo sobre tipo/escopo da revisão ("revisão preliminar", "completa fica para o polimento") — o arquivo vai direto aos vereditos; o que ficou de fora já vive em "Decisões adiadas" (regra "sem voz de processo" do CLAUDE.md).
- **Completo** (default do `/review` explícito e obrigatório para `status: "concluido"`): tudo abaixo.

1. Resolva a sessão-alvo (ativa na conversa; senão pergunte). **Se a sessão foi conduzida NESTA conversa, use o contexto — releia apenas `guardrails.md` e o que não passou pela conversa**; em conversa nova, leia todos os arquivos dela + `guardrails.md` da raiz.
2. Percorra **todos os itens** da checklist contra o design real. Para cada um:
   - **PASS**: o design endereça — cite onde/como.
   - **FALHA**: lacuna concreta — descreva o cenário de falha específico deste design ("se o consumer reprocessar o evento de pagamento, cobra duas vezes"), não genérico.
   - **N/A**: não se aplica, com motivo de uma linha.
   Seja adversarial de verdade: procure o cenário que quebra, não confirmação do que está bom.
3. **Lints mecânicos são da ferramenta, não seus**: rode `node tools/check.mjs <slug> --lint` — ele verifica deterministicamente cobertura diagrama↔components/costs, subgraphs, filas sem destino de falha (DLQ/reprocesso/"perda aceita"), numeração do fluxo começando na chegada do usuário, budget de zoom (~15 nós, rótulos ≤3 linhas), emojis da taxonomia, atores além do usuário final, "Defesa em 30s" e jargão interno. Incorpore FALHAS e avisos do lint direto nos vereditos, sem re-verificar. Gaste seu julgamento só no que é semântico: **direção de aresta invertida** (resposta desenhada como iniciativa — ex.: "CDN → serviço: polling" quando quem consulta é o cliente) é FALHA de legibilidade; papel secundário com aresta numerada competindo com o fluxo principal, jargão de nicho sem glosa na primeira ocorrência ("overselling", "thundering herd"…) e componente nomeado só pela marca do vendor sem o conceito ("DynamoDB" em vez de "KV gerenciado (ex.: DynamoDB)") são avisos; `why`/`rejected` ausentes em componente que nasceu de decisão são aviso. Ao final, atualize o bloco `guardrails` via `node tools/scorecard.mjs <slug> set-guardrails` (stdin: contagens + resumo de cada FALHA em `falhas`) — é o que aparece na Visão Geral.
4. Escreva `45-review.md` na sessão: tabela resumo (item · veredito · uma linha) + detalhe das FALHAs com sugestão de direção (sem resolver pelo usuário em modo estúdio; em sessão de entrevista já avaliada, pode detalhar a solução).
5. **Portão**: enquanto houver FALHA não endereçada nem registrada como fora-de-escopo consciente em `40-tradeoffs.md`, a sessão não pode ir a `status: "concluido"`. **Emende do veredito direto para UMA proposta concreta por FALHA** (correção + efeito + custo quando relevante) — o usuário valida/veta/aceita como risco POR ITEM; não pergunte antes se ele quer propostas. Ao aplicar cada uma: `30-design.md`, `40-tradeoffs.md`, `diagram.mmd`, veredito em `45-review.md` e `scorecard.mjs set-guardrails`.
6. Falhas recorrentes entre sessões viram itens em `learnings.md`.

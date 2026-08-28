---
name: grade
description: Avalia uma sessão de system design contra a rubrica da entrevista, gerando notas por critério, lacunas e plano de estudo em 60-avaliacao.md. Use quando o usuário digitar /grade ou pedir avaliação de um design.
---

# /grade — avaliação contra a rubrica

1. Resolva a sessão-alvo: a ativa na conversa; senão, liste `sessions/*/meta.json` e pergunte qual avaliar.
2. **Se a sessão foi conduzida nesta conversa, use o contexto** — releia apenas `rubric.md` e o que não passou pela conversa. Em conversa nova, leia todos os arquivos da sessão e a `rubric.md` da raiz.
3. Avalie cada um dos 8 critérios com nota 1-4. Para cada critério:
   - **Evidência**: citações/fatos concretos da sessão que sustentam a nota.
   - **Lacunas**: o que um entrevistador esperaria e não apareceu (seja específico: "não discutiu idempotência no consumer", não "faltou confiabilidade").
4. Verifique também as boas práticas da rubrica (conceito antes de ferramenta, trade-offs explícitos, operação, custo total) e o diagrama: `diagram.mmd` reflete o design final? Está legível (agrupamentos, rótulos)?
5. Atualize o bloco rubric via `node tools/scorecard.mjs <slug> set-rubric '<json>'` (`overall` + `scores` por critério) — alimenta a aba Visão Geral.
5b. **Alimente `argumentario.md`** (raiz): padrões de decisão exercitados nesta sessão que se repetem entre designs (ex.: 301 vs 302, SQL vs KV, fila vs stream) viram/atualizam entradas com a defesa curta — material de revisão pré-entrevista. Não duplique: atualize a entrada existente citando a nova sessão.
6. Escreva `60-avaliacao.md` — **texto autocontido, legível por terceiros via link compartilhado**: sem comandos/skills/mecânica interna (regra do CLAUDE.md); próximos passos em linguagem natural:
   - Tabela: critério · nota · resumo de uma linha.
   - Seção por critério com evidências e lacunas.
   - **Plano de estudo**: 3-5 itens priorizados (tema, por que importa, o que estudar/praticar).
   - Nota geral e veredito honesto de prontidão para entrevista.
7. **Atualize `learnings.md`** (raiz): cada lacuna relevante vira um item `aberto` (ou reforça um existente — não duplique); itens `aberto` de sessões anteriores que foram demonstrados com solidez nesta sessão são promovidos a `dominado`, citando a sessão como evidência.
8. Se aplicável, mude `status` para `"concluido"` no `meta.json` (o `updated` as ferramentas já mantêm) e resuma o veredito na conversa. Notas infladas destroem o propósito do harness — seja rigoroso como um entrevistador sênior de verdade.

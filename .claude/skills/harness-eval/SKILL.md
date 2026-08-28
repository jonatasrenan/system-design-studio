---
name: harness-eval
description: Avalia se o harness produziu um processo/resultado correto para uma sessão — camada determinística (tools/eval.mjs) + julgamento semântico (LLM-as-judge), com comparação opcional contra uma sessão golden. Use após testes cegos ou mudanças no harness.
---

# /harness-eval — avaliação do harness (não do candidato)

Objeto de avaliação: **o processo do harness**, não a qualidade do design em si (isso é papel do `/grade`). Rode de preferência numa sessão de Claude diferente da que produziu o design (juiz independente).

Argumentos: `<slug|caminho da sessão>` e opcionalmente `--golden <dir>` (o usuário informa o caminho do golden; não presuma).

## Camada 1 — determinística

Rode `node tools/eval.mjs <alvo> [--golden <dir>]` e incorpore o resultado. Qualquer ✗ é falha objetiva do harness — vá direto à causa (skill não instruiu? hook não disparou? agente ignorou convenção?).

**Custo do processo**: rode também `node tools/timing.mjs --latest` (ou com o caminho do transcript da sessão avaliada) — sai a linha do tempo de tool calls, durações e gaps de geração. Use para apontar atrito do harness (Reads desnecessários, chamadas gotejadas, round-trips de skill) separado do custo legítimo de geração de conteúdo.

## Camada 2 — juiz semântico

O que scripts não pegam. Leia todos os artefatos da sessão (e do golden, se houver) e julgue cada dimensão com nota 1-4 + evidência:

1. **Coerência entre etapas**: os números batem entre requisitos → estimativas → scorecard → design? (ex.: QPS declarado vs dimensionamento do cache; custo citado no texto vs costs do scorecard)
2. **Fidelidade diagrama ↔ design**: todo componente citado no design está no diagrama e vice-versa? A legenda descreve o que o design diz que o componente faz?
3. **Propagação semântica**: se houve mudança de premissa na sessão, ela chegou de verdade nos downstream (números recalculados, não só arquivos "tocados" para enganar o checker de hashes)?
4. **Profundidade do processo**: requisitos foram levantados antes da solução? Trade-offs têm alternativas reais e perdas explícitas, ou são retóricos? O review foi adversarial ou carimbo?
5. **Skimabilidade**: cada etapa se entende em ~1 tela? A história de uma request permite entender o sistema sem ler o resto?
6. **(com golden)** Cobertura relativa: o que o golden tem que a candidata não tem — e é falta do *harness* (não conduziu) ou variação legítima de design?

Importante: designs diferentes do golden podem ser igualmente válidos — julgue **processo e completude**, não semelhança de solução.

## Relatório

Escreva o veredito em um arquivo `eval-report-<yyyy-mm-dd>.md` **dentro do diretório que o usuário indicar** (num teste cego, fora do repo, junto do golden): resultado da camada 1, tabela das 6 dimensões com notas e evidências, lista de regressões/lacunas do harness com a correção sugerida (em qual skill/guardrail/ferramenta mexer), e veredito final: **harness OK / harness regrediu / inconclusivo**. Resuma o veredito na conversa.

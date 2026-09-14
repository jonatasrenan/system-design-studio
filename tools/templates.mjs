// Session stage templates — module shared between stage.mjs (creation)
// and the pipeline/viewer (stub detection: orange tab while the template hasn't been touched).
// Template CONTENT stays in Portuguese on purpose: it becomes actual session
// artifact text, and CLAUDE.md's writing rule keeps session files in Portuguese.
export const TEMPLATES = {
  requisitos: [
    '10-requisitos.md',
    `# Requisitos

## Funcionais

## Não-funcionais
_(latência, disponibilidade, consistência, durabilidade)_

## Escala
_(usuários, QPS, dados, picos)_

## Restrições
_(custo-alvo mensal, time, prazo, tecnologias impostas/vetadas)_
`,
  ],
  estimativas: [
    '20-estimativas.md',
    `# Estimativas

_(toda linha mostra a conta, não só o resultado)_

## QPS

| | Conta | Resultado |
|---|---|---|

## Storage

## Cache

## Banda
`,
  ],
  dominio: [
    '25-dominio.md',
    `<!-- lint contract (tools/check.mjs --lint), evaluated after HTML comments are
stripped from the file — this block itself is never read as content:
- Invariants: a table whose header row starts with "| ID |"; IDs follow the
  pattern INV-n; no data cell may be left empty; the "Prevenção" column only
  accepts one of prevenido no banco / prevenido no código / detectado depois /
  só coberto por teste, or an explicit not-yet-validated mark. Section
  missing entirely: reported as not checked, never silently passing.
- Lifecycle: a "## Ciclo de vida" heading containing a mermaid
  stateDiagram-v2 block; every state used as a transition's destination must
  also appear as a transition's source, or terminate at the diagram's final
  state. Enum values declared on a "state" attribute's comment in the
  erDiagram of 35-modelo-de-dados.md must all exist here too (cross-file
  check, case/accent-insensitive).
- Aggregates: one "### Agregado: <name>" heading per aggregate; its body must
  mention cardinality (FALHA if it doesn't) and cite the INV-n that justifies
  the boundary, or say the boundary is justified some other way (warning if
  neither is present — concurrency alone is a legitimate justification).
- Contexts x vocabulary: every context listed under "## Contextos" must own
  at least one row of the "| Termo | Contexto dono | Significado |" table
  under "## Vocabulário"; every owner cited in that table must be one of the
  declared contexts (matched without regard to accents or case).
Tables must be contiguous: the lint stops reading a table at the first line
that isn't part of it. -->
# Domínio

## Contextos
_(um bounded context por linha — nome curto e o que ele possui)_

## Invariantes

| ID | Regra | Prevenção | No código | No banco | Em teste |
|---|---|---|---|---|---|

## Ciclo de vida

\`\`\`mermaid
stateDiagram-v2
\`\`\`

## Agregados

_(um \`### Agregado: <nome>\` por agregado — corpo cita "cardinalidade" e o INV-n que justifica a fronteira, ou confirma que a fronteira está "justificada" por outro motivo, ex.: concorrência)_

## Vocabulário

| Termo | Contexto dono | Significado |
|---|---|---|
`,
  ],
  design: [
    '30-design.md',
    `# Design

## A história de uma request

_(5-8 passos numerados, ponta a ponta — reescreva quando o fluxo mudar)_

## API

## Modelo de dados

## Deep dives

_(um <details> por tema: cache, falhas, consistência...)_
`,
  ],
  modelo: [
    '35-modelo-de-dados.md',
    `<!-- lint contract (tools/check.mjs --lint): to declare a state enum on an
erDiagram attribute, name the attribute so it contains "state" and add a
comment right after it with the possible values, lowercase, in the design's
own language, separated by "|" (e.g. a "reservada|confirmada|expirada"
comment on a "state" attribute). Every one of those values must also exist
as a state in 25-dominio.md's lifecycle diagram (case/accent-insensitive
cross-file check) — this is how a mismatch between the two tabs gets caught
instead of drifting silently. Terms under "## Vocabulário" here are matched
against 25-dominio.md's vocabulary the same way. -->
# Modelo de dados

## Grão
_(a unidade de dado que representa a transação/registro do domínio — é o que decide o grão da linha)_

## Entidades

\`\`\`mermaid
erDiagram
\`\`\`

## Chaves, unicidade e nulos

## Índices × consultas
_(cada consulta que o design depende ↔ o índice que a sustenta)_

## Ciclo de vida do dado
_(retenção, expurgo, cascata)_

## Vocabulário
_(todo termo aqui casa com um termo da tabela de vocabulário do Domínio — mesma grafia, mesmo significado)_

| Termo | Significado |
|---|---|
`,
  ],
  tradeoffs: [
    '40-tradeoffs.md',
    `# Trade-offs

<!-- formato de cada entrada:
## N. Título da decisão
- **Opções**: a · b · c
- **Escolha**: x
- **Ganha**:
- **Perde**:
- **Defesa em 30s**: como articular a escolha na entrevista, com a nuance que diferencia.

Seções fixas no fim do arquivo:
## Decisões adiadas  — 1 linha cada: o que seria feito + por que pode esperar.
## Referências de mercado (opcional) — 1 linha por decisão: como sistemas reais resolvem, com fonte.
-->
`,
  ],
  operacao: [
    '50-operacao.md',
    `# Operação

## Observabilidade
_(métricas por modo de falha + alertas)_

## Deploy e rollback

## DR / modelo de falhas

## Time para operar
_(quantos engenheiros, por função, para rodar NA escala pedida — e o regime de on-call)_

## Custo total e em 10x
`,
  ],
  duvidas: [
    '90-duvidas.md',
    `# Dúvidas antecipadas

_(FAQ do design: perguntas que um leitor/entrevistador faria, respostas de 2-4 linhas. Resposta que já vive num trade-off aponta para ele em 1 linha.)_
`,
  ],
  poc: [
    '70-poc.md',
    `# POC / MVP

## O que esta POC prova
_(2-3 hipóteses de risco que precisam ser verdade para o design valer — cada uma vira passos da ordem de ataque)_

## Estrutura de pastas
_(por responsabilidade, 1 linha por pasta — sem código)_

\`\`\`
raiz/
└── ...
\`\`\`

## Stack mínima
_(o que roda local — docker-compose do dia 1 — e o que só entra gerenciado depois; produto concreto aqui é bem-vindo: POC é implementação)_

## Ordem de ataque
_(3-6 passos; cada um termina com **pronto quando:** o critério observável de aceite)_

## Métricas de aceite
_(tabela: hipótese · métrica · alvo · medido com quê — os números que dizem "a POC passou")_

## O que a POC NÃO prova
_(simplificações conscientes — escala real, DR, hardening — e onde cada uma será provada depois)_
`,
  ],
};

// filename -> template content (to detect a stub by exact comparison)
export const TEMPLATE_BY_FILE = Object.fromEntries(Object.values(TEMPLATES));

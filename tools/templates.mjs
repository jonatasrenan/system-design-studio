// Templates das etapas de sessão — módulo compartilhado entre stage.mjs (criação)
// e o pipeline/viewer (detecção de stub: aba laranja enquanto o template não foi tocado).
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

// filename -> conteúdo do template (para detectar stub por comparação exata)
export const TEMPLATE_BY_FILE = Object.fromEntries(Object.values(TEMPLATES));

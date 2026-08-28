# Rubrica de Avaliação — System Design Interview

## O formato que este harness treina

Uma entrevista de system design típica entrega um problema de arquitetura aberto para o candidato evoluir ao vivo, com desenho — e avalia a solução ponta a ponta: resiliente, escalável, manutenível e confiável.

Duas implicações para o treino: o desenho é parte da avaliação, não acessório; e a conversa — perguntas, co-construção, trade-offs verbalizados — pesa tanto quanto o resultado final. Por isso cada sessão aqui produz artefatos e diagrama, não um chat.

## Critérios

Cada critério é avaliado de 1 a 4:
1 = não demonstrou · 2 = superficial · 3 = sólido · 4 = destaque (profundidade + trade-offs explícitos)

## 1. Problem-Solving
- Entende e decompõe problemas complexos.
- Mapeia requisitos, restrições e soluções possíveis.
- Propõe arquitetura escalável, eficiente e confiável.

## 2. Fundamentos de System Design
- Princípios: escalabilidade, disponibilidade, performance, manutenibilidade.
- Conceitos distribuídos: balanceamento, cache, replicação, particionamento.

## 3. Conhecimento Técnico
- Bancos de dados, protocolos de rede, mensageria, storage, CDNs, observabilidade.

## 4. Modelagem de Dados & Armazenamento
- Define modelos e esquemas para as necessidades da aplicação.
- Domina SQL vs. NoSQL e seus prós/contras; estratégias de índices, sharding, consistência.

## 5. Escalabilidade & Performance
- Dimensiona para crescimento de usuários e carga.
- Conhece horizontal/vertical scaling, caching, queueing, backpressure.

## 6. Tolerância a Falhas & Confiabilidade
- Estratégias de redundância, failover, circuit breaker, retry, idempotência, DR.
- Considera modelos de falha e mitigação.

## 7. Trade-offs & Decisão
- Pesa performance, escalabilidade, simplicidade, custo, prazo.
- Toma decisões informadas e explícitas.

## 8. Criatividade & Inovação
- Explora soluções originais quando adequado; considera novas tecnologias com critério.

## Boas práticas esperadas durante a entrevista
- Priorizar conceitos antes de ferramentas: citar tecnologias explicando o racional vs. alternativas.
- Aprofundar o problema antes da solução: validar requisitos e restrições.
- Fazer perguntas e co-construir: usar o diálogo para refinar o design.
- Explicar trade-offs: deixar explícito o que ganha e o que perde em cada escolha.
- Pensar em operação: logs, métricas, tracing, deploy, rollback, feature flags, migrações.
- Pensar no custo total: infraestrutura, time, complexidade, manutenção e risco.

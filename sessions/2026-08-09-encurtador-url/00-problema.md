# Problema

Projetar um **encurtador de URLs** estilo bit.ly: dado um URL longo, gerar um código curto único; ao acessar o link curto, redirecionar para o URL original com latência mínima.

## Contexto

- Estudo de entrevista de system design (modo estúdio).
- Problema clássico: leitura-pesada, chave-valor no núcleo, com decisões interessantes de geração de código, cache e escala de redirect.

## Escopo

**Dentro (a confirmar no loop de requisitos):**
- Encurtar URL → código curto; redirect código → URL.
- Escala, latência e disponibilidade do caminho de redirect.

**Fora / a decidir:**
- Aliases customizados, expiração (TTL), analytics de cliques, contas de usuário, API pública — serão fechados na fase de requisitos.

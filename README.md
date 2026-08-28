# System Design Studio

Harness para estudar system design de entrevistas com o [Claude Code](https://claude.com/claude-code). A conversa acontece no terminal; um painel web mostra em tempo real os artefatos do design — requisitos, estimativas, decisões, diagrama — atualizados a cada troca. Cada design vira um diretório de arquivos que dá para reler, comparar e compartilhar como design doc.

## Requisitos

Node.js 20 ou superior. Nenhuma dependência npm — o viewer é um servidor HTTP nativo e as libs de front (Mermaid, marked) estão vendorizadas em `viewer/public/vendor/`. Só o compartilhamento de design (opcional, no fim deste arquivo) exige mais: a AWS CLI autenticada.

## Uso

```bash
node viewer/server.mjs        # painel em http://localhost:4400 (PORT muda a porta)
claude                        # em outro terminal, na raiz do repo
```

Os comandos abaixo são skills em `.claude/skills/`: ficam disponíveis por rodar o `claude` a partir da raiz deste repositório (e confiar no diretório quando ele perguntar), junto com as instruções de `CLAUDE.md` e o hook de consistência de `.claude/settings.json`.

| Comando | O que faz |
|---|---|
| `/design <problema>` | Novo estudo em modo estúdio: requisitos → estimativas → design → trade-offs → operação |
| `/design` | Lista os designs existentes para continuar um |
| `/interview` | Simulado solo: o Claude é entrevistador e escriba ao mesmo tempo |
| `/interviewer` | Simulado a três: este Claude é só o entrevistador; outro Claude, em outra sessão, apoia o candidato |
| `/review` | Revisão adversarial contra as classes de falha de `guardrails.md` |
| `/grade` | Avaliação contra a rubrica de `rubric.md` + plano de estudo |
| `/harness-eval` | Avalia o harness (não o candidato): eval determinística + juiz semântico |

Também dá para conversar em linguagem natural ("vamos desenhar um encurtador de URLs") — `CLAUDE.md` mapeia a intenção para o fluxo certo.

## Como está organizado

| Caminho | Papel |
|---|---|
| `sessions/<slug>/` | Um diretório por design: `.md` numerados (viram abas), `diagram.mmd` (Mermaid, fonte única do desenho), `scorecard.json` (painel executivo), `meta.json` |
| `rubric.md` | Critérios da entrevista, notas 1-4 |
| `guardrails.md` | Checklist de classes de falha (SPOF, idempotência, backpressure, hot keys, DR…); nenhum design conclui com falha aberta |
| `learnings.template.md` | Semente da memória de erros recorrentes (de `aberto` a `dominado`), que realimenta as próximas sessões |
| `argumentario.template.md` | Semente do repertório de decisões com a defesa curta pronta — revisão pré-entrevista |
| `tools/` | IO mecânico determinístico: criação de sessão e etapas, patch do scorecard, checagem de consistência |
| `viewer/` | Servidor Node com file watcher + SSE e o front do painel |
| `.env.example` | Semente da configuração pessoal (bucket, distribution, perfil AWS, porta) |
| `CLAUDE.md` | As instruções que dirigem o agente: fases, protocolo de propagação, regras de escrita |

O exemplo em `sessions/2026-08-09-encurtador-url/` é uma sessão real, do problema à avaliação. Foi a primeira do estúdio e antecede parte das convenções de hoje — não traz a ficha completa de componente, a "Defesa em 30s" por trade-off, nem os arquivos de POC e dúvidas.

**O que é seu não vira commit.** As suas sessões (`sessions/*`, menos a de exemplo) e a sua memória (`learnings.md`, `argumentario.md`, criados dos `.template.md` no primeiro uso) estão no `.gitignore`. Assim dá para estudar em cima de um clone, ou de um fork, sem que o conteúdo dos seus designs apareça como mudança para mandar de volta. Para versionar os seus, use outro repositório — ou remova essas linhas do `.gitignore`, sabendo o que está publicando.

## Duas peças que merecem explicação

**Propagação de premissa.** O pipeline é um DAG: mudar um requisito invalida estimativas, design e custos que dependem dele. `tools/check.mjs` compara com a última baseline e lista deterministicamente o que ficou para trás; um Stop hook (`.claude/settings.json`) bloqueia o fim do turno enquanto houver propagação pendente, com uma carência de 2 minutos para a sessão que o agente acabou de tocar.

**Compartilhar um design.** `tools/share.mjs` publica uma sessão como página estática (o mesmo painel, com os dados embutidos) num bucket S3 atrás de um CDN — útil para o entrevistador acompanhar ao vivo. É opcional, chama a **AWS CLI** (`aws s3 cp`, `aws cloudfront create-invalidation`) e precisa de configuração:

```bash
cp .env.example .env                     # e preencha:
#   SD_SHARE_BUCKET=meu-bucket            (obrigatório)
#   SD_SHARE_BASE=https://exemplo.com     (obrigatório: URL pública na frente do bucket)
#   SD_SHARE_DIST=E1234567890ABC          (opcional: distribution CloudFront a invalidar)
#   AWS_PROFILE=...                       (opcional: herda o ambiente)

node tools/share.mjs <slug>              # publica; --dry-run só gera o HTML, sem tocar na AWS
node tools/share.mjs <slug> --off        # pausa a republicação automática
node tools/share.mjs <slug> --delete     # tira do ar (compartilhar de novo devolve a mesma URL)
```

O `.env` fica fora do versionamento (o repositório traz só o `.env.example`), e variável exportada no shell vence o arquivo. Sem as duas obrigatórias o comando falha dizendo o que falta, sem chamar a AWS; o resto do harness funciona offline.

## Licença

MIT — veja [LICENSE](LICENSE).

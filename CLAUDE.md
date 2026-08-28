# jonatasrenan System Design Studio — harness de estudos

Repositório para praticar system design de entrevistas. Cada estudo é uma **sessão** em `sessions/<slug>/`. O viewer web (`node viewer/server.mjs`, http://localhost:4400) renderiza as sessões em abas e atualiza sozinho via SSE quando os arquivos mudam.

## Você é o piloto

O usuário conversa em linguagem natural — ele **não** conhece nem precisa chamar skills. Mapeie a intenção e conduza:

| O usuário diz algo como | Você faz |
|---|---|
| "vamos trabalhar num system design sobre X" / "novo design" | fluxo da skill `design` (sessão nova) |
| "vamos continuar o design de X" / "onde paramos?" | fluxo da skill `design` (continuar sessão) |
| "quero treinar / simular uma entrevista" (solo) | fluxo da skill `interview` — o piloto é entrevistador E escriba |
| "seja o entrevistador" (simulado a três: entrevistador aqui, piloto em outra sessão) | fluxo da skill `interviewer` — entrevistador puro, zero arquivos |
| "revisa esse design" / "o que está frágil?" | fluxo da skill `review` |
| "como fui?" / "avalia" | fluxo da skill `grade` |
| "muda a premissa X para Z" / qualquer mudança de requisito | **protocolo de propagação** abaixo |

## Protocolo de propagação (mudança de premissa)

O pipeline de uma sessão é um DAG (também é a ordem das abas): `00-problema → 10-requisitos → 20-estimativas → 30-design → 40-tradeoffs → 50-operacao → diagram/scorecard → 90-duvidas → 45-review → 70-poc → 60-avaliacao`. Quando qualquer premissa mudar:

1. Atualize o arquivo upstream onde a premissa vive.
2. Rode `node tools/check.mjs <slug>` — ele compara com a última baseline e lista **deterministicamente** os arquivos downstream não revisitados.
3. Percorra cada um: atualize o que a mudança afeta (números, componentes, custos, diagrama) ou confirme explicitamente que não é afetado.
4. Ao terminar, rode `node tools/check.mjs <slug> --baseline` para gravar o novo estado consistente.

Um Stop hook roda `node tools/check.mjs --hook` ao fim de cada turno e devolve a lista do que falta, bloqueando o encerramento. Duas folgas evitam que ele atrapalhe: sessão com arquivo tocado nos últimos 2 minutos fica de fora (a cobrança cai no turno seguinte), e um segundo bloqueio no mesmo encadeamento libera com aviso. Grave a primeira baseline de uma sessão quando ela atingir o primeiro estado coeso (fim da fase de design inicial); antes disso o checker não cobra staleness.

## Regras para o agente

- Toda conversa de design pertence a uma sessão. Se não houver sessão ativa na conversa, resolva primeiro (continuar existente ou criar nova) — veja a skill `design`.
- **Persista cedo e com frequência — e em bloco paralelo**: após cada troca substantiva (requisito fechado, decisão tomada, componente adicionado), atualize os arquivos da sessão e o `diagram.mmd`. As escritas de uma mesma rodada são independentes: emita todas **num único bloco de tool calls paralelos**, nunca gotejadas em sequência. O usuário acompanha as abas do viewer em tempo real — arquivos desatualizados quebram a experiência.
- **A saída do trabalho são os arquivos, não o chat**: não narre nem resuma no chat o que acabou de persistir (o painel acende a etapa sozinho) — marcador curto e siga para a próxima decisão. Perguntas do usuário são a exceção: sempre resposta completa.
- O diagrama tem **fonte única**: `diagram.mmd` (Mermaid). Nunca criar diagramas em outro formato/lugar. Diagramas auxiliares (sequência, ER) podem viver em fences ```mermaid dentro dos `.md`.
- Escreva os arquivos de sessão em português, tom de design doc: direto, com números e justificativas.
- **Artefatos de sessão são autocontidos e podem ser lidos por terceiros** (link compartilhado durante entrevistas): nunca cite dentro dos `.md` comandos, skills ou mecânica interna (`/design`, `/review`, `/grade`, "harness", "checker", "baseline", nomes de arquivos como `scorecard.json`/`learnings.md`). Referências a outras partes visíveis do design usam os nomes das abas ("visão geral", "trade-offs"). Recomendações de próximo passo em linguagem natural ("fazer um simulado de entrevista"), nunca em comando. **Sem voz de conversa nem de processo**: artefato é design doc — nunca se dirige ao leitor ("— me corrija", "fecha?", "aguardando resposta") nem cita mecânica de trabalho ("passada 1/2", "passada leve"); premissa assumida se registra fechada ("Fora de escopo (assumido): X"), e aprofundamento futuro como "detalhamento planejado", sem nomear fase. **Sem jargão que confunda a mesa**: termo de nicho ou anglicismo ("overselling", "thundering herd"…) só quando não houver equivalente simples — e com explicação de meia linha na primeira ocorrência; vocabulário padrão de entrevista (cache, fila, réplica) dispensa glosa. **Classe antes de marca**: componentes nomeados pelo conceito ("KV gerenciado", "balanceador gerenciado"), produto como exemplo só onde ancora números; nomes-de-tecnologia (Redis, Kafka, Postgres) usam direto; marca de vendor/hospedagem fica na aba de custos.
- **Nunca peça permissão para continuar o fluxo**: fase fechada → próxima fase no mesmo turno. Confirmação ("fecha?") é só para decisão real em aberto; andamento se anuncia, não se requisita.
- `meta.updated` é mantido automaticamente pelas ferramentas (`stage`, `scorecard`) — edite `meta.json` manualmente só para mudar `status`.

## Estrutura de uma sessão

```
sessions/<yyyy-mm-dd>-<slug>/
├── meta.json          # {"title", "mode": "estudio"|"entrevista", "status": "em-andamento"|"concluido", "created", "updated"}
├── 00-problema.md     # enunciado, contexto, escopo in/out
├── 10-requisitos.md   # funcionais, não-funcionais, restrições
├── 20-estimativas.md  # usuários, QPS, storage, banda — contas explícitas
├── 30-design.md       # API, modelo de dados, componentes, deep dives
├── 40-tradeoffs.md    # decisões: opções consideradas, escolha, o que ganha/perde
├── 45-review.md       # resultado da revisão adversarial (guardrails) — gerado pela skill review
├── 50-operacao.md     # observabilidade, deploy, rollback, DR, custo
├── 60-avaliacao.md    # gerado pela skill grade
├── 70-poc.md          # estrutura de pastas do MVP por responsabilidade — escrito ao fim do design inicial
├── 90-duvidas.md      # FAQ antecipada: perguntas que o piloto prevê, respostas de 2-4 linhas
├── diagram.mmd        # diagrama principal (Mermaid), fonte única
└── scorecard.json     # dados estruturados do design — vira a aba "Visão Geral" do viewer
```

## Ferramentas (IO mecânico NUNCA é datilografado pela LLM)

| Operação | Comando |
|---|---|
| Criar sessão (setup completo: esqueleto + viewer + learnings/argumentário no stdout) | `node tools/new-session.mjs "<título>" --mode estudio\|entrevista [--slug <slug>] [--no-viewer]` → linha 1 é o slug |
| Criar etapas com template (várias por chamada) | `node tools/stage.mjs <slug> <etapa> [<etapa>...] [--print]` (requisitos\|estimativas\|design\|tradeoffs\|operacao\|duvidas\|poc; `--print` só imprime o template, para Write direto) |
| Qualquer escrita no scorecard (preferir `apply` multi-bloco via stdin/heredoc) | `node tools/scorecard.mjs <slug> apply` ← stdin `{"components":[…],"costs":[…],"slos":[…],"capacity":[…],"risks":[…],"guardrails":{…},"rubric":{…}}` (comandos granulares `upsert-*`/`set-*`/`add-risks` seguem valendo) |
| Consistência / baseline (valida antes de gravar) | `node tools/check.mjs [<slug>] [--baseline] [--force]` |
| Lints determinísticos de review (cobertura diagrama↔scorecard, filas, numeração, jargão, budget) | `node tools/check.mjs <slug> --lint` |
| Eval estrutural | `node tools/eval.mjs <slug> [--golden <dir>]` |
| Escrever em `learnings.md`/`argumentario.md` (append/promote/note sob lock — seguro com sessões em paralelo) | `node tools/learnings.mjs append [--target learnings\|argumentario] --session <slug>` ← stdin com itens `## título`; `promote "<título>" --session <slug>`; `note "<título>" "<texto>" [--target …]` |
| Linha do tempo de uma conversa (tool calls × geração) | `node tools/timing.mjs --latest \| <transcript.jsonl>` |
| Compartilhar design (link público) | `node tools/share.mjs <slug>` — só quando o usuário pedir; depois o viewer re-publica sozinho a cada mudança (`--off` pausa, `--delete` tira do ar). Exige `SD_SHARE_BUCKET` e `SD_SHARE_BASE` no ambiente; sem elas, avise o usuário em vez de tentar publicar |

**A página compartilhada É o painel**: `share.mjs` embute o mesmo `app.js`/`style.css` do viewer em modo estático (dados em `window.__DATA__`, auto-refresh por ETag). Toda melhoria no painel entra automaticamente no compartilhado — nunca criar divergência entre os dois sem combinar com o usuário. Caso de uso principal: o entrevistador acompanha o link ao vivo durante a entrevista.

### scorecard.json

Painel executivo da sessão. Preencha os blocos **conforme os dados fecham na conversa** (não deixe para o final): `slos` e `capacity` quando os requisitos/estimativas fecham; `costs.items` conforme cada componente entra no design (a skill `review` cobra custo por componente); `guardrails` é escrito pela skill `review`; `rubric` pela skill `grade`. O viewer soma o custo total sozinho — nunca escreva total.

```json
{
  "slos":     [{ "name": "p99 redirect", "target": "< 100 ms" }],
  "capacity": [{ "name": "QPS leitura (pico)", "value": "16k" }],
  "components": [{ "name": "Serviço de Redirect",
                   "purpose": "papel neste design, UMA linha (hover + ficha)",
                   "what": "o que o componente É, conceito para qualquer leitor",
                   "failure": "se falhar: impacto + mitigação (a pergunta clássica de entrevista)",
                   "scaling": "como escala / qual o limite / é gargalo?",
                   "why": "a decisão que o colocou ali, 1-2 linhas",
                   "rejected": ["rótulos curtos das opções descartadas"], "tradeoff": "#3" }],
  "costs":    { "unit": "USD/mês", "items": [{ "component": "…", "cost": 450, "cost10x": 3800, "notes": "premissa da conta" }] },
  "guardrails": { "pass": 0, "falha": 0, "na": 0, "falhas": ["resumo de cada FALHA aberta"] },
  "rubric":   { "overall": 0, "scores": [{ "criterio": "…", "nota": 0 }] },
  "risks":    ["riscos aceitos / fora-de-escopo conscientes"]
}
```

**Todo nó do `diagram.mmd`, exceto atores** (usuário, back-office), **tem entrada em `components`** (objetivo de uma linha) **e em `costs.items`** — a legenda aparece junto do diagrama para leitura rápida; a skill `review` cobra as duas coberturas.

## Escrita skimável

As abas do viewer são para bater o olho: cada `.md` de sessão mira **~1 tela sem rolagem**. Estrutura: conclusão/números primeiro, prosa mínima; aprofundamentos (contas longas, alternativas descartadas, cenários de falha detalhados) vão em blocos colapsáveis `<details><summary>título</summary>…</details>`, que o viewer renderiza. `30-design.md` **começa** com a seção `## A história de uma request` — a jornada ponta a ponta em 5-8 passos numerados, antes de qualquer detalhe.

Os arquivos do pipeline viram abas na ordem do DAG acima, com rótulos fixos (Problema, Requisitos, …); só `.md` fora do pipeline usa o primeiro `# H1` como título. Crie os arquivos gradualmente conforme as fases avançam — não crie todos vazios de uma vez.

## Guardrails

`guardrails.md` na raiz é o portão de qualidade: checklist de classes de falha (SPOF, idempotência, backpressure, hot keys, retry storm, DR, migrações…). Nenhuma sessão vai a `status: "concluido"` com FALHA em aberto: a checagem bloqueia enquanto `guardrails.falha` for maior que zero. FALHA que o usuário aceita como risco consciente **sai da contagem** — vira uma entrada em `risks` e uma decisão registrada em `40-tradeoffs.md`; o que fica em `falha` é o que ainda não tem resposta. O resultado vive em `45-review.md` na sessão.

## Aprendizados e argumentário entre sessões

`learnings.md` na raiz é a memória do estudo — itens com status `aberto`/`dominado`, cada um ligado à sessão de origem. `argumentario.md` é o irmão dele: padrões de decisão recorrentes (301 vs 302, SQL vs KV…) com a "Defesa em 30s" pronta — alimentado pelo `/grade`, revisado antes de entrevistas. Toda entrada de `40-tradeoffs.md` termina com uma linha **"Defesa em 30s"**.

- **Ao iniciar ou continuar qualquer sessão**: leia `learnings.md` e use os itens abertos ativamente (em modo estúdio, alerte antes do usuário repetir o erro; em modo entrevista, provoque exatamente nessas áreas para testar se evoluiu).
- **Ao avaliar (`/grade`) ou corrigir algo relevante**: adicione/atualize itens — sem duplicar; se um item aberto foi demonstrado com solidez, promova para `dominado` citando a sessão que comprovou.

## Variáveis de ambiente

`.env` na raiz (fora do versionamento; `.env.example` é a semente) ou o shell: `SD_SHARE_BUCKET`/`SD_SHARE_BASE`/`SD_SHARE_DIST` e `AWS_PROFILE`/`AWS_REGION` para compartilhar; `PORT` e `HOST` para o viewer; `SD_SESSION=<slug>` limita o Stop hook a uma sessão (útil com sessões em paralelo); `SD_NO_VIEWER=1` cria sessão sem subir o painel.

## Viewer

- Subir: `node viewer/server.mjs` (porta 4400 por padrão, ou `PORT`; sem dependências npm). O painel também tem botão de compartilhar/descompartilhar a sessão, que chama o mesmo `share.mjs`.
- Antes de iniciar/continuar uma sessão, verifique com `curl -s localhost:4400/api/health`; se não estiver rodando, suba em background e avise o usuário para abrir http://localhost:4400.

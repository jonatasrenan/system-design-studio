# Requisitos

## Funcionais

1. **Encurtar**: URL longo → código curto único (gerado pelo sistema).
2. **Alias customizado**: usuário pode escolher o código (ex: `/minha-promo`); colisão → erro.
3. **Redirect**: `GET /<code>` → redirect HTTP para o URL original.
4. **Expiração**: TTL opcional por link; **padrão: nunca expira**.
5. **Contagem de cliques**: total de cliques por link (número simples).

**Fora de escopo (consciente):** analytics ricos (referrer/geo/dashboard), contas de usuário/login, edição de destino.

## Não-funcionais

| Requisito | Alvo | Implicação |
|---|---|---|
| Latência redirect | **p99 < 100 ms** | resolve na memória (cache), não no disco |
| Disponibilidade redirect | **99,99%** (~4 min/mês) | multi-AZ, sem SPOF, failover automático |
| Consistência | leitura-após-escrita p/ criador; eventual no resto | libera cache + réplicas assíncronas |
| Durabilidade | link nunca some (padrão sem expiração) | storage replicado, backup |

## Escala

| Métrica | Valor |
|---|---|
| URLs novas | ~200M/mês |
| Leitura : escrita | 100 : 1 |
| Retenção / horizonte | 10 anos |

> Premissa revisada em 2026-08-09: tráfego dobrado (100M → 200M/mês) e retenção estendida de 5 para 10 anos.

<details><summary>Notas da rodada de requisitos</summary>

- 99,99% foi escolhido acima da recomendação (99,9%) — encarece o design: exige redundância em todo o caminho de redirect e failover testado. Registrado como decisão consciente; trade-off documentado em `40-tradeoffs.md`.
- Escrita (criação de link) pode ter SLA mais frouxo que o redirect — o caminho crítico é só leitura.
</details>

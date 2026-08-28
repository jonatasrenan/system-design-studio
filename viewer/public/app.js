/* global marked, mermaid */
// Este arquivo renderiza DOIS modos com o mesmo código:
//  - vivo (viewer local): dados via /api + SSE
//  - estático (página compartilhada, gerada por tools/share.mjs): dados embutidos
//    em window.__DATA__ + auto-refresh por polling. Toda melhoria feita aqui
//    entra idêntica no compartilhado — se algo precisar divergir, combinar com o usuário.
const STATIC = !!window.__STATIC__;
mermaid.initialize({ startOnLoad: false, theme: 'dark', securityLevel: 'loose' });

// Tachado só com ~~duplo~~: o default do marked/GFM aceita ~simples~, o que
// transforma aproximações ("~0,5M ... ~30 B") em texto riscado e quebra o ** no meio.
marked.use({
  tokenizer: {
    del(src) {
      if (!src.startsWith('~')) return false;
      const cap = /^~~(?=[^\s~])([\s\S]*?[^\s~])~~(?!~)/.exec(src);
      if (cap) return { type: 'del', raw: cap[0], text: cap[1], tokens: this.lexer.inlineTokens(cap[1]) };
      return { type: 'text', raw: '~', text: '~' }; // ~ solto = "aproximadamente", nunca risco
    },
  },
});

const $ = (s) => document.querySelector(s);
const state = {
  sessions: [],
  learnings: '',
  rubric: '',
  guardrails: '',
  argumentario: '',
  current: null,
  session: null,
  activeTab: null,
  follow: true, // painel acompanha a conversa (sessão + etapa); navegação manual pausa
};
let mermaidSeq = 0;

// abas fixas, independentes da sessão
const GLOBAL_TABS = [
  { id: '__rubric__', label: '📋 Rubrica', key: 'rubric' },
  { id: '__guardrails__', label: '🛡 Guardrails', key: 'guardrails' },
  { id: '__learnings__', label: '🧠 Aprendizados', key: 'learnings' },
  { id: '__argumentario__', label: '💬 Argumentário', key: 'argumentario' },
];

function tabTitle(file) {
  const m = file.content.match(/^#\s+(.+)$/m);
  if (m) return m[1].trim();
  return file.name.replace(/^\d+-/, '').replace(/\.md$/, '');
}

async function renderMermaidIn(container) {
  const blocks = container.querySelectorAll('code.language-mermaid');
  for (const code of blocks) {
    const src = code.textContent;
    const holder = document.createElement('div');
    holder.className = 'mermaid-block';
    try {
      const { svg } = await mermaid.render(`mm-${++mermaidSeq}`, src);
      holder.innerHTML = svg;
    } catch (e) {
      holder.innerHTML = `<pre>${src}</pre><p style="color:#ef4444">mermaid: ${e.message}</p>`;
    }
    code.closest('pre').replaceWith(holder);
  }
}

const esc = (v) => String(v ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function fmtCost(n) {
  return typeof n === 'number' ? n.toLocaleString('pt-BR', { maximumFractionDigits: 0 }) : esc(n);
}

function renderOverview(sc) {
  if (!sc) {
    return `<div class="empty"><p>Sem scorecard ainda — a Visão Geral é preenchida conforme o design avança
      (SLOs e capacidade junto com os requisitos, custos conforme os componentes entram, classes de falha na revisão e notas na avaliação).</p></div>`;
  }
  const parts = [];

  // cards de topo: Custo total primeiro (o número-manchete, em verde);
  // guardrails só chama atenção quando há falha aberta (vermelho)
  const cards = [];
  const items = sc.costs?.items || [];
  const numeric = items.every((i) => typeof i.cost === 'number');
  // custo em 10x: explícito onde a escala não é linear (cost10x); extrapolado ×10 nos demais
  const has10x = items.some((i) => typeof i.cost10x === 'number');
  const total10x = items.reduce(
    (s, i) => s + (typeof i.cost10x === 'number' ? i.cost10x : typeof i.cost === 'number' ? i.cost * 10 : 0),
    0
  );
  if (items.length) {
    const total = items.reduce((s, i) => s + (typeof i.cost === 'number' ? i.cost : 0), 0);
    cards.push(`<div class="card good"><div class="card-label">Custo total</div>
      <div class="card-value">${numeric ? fmtCost(total) : '—'} <small>${esc(sc.costs.unit || '')}</small></div>
      ${has10x ? `<div class="card-sub">≈ ${fmtCost(total10x)} em escala 10x</div>` : ''}</div>`);
  }
  const g = sc.guardrails;
  if (g) {
    const cls = g.falha > 0 ? 'bad' : '';
    // público: sem vocabulário interno — "guardrails/pass/falha" vira linguagem de design
    cards.push(
      STATIC
        ? `<div class="card ${cls}"><div class="card-label">Classes de falha revisadas</div>
      <div class="card-value">${g.pass ?? 0} ok · ${g.falha ?? 0} aberta(s) · ${g.na ?? 0} não se aplicam</div></div>`
        : `<div class="card ${cls}"><div class="card-label">Guardrails</div>
      <div class="card-value">${g.pass ?? 0} pass · ${g.falha ?? 0} falha · ${g.na ?? 0} n/a</div></div>`
    );
  }
  if (sc.rubric?.overall != null) {
    cards.push(`<div class="card"><div class="card-label">Rubrica (geral)</div>
      <div class="card-value">${esc(sc.rubric.overall)} / 4</div></div>`);
  }
  if (cards.length) parts.push(`<div class="cards">${cards.join('')}</div>`);

  const table = (title, head, rows) =>
    `<h2>${title}</h2><table><thead><tr>${head.map((h) => `<th>${h}</th>`).join('')}</tr></thead>
     <tbody>${rows.join('')}</tbody></table>`;

  if (items.length)
    parts.push(
      table(
        '💰 Custos por componente',
        ['Componente', `Custo (${esc(sc.costs.unit || '')})`, ...(has10x ? ['Em 10x'] : []), 'Premissas'],
        items.map(
          (i) =>
            `<tr><td>${esc(i.component)}</td><td class="num">${fmtCost(i.cost)}</td>` +
            (has10x
              ? `<td class="num">${typeof i.cost10x === 'number' ? fmtCost(i.cost10x) : `<span class="muted">×10</span>`}</td>`
              : '') +
            `<td>${esc(i.notes)}</td></tr>`
        )
      )
    );
  if (sc.slos?.length)
    parts.push(table('🎯 SLOs', ['SLO', 'Alvo'], sc.slos.map((s) => `<tr><td>${esc(s.name)}</td><td>${esc(s.target)}</td></tr>`)));
  if (sc.capacity?.length)
    parts.push(table('📈 Capacidade', ['Dimensão', 'Valor'], sc.capacity.map((c) => `<tr><td>${esc(c.name)}</td><td>${esc(c.value)}</td></tr>`)));
  if (g?.falhas?.length)
    parts.push(`<h2>🛡 Falhas abertas${STATIC ? '' : ' (guardrails)'}</h2><ul>${g.falhas.map((f) => `<li>${esc(f)}</li>`).join('')}</ul>`);
  if (sc.rubric?.scores?.length)
    parts.push(table('📋 Rubrica', ['Critério', 'Nota'], sc.rubric.scores.map((r) => `<tr><td>${esc(r.criterio)}</td><td class="num">${esc(r.nota)} / 4</td></tr>`)));
  if (sc.risks?.length)
    parts.push(`<h2>⚠️ Riscos aceitos</h2><ul>${sc.risks.map((r) => `<li>${esc(r)}</li>`).join('')}</ul>`);

  return `<div class="md overview">${parts.join('') || '<p class="empty">scorecard vazio</p>'}</div>`;
}

async function renderTab() {
  const content = $('#content');
  const s = state.session;
  if (!s) {
    content.innerHTML = `<div class="empty"><p>Nenhuma sessão ainda.</p>
      <p>No Claude Code, rode <code>/design &lt;problema&gt;</code> ou <code>/interview</code> para começar.</p></div>`;
    return;
  }
  const scrollPos = content.scrollTop;
  if (state.activeTab === '__overview__') {
    content.innerHTML = renderOverview(s.scorecard);
  } else if (state.activeTab === '__diagram__') {
    if (!s.diagram) {
      content.innerHTML = '<div class="empty"><p>Sem diagrama ainda — ele aparece aqui assim que o design começar a tomar forma.</p></div>';
    } else {
      const comps = s.scorecard?.components || [];
      // ficha do componente: o hover responde rápido; aqui é o material de estudo
      const compCard = (c) => {
        const row = (label, v) => (v ? `<div class="comp-row"><b>${label}</b><span>${esc(v)}</span></div>` : '');
        const tr = c.tradeoff
          ? `<a class="tr-link" data-tab="40-tradeoffs.md" data-tr="${esc(c.tradeoff)}">→ trade-off ${esc(c.tradeoff)}</a>`
          : '';
        return `<div class="comp" id="comp-${norm(c.name).replace(/ /g, '-')}"><b class="comp-name">${esc(c.name)}</b>
          ${row('O que é', c.what)}
          ${row('Papel', c.purpose)}
          ${row('Se falhar', c.failure)}
          ${row('Como escala', c.scaling)}
          ${row('Por quê', c.why)}
          ${row('Alternativas', c.rejected?.length ? c.rejected.join(' · ') : '')}${tr}</div>`;
      };
      const legend = comps.length ? `<div class="comp-legend">${comps.map(compCard).join('')}</div>` : '';
      content.innerHTML = `<div class="diagram-wrap"></div>${legend}`;
      try {
        const { svg } = await mermaid.render(`mm-${++mermaidSeq}`, s.diagram);
        content.firstChild.innerHTML = svg;
        // ordem de pintura: arestas atrás de rótulos e nós (fundo → arestas → rótulos → nós)
        content.firstChild.querySelectorAll('.edgePaths').forEach((ep) => {
          const anchor =
            ep.parentNode.querySelector(':scope > .edgeLabels') || ep.parentNode.querySelector(':scope > .nodes');
          if (anchor) ep.parentNode.insertBefore(ep, anchor);
        });
        attachNodeTooltips(content.firstChild, comps);
        // clique na ficha → rola até o nó no diagrama e o destaca (inverso do clique no nó)
        content.querySelectorAll('.comp').forEach((card) => {
          card.addEventListener('click', (e) => {
            if (e.target.closest('.tr-link')) return;
            const node = content.firstChild.querySelector(`.node[data-comp="${card.id.slice(5)}"]`);
            if (!node) return;
            node.scrollIntoView({ behavior: 'smooth', block: 'center' });
            node.classList.add('node-flash');
            setTimeout(() => node.classList.remove('node-flash'), 1600);
          });
        });
      } catch (e) {
        content.firstChild.innerHTML = `<pre>${s.diagram}</pre><p style="color:#ef4444">mermaid: ${e.message}</p>`;
      }
      content.querySelectorAll('.tr-link').forEach((a) => {
        a.onclick = async () => {
          await manualNav(a.dataset.tab);
          // rola até a entrada do trade-off e a acende ("## 5. Título")
          const n = (String(a.dataset.tr || '').match(/\d+/) || [])[0];
          if (!n) return;
          const h = [...content.querySelectorAll('.md h2')].find((el) => el.textContent.trim().startsWith(`${n}.`));
          if (!h) return;
          h.scrollIntoView({ behavior: 'smooth', block: 'start' });
          h.classList.add('tr-flash');
          setTimeout(() => h.classList.remove('tr-flash'), 2000);
        };
      });
    }
  } else if (GLOBAL_TABS.some((t) => t.id === state.activeTab)) {
    const tab = GLOBAL_TABS.find((t) => t.id === state.activeTab);
    content.innerHTML = `<div class="md">${marked.parse(state[tab.key] || '_vazio_')}</div>`;
    await renderMermaidIn(content);
  } else {
    const file = s.files.find((f) => f.name === state.activeTab);
    content.innerHTML = `<div class="md">${file ? marked.parse(file.content) : ''}</div>`;
    await renderMermaidIn(content);
  }
  content.scrollTop = scrollPos;
}

// etapa do pipeline → [rótulo, aba correspondente]
const STAGE_META = {
  '00-problema.md': ['Problema', '00-problema.md'],
  '10-requisitos.md': ['Requisitos', '10-requisitos.md'],
  '20-estimativas.md': ['Estimativas', '20-estimativas.md'],
  '30-design.md': ['Design', '30-design.md'],
  'diagram.mmd': ['Diagrama', '__diagram__'],
  'scorecard.json': ['Visão Geral', '__overview__'],
  '40-tradeoffs.md': ['Trade-offs', '40-tradeoffs.md'],
  '45-review.md': ['Review', '45-review.md'],
  '50-operacao.md': ['Operação', '50-operacao.md'],
  '60-avaliacao.md': ['Avaliação', '60-avaliacao.md'],
  '70-poc.md': ['POC/MVP', '70-poc.md'],
  '90-duvidas.md': ['Dúvidas', '90-duvidas.md'],
};
const STATUS_TITLE = {
  ok: 'atualizada — consistente com a última baseline',
  editado: 'em edição — divergiu da baseline (trabalho em andamento)',
  desatualizado: 'DESATUALIZADA — um upstream mudou e esta etapa não foi revisitada',
  pendente: 'pendente — ainda não existe',
  stub: 'template criado, conteúdo ainda não escrito',
  falhas: 'review aberto — há FALHAs aguardando emenda ou registro consciente',
};

// --- tooltip nos nós do SVG do diagrama (descrição · por quê · descartadas) ---
const norm = (s) =>
  (s || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

function bestComponent(label, comps) {
  const L = new Set(norm(label).split(' '));
  let best = null;
  let bestScore = 0;
  for (const c of comps) {
    const toks = norm(c.name).split(' ').filter(Boolean);
    if (!toks.length) continue;
    const hit = toks.filter((t) => L.has(t)).length / toks.length;
    if (hit > bestScore) {
      bestScore = hit;
      best = c;
    }
  }
  return bestScore >= 0.5 ? best : null;
}

let tipEl = null;
function attachNodeTooltips(container, comps) {
  if (!comps.length) return;
  if (!tipEl) {
    tipEl = document.createElement('div');
    tipEl.id = 'node-tip';
    document.body.appendChild(tipEl);
  }
  container.querySelectorAll('.node').forEach((node) => {
    const comp = bestComponent(node.textContent, comps);
    if (!comp) return;
    node.style.cursor = 'pointer';
    node.dataset.comp = norm(comp.name).replace(/ /g, '-');
    // clique no nó → rola até a ficha do componente na legenda
    node.addEventListener('click', () => {
      const card = document.getElementById(`comp-${norm(comp.name).replace(/ /g, '-')}`);
      if (!card) return;
      card.scrollIntoView({ behavior: 'smooth', block: 'center' });
      card.classList.add('flash');
      setTimeout(() => card.classList.remove('flash'), 1600);
    });
    // realce: hover no nó acende as arestas dele e esmaece o resto (leitura de diagrama denso)
    const mid = (node.id.match(/^flowchart-(.+)-\d+$/) || [])[1];
    const setHighlight = (on) => {
      const paths = [...container.querySelectorAll('.edgePaths path')];
      const labels = [...container.querySelectorAll('.edgeLabels > g')];
      paths.forEach((p2, i) => {
        const touches =
          on &&
          mid &&
          (p2.classList.contains(`LS-${mid}`) ||
            p2.classList.contains(`LE-${mid}`) ||
            new RegExp(`[-_]${mid}[-_]`).test(p2.id || ''));
        p2.classList.toggle('edge-hl', !!touches);
        p2.classList.toggle('edge-dim', on && !touches);
        labels[i]?.classList.toggle('edge-dim', on && !touches);
      });
    };
    node.addEventListener('mouseenter', () => {
      setHighlight(true);
      tipEl.innerHTML =
        `<b>${esc(comp.name)}</b><span>${esc(comp.purpose)}</span>` +
        (comp.tradeoff ? `<u>→ trade-off ${esc(comp.tradeoff)}</u>` : '');
      tipEl.style.display = 'block';
    });
    node.addEventListener('mousemove', (e) => {
      const pad = 14;
      const w = tipEl.offsetWidth;
      const x = Math.min(e.clientX + pad, window.innerWidth - w - 8);
      const y = e.clientY + pad + tipEl.offsetHeight > window.innerHeight ? e.clientY - tipEl.offsetHeight - pad : e.clientY + pad;
      tipEl.style.left = `${x}px`;
      tipEl.style.top = `${y}px`;
    });
    node.addEventListener('mouseleave', () => {
      setHighlight(false);
      tipEl.style.display = 'none';
    });
  });
}

// navegação manual: troca de aba e pausa o modo seguir
function manualNav(tabId) {
  state.follow = false;
  state.activeTab = tabId;
  renderHeader();
  renderNav();
  return renderTab();
}

const FILE_TO_TAB = (name) => {
  if (name === 'diagram.mmd') return '__diagram__';
  if (name === 'scorecard.json') return '__overview__';
  if (name?.endsWith('.md')) return name;
  return null;
};

// navegação única: pipeline da sessão + documentos globais
function renderNav() {
  const el = $('#pipeline');
  const s = state.session;
  const p = s?.pipeline;
  const clickable = new Set();
  let track = '';

  if (s && p) {
    // público com tudo verde: bolinhas de estado (e o ponto "ao vivo") viram ruído — some tudo
    const allGreen = STATIC && p.baseline && p.stages.every((st) => !st.exists || (st.status === 'ok' && !st.stub));
    document.body.classList.toggle('all-green', allGreen);
    // Diagrama sempre tem aba (com estado vazio); Scorecard só liga com dados reais
    const alwaysOpen = new Set(['__diagram__']);
    const nodes = p.stages.map((st) => {
      const [label, tabId] = STAGE_META[st.name] ?? [st.name, null];
      const enabled = tabId && (st.exists || alwaysOpen.has(tabId));
      if (enabled) clickable.add(tabId);
      const active = tabId === state.activeTab ? ' active' : '';
      // stub (laranja) só cede para "desatualizado" — o alerta vermelho tem prioridade
      const cls = st.status === 'desatualizado' ? 'desatualizado' : st.stub ? 'stub' : st.status;
      return `<button class="stage ${cls}${active}" data-tab="${enabled ? tabId : ''}"
        title="${st.name}: ${STATUS_TITLE[cls]}" ${enabled ? '' : 'disabled'}>
        <span class="dot"></span>${label}</button>`;
    });
    // arquivos avulsos fora do pipeline viram nós neutros no fim
    for (const f of s.files.filter((f) => !(f.name in STAGE_META))) {
      clickable.add(f.name);
      const active = f.name === state.activeTab ? ' active' : '';
      nodes.push(`<button class="stage extra${active}" data-tab="${f.name}" title="${f.name}">${tabTitle(f)}</button>`);
    }
    track = nodes.join('<span class="arrow">→</span>');
    if (!p.baseline)
      track += '<span class="pipeline-note" title="A consistência entre etapas passa a ser rastreada após a primeira baseline (node tools/check.mjs <slug> --baseline)">sem baseline</span>';
  }

  // página compartilhada é só a sessão — documentos globais (aprendizados, argumentário...) não viajam
  const globals = STATIC
    ? ''
    : GLOBAL_TABS.map((t) => {
        clickable.add(t.id);
        return `<button class="gtab${t.id === state.activeTab ? ' active' : ''}" data-tab="${t.id}">${t.label}</button>`;
      }).join('');

  if (!clickable.has(state.activeTab)) {
    // fallback: primeira etapa clicável na ordem do pipeline (Problema, numa sessão nova) — nunca o scorecard vazio
    const firstStage = s && p ? p.stages.map((st) => (STAGE_META[st.name] ?? [])[1]).find((t) => t && clickable.has(t)) : null;
    state.activeTab = s ? firstStage ?? '__overview__' : STATIC ? null : GLOBAL_TABS[0].id;
  }

  el.innerHTML = `<div class="pipeline-track">${track}</div><div class="global-tabs">${globals}</div>`;
  el.querySelectorAll('button[data-tab]').forEach((b) => {
    if (!b.dataset.tab) return;
    b.onclick = () => manualNav(b.dataset.tab);
  });
}

function renderHeader() {
  const sel = $('#session-select');
  sel.innerHTML = '';
  for (const s of state.sessions) {
    const o = document.createElement('option');
    o.value = s.slug;
    o.textContent = s.title;
    if (s.slug === state.current) o.selected = true;
    sel.appendChild(o);
  }
  sel.style.display = state.sessions.length && !STATIC ? '' : 'none';
  if (state.session?.meta?.title) {
    // formato único "título - jonatasrenan"; o sufixo System Design Studio é só do viewer local
    document.title = `${state.session.meta.title} - jonatasrenan${STATIC ? '' : ' System Design Studio'}`;
    if (STATIC) $('header h1').textContent = `${state.session.meta.title} - jonatasrenan`;
  }
  const badges = $('#session-badges');
  const meta = state.session?.meta || {};
  badges.innerHTML = '';
  // "estudio" é o padrão — badge de modo só quando for a exceção informativa (simulado)
  if (meta.mode === 'entrevista') badges.innerHTML += `<span class="badge">entrevista</span>`;
  // página pública: "em-andamento" não aparece (ruído para o leitor externo); "concluido" fica
  if (meta.status && !(STATIC && meta.status === 'em-andamento'))
    badges.innerHTML += `<span class="badge status-${meta.status}">${meta.status}</span>`;
  if (state.session && !STATIC) {
    if (state.shareBusy) {
      badges.innerHTML += `<span class="badge">⏳ publicando…</span>`;
    } else if (meta.share?.url) {
      badges.innerHTML += `<a class="badge share" href="${meta.share.url}" target="_blank" title="design publicado — atualiza sozinho a cada mudança">🔗 compartilhado</a><button class="badge share-btn" id="unshare-btn" title="remove a página publicada do ar">✕</button>`;
    } else {
      badges.innerHTML += `<button class="badge share-btn" id="share-btn" title="publica este design num link público que atualiza sozinho">🔗 compartilhar</button>`;
    }
  }
  const shareCall = async (action) => {
    state.shareBusy = true;
    renderHeader();
    try {
      const r = await fetch(`/api/session/${encodeURIComponent(state.current)}/${action}`, { method: 'POST' });
      const d = await r.json();
      if (!r.ok) alert(d.error || 'falha ao publicar');
      else if (state.session) state.session.meta.share = d.share ?? undefined;
    } catch (e) {
      alert(`falha: ${e.message}`);
    }
    state.shareBusy = false;
    renderHeader();
  };
  const sb = $('#share-btn');
  if (sb) sb.onclick = () => shareCall('share');
  const ub = $('#unshare-btn');
  if (ub)
    ub.onclick = () => {
      if (confirm('Descompartilhar? A página pública sai do ar.')) shareCall('unshare');
    };
  const fb = $('#follow-btn');
  // página pública: sem controle de "seguir" — é ferramenta de acompanhamento do estúdio
  if (STATIC) fb.style.display = 'none';
  fb.textContent = state.follow ? '🔄 seguindo' : '📌 fixo';
  fb.className = state.follow ? 'on' : '';
  fb.onclick = () => {
    state.follow = !state.follow;
    if (state.follow) load();
    else renderHeader();
  };
}

let loadSeq = 0;
async function load(keepSession = true) {
  const seq = ++loadSeq;
  const data = STATIC
    ? {
        sessions: [{ slug: window.__DATA__.slug, title: window.__DATA__.meta?.title ?? 'design' }],
        learnings: '',
        rubric: '',
        guardrails: '',
        argumentario: '',
      }
    : await (await fetch('/api/sessions')).json();
  if (seq !== loadSeq) return; // resposta atrasada de um load antigo — descarta
  state.sessions = data.sessions;
  state.learnings = data.learnings;
  state.rubric = data.rubric;
  state.guardrails = data.guardrails;
  state.argumentario = data.argumentario;
  const fromHash = decodeURIComponent(location.hash.slice(1));
  if (state.follow) {
    // seguir a conversa: sessão modificada mais recentemente
    state.current = state.sessions[0]?.slug ?? null;
  } else if (!keepSession || !state.current || !state.sessions.some((s) => s.slug === state.current)) {
    state.current = state.sessions.some((s) => s.slug === fromHash) ? fromHash : state.sessions[0]?.slug ?? null;
  }
  state.session = null;
  if (state.current) {
    if (STATIC) {
      state.session = window.__DATA__;
    } else {
      const r = await fetch(`/api/session/${encodeURIComponent(state.current)}`);
      if (seq !== loadSeq) return;
      if (r.ok) state.session = await r.json();
    }
  }
  if (state.follow && state.session) {
    if (STATIC && !state.loadedOnce) {
      // pública: a PRIMEIRA carga sempre abre no Problema — leitura começa do início.
      // O acompanhamento ao vivo (pular para a etapa ativa) vale só para atualizações seguintes.
      if (state.session.files.some((f) => f.name === '00-problema.md')) state.activeTab = '00-problema.md';
    } else {
      // ...e a etapa que a conversa acabou de tocar
      const tab = FILE_TO_TAB(state.session.lastChanged);
      if (tab) state.activeTab = tab;
    }
    state.loadedOnce = true;
  }
  renderHeader();
  renderNav();
  await renderTab();
}

$('#session-select').addEventListener('change', (e) => {
  state.follow = false; // escolha manual de sessão pausa o seguir
  state.current = e.target.value;
  location.hash = state.current;
  state.activeTab = null;
  load();
});

// vivo: SSE re-carrega a cada mudança de arquivo.
// estático: polling — se uma versão nova foi publicada, recarrega a página inteira.
function connect() {
  if (STATIC) {
    // HEAD + ETag a cada 5s (só cabeçalhos). Versão nova → atualização SUAVE:
    // baixa o html, extrai os dados embutidos e re-renderiza no lugar (sem reload,
    // preserva scroll/aba de quem está assistindo). Reload completo só se o
    // código da página mudou (__APP_HASH__ diferente).
    let lastTag = null;
    let syncing = false;
    setInterval(async () => {
      if (syncing) return;
      try {
        const r = await fetch(location.href, { method: 'HEAD', cache: 'no-store' });
        const tag = r.headers.get('etag') || r.headers.get('last-modified');
        const changed = lastTag && tag && tag !== lastTag;
        if (tag) lastTag = tag;
        $('#live-dot').classList.remove('off');
        if (!changed) return;
        syncing = true;
        const txt = await (await fetch(location.href, { cache: 'no-store' })).text();
        const hash = txt.match(/__APP_HASH__ = "([^"]+)"/)?.[1];
        const dataLine = txt.match(/window\.__DATA__ = (.+);/)?.[1];
        if (hash && window.__APP_HASH__ && hash !== window.__APP_HASH__) {
          location.reload(); // código novo — precisa do reload de verdade
          return;
        }
        if (dataLine) {
          window.__DATA__ = JSON.parse(dataLine);
          window.__BUILD_AT__ = txt.match(/__BUILD_AT__ = "([^"]+)"/)?.[1] ?? window.__BUILD_AT__;
          await load(); // re-render no lugar — modo seguir pula para a etapa recém-tocada
        }
        syncing = false;
      } catch {
        syncing = false;
        $('#live-dot').classList.add('off');
      }
    }, 5000);
    return;
  }
  const es = new EventSource('/events');
  es.onopen = () => $('#live-dot').classList.remove('off');
  es.onmessage = () => load();
  es.onerror = () => {
    $('#live-dot').classList.add('off');
    es.close();
    setTimeout(connect, 1500);
  };
}

load();
connect();

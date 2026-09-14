/* global marked, mermaid */
// Este arquivo renderiza DOIS modos com o mesmo código:
//  - vivo (viewer local): dados via /api + SSE
//  - estático (página compartilhada, gerada por tools/share.mjs): dados embutidos
//    em window.__DATA__ + auto-refresh por polling. Toda melhoria feita aqui
//    entra idêntica no compartilhado — se algo precisar divergir, combinar com o usuário.
const STATIC = !!window.__STATIC__;
// Configuração base: toda chamada a mermaid.initialize SUBSTITUI a configuração
// inteira (não faz merge), então quem re-inicializa precisa reenviar o tema junto —
// senão o diagrama volta ao tema claro.
const MERMAID_BASE = {
  startOnLoad: false,
  theme: 'dark',
  securityLevel: 'loose',
  // largura do diagrama é decisão de renderização, não do .mmd: rótulo longo quebra
  // em linhas (em vez de esticar o nó) e o espaçamento entre nós fica menor.
  flowchart: { useMaxWidth: true, htmlLabels: true, wrappingWidth: 160, nodeSpacing: 28, rankSpacing: 44, padding: 8 },
  elk: { mergeEdges: true, nodePlacementStrategy: 'BRANDES_KOEPF' },
  // ER: slightly tighter boxes so a 15-entity model fits the width at a readable size
  er: { useMaxWidth: true, fontSize: 12, entityPadding: 12, minEntityWidth: 90, minEntityHeight: 50, layoutDirection: 'TB' },
};
const mermaidInit = (renderer) =>
  mermaid.initialize({ ...MERMAID_BASE, flowchart: { ...MERMAID_BASE.flowchart, defaultRenderer: renderer } });
mermaidInit('dagre-wrapper');

// O motor padrão (dagre) empilha ramos lado a lado e cresce sempre para os lados.
// O ELK compacta em camadas e cresce para baixo — é o que mantém o desenho legível
// quando a largura acaba. Se ele falhar (ou devolver um SVG sem nós, do qual os
// tooltips dependem), cai para o motor padrão sem que o usuário perceba.
// Direction of the main diagram is a rendering choice too: a left-to-right source
// with five grouped layers becomes a 25%-zoom strip; top-down keeps every label
// readable at fit-to-width. The reader can flip it; the .mmd stays as written.
const DIAGRAM_DIR_KEY = 'sd-diagram-direction';
const diagramDirection = () => {
  try {
    return localStorage.getItem(DIAGRAM_DIR_KEY) || 'TB';
  } catch {
    return 'TB';
  }
};
const withDirection = (src, dir) =>
  dir ? src.replace(/^(\s*)(flowchart|graph)\s+(LR|RL|TB|TD|BT)\b/, `$1$2 ${dir}`) : src;

// Edge labels are what makes a busy map grow sideways: ELK lays every label out on
// one line next to its edge, so 27 labelled edges cost more width than 15 nodes.
// Compact mode keeps only the step number on numbered edges ("3·") and moves the
// text to a legend under the map — the story reads top to bottom instead of
// being scattered along the edges.
const DIAGRAM_LABELS_KEY = 'sd-diagram-labels';
const diagramLabelsPref = () => {
  try {
    return localStorage.getItem(DIAGRAM_LABELS_KEY) || 'auto';
  } catch {
    return 'auto';
  }
};
const EDGE_RE = /^(\s*)([A-Za-z0-9_]+)\s*(-->|-\.->|==>)\s*\|([^|]+)\|\s*([A-Za-z0-9_]+)\s*$/;
function edgeList(src) {
  const edges = [];
  for (const raw of src.split('\n')) {
    const m = raw.match(EDGE_RE);
    if (!m) continue;
    const n = m[4].match(/^\s*(\d+)\s*[·.]\s*(.*)$/);
    edges.push({ from: m[2], to: m[5], dashed: m[3] === '-.->', n: n ? Number(n[1]) : null, text: n ? n[2].trim() : m[4].trim() });
  }
  return edges;
}
const compactEdgeLabels = (src) =>
  src
    .split('\n')
    .map((raw) => {
      const m = raw.match(EDGE_RE);
      if (!m) return raw;
      const n = m[4].match(/^\s*(\d+)\s*[·.]/);
      return n ? `${m[1]}${m[2]} ${m[3]}|${n[1]}·| ${m[5]}` : `${m[1]}${m[2]} ${m[3]} ${m[5]}`;
    })
    .join('\n');
// node id → label text (first line, emoji kept), for the legend
function nodeNames(src) {
  const names = {};
  for (const m of src.matchAll(/^\s*([A-Za-z0-9_]+)\[([^\]]*)\]/gm)) names[m[1]] = m[2].split('<br>')[0].replace(/^"|"$/g, '').trim();
  return names;
}
function edgeLegendHtml(src) {
  const edges = edgeList(src);
  const names = nodeNames(src);
  const name = (id) => esc(names[id] ?? id);
  const numbered = edges.filter((e) => e.n !== null).sort((a, b) => a.n - b.n);
  const others = edges.filter((e) => e.n === null);
  if (!numbered.length && !others.length) return '';
  const li = (e) =>
    `<li><span class="el-from">${name(e.from)}</span> → <span class="el-to">${name(e.to)}</span><span class="el-text">${esc(e.text)}</span></li>`;
  return `<div class="edge-legend">
    ${numbered.length ? `<b>The story of a request</b><ol>${numbered.map((e) => `<li value="${e.n}">${li(e).slice(4)}`).join('')}</ol>` : ''}
    ${others.length ? `<b>Other edges</b><ul>${others.map(li).join('')}</ul>` : ''}
  </div>`;
}

// Full labels, placed by us: the layout runs with number-only edge labels (tight),
// then each edge's text is drawn at a different point along its own path — 38%,
// 62%, 28%… — skipping spots that collide with a node or with a label already
// placed. Labels stop sharing one horizontal band, which is what made the map wide.
function overlayEdgeLabels(svg, src) {
  const NS = 'http://www.w3.org/2000/svg';
  const edges = edgeList(src);
  svg.querySelectorAll('.edge-note').forEach((e) => e.remove());
  const boxes = [];
  for (const g of svg.querySelectorAll('g.node')) {
    const t = (g.getAttribute('transform') || '').match(/translate\(([-\d.]+),\s*([-\d.]+)\)/);
    const bb = g.getBBox();
    if (t) boxes.push({ x: +t[1] + bb.x - 4, y: +t[2] + bb.y - 4, w: bb.width + 8, h: bb.height + 8 });
  }
  const overlaps = (a, b) => !(a.x + a.w < b.x || b.x + b.w < a.x || a.y + a.h < b.y || b.y + b.h < a.y);
  const wrap = (t, max) => {
    const out = [];
    let cur = '';
    for (const w of t.split(/\s+/)) {
      if ((cur + ' ' + w).trim().length > max && cur) {
        out.push(cur);
        cur = w;
      } else cur = (cur + ' ' + w).trim();
    }
    if (cur) out.push(cur);
    return out;
  };
  const paths = [...svg.querySelectorAll('path.flowchart-link')];
  const fs = 11;
  paths.forEach((p, i) => {
    const cls = p.className.baseVal;
    const from = (cls.match(/LS-([A-Za-z0-9_]+)/) || [])[1];
    const to = (cls.match(/LE-([A-Za-z0-9_]+)/) || [])[1];
    const e = edges[i] && edges[i].from === from && edges[i].to === to ? edges[i] : edges.find((x) => x.from === from && x.to === to);
    if (!e || !e.text) return;
    const lines = wrap(e.text, 24);
    const w = Math.max(...lines.map((l) => l.length)) * fs * 0.56 + 10;
    const h = lines.length * (fs + 3) + 6;
    const L = p.getTotalLength();
    let best = null;
    // the step number sits at the midpoint — start beside it, not on it
    for (const t of [0.38, 0.62, 0.28, 0.72, 0.18, 0.82, 0.5, 0.1, 0.9]) {
      const pt = p.getPointAtLength(L * t);
      const box = { x: pt.x - w / 2, y: pt.y - h / 2, w, h };
      if (!boxes.some((b) => overlaps(b, box))) {
        best = box;
        break;
      }
    }
    if (!best) {
      const pt = p.getPointAtLength(L * 0.5);
      best = { x: pt.x - w / 2, y: pt.y - h / 2, w, h };
    }
    boxes.push(best);
    const g = document.createElementNS(NS, 'g');
    g.setAttribute('class', `edge-note${e.dashed ? ' dashed' : ''}`);
    g.dataset.from = from;
    g.dataset.to = to;
    const rect = document.createElementNS(NS, 'rect');
    for (const [k, v] of Object.entries({ x: best.x, y: best.y, width: w, height: h, rx: 3 })) rect.setAttribute(k, v);
    g.appendChild(rect);
    lines.forEach((ln, k) => {
      const tx = document.createElementNS(NS, 'text');
      tx.setAttribute('x', best.x + w / 2);
      tx.setAttribute('y', best.y + 4 + (k + 1) * (fs + 3) - 3);
      tx.setAttribute('text-anchor', 'middle');
      tx.setAttribute('font-size', fs);
      tx.textContent = ln;
      g.appendChild(tx);
    });
    svg.appendChild(g);
  });
}

async function renderFlowchart(id, src, { direction } = {}) {
  const isFlowchart = /^\s*(flowchart|graph)\b/.test(src);
  if (isFlowchart && direction) src = withDirection(src, direction);
  if (isFlowchart) {
    try {
      mermaidInit('elk');
      const out = await mermaid.render(`${id}-elk`, src);
      const probe = document.createElement('div');
      probe.innerHTML = out.svg;
      if (probe.querySelector('svg') && probe.querySelectorAll('.node').length) return out;
    } catch {
      /* cai para o motor padrão */
    }
  }
  mermaidInit('dagre-wrapper');
  return mermaid.render(id, src);
}

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
  patterns: '',
  guardrails: '',
  current: null,
  session: null,
  activeTab: null,
  follow: true, // painel acompanha a conversa (sessão + etapa); navegação manual pausa
};
let mermaidSeq = 0;

// abas fixas, independentes da sessão
const GLOBAL_TABS = [
  { id: '__guardrails__', label: '🛡 Guardrails', key: 'guardrails' },
  { id: '__learnings__', label: '🧠 Learnings', key: 'learnings' },
  { id: '__patterns__', label: '🧩 Patterns', key: 'patterns' },
];

// Zoom do diagrama: "ajustar" cabe na largura disponível; acima disso o diagrama
// cresce e o contêiner rola, o que preserva a legibilidade em desenho largo.
function setupDiagramZoom(root, wrap) {
  const svg = wrap.querySelector('svg');
  if (!svg) return;
  const box = svg.viewBox?.baseVal;
  const natural = box?.width || svg.getBoundingClientRect().width || 1;
  const label = root.querySelector('.diagram-zoom-val');
  let z = null; // null = ajustar à largura
  const apply = () => {
    const avail = wrap.clientWidth || natural;
    const fit = Math.min(1, avail / natural);
    const factor = z ?? fit;
    svg.style.width = `${natural * factor}px`;
    svg.style.maxWidth = 'none';
    svg.style.height = 'auto';
    wrap.classList.toggle('is-zoomed', factor > fit + 0.001);
    label.textContent = `${Math.round(factor * 100)}%`;
  };
  root.querySelectorAll('.diagram-zoom button').forEach((b) => {
    b.onclick = () => {
      const avail = wrap.clientWidth || natural;
      const fit = Math.min(1, avail / natural);
      if (b.dataset.z === 'fit') z = null;
      else z = Math.min(3, Math.max(0.2, (z ?? fit) * (b.dataset.z === 'in' ? 1.25 : 0.8)));
      apply();
    };
  });
  // arrastar para deslocar quando estiver ampliado
  let drag = null;
  wrap.addEventListener('pointerdown', (e) => {
    if (!wrap.classList.contains('is-zoomed') || e.target.closest('.node')) return;
    drag = { x: e.clientX, y: e.clientY, l: wrap.scrollLeft, t: wrap.scrollTop };
    wrap.setPointerCapture(e.pointerId);
  });
  wrap.addEventListener('pointermove', (e) => {
    if (!drag) return;
    wrap.scrollLeft = drag.l - (e.clientX - drag.x);
    wrap.scrollTop = drag.t - (e.clientY - drag.y);
  });
  wrap.addEventListener('pointerup', () => (drag = null));
  addEventListener('resize', apply, { passive: true });
  apply();
}

function tabTitle(file) {
  const m = file.content.match(/^#\s+(.+)$/m);
  if (m) return m[1].trim();
  return file.name.replace(/^\d+-/, '').replace(/\.md$/, '');
}

// Diagrams inside a stage's markdown (ER on the data-model tab, zoom sub-diagrams in
// design) get the same treatment as the main diagram: they break out of the 900px
// text column when they need the width, fit to it, and zoom/drag like the main one.
async function renderMermaidIn(container) {
  const blocks = container.querySelectorAll('code.language-mermaid');
  for (const code of blocks) {
    const src = code.textContent;
    const holder = document.createElement('div');
    holder.className = 'mermaid-block';
    try {
      const { svg } = await renderFlowchart(`mm-${++mermaidSeq}`, src);
      holder.innerHTML = `<div class="diagram-zoom">
          <button data-z="out" title="Zoom out">−</button>
          <button data-z="fit" title="Fit to width">fit</button>
          <button data-z="in" title="Zoom in">+</button>
          <span class="diagram-zoom-val">100%</span>
        </div><div class="diagram-wrap"></div>`;
      const wrap = holder.querySelector('.diagram-wrap');
      wrap.innerHTML = svg;
      code.closest('pre').replaceWith(holder);
      // wider than the text column → full-bleed, so the fit-to-width factor stays readable
      const natural = wrap.querySelector('svg')?.viewBox?.baseVal?.width || 0;
      if (natural > holder.clientWidth) holder.classList.add('wide');
      setupDiagramZoom(holder, wrap);
      continue;
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
    return `<div class="empty"><p>No scorecard yet — the Overview fills in as the design progresses
      (SLOs and capacity alongside the requirements, costs as components come in, failure classes during the review, and scores during grading).</p></div>`;
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
    cards.push(`<div class="card good"><div class="card-label">Total cost</div>
      <div class="card-value">${numeric ? fmtCost(total) : '—'} <small>${esc(sc.costs.unit || '')}</small></div>
      ${has10x ? `<div class="card-sub">≈ ${fmtCost(total10x)} at 10x scale</div>` : ''}</div>`);
  }
  const g = sc.guardrails;
  if (g) {
    const cls = g.fail > 0 ? 'bad' : '';
    const premises = g.premises ?? 0;
    const acceptedRisks = g.accepted_risks ?? 0;
    // extra states shown only when in use — premises/accepted risks don't count against the design,
    // so they get the same neutral visual treatment as "n/a", never the "bad" one
    const extra = [premises ? `${premises} to validate` : '', acceptedRisks ? `${acceptedRisks} accepted risk(s)` : '']
      .filter(Boolean)
      .join(' · ');
    // public page: no internal vocabulary — "guardrails/pass/fail" becomes design language
    cards.push(
      STATIC
        ? `<div class="card ${cls}"><div class="card-label">Failure classes reviewed</div>
      <div class="card-value">${g.pass ?? 0} ok · ${g.fail ?? 0} open · ${g.na ?? 0} not applicable</div>
      ${extra ? `<div class="card-sub">${esc(extra)}</div>` : ''}</div>`
        : `<div class="card ${cls}"><div class="card-label">Guardrails</div>
      <div class="card-value">${g.pass ?? 0} pass · ${g.fail ?? 0} fail · ${g.na ?? 0} n/a</div>
      ${extra ? `<div class="card-sub">${esc(extra)}</div>` : ''}</div>`
    );
  }
  if (cards.length) parts.push(`<div class="cards">${cards.join('')}</div>`);

  const table = (title, head, rows) =>
    `<h2>${title}</h2><table><thead><tr>${head.map((h) => `<th>${h}</th>`).join('')}</tr></thead>
     <tbody>${rows.join('')}</tbody></table>`;

  if (items.length)
    parts.push(
      table(
        '💰 Costs by component',
        ['Component', `Cost (${esc(sc.costs.unit || '')})`, ...(has10x ? ['At 10x'] : []), 'Assumptions'],
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
    parts.push(table('🎯 SLOs', ['SLO', 'Target'], sc.slos.map((s) => `<tr><td>${esc(s.name)}</td><td>${esc(s.target)}</td></tr>`)));
  if (sc.capacity?.length)
    parts.push(table('📈 Capacity', ['Dimension', 'Value'], sc.capacity.map((c) => `<tr><td>${esc(c.name)}</td><td>${esc(c.value)}</td></tr>`)));
  if (g?.failures?.length)
    parts.push(`<h2>🛡 Open failures${STATIC ? '' : ' (guardrails)'}</h2><ul>${g.failures.map((f) => `<li>${esc(f)}</li>`).join('')}</ul>`);
  if (sc.risks?.length)
    parts.push(`<h2>⚠️ Accepted risks</h2><ul>${sc.risks.map((r) => `<li>${esc(r)}</li>`).join('')}</ul>`);

  return `<div class="md overview">${parts.join('') || '<p class="empty">empty scorecard</p>'}</div>`;
}

async function renderTab() {
  const content = $('#content');
  const s = state.session;
  if (!s) {
    content.innerHTML = `<div class="empty"><p>No session yet.</p>
      <p>In Claude Code, run <code>/design &lt;problem&gt;</code> to get started.</p></div>`;
    return;
  }
  const scrollPos = content.scrollTop;
  if (state.activeTab === '__overview__') {
    content.innerHTML = renderOverview(s.scorecard);
  } else if (state.activeTab === '__diagram__') {
    if (!s.diagram) {
      content.innerHTML = '<div class="empty"><p>No diagram yet — it shows up here as soon as the design starts taking shape.</p></div>';
    } else {
      const comps = s.scorecard?.components || [];
      // ficha do componente: o hover responde rápido; aqui é o material de estudo
      const compCard = (c) => {
        const row = (label, v) => (v ? `<div class="comp-row"><b>${label}</b><span>${esc(v)}</span></div>` : '');
        const tr = c.tradeoff
          ? `<a class="tr-link" data-tab="40-tradeoffs.md" data-tr="${esc(c.tradeoff)}">→ trade-off ${esc(c.tradeoff)}</a>`
          : '';
        return `<div class="comp" id="comp-${norm(c.name).replace(/ /g, '-')}"><b class="comp-name">${esc(c.name)}</b>
          ${row('What it is', c.what)}
          ${row('Role', c.purpose)}
          ${row('If it fails', c.failure)}
          ${row('How it scales', c.scaling)}
          ${row('Why', c.why)}
          ${row('Alternatives', c.rejected?.length ? c.rejected.join(' · ') : '')}${tr}</div>`;
      };
      const legend = comps.length ? `<div class="comp-legend">${comps.map(compCard).join('')}</div>` : '';
      const dir = diagramDirection();
      const labelsPref = diagramLabelsPref();
      content.innerHTML = `<div class="diagram-zoom">
          <button data-dir title="Layout direction: ${dir === 'TB' ? 'top-down (click for left-to-right)' : 'left-to-right (click for top-down)'}">${dir === 'TB' ? '↓ top-down' : '→ left-right'}</button>
          <button data-labels title="Edge labels — auto: layout with step numbers only, full text placed along each edge; full: the layout engine places every label (wide); list: step numbers on the map, text in a legend below">labels: ${labelsPref}</button>
          <button data-z="out" title="Zoom out">−</button>
          <button data-z="fit" title="Fit to width">fit</button>
          <button data-z="in" title="Zoom in">+</button>
          <span class="diagram-zoom-val">100%</span>
        </div><div class="diagram-wrap"></div><div class="edge-legend-slot"></div>${legend}`;
      content.querySelector('[data-dir]').onclick = () => {
        try {
          localStorage.setItem(DIAGRAM_DIR_KEY, dir === 'TB' ? 'LR' : 'TB');
        } catch {}
        renderTab();
      };
      content.querySelector('[data-labels]').onclick = () => {
        const next = { auto: 'full', full: 'list', list: 'auto' }[labelsPref];
        try {
          localStorage.setItem(DIAGRAM_LABELS_KEY, next);
        } catch {}
        renderTab();
      };
      try {
        const wrap = content.querySelector('.diagram-wrap');
        // 'full' lets the layout engine place every label; the other two modes lay out
        // with step numbers only and add the text afterwards (along the edges, or as a list)
        const src = labelsPref === 'full' ? s.diagram : compactEdgeLabels(s.diagram);
        const { svg } = await renderFlowchart(`mm-${++mermaidSeq}`, src, { direction: dir });
        wrap.innerHTML = svg;
        content.querySelector('.edge-legend-slot').innerHTML = labelsPref === 'list' ? edgeLegendHtml(s.diagram) : '';
        if (labelsPref === 'auto') overlayEdgeLabels(wrap.querySelector('svg'), s.diagram);
        setupDiagramZoom(content, wrap);
        // ordem de pintura: arestas atrás de rótulos e nós (fundo → arestas → rótulos → nós)
        wrap.querySelectorAll('.edgePaths').forEach((ep) => {
          const anchor =
            ep.parentNode.querySelector(':scope > .edgeLabels') || ep.parentNode.querySelector(':scope > .nodes');
          if (anchor) ep.parentNode.insertBefore(ep, anchor);
        });
        attachNodeTooltips(wrap, comps);
        // clique na ficha → rola até o nó no diagrama e o destaca (inverso do clique no nó)
        content.querySelectorAll('.comp').forEach((card) => {
          card.addEventListener('click', (e) => {
            if (e.target.closest('.tr-link')) return;
            const node = wrap.querySelector(`.node[data-comp="${card.id.slice(5)}"]`);
            if (!node) return;
            node.scrollIntoView({ behavior: 'smooth', block: 'center' });
            node.classList.add('node-flash');
            setTimeout(() => node.classList.remove('node-flash'), 1600);
          });
        });
      } catch (e) {
        content.querySelector('.diagram-wrap').innerHTML =
          `<pre>${s.diagram}</pre><p style="color:#ef4444">mermaid: ${e.message}</p>`;
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
    content.innerHTML = `<div class="md">${marked.parse(state[tab.key] || '_empty_')}</div>`;
    await renderMermaidIn(content);
  } else {
    const file = s.files.find((f) => f.name === state.activeTab);
    content.innerHTML = `<div class="md">${file ? marked.parse(file.content) : ''}</div>`;
    await renderMermaidIn(content);
  }
  content.scrollTop = scrollPos;
}

// pipeline stage → [label, matching tab]
const STAGE_META = {
  '00-problem.md': ['Problem', '00-problem.md'],
  '10-requirements.md': ['Requirements', '10-requirements.md'],
  '20-estimates.md': ['Estimates', '20-estimates.md'],
  '25-domain.md': ['Domain', '25-domain.md'],
  '30-design.md': ['Design', '30-design.md'],
  '35-data-model.md': ['Data Model', '35-data-model.md'],
  'diagram.mmd': ['Diagram', '__diagram__'],
  'scorecard.json': ['Overview', '__overview__'],
  '40-tradeoffs.md': ['Trade-offs', '40-tradeoffs.md'],
  '45-review.md': ['Review', '45-review.md'],
  '50-operations.md': ['Operations', '50-operations.md'],
  '70-poc.md': ['POC/MVP', '70-poc.md'],
  '90-faq.md': ['Questions', '90-faq.md'],
};
const STATUS_TITLE = {
  ok: 'up to date — consistent with the last baseline',
  editado: 'being edited — diverged from the baseline (work in progress)',
  desatualizado: 'STALE — an upstream changed and this stage wasn\'t revisited',
  pendente: 'pending — doesn\'t exist yet',
  stub: 'template created, content not written yet',
  falhas: 'review open — there are FAILs awaiting a fix or a conscious record',
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
// A missing optional stage (25-domain.md, 35-data-model.md) that was a
// conscious call, not an oversight, has a line under "## Deferred decisions" in
// 40-tradeoffs.md naming it and saying "dismissed" ("dispensad[a/o]" in a
// Portuguese session) — same convention the [deferred] lint uses server-side.
// Returns that line, or null.
const DISMISS_KEYWORDS = { '25-domain.md': /dom[íi]nio|domain/i, '35-data-model.md': /modelo|model/i };
function dismissedReason(stageName, files) {
  const kw = DISMISS_KEYWORDS[stageName];
  if (!kw) return null;
  const tradeoffs = files.find((f) => f.name === '40-tradeoffs.md');
  if (!tradeoffs) return null;
  const m = tradeoffs.content.match(/^##\s+(?:Deferred decisions|Decisões adiadas)\s*$([\s\S]*?)(?=^##\s|\s*$(?![\s\S]))/m);
  if (!m) return null;
  for (const raw of m[1].split('\n')) {
    const line = raw.trim();
    if (/^-\s/.test(line) && kw.test(line) && /dispensad|dismissed/i.test(line)) return line.replace(/^-\s*/, '');
  }
  return null;
}

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
      let cls = st.status === 'desatualizado' ? 'desatualizado' : st.stub ? 'stub' : st.status;
      let title = `${st.name}: ${STATUS_TITLE[cls]}`;
      // an optional stage that never got a file BUT has a recorded dismissal reads
      // as a conscious call, not a forgotten tab — distinct dashed style, reason on hover
      if (st.status === 'pendente') {
        const reason = dismissedReason(st.name, s.files);
        if (reason) {
          cls = 'dismissed';
          title = `${st.name}: dismissed with reason — "${reason}"`;
        }
      }
      return `<button class="stage ${cls}${active}" data-tab="${enabled ? tabId : ''}"
        title="${esc(title)}" ${enabled ? '' : 'disabled'}>
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
      track += '<span class="pipeline-note" title="Consistency between stages starts being tracked after the first baseline (node tools/check.mjs <slug> --baseline)">no baseline</span>';
  }

  // página compartilhada é só a sessão — documentos globais (aprendizados, padrões...) não viajam
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
    // single format "title - jonatasrenan"; the "System Design Studio" suffix is local-viewer only
    document.title = `${state.session.meta.title} - jonatasrenan${STATIC ? '' : ' System Design Studio'}`;
    if (STATIC) $('header h1').textContent = `${state.session.meta.title} - jonatasrenan`;
  }
  const badges = $('#session-badges');
  const meta = state.session?.meta || {};
  badges.innerHTML = '';
  // public page: "in-progress" doesn't show (noise for an external reader); "done" stays
  if (meta.status && !(STATIC && meta.status === 'in-progress'))
    badges.innerHTML += `<span class="badge status-${meta.status}">${meta.status === 'done' ? 'completed' : 'in progress'}</span>`;
  if (state.session && !STATIC) {
    if (state.shareBusy) {
      badges.innerHTML += `<span class="badge">⏳ publishing…</span>`;
    } else if (meta.share?.url) {
      badges.innerHTML += `<a class="badge share" href="${meta.share.url}" target="_blank" title="design published — updates itself on every change">🔗 shared</a><button class="badge share-btn" id="unshare-btn" title="takes the published page down">✕</button>`;
    } else {
      badges.innerHTML += `<button class="badge share-btn" id="share-btn" title="publishes this design to a public link that updates itself">🔗 share</button>`;
    }
  }
  const shareCall = async (action) => {
    state.shareBusy = true;
    renderHeader();
    try {
      const r = await fetch(`/api/session/${encodeURIComponent(state.current)}/${action}`, { method: 'POST' });
      const d = await r.json();
      if (!r.ok) alert(d.error || 'failed to publish');
      else if (state.session) state.session.meta.share = d.share ?? undefined;
    } catch (e) {
      alert(`failed: ${e.message}`);
    }
    state.shareBusy = false;
    renderHeader();
  };
  const sb = $('#share-btn');
  if (sb) sb.onclick = () => shareCall('share');
  const ub = $('#unshare-btn');
  if (ub)
    ub.onclick = () => {
      if (confirm('Unshare? The public page goes offline.')) shareCall('unshare');
    };
  const fb = $('#follow-btn');
  // public page: no "follow" control — that's a studio tracking tool
  if (STATIC) fb.style.display = 'none';
  fb.textContent = state.follow ? '🔄 following' : '📌 pinned';
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
        patterns: '',
        guardrails: '',
      }
    : await (await fetch('/api/sessions')).json();
  if (seq !== loadSeq) return; // resposta atrasada de um load antigo — descarta
  state.sessions = data.sessions;
  state.learnings = data.learnings;
  state.patterns = data.patterns;
  state.guardrails = data.guardrails;
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
      if (state.session.files.some((f) => f.name === '00-problem.md')) state.activeTab = '00-problem.md';
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

/* Selfloop · 闭环查看器前端（零依赖，纯原生） */
'use strict';

// ============================================================
// 全局状态
// ============================================================
const S = {
  data: null,          // 最新 /api/state 聚合结果
  selected: null,      // { png, dist, id, note, params }
  byPng: new Map(),    // 归一化 png -> { dist, id, note, params }
  paramCols: [],       // 曲线里的参数列（非 m:/nd: 前缀的数值列）
  mode: 'side',        // side | overlay
  blinkOn: false,
  blinkTimer: null,
  overlayPos: 50,      // 叠加分割线位置 0..100
  curvePts: [],        // 曲线有效点
};

// ============================================================
// 小工具
// ============================================================
const $ = (id) => document.getElementById(id);

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function escAttr(s) { return esc(s); }

function fmt(x) {
  if (x == null) return '—';
  if (typeof x === 'number') {
    if (!Number.isFinite(x)) return String(x);
    if (Number.isInteger(x)) return String(x);
    const a = Math.abs(x);
    const d = a >= 100 ? 0 : a >= 1 ? 2 : 4;
    return x.toFixed(d);
  }
  return String(x);
}

function normalize(p) { return String(p == null ? '' : p).replace(/\\/g, '/'); }
function basename(p) { const n = normalize(p); const i = n.lastIndexOf('/'); return i >= 0 ? n.slice(i + 1) : n; }
function runUrl(p) { return p ? '/run/' + normalize(p) : ''; }

function paramsStr(params) {
  const keys = Object.keys(params || {});
  if (!keys.length) return '';
  return keys.map((k) => k + '=' + fmt(params[k])).join(' ');
}

function rowParams(r) {
  const params = {};
  for (const c of (S.paramCols || [])) if (r && r[c] != null) params[c] = r[c];
  return params;
}

function el(tag, cls) { const e = document.createElement(tag); if (cls) e.className = cls; return e; }
function span(cls, txt) { const s = el('span', cls); s.textContent = txt; return s; }

let toastTimer = null;
function flash(msg) {
  const t = $('toast');
  if (!t) return;
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 1400);
}
async function copyText(txt) {
  try {
    await navigator.clipboard.writeText(String(txt == null ? '' : txt));
    flash('已复制');
  } catch {
    flash('复制失败（浏览器未授权剪贴板）');
  }
}

// ============================================================
// 取数
// ============================================================
async function fetchState() {
  const res = await fetch('/api/state', { cache: 'no-store' });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  return res.json();
}

function derive() {
  const d = S.data || {};
  const known = new Set(['round', 'eval_seq', 'id', 'note', 'dist', 'pen', 'png']);
  const header = (Array.isArray(d.curveHeader) && d.curveHeader.length)
    ? d.curveHeader
    : (Array.isArray(d.curve) && d.curve[0] ? Object.keys(d.curve[0]) : []);
  S.paramCols = header.filter((h) => !known.has(h) && !String(h).startsWith('m:') && !String(h).startsWith('nd:'));

  const map = new Map();
  if (Array.isArray(d.curve)) {
    for (const r of d.curve) {
      if (!r || !r.png) continue;
      const params = {};
      for (const c of S.paramCols) if (r[c] != null) params[c] = r[c];
      map.set(normalize(r.png), { dist: r.dist, id: r.id, note: r.note, params });
    }
  }
  S.byPng = map;
}

function resolveSelection() {
  const d = S.data || {};
  const cur = S.selected && S.selected.png ? S.selected.png : '';
  if (!cur) {
    const best = d.bestPng
      || (Array.isArray(d.curve) && d.curve.length ? d.curve[d.curve.length - 1].png : '')
      || '';
    S.selected = {
      png: best,
      dist: (d.summary && d.summary.bestDist) ?? null,
      id: 'best', note: 'best',
      params: (d.summary && d.summary.bestParams) || {},
    };
    return;
  }
  const n = normalize(cur);
  const hit = S.byPng.get(n);
  if (hit) {
    S.selected = { png: cur, dist: hit.dist ?? null, id: hit.id, note: hit.note, params: hit.params };
  } else if (n === normalize(d.bestPng)) {
    S.selected = {
      png: d.bestPng,
      dist: (d.summary && d.summary.bestDist) ?? null,
      id: 'best', note: 'best',
      params: (d.summary && d.summary.bestParams) || {},
    };
  }
  // 否则保留原样（该帧可能已在轮询更新中消失）
}

function selectFrame(png, dist, id, note, params) {
  S.selected = { png: png || '', dist: dist ?? null, id: id || '', note: note || '', params: params || {} };
  renderCompare();
  renderCurve();
  renderFilmstrip();
}

// ============================================================
// 渲染 KPI
// ============================================================
function renderKPI() {
  const box = $('kpis');
  const d = S.data || {};
  const s = d.summary || null;
  if (!s) {
    box.innerHTML = '<div class="kpi-banner">这个 run 没有 best.json（只有帧 / 报告 / 事件可看）</div>';
    return;
  }

  const sd = s.startDist, bd = s.bestDist;
  let pct = s.dropPct;
  if (pct == null && sd != null && bd != null && sd !== 0) pct = (sd - bd) / sd * 100;
  const good = pct != null && pct >= 0;
  const dropBadge = pct != null
    ? '<span class="k-sub ' + (good ? 'good' : 'bad') + '">' + (good ? '↓' : '↑') + ' ' + fmt(Math.abs(pct)) + '%</span>'
    : '<span class="k-sub dim">—</span>';

  const used = s.used ?? s.evaluations?.used ?? null;
  const ev = s.evaluations;
  const evSub = ev
    ? '<span class="k-sub dim">预检' + fmt(ev.precheck) + ' · 搜索' + fmt(ev.search) + ' · 缓存' + fmt(ev.cache) + '</span>'
    : '';
  const metricStr = (Array.isArray(s.metricIds) && s.metricIds.length) ? s.metricIds.join(', ') : '—';
  const aliveStr = (Array.isArray(s.alive) && s.alive.length) ? s.alive.join(',') : '—';
  const tSub = s.stepN != null ? '<span class="k-sub dim">step ' + fmt(s.stepN) + '</span>' : '';
  const tierSub = s.stepMs != null ? '<span class="k-sub dim">stepMs ' + fmt(s.stepMs) + '</span>' : '';
  const wh = (s.w != null && s.h != null) ? s.w + '×' + s.h : '—';

  const cards = [
    card('距离', fmt(sd) + ' → ' + fmt(bd), dropBadge, '降幅 dropAbs=' + fmt(s.dropAbs)),
    card('评估', fmt(used) + ' / ' + fmt(s.budget), evSub),
    card('终止', s.stopReason || '—', '', s.stopDetail || ''),
    card('种子 seed', fmt(s.seed), ''),
    card('时刻 t', s.t != null ? fmt(s.t) + ' ms' : '—', tSub),
    card('画质 tier', s.tier || '—', tierSub),
    card('尺寸', wh, ''),
    card('目标', (s.effect || '') + (s.block ? ' · ' + s.block : ''), s.strategy ? '<span class="k-sub dim">' + esc(s.strategy) + '</span>' : ''),
    card('指标', metricStr, '<span class="k-sub dim">白名单 ' + esc(aliveStr) + '</span>'),
    hashCard((s.hash || '').slice(0, 12), s.hash),
  ];
  box.innerHTML = cards.join('');

  const hb = box.querySelector('.hash-copy');
  if (hb) hb.addEventListener('click', () => copyText(s.hash || ''));
}

function card(label, val, sub, title) {
  const t = title ? ' title="' + escAttr(title) + '"' : '';
  return '<div class="kpi"' + t + '><div class="k-label">' + esc(label) + '</div>'
    + '<div class="k-val mono">' + esc(val == null ? '—' : val) + '</div>' + (sub || '') + '</div>';
}

function hashCard(short, full) {
  return '<div class="kpi" title="' + escAttr(full || '') + '（点击复制）"><div class="k-label">指纹 hash</div>'
    + '<button type="button" class="k-val mono hash-copy">' + esc(short || '—') + '</button></div>';
}

// ============================================================
// 渲染对比区
// ============================================================
function renderCompare() {
  const body = $('compare-body');
  const foot = $('compare-foot');
  const d = S.data || {};
  const ref = d.targetPng || '';
  const sel = S.selected || {};
  const cand = sel.png || d.bestPng || '';
  const candDist = sel.dist != null ? sel.dist : null;
  const aspect = aspectRatio(d);

  stopBlink();

  if (S.blinkOn) {
    const stage = el('div', 'stage blink');
    stage.style.aspectRatio = aspect;
    stage.append(layerEl(ref, 'bky a'), layerEl(cand, 'bky b'));
    stage.append(span('badge', 'A/B 闪烁'));
    body.replaceChildren(stage);
    foot.innerHTML = footHtml(cand, candDist, 'A/B 闪烁中：REF 与候选每 400ms 交替');
    ensureBlink();
    return;
  }

  if (S.mode === 'overlay') {
    const stage = el('div', 'stage overlay');
    stage.style.aspectRatio = aspect;
    const candLyr = layerEl(cand, 'lyr cand');
    candLyr.style.clipPath = 'inset(0 0 0 ' + S.overlayPos + '%)';
    const divider = el('div', 'divider');
    divider.style.left = S.overlayPos + '%';
    divider.append(span('grip', '⋮'));
    stage.append(layerEl(ref, 'lyr ref'), candLyr, divider);
    stage.append(span('badge ref-badge', 'REF'), span('badge cand-badge', '候选'));
    body.replaceChildren(stage);
    foot.innerHTML = footHtml(cand, candDist, '叠加：拖动分割线切换 REF / 候选');
    attachOverlayDrag(stage);
    return;
  }

  const stage = el('div', 'stage side');
  stage.append(panel(ref, 'REF', null), panel(cand, '候选', candDist));
  body.replaceChildren(stage);
  foot.innerHTML = footHtml(cand, candDist, '并排：左 REF 右候选');
}

function panel(png, label, dist) {
  const fig = el('figure', 'panel');
  const cap = el('figcaption', 'panel-cap');
  cap.append(document.createTextNode(label + ' '), span('mono', basename(png) || '无图'));
  if (dist != null) cap.append(span('mono dim', ' d=' + fmt(dist)));
  const wrap = el('div', 'imgwrap');
  wrap.append(layerEl(png, ''));
  fig.append(cap, wrap);
  return fig;
}

function footHtml(cand, dist, hint) {
  const ps = paramsStr(S.selected && S.selected.params);
  let s = '<span class="fn">' + esc(basename(cand) || '无候选') + '</span>';
  if (dist != null) s += ' <span class="mono dim">d=' + fmt(dist) + '</span>';
  if (ps) s += ' <span class="mono dim">' + esc(ps) + '</span>';
  if (hint) s += '<span class="hint">' + esc(hint) + '</span>';
  return s;
}

function aspectRatio(d) {
  const s = d && d.summary;
  if (s && s.w > 0 && s.h > 0) return s.w + ' / ' + s.h;
  return '16 / 9';
}

function layerEl(src, cls) {
  const n = normalize(src || '');
  if (!n) {
    const ph = el('div', (cls ? cls + ' ' : '') + 'img-fail');
    ph.textContent = '✕ 无图';
    return ph;
  }
  const img = document.createElement('img');
  if (cls) img.className = cls;
  img.src = runUrl(src);
  img.alt = basename(src);
  img.addEventListener('error', () => {
    const ph = el('div', (cls ? cls + ' ' : '') + 'img-fail');
    ph.textContent = '✕ ' + basename(src);
    img.replaceWith(ph);
  });
  return img;
}

function ensureBlink() {
  stopBlink();
  if (!S.blinkOn) return;
  const stage = $('compare-body').querySelector('.stage.blink');
  if (stage) S.blinkTimer = setInterval(() => stage.classList.toggle('showB'), 400);
}
function stopBlink() { if (S.blinkTimer) { clearInterval(S.blinkTimer); S.blinkTimer = null; } }

function attachOverlayDrag(stage) {
  const cand = stage.querySelector('.lyr.cand');
  const divider = stage.querySelector('.divider');
  const apply = (pos) => {
    S.overlayPos = Math.max(2, Math.min(98, pos));
    if (cand) cand.style.clipPath = 'inset(0 0 0 ' + S.overlayPos + '%)';
    if (divider) divider.style.left = S.overlayPos + '%';
  };
  const move = (clientX) => {
    const r = stage.getBoundingClientRect();
    if (r.width <= 0) return;
    apply((clientX - r.left) / r.width * 100);
  };
  stage.addEventListener('pointerdown', (e) => { stage.setPointerCapture(e.pointerId); move(e.clientX); });
  stage.addEventListener('pointermove', (e) => { if (e.buttons & 1) move(e.clientX); });
}

// ============================================================
// 渲染曲线
// ============================================================
function renderCurve() {
  const box = $('curve');
  const d = S.data || {};
  const rows = Array.isArray(d.curve) ? d.curve : [];

  const pts = [];
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i] || {};
    const x = r.eval_seq != null ? Number(r.eval_seq) : (i + 1);
    const y = r.dist != null ? Number(r.dist) : NaN;
    if (Number.isFinite(x) && Number.isFinite(y)) pts.push(Object.assign({}, r, { _x: x, _y: y }));
  }
  if (!pts.length) {
    box.innerHTML = '<div class="empty">这个 run 没有 curve.csv（或曲线为空）</div>';
    S.curvePts = [];
    return;
  }
  pts.sort((a, b) => a._x - b._x);
  S.curvePts = pts;

  const xs = pts.map((p) => p._x), ys = pts.map((p) => p._y);
  const xMin = Math.min(...xs), xMax = Math.max(...xs);
  let yMin = Math.min(...ys), yMax = Math.max(...ys);
  if (yMax - yMin < 1e-9) { yMin -= 0.01; yMax += 0.01; }

  const W = 960, H = 300, padL = 50, padR = 14, padT = 18, padB = 28;
  const plotW = W - padL - padR, plotH = H - padT - padB;
  const X = (x) => padL + (x - xMin) / (xMax - xMin || 1) * plotW;
  const Y = (y) => padT + (y - yMin) / (yMax - yMin) * plotH;

  let g = '';
  const yTicks = [yMin, (yMin + yMax) / 2, yMax];
  for (const t of yTicks) {
    const yy = Y(t);
    g += '<line x1="' + padL + '" y1="' + yy.toFixed(1) + '" x2="' + (W - padR) + '" y2="' + yy.toFixed(1) + '" class="grid"/>';
    g += '<text x="' + (padL - 6) + '" y="' + (yy + 3).toFixed(1) + '" class="axis" text-anchor="end">' + fmt(t) + '</text>';
  }
  const xTicks = [xMin, (xMin + xMax) / 2, xMax];
  for (const t of xTicks) {
    const xx = X(t);
    g += '<text x="' + xx.toFixed(1) + '" y="' + (H - 8) + '" class="axis" text-anchor="middle">' + fmt(t) + '</text>';
  }

  let budgetLine = '';
  const used = (d.summary && (d.summary.used ?? d.summary.evaluations?.used)) ?? null;
  if (used != null && used >= xMin - 1 && used <= xMax + 1) {
    const xx = X(Math.max(xMin, Math.min(used, xMax)));
    budgetLine = '<line x1="' + xx.toFixed(1) + '" y1="' + padT + '" x2="' + xx.toFixed(1) + '" y2="' + (padT + plotH) + '" class="budget"/>'
      + '<text x="' + xx.toFixed(1) + '" y="' + (padT - 5) + '" class="budget-label" text-anchor="middle">预算</text>';
  }

  const line = pts.map((p) => X(p._x).toFixed(2) + ',' + Y(p._y).toFixed(2)).join(' ');

  let bestIdx = 0;
  pts.forEach((p, i) => { if (p._y < pts[bestIdx]._y) bestIdx = i; });

  const selN = normalize(S.selected && S.selected.png || '');
  let dots = '';
  pts.forEach((p, i) => {
    const cx = X(p._x).toFixed(1), cy = Y(p._y).toFixed(1);
    const note = String(p.note || '');
    const cls = 'curve-point ' + (note === 'start' ? 'p-start' : note.indexOf('precheck') === 0 ? 'p-pre' : 'p-norm');
    const isSel = normalize(p.png || '') === selN;
    const isBest = i === bestIdx;
    dots += '<circle class="' + cls + '" cx="' + cx + '" cy="' + cy + '" r="' + (isSel ? 5.5 : isBest ? 5 : 4) + '" data-i="' + i + '"'
      + (isSel ? ' stroke="#fff" stroke-width="2"' : '')
      + '></circle>';
    if (isBest) {
      dots += '<path d="M' + cx + ' ' + (parseFloat(cy) - 11).toFixed(1) + ' L' + (parseFloat(cx) + 5).toFixed(1) + ' ' + (parseFloat(cy) - 5).toFixed(1)
        + ' L' + cx + ' ' + (parseFloat(cy) + 1).toFixed(1) + ' L' + (parseFloat(cx) - 5).toFixed(1) + ' ' + (parseFloat(cy) - 5).toFixed(1) + ' Z" class="best-flag"></path>';
    }
  });

  box.innerHTML = '<svg viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="xMidYMid meet" role="img">'
    + '<text x="' + (W - padR) + '" y="' + (padT + 4) + '" class="axis-title" text-anchor="end">dist（越低越靠上 = 越好）</text>'
    + g + budgetLine
    + '<polyline points="' + line + '" class="curve-line"/>'
    + dots
    + '</svg>';

  box.querySelectorAll('.curve-point').forEach((c) => {
    const i = Number(c.dataset.i);
    const p = S.curvePts[i];
    c.addEventListener('click', () => selectFrame(p.png, p.dist, p.id, p.note, rowParams(p)));
    c.addEventListener('mouseenter', (e) => showTip(e, p));
    c.addEventListener('mousemove', (e) => moveTip(e));
    c.addEventListener('mouseleave', hideTip);
  });
}

function showTip(e, p) {
  const tip = $('tooltip');
  const lines = [];
  lines.push('id=' + (p.id || '—') + (p.note ? ' · ' + p.note : ''));
  lines.push('dist=' + fmt(p.dist));
  const ps = paramsStr(rowParams(p));
  if (ps) lines.push(ps);
  tip.innerHTML = lines.map((l) => '<div>' + esc(l) + '</div>').join('');
  tip.hidden = false;
  moveTip(e);
}
function moveTip(e) {
  const tip = $('tooltip');
  let x = e.clientX + 12, y = e.clientY + 12;
  const r = tip.getBoundingClientRect();
  if (x + r.width > window.innerWidth - 8) x = e.clientX - r.width - 12;
  if (y + r.height > window.innerHeight - 8) y = e.clientY - r.height - 12;
  tip.style.left = x + 'px';
  tip.style.top = y + 'px';
}
function hideTip() { const tip = $('tooltip'); tip.hidden = true; }

// ============================================================
// 渲染胶片带
// ============================================================
function renderFilmstrip() {
  const box = $('filmstrip');
  const d = S.data || {};
  const shots = Array.isArray(d.shots) ? d.shots : [];
  const scrollLeft = box.scrollLeft;
  if (!shots.length) {
    box.innerHTML = '<div class="empty">没有截图帧（shots/ 为空）</div>';
    return;
  }
  const selN = normalize(S.selected && S.selected.png || '');
  let html = '';
  for (const s of shots) {
    const n = normalize(s);
    const hit = S.byPng.get(n);
    const dd = hit ? hit.dist : null;
    const active = n === selN ? ' active' : '';
    html += '<button type="button" class="thumb' + active + '" data-png="' + escAttr(s) + '" title="' + escAttr(basename(s) + (dd != null ? ' · d=' + fmt(dd) : '')) + '">'
      + '<img loading="lazy" src="' + escAttr(runUrl(s)) + '" alt="' + escAttr(basename(s)) + '">'
      + '</button>';
  }
  box.innerHTML = html;
  box.scrollLeft = scrollLeft;
  box.querySelectorAll('.thumb').forEach((b) => {
    b.addEventListener('click', () => {
      const p = b.dataset.png;
      const hit = S.byPng.get(normalize(p));
      selectFrame(p, hit ? hit.dist : null, hit ? hit.id : null, hit ? hit.note : null, hit ? hit.params : {});
    });
  });
}

// ============================================================
// 渲染台帐
// ============================================================
function renderLedger() {
  const box = $('ledger');
  const d = S.data || {};
  const nodes = Array.isArray(d.nodes) ? d.nodes : [];
  if (!nodes.length) {
    box.innerHTML = '<div class="empty">这个 run 没有台帐（0.5.0 之前的版本）</div>';
    return;
  }
  const counts = { done: 0, skipped: 0, degraded: 0, failed: 0 };
  nodes.forEach((n) => { const st = n.status || ''; if (st in counts) counts[st]++; });
  const sorted = nodes.slice().sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
  let html = '<div class="ledger-sum">'
    + '<span class="st done">' + counts.done + ' done</span>'
    + '<span class="st skipped">' + counts.skipped + ' skipped</span>'
    + '<span class="st degraded">' + counts.degraded + ' degraded</span>'
    + '<span class="st failed">' + counts.failed + ' failed</span>'
    + '</div><ol class="ledger-list">';
  for (const n of sorted) {
    const st = n.status || 'other';
    const name = n.node || n.name || String(n.file || '').replace(/\.json$/i, '');
    const ms = n.ms != null ? fmt(n.ms) + 'ms' : '';
    html += '<li class="node st-' + escAttr(st) + '">'
      + '<button type="button" class="node-head"><span class="node-dot"></span>'
      + '<span class="node-name mono">' + esc(name) + '</span>'
      + '<span class="node-producer">' + esc(n.producer || '') + '</span>'
      + '<span class="node-ms mono">' + esc(ms) + '</span></button>'
      + '<div class="node-body" hidden>' + nodeDetail(n) + '</div>'
      + '</li>';
  }
  html += '</ol>';
  box.innerHTML = html;
  box.querySelectorAll('.node-head').forEach((h) => {
    h.addEventListener('click', () => {
      const body = h.nextElementSibling;
      body.hidden = !body.hidden;
      h.classList.toggle('open', !body.hidden);
    });
  });
}

function nodeDetail(n) {
  const row = (k, v) => '<div class="d-row"><span class="d-k">' + esc(k) + '</span><span class="d-v">' + v + '</span></div>';
  const parts = [];
  const dec = n.decision || {};
  if (dec.why) parts.push(row('why', esc(dec.why)));
  if (dec.basis) parts.push(row('basis', esc(dec.basis)));
  if (Array.isArray(n.artifacts) && n.artifacts.length) parts.push(row('artifacts', esc(n.artifacts.join(', '))));
  if (n.cost != null) {
    let cs; try { cs = JSON.stringify(n.cost); } catch { cs = String(n.cost); }
    parts.push(row('cost', '<span class="mono">' + esc(cs) + '</span>'));
  }
  if (!parts.length) return '<div class="d-row muted">无额外信息</div>';
  return parts.join('');
}

// ============================================================
// 渲染报告 / 侧栏
// ============================================================
function renderSidebar() {
  const d = S.data || {};
  const s = d.summary || null;

  const ib = $('intent-box');
  let ih = '';
  if (s) ih += paramsBlock(s);
  if (d.intent && typeof d.intent === 'object') ih += '<div class="sec-label">intent</div>' + renderTree(d.intent);
  if (d.research && typeof d.research === 'object') ih += '<div class="sec-label">research</div>' + renderTree(d.research);
  if (!ih) ih = '<div class="empty">无 intent.json / research.json</div>';
  ib.innerHTML = ih;

  const rb = $('report-box');
  rb.innerHTML = '';
  const head = el('div', 'report-head');
  const btn = el('button', 'copy-btn');
  btn.type = 'button';
  btn.textContent = '复制全文';
  head.append(btn);
  const pre = el('pre', 'report-pre');
  pre.textContent = d.report || '（无 report.md）';
  rb.append(head, pre);
  btn.addEventListener('click', () => copyText(d.report || ''));

  const lb = $('live-box');
  const live = Array.isArray(d.live) ? d.live : [];
  if (!live.length) { lb.innerHTML = '<div class="empty">无 live.jsonl</div>'; return; }
  const items = live.slice().reverse().map((ev) => {
    let str; try { str = JSON.stringify(ev); } catch { str = String(ev); }
    const short = str.length > 240 ? str.slice(0, 240) + '…' : str;
    return '<div class="live-item mono" title="' + escAttr(str) + '">' + esc(short) + '</div>';
  }).join('');
  lb.innerHTML = '<div class="live-count mono">' + live.length + ' 条 · 最新在上</div>' + items;
}

function paramsBlock(s) {
  const row = (k, v) => '<div class="d-row"><span class="d-k">' + esc(k) + '</span><span class="d-v mono">' + esc(v) + '</span></div>';
  const j = (o) => { try { return JSON.stringify(o); } catch { return String(o); } };
  let h = '<div class="sec-label">参数 / 白名单</div>';
  h += row('白名单 alive', (Array.isArray(s.alive) && s.alive.length ? s.alive.join(', ') : '—'));
  h += row('dead', (Array.isArray(s.dead) && s.dead.length ? s.dead.join(', ') : '—'));
  h += row('指标 metricIds', (Array.isArray(s.metricIds) && s.metricIds.length ? s.metricIds.join(', ') : '—'));
  h += row('起始参数', j(s.startParams || {}));
  h += row('最佳参数', j(s.bestParams || {}));
  return h;
}

function renderTree(obj) {
  if (obj == null) return '<span class="nil mono">null</span>';
  if (typeof obj !== 'object') return '<span class="mono">' + esc(fmt(obj)) + '</span>';
  if (Array.isArray(obj)) {
    if (!obj.length) return '<span class="nil mono">[]</span>';
    return '<ul class="tree">' + obj.map((v, i) => '<li><span class="tk mono">' + i + '</span>' + renderTree(v) + '</li>').join('') + '</ul>';
  }
  const keys = Object.keys(obj);
  if (!keys.length) return '<span class="nil mono">{}</span>';
  return '<ul class="tree">' + keys.map((k) => '<li><span class="tk">' + esc(k) + '</span>' + renderTree(obj[k]) + '</li>').join('') + '</ul>';
}

// ============================================================
// 汇总 / 页头
// ============================================================
function renderHeader() {
  const d = S.data || {};
  const s = d.summary || null;
  const parts = [];
  if (d.run && d.run.name) parts.push('<span class="mono">' + esc(d.run.name) + '</span>');
  if (d.run && d.run.dir) parts.push('<span class="dim" title="' + escAttr(d.run.dir) + '">' + esc(basename(d.run.dir)) + '</span>');
  if (s && (s.effect || s.block)) parts.push('<span>' + esc((s.effect || '') + (s.block ? ' · ' + s.block : '')) + '</span>');
  $('runmeta').innerHTML = parts.join('<span class="sep">/</span>');
}

function renderClock(err) {
  const el = $('clock');
  const d = S.data || {};
  const now = new Date();
  const ts = now.getHours().toString().padStart(2, '0') + ':' + now.getMinutes().toString().padStart(2, '0') + ':' + now.getSeconds().toString().padStart(2, '0');
  let html = '最后更新 ' + esc(ts);
  const s = d.summary;
  if (!err && s && s.stopReason && d.run && d.run.mtime && (now.getTime() - d.run.mtime) > 30000) {
    html += ' <span class="still">■ 已静止 · ' + esc(s.stopReason) + '</span>';
  }
  if (err) html = '<span class="err">连接失败：' + esc(err) + '</span>';
  el.innerHTML = html;
}

function renderAll() {
  renderHeader();
  renderKPI();
  renderCompare();
  renderCurve();
  renderFilmstrip();
  renderLedger();
  renderSidebar();
  renderClock();
}

// ============================================================
// 轮询
// ============================================================
async function poll() {
  let d;
  try {
    d = await fetchState();
  } catch (e) {
    renderClock(e.message || String(e));
    return;
  }
  const prev = S.data;
  const changed = !prev
    || (d.run && d.run.mtime) !== (prev.run && prev.run.mtime)
    || (Array.isArray(d.live) ? d.live.length : 0) !== (Array.isArray(prev.live) ? prev.live.length : 0);
  S.data = d;
  derive();
  resolveSelection();
  if (changed) renderAll();
  else renderClock();
}

// ============================================================
// 控件接线 / 启动
// ============================================================
function wireControls() {
  $('mode-seg').querySelectorAll('button').forEach((b) => {
    b.addEventListener('click', () => {
      S.mode = b.dataset.mode;
      $('mode-seg').querySelectorAll('button').forEach((x) => x.classList.toggle('active', x === b));
      renderCompare();
    });
  });
  $('blink-toggle').addEventListener('change', (e) => {
    S.blinkOn = e.target.checked;
    renderCompare();
  });
  // 胶片带缩略图加载失败 -> 占位块（error 不冒泡，用捕获阶段）
  document.addEventListener('error', (e) => {
    const t = e.target;
    if (t && t.tagName === 'IMG' && t.closest('.thumb')) {
      const ph = el('div', 'img-fail');
      ph.textContent = '✕ ' + (t.alt || '');
      t.replaceWith(ph);
    }
  }, true);
}

wireControls();
poll();
setInterval(poll, 2000);

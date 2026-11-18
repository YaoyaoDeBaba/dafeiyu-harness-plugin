'use strict';

const $ = (id) => document.getElementById(id);

const S = { data: null, stage: 1, curvePts: [], byPng: new Map(), selectedPng: null };

const ROLE_KEYS = ['manager', 'observer', 'researcher', 'executor'];
const ROLE_FALLBACK = { manager: '项目经理', observer: '观察员', researcher: '调查员', executor: '执行者' };
const MODEL_OPTIONS = ['自动', 'deepseek-v4-pro', 'deepseek-v4-flash', 'mimo-v2.6-pro', 'mimo-v2.6-flash', 'kimi-k3', 'kimi-k3.1-pro'];
const PARAM_KEYS = ['length', 'radius', 'flow', 'sphereRadius', 'haloSize', 'flameGain', 'emberPerSec'];

function esc(s) {
  const t = String(s == null ? '' : s);
  return t.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function escAttr(s) { return esc(s); }
function pad(n) { return String(n).padStart(2, '0'); }
function hhmm(v) {
  let d = v == null || v === '' ? new Date() : new Date(v);
  if (isNaN(d.getTime())) d = new Date();
  return pad(d.getHours()) + ':' + pad(d.getMinutes());
}
function truncate(s, n) { s = String(s || ''); return s.length > n ? s.slice(0, n) + '…' : s; }
function basename(p) { const s = String(p || ''); const i = s.lastIndexOf('/'); return i >= 0 ? s.slice(i + 1) : s; }
function fmt(v) {
  if (v == null || v === '') return '—';
  const n = Number(v);
  if (Number.isFinite(n)) {
    if (Number.isInteger(n) && Math.abs(n) < 100000) return String(n);
    return String(parseFloat(n.toFixed(4)));
  }
  return String(v);
}
function dist2(v) { const n = Number(v); return Number.isFinite(n) ? n.toFixed(2) : '—'; }
function stripJsonExt(s) {
  let t = String(s || '');
  if (t.toLowerCase().slice(-5) === '.json') t = t.slice(0, -5);
  return t;
}
function normalize(p) {
  let s = String(p || '');
  if (s.indexOf('/run/') === 0) s = s.slice('/run/'.length);
  while (s.charAt(0) === '/') s = s.slice(1);
  return s;
}
function runUrl(p) {
  if (p == null || p === '') return '';
  const s = String(p);
  if (s.indexOf('http:') === 0 || s.indexOf('https:') === 0) return s;
  if (s.indexOf('/run/') === 0 || s.indexOf('/ui/') === 0) return s;
  let t = s;
  while (t.charAt(0) === '/') t = t.slice(1);
  return '/run/' + t;
}
function roundsArr() { const d = S.data || {}; return Array.isArray(d.rounds) ? d.rounds : []; }
function maxRounds() { const d = S.data || {}; const b = (d.project && d.project.budget) || {}; return Number(b.maxRounds) || 0; }

async function fetchState() {
  const res = await fetch('/api/state', { cache: 'no-store' });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  return res.json();
}

let toastTimer = null;
const ACTION_LABEL = {
  confirm: '确认，开干', reject: '打回，重定判据', stop: '停下来', accept: '收下交付',
  revise: '这里不对', roles: '角色模型调整', note: '备注'
};

/** 存回 project.json（需求 / 轮数 / 角色模型）——这是页面上唯一"改配置"的写操作 */
async function saveProject(patch, okMsg) {
  try {
    const r = await fetch('/api/project', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(patch || {})
    });
    const j = await r.json();
    if (!j.ok) { renderToast('没存上：' + (j.error || '未知原因')); return; }
    renderToast(okMsg || '已保存');
    poll();
  } catch (e) {
    renderToast('没存上：' + (e && e.message ? e.message : e));
  }
}

/** 传参考图：原始字节 POST 到 /api/refs，服务端落 refs/ 并写进 project.json.refs[] */
async function uploadRefs(files) {
  if (!files || !files.length) return;
  let ok = 0;
  for (const file of files) {
    try {
      const buf = await file.arrayBuffer();
      const r = await fetch('/api/refs', {
        method: 'POST',
        headers: {
          'content-type': 'application/octet-stream',
          'x-filename': encodeURIComponent(file.name),
          'x-note': encodeURIComponent('')
        },
        body: buf
      });
      const j = await r.json();
      if (j.ok) ok += 1; else renderToast('传不上去：' + (j.error || file.name));
    } catch (e) {
      renderToast('传不上去：' + (e && e.message ? e.message : file.name));
    }
  }
  if (ok) renderToast('已加入 ' + ok + ' 份参考');
  poll();
}

/** 把人在界面上的决定落到 <run>/decisions.jsonl（agent 侧读它执行）；失败就明说失败，不许假装成功 */
async function decide(action, extra) {
  try {
    const r = await fetch('/api/decision', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(Object.assign({ action }, extra || {}))
    });
    const j = await r.json();
    if (!j.ok) { renderToast('没记上：' + (j.error || '未知原因')); return; }
    renderToast('已记下「' + (ACTION_LABEL[action] || action) + '」，agent 侧会执行');
    poll();
  } catch (e) {
    renderToast('没记上：' + (e && e.message ? e.message : e));
  }
}

function renderToast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.add('show');
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2600);
}
function openLightbox(url) {
  if (!url) return;
  const lb = $('lightbox');
  lb.innerHTML = '<img src="' + escAttr(url) + '" alt="">';
  lb.hidden = false;
}
function closeLightbox() { const lb = $('lightbox'); lb.hidden = true; lb.innerHTML = ''; }

function currentStage(d) {
  const deliver = d.deliver;
  const rounds = Array.isArray(d.rounds) ? d.rounds : [];
  const intent = d.intent;
  if (deliver && (deliver.verdict || deliver.finalShot || deliver.finalRound != null)) return 4;
  if (rounds.some((r) => r && r.status === 'running')) return 3;
  if (intent && intent.status && intent.status !== 'confirmed') return 2;
  if (rounds.length > 0) return 3;
  return 1;
}

function renderStepper() {
  const d = S.data || {};
  S.stage = currentStage(d);
  const steps = [['input', '① 投入'], ['understand', '② 理解'], ['rounds', '③ 过程'], ['deliver', '④ 交付']];
  const nav = $('stepper');
  let html = '';
  for (let i = 0; i < steps.length; i++) {
    const idx = i + 1;
    const cls = 'step' + (idx === S.stage ? ' active' : '') + (idx < S.stage ? ' done' : '');
    html += '<button type="button" class="' + cls + '" data-sec="' + steps[i][0] + '">' + steps[i][1] + '</button>';
  }
  nav.innerHTML = html;
  nav.querySelectorAll('button').forEach((b) => {
    b.addEventListener('click', () => {
      const sec = document.getElementById('sec-' + b.dataset.sec);
      if (sec) sec.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  });
}

function renderTopbar() {
  const d = S.data || {};
  const hasProject = !!d.project;
  const p = d.project || {};
  const rounds = roundsArr();
  const m = maxRounds();
  $('projname').textContent = hasProject ? (truncate(p.instruction, 20) || '（未命名项目）') : '（不是作业台）';
  $('roundcount').textContent = hasProject ? ('项目已跑 ' + rounds.length + '/' + (m || rounds.length) + ' 轮') : '';
  $('clock').textContent = '最后更新 ' + hhmm(d.run && d.run.mtime);
  // 没有项目时：① 段留着（里面有「新建项目」），②③④ 收起来；有项目但格式不对才提示
  const emptyDir = !hasProject && (d.exists === false || d.exists === undefined);
  $('projname').textContent = hasProject ? (truncate(p.instruction, 20) || '（未命名项目）') : '（新项目）';
  const banner = $('missing-banner');
  banner.hidden = hasProject || emptyDir;
  if (!hasProject && !emptyDir) banner.innerHTML = '<span>这个目录不是作业台格式（缺 project.json）</span>';
  const secs = ['input', 'understand', 'rounds', 'deliver'];
  for (let i = 0; i < secs.length; i++) {
    const hide = i === 0 ? false : !hasProject;
    document.getElementById('sec-' + secs[i]).hidden = hide;
  }
  $('stepper').hidden = false;
  if (!hasProject) $('tech-details').open = false;
}

function roleCard(key, r) {
  const name = (r && r.name) || ROLE_FALLBACK[key] || key;
  const duty = (r && r.duty) || '';
  const cur = (r && r.model) || '自动';
  const curNorm = (cur === 'auto' || cur === '') ? '自动' : cur;
  let opts = MODEL_OPTIONS.slice();
  if (opts.indexOf(curNorm) < 0) opts.unshift(curNorm);
  let sel = '<select class="role-select">';
  for (const m of opts) sel += '<option value="' + escAttr(m) + '"' + (m === curNorm ? ' selected' : '') + '>' + esc(m) + '</option>';
  sel += '</select>';
  return '<div class="role-card">'
    + '<div class="role-head"><span class="role-name">' + esc(name) + '</span>'
    + '<span class="role-model mono">' + esc(curNorm) + '</span></div>'
    + '<div class="role-duty">' + esc(duty) + '</div>'
    + sel
    + '</div>';
}

function renderInput() {
  const d = S.data || {};
  const p = d.project || {};
  const intent = d.intent || {};
  const root = $('input-root');
  const nCrit = Array.isArray(intent.criteria) ? intent.criteria.length : null;

  let html = '<div class="i-card i-need"><div class="i-label">需求</div>'
    + '<textarea id="need-edit" class="need-edit" rows="3" placeholder="一句话说清你要什么（例：角色右手火焰长枪向前突刺，要脆、要有主次）">' + esc(p.instruction || '') + '</textarea>'
    + '<div class="need-actions"><button type="button" class="btn btn-primary" id="need-save">保存需求</button><span class="need-hint">保存后 agent 会据此重做需求转译</span></div>'
    + '<div class="need-sub">这句话会被转译成 ' + (nCrit != null ? nCrit : '若干') + ' 条可测判据</div>'
    + '</div>';

  const refs = Array.isArray(p.refs) ? p.refs : [];
  html += '<div class="i-card i-refs"><div class="i-label">参考</div><div class="ref-grid">';
  if (!refs.length) html += '<div class="empty">没有参考</div>';
  for (const r of refs) {
    const kind = (r && r.kind) || 'image';
    const frameTag = (kind === 'gif' || kind === 'video')
      ? '<span class="kind-corner">' + (kind === 'video' ? '视频' : '动图') + (r.frames != null ? ' ' + r.frames + ' 帧' : '') + '</span>'
      : '';
    html += '<div class="ref-card" data-full="' + escAttr(runUrl(r.path)) + '">'
      + '<div class="ref-thumb"><img loading="lazy" src="' + escAttr(runUrl(r.path)) + '" alt=""></div>'
      + '<span class="kind-badge kind-' + escAttr(kind) + '">' + esc(kind) + '</span>'
      + frameTag
      + (r.note ? '<div class="ref-note">' + esc(r.note) + '</div>' : '')
      + '</div>';
  }
  html += '<div class="ref-add" id="ref-add"><span>＋ 添加参考</span><span style="font-size:11px">拖进来或点选（图 / gif / 视频）</span></div>';
  html += '</div></div>';

  const budget = p.budget || {};
  const mr = Number(budget.maxRounds) || 0;
  let dots = '';
  for (let i = 0; i < mr; i++) dots += '<span class="dot filled">●</span>';
  html += '<div class="i-card i-budget"><div class="i-label">预算</div>'
    + '<div class="dots-row"><button type="button" class="step-btn" id="rounds-minus">−</button><div class="dots">' + (mr ? dots : '<span class="empty">未设上限</span>') + '</div><button type="button" class="step-btn" id="rounds-plus">+</button></div>'
    + '<div class="need-sub">' + esc(budget.note || '') + '</div>'
    + '</div>';

  const roles = p.roles || {};
  html += '<div class="i-card i-roles"><div class="i-label">角色指派</div><div class="role-grid">';
  for (const key of ROLE_KEYS) html += roleCard(key, roles[key]);
  html += '</div></div>';

  root.innerHTML = html;

  root.querySelectorAll('.ref-card').forEach((c) => c.addEventListener('click', () => openLightbox(c.dataset.full)));
  const refAdd = $('ref-add');
  if (refAdd) {
    const picker = document.createElement('input');
    picker.type = 'file';
    picker.multiple = true;
    picker.accept = 'image/*,video/*';
    picker.style.display = 'none';
    document.body.appendChild(picker);
    picker.addEventListener('change', () => { uploadRefs(picker.files); picker.value = ''; });
    refAdd.addEventListener('click', () => picker.click());
    const grid = refAdd.parentElement;
    if (grid) {
      ['dragenter', 'dragover'].forEach((ev) => grid.addEventListener(ev, (e) => { e.preventDefault(); grid.classList.add('ref-drop'); }));
      ['dragleave', 'drop'].forEach((ev) => grid.addEventListener(ev, (e) => { e.preventDefault(); grid.classList.remove('ref-drop'); }));
      grid.addEventListener('drop', (e) => { if (e.dataTransfer && e.dataTransfer.files) uploadRefs(e.dataTransfer.files); });
    }
  }
  const needSave = $('need-save');
  if (needSave) needSave.addEventListener('click', () => {
    const ta = $('need-edit');
    saveProject({ instruction: ta ? ta.value : '' }, '需求已保存');
  });
  const minus = $('rounds-minus');
  const plus = $('rounds-plus');
  if (minus) minus.addEventListener('click', () => saveProject({ maxRounds: Math.max(1, maxRounds() - 1) }, '轮数 → ' + Math.max(1, maxRounds() - 1)));
  if (plus) plus.addEventListener('click', () => saveProject({ maxRounds: Math.min(20, maxRounds() + 1) }, '轮数 → ' + Math.min(20, maxRounds() + 1)));
  root.querySelectorAll('select.role-select').forEach((sel) => {
    sel.addEventListener('change', () => {
      const card = sel.closest('.role-card');
      if (card) card.querySelector('.role-model').textContent = sel.value;
      const roleKey = card ? (card.dataset.role || '') : '';
      const patch = { roles: {} };
      if (roleKey) patch.roles[roleKey] = sel.value;
      saveProject(patch, roleKey ? ('角色 ' + roleKey + ' → ' + sel.value) : '已保存');
    });
  });
}

function renderUnderstand() {
  const d = S.data || {};
  const intent = d.intent || {};
  const research = d.research || {};
  const root = $('understand-root');

  const restate = intent.restate || '（还没有转译复述）';
  const instr = intent.instruction || '';

  let html = '<div class="u-grid"><div class="u-col u-left">'
    + '<div class="u-label">我的理解</div>'
    + '<div class="restate">' + esc(restate) + '</div>'
    + (instr ? '<div class="instr-quote">' + esc(instr) + '</div>' : '')
    + '</div>';

  html += '<div class="u-col u-right">';
  const criteria = Array.isArray(intent.criteria) ? intent.criteria : [];
  html += '<div class="u-label">判据表</div>';
  if (criteria.length) {
    html += '<table class="crit-table"><thead><tr><th>要什么</th><th>你说的原话</th><th>怎么量</th><th class="num">阈值</th></tr></thead><tbody>';
    for (const c of criteria) {
      html += '<tr>'
        + '<td class="anchor">' + esc((c && c.anchor) || '')
        + ((c && c.weight != null) ? '<span class="w mono">w=' + esc(fmt(c.weight)) + '</span>' : '') + '</td>'
        + '<td class="uw">“' + esc((c && c.userWords) || '') + '”</td>'
        + '<td class="hm mono">' + esc((c && c.howMeasured) || '') + '</td>'
        + '<td class="num mono">' + esc(fmt(c && c.target)) + '</td>'
        + '</tr>';
    }
    html += '</tbody></table>';
  } else {
    html += '<div class="empty">还没有判据</div>';
  }

  const notWanted = Array.isArray(intent.notWanted) ? intent.notWanted : [];
  html += '<div class="u-label">反例</div>';
  html += notWanted.length
    ? '<div class="chips">' + notWanted.map((x) => '<span class="chip chip-red">' + esc(x) + '</span>').join('') + '</div>'
    : '<div class="empty">没有反例</div>';

  const fvf = intent.freeVsFixed || {};
  const fixed = Array.isArray(fvf.fixed) ? fvf.fixed : [];
  const free = Array.isArray(fvf.free) ? fvf.free : [];
  const listFn = (arr) => arr.length ? '<ul class="fv-list">' + arr.map((x) => '<li>' + esc(x) + '</li>').join('') + '</ul>' : '<div class="empty">—</div>';
  html += '<div class="u-label">自由度</div>';
  html += '<div class="fv-two">'
    + '<div class="fv-box"><div class="fv-title">钉死（不能动）</div>' + listFn(fixed) + '</div>'
    + '<div class="fv-box"><div class="fv-title">自由（随你发挥）</div>' + listFn(free) + '</div>'
    + '</div>';
  html += '</div></div>';

  const findings = Array.isArray(research.findings) ? research.findings : [];
  html += '<div class="u-label">调查员查到了什么</div>';
  if (findings.length) {
    html += '<div class="finding-list">';
    for (const f of findings) {
      const used = f.used ? '用上了' : '没采用';
      const ucls = f.used ? 'tag-used' : 'tag-skip';
      html += '<div class="finding">'
        + '<div class="finding-main">'
        + '<a class="finding-title" href="' + escAttr(f.url || '#') + '" target="_blank" rel="noopener">' + esc(f.title || '（无标题）') + '</a>'
        + '<div class="finding-sum">' + esc(f.summary || '') + '</div>'
        + '</div>'
        + '<span class="tag ' + ucls + '">' + used + '</span>'
        + '</div>';
    }
    html += '</div>';
  } else {
    html += '<div class="empty">还没调研</div>';
  }

  const changed = Array.isArray(research.changed) ? research.changed : [];
  html += '<div class="changed-row">据此改了：'
    + (changed.length ? changed.map((x) => '<span class="chip chip-accent">' + esc(x) + '</span>').join('') : '<span class="dim">（还没有）</span>')
    + '</div>';

  const status = intent.status;
  const confirmed = status === 'confirmed';
  const statusHtml = confirmed
    ? '已于 ' + hhmm(intent.confirmedAt) + ' 确认'
    : (status ? '状态：' + esc(status) : '待确认');
  html += '<div class="u-actions">'
    + '<button type="button" class="btn btn-primary' + (confirmed ? ' weak' : '') + '" data-act="confirm">确认，开干</button>'
    + '<button type="button" class="btn btn-ghost' + (confirmed ? ' weak' : '') + '" data-act="revise">这里不对，我说清楚</button>'
    + '<span class="u-status' + (confirmed ? ' ok' : '') + '">' + statusHtml + '</span>'
    + '</div>';

  root.innerHTML = html;
  root.querySelectorAll('[data-act]').forEach((b) => {
    b.addEventListener('click', () => {
      const act = b.dataset.act === 'confirm' ? 'confirm' : 'revise';
      const note = act === 'revise' ? (window.prompt('哪里理解错了？写清楚，agent 会据此重写判据') || '') : '';
      if (act === 'revise' && note.trim() === '') { renderToast('没写原因，先不记'); return; }
      decide(act, { note });
    });
  });
}

function roundCard(r) {
  const status = (r && r.status) || 'reviewed';
  const sd = { reviewed: 'gray', running: 'blue', delivered: 'green', interrupted: 'orange' }[status] || 'gray';
  const stLabel = { reviewed: '已审', running: '进行中', delivered: '已交付', interrupted: '已打断' }[status] || status;
  const title = 'v' + (r.n != null ? r.n : '') + ' ' + (r.title || '');
  const shot = runUrl(r.shot);
  const preview = r.preview || {};
  const pkind = preview.kind || 'none';
  const purl = preview.url || '';
  const pUrlAbs = pkind === 'web' ? purl : runUrl(purl);

  let prevBtn;
  if (pkind === 'web') prevBtn = '<button type="button" class="btn btn-ghost btn-sm" data-prev="web" data-prev-url="' + escAttr(purl) + '">预览</button>';
  else if (pkind === 'image') prevBtn = '<button type="button" class="btn btn-ghost btn-sm" data-prev="image" data-prev-url="' + escAttr(pUrlAbs) + '">预览</button>';
  else prevBtn = '<button type="button" class="btn btn-ghost btn-sm" disabled title="这一版没有可运行预览">预览</button>';

  const rev = r.review || {};
  const notes = Array.isArray(rev.notes) ? rev.notes : [];
  const notesHtml = notes.map((n) => '<div class="rev-note"><span class="dot"></span>' + esc(n) + '</div>').join('');
  const vsRef = rev.vsRef ? '<div class="vsref">“' + esc(rev.vsRef) + '”</div>' : '';

  const m = r.metrics || {};
  const dist = m.dist != null ? m.dist : null;
  const delta = m.deltaPct != null ? m.deltaPct : null;
  let metricHtml = '';
  if (dist != null) {
    metricHtml = '<span class="metric">离参考还有 ' + dist2(dist);
    if (delta != null) {
      const arrow = delta < 0 ? '↓' : delta > 0 ? '↑' : '→';
      const dcls = delta < 0 ? 'good' : delta > 0 ? 'bad' : '';
      metricHtml += ' <span class="' + dcls + '">' + arrow + Math.abs(delta).toFixed(1) + '%</span>';
    }
    metricHtml += '</span>';
  }

  const changes = Array.isArray(r.changes) ? r.changes : [];
  const changesHtml = changes.length
    ? '<div class="chips">' + changes.map((c) => '<span class="chip">' + esc(c) + '</span>').join('') + '</div>'
    : '';

  const interruptChip = (status === 'interrupted' && r.interruptNote)
    ? '<span class="chip chip-red">打断：' + esc(r.interruptNote) + '</span>' : '';

  return '<div class="round-card status-' + escAttr(status) + '">'
    + '<div class="round-head">'
    + '<div class="round-title"><span class="status-dot sd-' + sd + (status === 'running' ? ' pulse' : '') + '"></span>'
    + '<span class="rt-name">' + esc(title) + '</span>'
    + '<span class="rt-status">' + stLabel + '</span></div>'
    + '<div class="round-actions">' + prevBtn + '<button type="button" class="btn-stop-sm" data-stop>停在这里</button></div>'
    + '</div>'
    + '<div class="round-body">'
    + (shot ? '<div class="round-shot" data-shot="' + escAttr(shot) + '"><img loading="lazy" src="' + escAttr(shot) + '" alt=""></div>' : '<div class="round-shot empty">无截图</div>')
    + '<div class="round-review">'
    + '<div class="rev-label">观察员评审' + (rev.model ? ' <span class="dim mono">' + esc(rev.model) + '</span>' : '') + '</div>'
    + '<div class="verdict">' + esc(rev.verdict || '') + '</div>'
    + notesHtml
    + vsRef
    + '</div>'
    + '</div>'
    + '<div class="round-foot">'
    + '<div class="round-changes"><span class="ft-label">这轮改了什么</span>' + changesHtml + '</div>'
    + metricHtml + interruptChip
    + '</div>'
    + '</div>';
}

function renderRounds() {
  const rounds = roundsArr();
  const m = maxRounds();
  const root = $('rounds-root');

  const delivered = rounds.filter((r) => r && r.status === 'delivered').length;
  const running = rounds.find((r) => r && r.status === 'running');
  const curN = running ? running.n : (rounds.length ? rounds[rounds.length - 1].n : 0);

  let html = '<div class="rounds-sum">已交付 ' + delivered + '/' + m + ' 轮 · 当前第 ' + curN + ' 轮</div>';

  if (!rounds.length) {
    html += '<div class="empty">还没开始跑（确认理解后开始第 1 轮）</div>';
    root.innerHTML = html;
    return;
  }

  for (let i = 0; i < rounds.length; i++) {
    html += roundCard(rounds[i]);
    if (i < rounds.length - 1) html += '<div class="round-connector"><span>自审 →</span></div>';
  }
  root.innerHTML = html;

  root.querySelectorAll('[data-shot]').forEach((el) => el.addEventListener('click', () => openLightbox(el.dataset.shot)));
  root.querySelectorAll('[data-prev]').forEach((el) => {
    el.addEventListener('click', () => {
      const kind = el.dataset.prev;
      const url = el.dataset.prevUrl;
      if (kind === 'web') window.open(url, '_blank', 'noopener');
      else if (kind === 'image') openLightbox(url);
    });
  });
  root.querySelectorAll('[data-stop]').forEach((el) => el.addEventListener('click', () => {
    const n = Number(el.dataset.stop);
    const note = window.prompt('为什么在这一轮停？（可以不写）') || '';
    decide('stop', { round: Number.isFinite(n) ? n : undefined, note });
  }));
}

function renderDeliver() {
  const d = S.data || {};
  const deliver = d.deliver;
  const root = $('deliver-root');
  const rounds = roundsArr();

  const hasDeliver = deliver && (deliver.verdict || deliver.finalShot || deliver.finalRound != null
    || (Array.isArray(deliver.checks) && deliver.checks.length) || (Array.isArray(deliver.diff) && deliver.diff.length));

  if (!hasDeliver) {
    const last = rounds.length ? rounds[rounds.length - 1] : null;
    let html = '<div class="deliver-missing">还没到交付阶段';
    if (last && last.shot) {
      html += '<div class="preview-note">下面用最后一轮（v' + (last.n != null ? last.n : '') + '）当预览</div>'
        + '<div class="deliver-shot" data-shot="' + escAttr(runUrl(last.shot)) + '"><img loading="lazy" src="' + escAttr(runUrl(last.shot)) + '" alt=""></div>';
    }
    html += '</div>';
    root.innerHTML = html;
    root.querySelectorAll('[data-shot]').forEach((e) => e.addEventListener('click', () => openLightbox(e.dataset.shot)));
    return;
  }

  const verdict = deliver.verdict || 'done';
  const vcls = { done: 'green', partial: 'yellow', failed: 'red' }[verdict] || 'gray';
  const vtxt = { done: '完成', partial: '部分完成', failed: '失败' }[verdict] || verdict;

  const params = deliver.params || {};
  const pKeys = Object.keys(params);
  const paramsHtml = pKeys.length
    ? '<table class="params-table">' + pKeys.map((k) => '<tr><td class="mono">' + esc(k) + '</td><td class="mono num">' + esc(fmt(params[k])) + '</td></tr>').join('') + '</table>'
    : '<div class="empty">无参数</div>';

  const interruptedTag = deliver.interrupted ? '<span class="tag tag-orange">中途停下</span>' : '';

  const checks = Array.isArray(deliver.checks) ? deliver.checks : [];
  const checksHtml = checks.length
    ? '<table class="checks-table"><thead><tr><th>检查项</th><th>结果</th><th>详情</th></tr></thead><tbody>'
      + checks.map((c) => {
        const rcls = { pass: 'green', warn: 'yellow', fail: 'red' }[c.result] || 'gray';
        const rtxt = { pass: '通过', warn: '有保留', fail: '不通过' }[c.result] || (c.result || '—');
        return '<tr><td>' + esc(c.name || '') + '</td><td><span class="tag tag-' + rcls + '">' + rtxt + '</span></td><td class="dim">' + esc(c.detail || '') + '</td></tr>';
      }).join('')
      + '</tbody></table>'
    : '<div class="empty">无检查记录</div>';

  const diff = Array.isArray(deliver.diff) ? deliver.diff : [];
  const diffHtml = diff.length
    ? '<ul class="diff-list">' + diff.map((x) => '<li><span class="mono diff-file">' + esc(x.file || '') + '</span><span class="diff-change">' + esc(x.change || '') + '</span></li>').join('') + '</ul>'
    : '<div class="empty">无改动记录</div>';

  const sugg = Array.isArray(deliver.suggestion) ? deliver.suggestion : [];
  const suggHtml = sugg.length
    ? '<ol class="sugg-list">' + sugg.map((s) => '<li>' + esc(s) + '</li>').join('') + '</ol>'
    : '<div class="empty">无建议</div>';

  const shot = runUrl(deliver.finalShot);
  const finalRound = deliver.finalRound != null ? deliver.finalRound : (rounds.length || '—');

  root.innerHTML = '<div class="deliver-top">'
    + (shot ? '<div class="deliver-shot" data-shot="' + escAttr(shot) + '"><img loading="lazy" src="' + escAttr(shot) + '" alt=""></div>' : '')
    + '<div class="deliver-info">'
    + '<div class="dv-row"><span class="dv-label">最终第 ' + finalRound + ' 轮</span>'
    + '<span class="tag tag-' + vcls + '">' + vtxt + '</span>' + interruptedTag + '</div>'
    + '<div class="u-label">参数</div>' + paramsHtml
    + '</div>'
    + '</div>'
    + '<div class="u-label">跑过的检查</div>' + checksHtml
    + '<div class="u-label">改动 diff</div>' + diffHtml
    + '<div class="u-label">建议</div>' + suggHtml
    + '<div class="u-actions">'
    + '<button type="button" class="btn btn-primary" data-act="accept">满意，收下</button>'
    + '<button type="button" class="btn btn-ghost" data-act="reject">不满意，说说哪里不对</button>'
    + '</div>';

  root.querySelectorAll('[data-shot]').forEach((e) => e.addEventListener('click', () => openLightbox(e.dataset.shot)));
  root.querySelectorAll('[data-act]').forEach((b) => b.addEventListener('click', () => {
    const act = b.dataset.act === 'accept' ? 'accept' : 'reject';
    const note = act === 'reject' ? (window.prompt('哪里不对？写清楚，agent 会拿它重定判据') || '') : '';
    if (act === 'reject' && note.trim() === '') { renderToast('没写原因，先不记'); return; }
    decide(act, { note });
  }));
}

function techKpiHtml(d) {
  const s = d.summary || {};
  const used = s.used != null ? s.used : (s.evaluations && s.evaluations.used);
  const budget = s.budget;
  const seed = s.seed, t = s.t, tier = s.tier, w = s.w, h = s.h;
  const hash = String(s.hash || '');
  const hash12 = hash.slice(0, 12);
  const row = (k, v) => '<div class="kpi"><div class="k-label">' + esc(k) + '</div><div class="k-val">' + v + '</div></div>';
  let html = '<div class="kpis">';
  html += row('startDist → bestDist', '<span class="mono">' + esc(fmt(s.startDist)) + '</span> → <span class="mono good">' + esc(fmt(s.bestDist)) + '</span>');
  html += row('评估 used / budget', '<span class="mono">' + esc(used != null ? used : '—') + ' / ' + esc(budget != null ? budget : '—') + '</span>');
  html += row('seed / t / tier', '<span class="mono">' + esc(seed != null ? seed : '—') + ' / ' + esc(t != null ? t : '—') + ' / ' + esc(tier != null ? tier : '—') + '</span>');
  html += row('尺寸 w×h', '<span class="mono">' + esc(w != null ? w : '—') + '×' + esc(h != null ? h : '—') + '</span>');
  html += row('决策 hash', '<span class="mono" title="' + escAttr(hash) + '">' + esc(hash12 || '—') + '…</span>');
  html += '</div>';
  return html;
}

function rowParams(r) {
  const o = {};
  for (const k of PARAM_KEYS) if (r && r[k] != null) o[k] = r[k];
  return o;
}

function selectFrame(png, dist, id, note, params) {
  const fp = $('frame-preview');
  const url = runUrl(png);
  fp.innerHTML = '<img src="' + escAttr(url) + '" alt="">'
    + '<div><div class="fp-meta mono">' + esc(id || basename(png)) + (note ? ' · ' + esc(note) : '') + (dist != null ? ' · d=' + esc(fmt(dist)) : '') + '</div>'
    + (params && Object.keys(params).length ? '<div class="fp-params mono">' + esc(JSON.stringify(params)) + '</div>' : '')
    + '</div>';
  S.selectedPng = png;
  renderFilmstrip();
}

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
  if (!pts.length) { box.innerHTML = '<div class="empty">这个 run 没有 curve（或曲线为空）</div>'; return; }
  pts.sort((a, b) => a._x - b._x);
  S.curvePts = pts;

  const xs = pts.map((p) => p._x), ys = pts.map((p) => p._y);
  const xMin = Math.min.apply(null, xs), xMax = Math.max.apply(null, xs);
  let yMin = Math.min.apply(null, ys), yMax = Math.max.apply(null, ys);
  if (yMax - yMin < 1e-9) { yMin -= 0.01; yMax += 0.01; }

  const W = 960, H = 280, padL = 50, padR = 14, padT = 18, padB = 26;
  const plotW = W - padL - padR, plotH = H - padT - padB;
  const X = (x) => padL + (x - xMin) / (xMax - xMin || 1) * plotW;
  const Y = (y) => padT + (y - yMin) / (yMax - yMin || 1) * plotH;

  let g = '';
  const yTicks = [yMin, (yMin + yMax) / 2, yMax];
  for (const t of yTicks) {
    const yy = Y(t);
    g += '<line x1="' + padL + '" y1="' + yy.toFixed(1) + '" x2="' + (W - padR) + '" y2="' + yy.toFixed(1) + '" class="grid"/>';
    g += '<text x="' + (padL - 6) + '" y="' + (yy + 3).toFixed(1) + '" class="axis" text-anchor="end">' + fmt(t) + '</text>';
  }
  const line = pts.map((p) => X(p._x).toFixed(2) + ',' + Y(p._y).toFixed(2)).join(' ');

  let bestIdx = 0;
  pts.forEach((p, i) => { if (p._y < pts[bestIdx]._y) bestIdx = i; });

  let dots = '';
  pts.forEach((p, i) => {
    const cx = X(p._x).toFixed(1), cy = Y(p._y).toFixed(1);
    const note = String(p.note || '');
    const cls = 'curve-point ' + (note === 'start' ? 'p-start' : note.indexOf('precheck') === 0 ? 'p-pre' : 'p-norm') + (i === bestIdx ? ' is-best' : '');
    dots += '<circle class="' + cls + '" cx="' + cx + '" cy="' + cy + '" r="' + (i === bestIdx ? 5 : 3.5) + '" data-i="' + i + '"><title>' + esc(p.id || '') + ' · d=' + esc(fmt(p.dist)) + ' · ' + esc(note) + '</title></circle>';
  });

  box.innerHTML = '<svg viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="xMidYMid meet" role="img">'
    + '<text x="' + (W - padR) + '" y="' + (padT + 4) + '" class="axis-title" text-anchor="end">dist（越低越靠上 = 越好）</text>'
    + g
    + '<polyline points="' + line + '" class="curve-line"/>'
    + dots
    + '</svg>';

  box.querySelectorAll('.curve-point').forEach((c) => {
    c.addEventListener('click', () => {
      const p = S.curvePts[Number(c.dataset.i)];
      selectFrame(p.png, p.dist, p.id, p.note, rowParams(p));
    });
  });
}

function renderFilmstrip() {
  const box = $('filmstrip');
  const d = S.data || {};
  const shots = Array.isArray(d.shots) ? d.shots : [];
  const scrollLeft = box.scrollLeft;
  if (!shots.length) { box.innerHTML = '<div class="empty">没有截图帧（shots/ 为空）</div>'; return; }
  const selN = normalize(S.selectedPng || '');
  let html = '';
  for (const s of shots) {
    const n = normalize(s);
    const hit = S.byPng.get(n);
    const active = n === selN ? ' active' : '';
    html += '<button type="button" class="thumb' + active + '" data-png="' + escAttr(s) + '" title="' + escAttr(basename(s) + (hit && hit.dist != null ? ' · d=' + fmt(hit.dist) : '')) + '">'
      + '<img loading="lazy" src="' + escAttr(runUrl(s)) + '" alt="' + escAttr(basename(s)) + '"></button>';
  }
  box.innerHTML = html;
  box.scrollLeft = scrollLeft;
  box.querySelectorAll('.thumb').forEach((b) => {
    b.addEventListener('click', () => {
      const p = b.dataset.png;
      const hit = S.byPng.get(normalize(p));
      selectFrame(p, hit ? hit.dist : null, hit ? hit.id : null, hit ? hit.note : null, hit ? rowParams(hit) : {});
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
  if (n.cost != null) { let cs; try { cs = JSON.stringify(n.cost); } catch (e) { cs = String(n.cost); } parts.push(row('cost', '<span class="mono">' + esc(cs) + '</span>')); }
  if (!parts.length) return '<div class="d-row muted">无额外信息</div>';
  return parts.join('');
}

function renderLedger() {
  const box = $('ledger');
  const d = S.data || {};
  const nodes = Array.isArray(d.nodes) ? d.nodes : [];
  if (!nodes.length) { box.innerHTML = '<div class="empty">这个 run 没有台帐（0.5.0 之前的版本）</div>'; return; }
  const counts = { done: 0, degraded: 0, skipped: 0, failed: 0 };
  nodes.forEach((n) => { const st = n.status || ''; if (st in counts) counts[st]++; });
  const sorted = nodes.slice().sort((a, b) => (a.seq != null ? a.seq : 0) - (b.seq != null ? b.seq : 0));
  let html = '<div class="ledger-sum"><span class="st done">' + counts.done + ' done</span><span class="st degraded">' + counts.degraded + ' degraded</span><span class="st skipped">' + counts.skipped + ' skipped</span><span class="st failed">' + counts.failed + ' failed</span></div><ol class="ledger-list">';
  for (const n of sorted) {
    const st = n.status || 'other';
    const name = n.node || n.name || stripJsonExt(n.file);
    const ms = n.ms != null ? fmt(n.ms) + 'ms' : '';
    html += '<li class="node st-' + escAttr(st) + '"><button type="button" class="node-head"><span class="node-dot"></span><span class="node-name mono">' + esc(name) + '</span><span class="node-producer">' + esc(n.producer || '') + '</span><span class="node-ms mono">' + esc(ms) + '</span></button><div class="node-body" hidden>' + nodeDetail(n) + '</div></li>';
  }
  html += '</ol>';
  box.innerHTML = html;
  box.querySelectorAll('.node-head').forEach((h) => {
    h.addEventListener('click', () => {
      const b = h.nextElementSibling;
      b.hidden = !b.hidden;
      h.classList.toggle('open', !b.hidden);
    });
  });
}

function renderReportLive() {
  const d = S.data || {};
  $('report-pre').textContent = d.report || '（无 report.md）';
  const live = Array.isArray(d.live) ? d.live : [];
  const lb = $('live-box');
  if (!live.length) { lb.innerHTML = '<div class="empty">无 live.jsonl</div>'; return; }
  const items = live.slice().reverse().map((ev) => {
    let str; try { str = JSON.stringify(ev); } catch (e) { str = String(ev); }
    const short = str.length > 240 ? str.slice(0, 240) + '…' : str;
    return '<div class="live-item mono" title="' + escAttr(str) + '">' + esc(short) + '</div>';
  }).join('');
  lb.innerHTML = '<div class="live-count mono">' + live.length + ' 条 · 最新在上</div>' + items;
}

function renderTechDetails() {
  const d = S.data || {};
  $('tech-kpi').innerHTML = techKpiHtml(d);
  renderCurve();
  renderFilmstrip();
  renderLedger();
  renderReportLive();
}

function derive() {
  const d = S.data || {};
  const rows = Array.isArray(d.curve) ? d.curve : [];
  S.byPng = new Map();
  for (const r of rows) { const png = normalize(r && r.png); if (png) S.byPng.set(png, r); }
}

function renderInit() {
  const root = $('input-root');
  const dir = (S.data && S.data.run && S.data.run.dir) || '';
  root.innerHTML = '<div class="i-card" style="grid-column:1/-1">'
    + '<div class="i-label">这个目录还没有项目</div>'
    + '<div class="need-sub mono">' + esc(dir) + '</div>'
    + '<div class="need-actions"><button type="button" class="btn btn-primary" id="init-btn">新建项目</button>'
    + '<span class="need-hint">会建 refs/ rounds/ shots/ 和一份 project.json 骨架</span></div></div>';
  const b = $('init-btn');
  if (b) b.addEventListener('click', async () => {
    try {
      const r = await fetch('/api/init', { method: 'POST' });
      const j = await r.json();
      renderToast(j.ok ? '项目已建好，填需求吧' : ('建不了：' + (j.error || '')));
      poll();
    } catch (e) { renderToast('建不了：' + (e && e.message ? e.message : e)); }
  });
  for (const id of ['understand-root', 'rounds-root', 'deliver-root']) { const el = $(id); if (el) el.innerHTML = ''; }
}

function renderLog() {
  const box = $('log-box');
  if (!box) return;
  const log = Array.isArray(S.data && S.data.log) ? S.data.log : [];
  if (!log.length) { box.innerHTML = '<div class="log-empty">还没有日志（agent 开始跑之后会往里写）</div>'; return; }
  const nearBottom = box.scrollTop + box.clientHeight >= box.scrollHeight - 30;
  box.innerHTML = log.map((ev) => {
    const t = (ev && ev.at) ? String(ev.at).slice(11, 19) : '';
    const stage = (ev && ev.stage) ? String(ev.stage) : '';
    const text = (ev && ev.text != null) ? String(ev.text) : JSON.stringify(ev);
    return '<div class="log-line"><span class="log-time">' + esc(t) + '</span><span class="log-stage">' + esc(stage) + '</span><span>' + esc(text) + '</span></div>';
  }).join('');
  if (nearBottom) box.scrollTop = box.scrollHeight;
}

function renderAll() {
  renderTopbar();
  renderStepper();
  const d = S.data || {};
  if (d.exists === false) { renderInit(); renderLog(); return; }
  const hasProject = !!d.project;
  if (hasProject) {
    renderInput();
    renderUnderstand();
    renderRounds();
    renderDeliver();
  }
  renderTechDetails();
  renderLog();
}

async function poll() {
  let d;
  try { d = await fetchState(); }
  catch (e) { renderToast('连接失败：' + (e && e.message ? e.message : e)); return; }
  S.data = d;
  derive();
  renderAll();
}

function copyText(t) {
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(t || '').then(() => renderToast('已复制')).catch(() => renderToast('复制失败'));
  } else renderToast('复制失败');
}

function wireControls() {
  $('stop-btn').addEventListener('click', () => {
    const note = window.prompt('停下来的原因？（可以不写）') || '';
    decide('stop', { note });
  });
  $('copy-btn').addEventListener('click', () => copyText((S.data && S.data.report) || ''));
  $('lightbox').addEventListener('click', () => closeLightbox());
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeLightbox(); });
}

wireControls();
poll();
setInterval(poll, 2000);


// 2026-11-18 可靠性自检：停摆与最近错误的渲染（查看器用）
function stallHtml(st) {
  const s = (st && st.stageStall) || {};
  const err = st && st.lastError;
  let out = '';
  if (s.stuck) {
    const idle = Math.max(0, Math.round(Number(s.idleMs || 0) / 60000));
    const lim = Number.isFinite(Number(s.limitMs)) ? Math.round(Number(s.limitMs) / 60000) : null;
    out += '<div class="u-warn">⛔ 卡在 ' + (s.stage || '') + ' ' + idle + ' 分钟' + (lim !== null ? '（阈值 ' + lim + '）' : '') + '</div>';
  }
  if (err && err.message) out += '<div class="u-warn">✖ ' + (err.stage || '') + '：' + String(err.message).slice(0, 160) + '</div>';
  return out;
}

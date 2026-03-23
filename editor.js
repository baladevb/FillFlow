/* editor.js — FillFlow */
'use strict';

let steps           = [];
let currentType     = 'type';
let currentFocusOpt = 'capture';
let ffOption        = 'A';
let ffSelector      = '';
let editingId       = null;
let isCompact       = false;

/* ── Column index → Excel-style letter (0=A, 25=Z, 26=AA …) */
function colIndexToLetter(idx) {
  let s = '', n = idx + 1;
  while (n > 0) { n--; s = String.fromCharCode(65 + (n % 26)) + s; n = Math.floor(n / 26); }
  return s;
}

/* ── Step numbering helpers ──────────────────────────────── */
/* Returns array of { step, displayNum, flatIndex }.
   Separators have displayNum = null. */
function stepsWithNumbers() {
  let num = 0;
  return steps.map((step, idx) => {
    if (step.type === 'separator') return { step, displayNum: null, flatIndex: idx };
    num++;
    return { step, displayNum: num, flatIndex: idx };
  });
}

/* Jump-to options for skip step — all non-separator steps except self */
function buildJumpToOptions(excludeIdx) {
  return stepsWithNumbers()
    .filter(e => e.step.type !== 'separator' && e.flatIndex !== excludeIdx)
    .map(e => ({ label: `Step ${e.displayNum} — ${stepLabel(e.step)}`, flatIndex: e.flatIndex }));
}

/* ── Badge maps ──────────────────────────────────────────── */
const BADGE_CLASS = {
  type:        'b-type',
  text:        'b-text',
  key:         'b-key',
  wait:        'b-wait',
  waitforclick:'b-click',
  waituntil:   'b-waituntil',
  skip:        'b-skip',
  focusfield:  'b-focusfield'
};
const BADGE_LABEL = {
  type:        'Type',
  text:        'Text',
  key:         'Key',
  wait:        'Wait',
  waitforclick:'Click',
  waituntil:   'Ready',
  skip:        'Skip',
  focusfield:  'Focus'
};

/* ── Init ────────────────────────────────────────────────── */
document.addEventListener('DOMContentLoaded', async () => {

  document.getElementById('close-btn').addEventListener('click', () => window.close());
  document.getElementById('export-btn').addEventListener('click', exportCurrentFlow);

  /* View toggle */
  document.getElementById('vt-normal').addEventListener('click',  () => setView('normal'));
  document.getElementById('vt-compact').addEventListener('click', () => setView('compact'));

  /* Key combo preview */
  /* Keys the browser owns — dispatchEvent cannot simulate these */
  /* Keys the browser intercepts before page scripts can see them.
     FillFlow can still dispatch these events but they may not trigger
     browser-level actions (page reload, close tab, etc.). */
  const BROWSER_OWNED_KEYS = new Set([
    'F5', 'F11', 'F12',
    'Ctrl+w', 'Ctrl+t', 'Ctrl+n', 'Ctrl+r', 'Ctrl+l',
    'Ctrl+W', 'Ctrl+T', 'Ctrl+N', 'Ctrl+R', 'Ctrl+L'
  ]);

  function updateKeyPreview() {
    const mods = [];
    if (document.getElementById('mod-ctrl').checked)  mods.push('Ctrl');
    if (document.getElementById('mod-shift').checked) mods.push('Shift');
    if (document.getElementById('mod-alt').checked)   mods.push('Alt');
    const key   = document.getElementById('key-select').value;
    const combo = [...mods, key].join('+');
    document.getElementById('key-preview').textContent = combo;
    /* Use the Set — warn if this combo is browser-owned */
    const isBrowserKey = BROWSER_OWNED_KEYS.has(combo) ||
      (mods.length === 0 && BROWSER_OWNED_KEYS.has(key));
    document.getElementById('browser-key-warn').classList.toggle('hidden', !isBrowserKey);
  }
  document.getElementById('key-select').addEventListener('change', updateKeyPreview);
  document.getElementById('mod-shift').addEventListener('change',  updateKeyPreview);
  document.getElementById('mod-ctrl').addEventListener('change',   updateKeyPreview);
  document.getElementById('mod-alt').addEventListener('change',    updateKeyPreview);

  /* Step type tabs */
  document.getElementById('type-tabs').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-type]');
    if (!btn) return;
    document.querySelectorAll('.type-tab').forEach(t => t.classList.remove('active'));
    btn.classList.add('active');
    currentType = btn.dataset.type;
    ['type','text','key','wait','waitforclick','waituntil','skip','focusfield'].forEach(t => {
      document.getElementById('opts-' + t).classList.toggle('hidden', t !== currentType);
    });
    if (currentType === 'skip') populateJumpToSelect();
  });

  /* Column number badges */
  document.getElementById('col-number').addEventListener('input', () => {
    const n = parseInt(document.getElementById('col-number').value, 10);
    document.getElementById('col-letter-badge').textContent = n >= 1 ? 'Col ' + colIndexToLetter(n - 1) : '';
  });
  document.getElementById('skip-col-number').addEventListener('input', () => {
    const n = parseInt(document.getElementById('skip-col-number').value, 10);
    document.getElementById('skip-col-badge').textContent = n >= 1 ? 'Col ' + colIndexToLetter(n - 1) : '';
  });

  /* Skip operator — hide value input for empty/notempty */
  document.getElementById('skip-operator').addEventListener('change', () => {
    const op = document.getElementById('skip-operator').value;
    document.getElementById('skip-value-wrap').classList.toggle('hidden', op !== 'equals');
  });

  /* Add step */
  document.getElementById('add-btn').addEventListener('click', addStep);

  /* Quick Tab / Enter buttons */
  document.getElementById('quick-tab-btn').addEventListener('click',        () => { addStep(); addKeyStep('Tab'); });
  document.getElementById('quick-enter-btn').addEventListener('click',      () => { addStep(); addKeyStep('Enter'); });
  document.getElementById('quick-tab-text-btn').addEventListener('click',   () => { addStep(); addKeyStep('Tab'); });
  document.getElementById('quick-enter-text-btn').addEventListener('click', () => { addStep(); addKeyStep('Enter'); });

  /* Focus field option tabs */
  document.getElementById('focus-opt-tabs').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-focus]');
    if (!btn) return;
    currentFocusOpt = btn.dataset.focus;
    document.querySelectorAll('.focus-tab').forEach(t => t.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById('focus-detail-capture').classList.toggle('hidden',      currentFocusOpt !== 'capture');
    document.getElementById('focus-detail-waitforclick').classList.toggle('hidden', currentFocusOpt !== 'waitforclick');
    document.getElementById('focus-saved-selector-wrap').classList.toggle('hidden', currentFocusOpt !== 'capture');
  });
  document.getElementById('clear-focus-selector-btn').addEventListener('click', () => {
    document.getElementById('focus-selector').value = '';
  });

  /* Page separator */
  document.getElementById('insert-separator-btn').addEventListener('click', insertSeparator);

  /* First field option tabs */
  document.getElementById('ff-tabs').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-opt]');
    if (!btn) return;
    setFFOption(btn.dataset.opt);
  });
  document.getElementById('ff-selector').addEventListener('input', (e) => {
    ffSelector = e.target.value.trim();
  });
  document.getElementById('clear-selector-btn').addEventListener('click', () => {
    ffSelector = '';
    document.getElementById('ff-selector').value = '';
  });

  /* WPM slider */
  document.getElementById('wpm-slider').addEventListener('input', (e) => {
    document.getElementById('wpm-val').textContent = e.target.value + ' WPM';
  });

  /* Save */
  document.getElementById('save-btn').addEventListener('click', saveLayout);

  /* Step list — move / delete via event delegation */
  document.getElementById('step-list').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-action]');
    if (!btn) return;
    const idx = parseInt(btn.dataset.idx, 10);
    if (btn.dataset.action === 'up')  moveStep(idx, -1);
    if (btn.dataset.action === 'dn')  moveStep(idx,  1);
    if (btn.dataset.action === 'del') deleteStep(idx);
  });

  /* Load layout if editing */
  const params   = new URLSearchParams(window.location.search);
  const layoutId = params.get('id');
  if (layoutId) {
    const all    = await loadAllFlows();
    const layout = all.find(l => l.id === layoutId);
    if (layout) loadLayout(layout);
  }

  /* Field captured notification from background */
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === 'BG_FIELD_CAPTURED') {
      ffSelector = msg.selector;
      document.getElementById('ff-selector').value = ffSelector;
    }
  });
});

/* ── Storage helpers ─────────────────────────────────────── */
async function loadAllFlows() {
  const data = await chrome.storage.local.get(['flows', 'layouts']);
  /* Migrate legacy 'layouts' key to 'flows' on first read */
  if (!data.flows && data.layouts) {
    await chrome.storage.local.set({ flows: data.layouts });
    await chrome.storage.local.remove('layouts');
    return data.layouts;
  }
  return data.flows || [];
}

async function saveAllFlows(all) {
  await chrome.storage.local.set({ flows: all });
}

/* ── Load existing layout into editor ────────────────────── */
function loadLayout(layout) {
  editingId = layout.id;
  document.getElementById('topbar-context').textContent = layout.name;
  document.getElementById('layout-name').value          = layout.name;
  document.getElementById('wpm-slider').value           = layout.wpm || 100;
  document.getElementById('wpm-val').textContent        = (layout.wpm || 100) + ' WPM';

  ffOption   = layout.firstFieldOption   || 'A';
  ffSelector = layout.firstFieldSelector || '';
  document.getElementById('ff-selector').value = ffSelector;
  setFFOption(ffOption);

  steps = layout.steps.map(s => ({ ...s }));
  renderSteps();
}

/* ── First field option ──────────────────────────────────── */
function setFFOption(opt) {
  ffOption = opt;
  document.querySelectorAll('.ff-tab').forEach(b =>
    b.classList.toggle('active', b.dataset.opt === opt));
  ['A','B','C'].forEach(o =>
    document.getElementById('ff-detail-' + o).classList.toggle('hidden', o !== opt));
  document.getElementById('ff-selector-wrap').classList.toggle('hidden', opt !== 'A');
}

/* ── Skip jump-to select ─────────────────────────────────── */
function populateJumpToSelect(currentIdx) {
  const sel  = document.getElementById('skip-jumpto');
  const opts = buildJumpToOptions(currentIdx);
  const prev = sel.value;
  sel.innerHTML = opts.length
    ? opts.map(o => `<option value="${o.flatIndex}">${esc(o.label)}</option>`).join('')
    : '<option value="">— add more steps first —</option>';
  if (prev && [...sel.options].some(o => o.value === prev)) sel.value = prev;
}

/* ── Add step ────────────────────────────────────────────── */
function addStep() {
  let step;
  switch (currentType) {
    case 'type': {
      const num = parseInt(document.getElementById('col-number').value, 10);
      if (!num || num < 1) { showFeedback('Enter a valid column number', false); return; }
      const label     = document.getElementById('col-label').value.trim();
      const fieldType = document.getElementById('col-field-type').value;
      const letter    = colIndexToLetter(num - 1);
      step = { type: 'type', colIndex: num - 1, label: label ? `Col ${letter} — ${label}` : `Col ${letter}`, fieldType };
      break;
    }
    case 'text': {
      const fieldType = document.getElementById('text-field-type').value;
      step = { type: 'text', value: document.getElementById('custom-text-value').value, fieldType };
      break;
    }
    case 'key': {
      const mods    = [];
      if (document.getElementById('mod-ctrl').checked)  mods.push('Ctrl');
      if (document.getElementById('mod-shift').checked) mods.push('Shift');
      if (document.getElementById('mod-alt').checked)   mods.push('Alt');
      const combo   = [...mods, document.getElementById('key-select').value].join('+');
      step = { type: 'key', key: combo };
      break;
    }
    case 'wait': {
      const sec = parseFloat(document.getElementById('wait-seconds').value);
      if (!sec || sec <= 0) { showFeedback('Enter a valid duration', false); return; }
      step = { type: 'wait', seconds: sec };
      break;
    }
    case 'waitforclick':
      step = { type: 'waitforclick' };
      break;
    case 'waituntil':
      step = {
        type:         'waituntil',
        retrySeconds: parseFloat(document.getElementById('waituntil-retry').value) || 2,
        maxRetries:   parseInt(document.getElementById('waituntil-max').value, 10)  || 10
      };
      break;
    case 'focusfield':
      step = {
        type:        'focusfield',
        focusOption: currentFocusOpt,
        selector:    document.getElementById('focus-selector').value.trim() || ''
      };
      break;
    case 'skip': {
      const colNum = parseInt(document.getElementById('skip-col-number').value, 10);
      if (!colNum || colNum < 1) { showFeedback('Enter a valid column number', false); return; }
      const jumpVal = document.getElementById('skip-jumpto').value;
      if (jumpVal === '' || jumpVal === 'null') { showFeedback('Select a step to jump to', false); return; }
      step = {
        type:         'skip',
        colIndex:     colNum - 1,
        operator:     document.getElementById('skip-operator').value,
        compareValue: document.getElementById('skip-value').value.trim(),
        behaviour:    document.getElementById('skip-behaviour').value,
        jumpToIndex:  parseInt(jumpVal, 10)
      };
      break;
    }
  }
  if (step) { steps.push(step); renderSteps(); flashAdd(); }
}

function addKeyStep(key) {
  steps.push({ type: 'key', key });
  renderSteps();
}

function insertSeparator() {
  const skipNavCheck = document.getElementById('sep-skip-nav-check').checked;
  steps.push({ type: 'separator', skipNavCheck });
  renderSteps();
  showFeedback('Page separator added', true);
}

/* ── Move / delete ───────────────────────────────────────── */
function moveStep(idx, dir) {
  const n = idx + dir;
  if (n < 0 || n >= steps.length) return;
  [steps[idx], steps[n]] = [steps[n], steps[idx]];
  /* Keep skip jumpToIndex consistent across swaps */
  steps.forEach(s => {
    if (s.type !== 'skip') return;
    if (s.jumpToIndex === idx)      s.jumpToIndex = n;
    else if (s.jumpToIndex === n)   s.jumpToIndex = idx;
  });
  renderSteps();
}

function deleteStep(idx) {
  steps.splice(idx, 1);
  /* Adjust skip targets pointing at or past the deleted index */
  steps.forEach(s => {
    if (s.type !== 'skip') return;
    if (s.jumpToIndex === idx)      s.jumpToIndex = null;  /* target deleted — invalidate */
    else if (s.jumpToIndex > idx)   s.jumpToIndex--;
  });
  renderSteps();
}

/* ── Render step list ────────────────────────────────────── */
function renderSteps() {
  const list    = document.getElementById('step-list');
  const empty   = document.getElementById('empty-steps');
  const countEl = document.getElementById('step-count');

  const realCount = steps.filter(s => s.type !== 'separator').length;
  countEl.textContent = realCount + (realCount === 1 ? ' step' : ' steps');

  if (!steps.length) { empty.classList.remove('hidden'); list.innerHTML = ''; return; }
  empty.classList.add('hidden');
  list.innerHTML = '';

  let pageNum = 1;
  let stepNum = 0;

  steps.forEach((step, idx) => {
    if (step.type === 'separator') {
      const div = document.createElement('div');
      div.className = 'separator-row';
      const skipLabel = step.skipNavCheck
        ? '<span class="sep-skip-badge">skip nav check</span>'
        : '';
      div.innerHTML = `
        <div class="separator-line"></div>
        <div class="separator-label">
          <span class="separator-badge">Page ${pageNum} ↓ Page ${pageNum + 1}</span>
          ${skipLabel}
          <button class="sact del sep-del" data-action="del" data-idx="${idx}" title="Remove separator">✕</button>
        </div>
        <div class="separator-line"></div>
      `;
      list.appendChild(div);
      pageNum++;
      return;
    }

    stepNum++;
    const row = document.createElement('div');
    row.className = 'step-row' + (isCompact ? ' compact' : '');
    const val = stepLabel(step);
    row.innerHTML = `
      <span class="drag-handle">⣿</span>
      <span class="step-n">${stepNum}</span>
      <span class="step-badge ${BADGE_CLASS[step.type] || 'b-type'}">${BADGE_LABEL[step.type] || step.type}</span>
      <span class="step-val" title="${esc(val)}">${esc(val)}</span>
      <div class="step-acts">
        <button class="sact" data-action="up"  data-idx="${idx}" title="Move up">↑</button>
        <button class="sact" data-action="dn"  data-idx="${idx}" title="Move down">↓</button>
        <button class="sact del" data-action="del" data-idx="${idx}" title="Delete">✕</button>
      </div>
    `;
    list.appendChild(row);
  });

  if (currentType === 'skip') populateJumpToSelect();
}

/* ── Step label (pure function — no DOM reads) ───────────── */
function stepLabel(step) {
  switch (step.type) {
    case 'type': {
      const badge = step.fieldType && step.fieldType !== 'auto' ? ` [${step.fieldType}]` : '';
      return (step.label || `Col ${colIndexToLetter(step.colIndex)}`) + badge;
    }
    case 'text':         return `"${step.value || ''}"`;
    case 'key':          return step.key;
    case 'wait':         return step.seconds + 's';
    case 'waitforclick': return 'Wait for click';
    case 'waituntil':    return `Ready? every ${step.retrySeconds}s × ${step.maxRetries}`;
    case 'focusfield':   return step.focusOption === 'waitforclick'
      ? 'Wait for click to focus'
      : step.selector ? `Captured: ${step.selector}` : 'Capture field (first run)';
    case 'skip': {
      const col    = `Col ${colIndexToLetter(step.colIndex)}`;
      const op     = step.operator === 'equals'   ? `= "${step.compareValue}"` :
                     step.operator === 'empty'    ? 'is empty' : 'is not empty';
      const when   = step.behaviour === 'skip-if-met' ? 'if' : 'unless';
      const target = step.jumpToIndex != null
        ? stepsWithNumbers().find(e => e.flatIndex === step.jumpToIndex)
        : null;
      const toNum  = target ? `step ${target.displayNum}` : '⚠ invalid';
      return `${col} ${op} → ${when} met → ${toNum}`;
    }
    case 'separator':    return step.skipNavCheck ? 'Page separator (skip nav check)' : 'Page separator';
    default:             return step.type || '?';
  }
}

/* ── View toggle ─────────────────────────────────────────── */
function setView(mode) {
  isCompact = mode === 'compact';
  document.getElementById('vt-normal').classList.toggle('active',  !isCompact);
  document.getElementById('vt-compact').classList.toggle('active', isCompact);
  renderSteps();
}

/* ── Save layout ─────────────────────────────────────────── */
async function saveLayout() {
  const name = document.getElementById('layout-name').value.trim();
  if (!name) { showFeedback('Enter a flow name', false); return; }
  if (!steps.filter(s => s.type !== 'separator').length) {
    showFeedback('Add at least one step', false); return;
  }

  /* Strip runtime-only annotations before saving */
  const cleanSteps = steps.map(s => {
    const clean = { ...s };
    delete clean._flatIndex;
    delete clean._flowId;
    return clean;
  });

  const layout = {
    id:                 editingId || generateId(),
    name,
    wpm:                parseInt(document.getElementById('wpm-slider').value, 10),
    firstFieldOption:   ffOption,
    firstFieldSelector: ffOption === 'A' ? (document.getElementById('ff-selector').value.trim() || '') : '',
    steps:              cleanSteps,
    updatedAt:          Date.now()
  };

  const all = await loadAllFlows();
  const idx = all.findIndex(l => l.id === layout.id);
  if (idx >= 0) all[idx] = layout; else all.push(layout);
  await saveAllFlows(all);

  editingId = layout.id;
  document.getElementById('topbar-context').textContent = layout.name;
  showFeedback('Flow saved — ' + layout.name, true);
}

/* ── Export current flow ─────────────────────────────────── */
async function exportCurrentFlow() {
  if (!editingId) { showFeedback('Save the flow first before exporting', false); return; }
  const all  = await loadAllFlows();
  const flow = all.find(f => f.id === editingId);
  if (!flow) { showFeedback('Flow not found — save first', false); return; }
  const blob = new Blob([JSON.stringify(flow, null, 2)], { type: 'application/json' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = flow.name.replace(/[^a-z0-9_\- ]/gi, '_') + '.fillflow.json';
  a.click();
  URL.revokeObjectURL(url);
}

/* ── Feedback / flash ────────────────────────────────────── */
function showFeedback(msg, ok) {
  const el = document.getElementById('save-feedback');
  el.textContent = (ok ? '✓ ' : '⚠ ') + msg;
  el.className   = 'save-feedback ' + (ok ? 'ok' : 'err');
  el.classList.remove('hidden');
  setTimeout(() => el.classList.add('hidden'), 3000);
}

function flashAdd() {
  const btn = document.getElementById('add-btn');
  btn.textContent = '✓ Added';
  btn.style.background = '#1a6e3a';
  setTimeout(() => { btn.textContent = '+ Add step'; btn.style.background = ''; }, 700);
}

/* ── Helpers ─────────────────────────────────────────────── */
function generateId() {
  return 'flow_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7);
}
function esc(str) {
  return String(str)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;')
    .replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

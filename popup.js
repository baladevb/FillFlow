/* popup.js — FillFlow */
'use strict';

let selectedFlowId  = null;
let parsedRows      = [];
let allFlows        = [];
let isCapturing     = false;
let previewRowIndex = 0;

const PREVIEW_INLINE_MAX = 5;

/* ── Storage helpers ─────────────────────────────────────── */
async function loadAllFlows() {
  const data = await chrome.storage.local.get(['flows', 'layouts']);
  /* One-time migration from legacy 'layouts' key */
  if (!data.flows && data.layouts) {
    await chrome.storage.local.set({ flows: data.layouts });
    await chrome.storage.local.remove('layouts');
    return data.layouts;
  }
  return data.flows || [];
}

async function saveAllFlows(flows) {
  await chrome.storage.local.set({ flows });
}

/* ── Init ────────────────────────────────────────────────── */
document.addEventListener('DOMContentLoaded', async () => {

  const { runState } = await chrome.storage.local.get('runState');
  if (runState && ['running', 'paused', 'starting'].includes(runState.status)) {
    /* Only show running view if the run is on the currently active tab */
    const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!activeTab || runState.tabId === activeTab.id) {
      showRunningView(runState);
      return;
    }
  }
  /* Do NOT remove runState here — side panel may still be reading it */

  document.getElementById('tab-run').addEventListener('click',   () => switchTab('run'));
  document.getElementById('tab-flows').addEventListener('click', () => switchTab('flows'));
  document.getElementById('run-btn').addEventListener('click',       handleRun);
  document.getElementById('dry-run-btn').addEventListener('click',   handleDryRun);
  document.getElementById('new-flow-btn').addEventListener('click',  () => openEditor());
  document.getElementById('capture-btn').addEventListener('click',   startCapture);
  document.getElementById('capture-clear').addEventListener('click', clearCapture);
  document.getElementById('import-flow-btn').addEventListener('click', () => {
    document.getElementById('import-file-input').click();
  });
  document.getElementById('import-file-input').addEventListener('change', handleImport);

  document.getElementById('preview-all-btn').addEventListener('click',   openPreviewOverlay);
  document.getElementById('preview-close-btn').addEventListener('click', closePreviewOverlay);
  document.getElementById('prev-row-btn').addEventListener('click', () => navigatePreview(-1));
  document.getElementById('next-row-btn').addEventListener('click', () => navigatePreview(+1));

  /* Show version from manifest */
  const manifest = chrome.runtime.getManifest();
  const vEl = document.getElementById('app-version');
  if (vEl) vEl.textContent = 'v' + manifest.version;

  /* RC toggle */
  const { rcUnlock } = await chrome.storage.local.get('rcUnlock');
  setToggle(!!rcUnlock);
  document.getElementById('rc-toggle').addEventListener('click', async () => {
    const next = !document.getElementById('rc-toggle').classList.contains('on');
    setToggle(next);
    await chrome.storage.local.set({ rcUnlock: next });
  });

  /* Paste area */
  const pa = document.getElementById('paste-area');
  pa.addEventListener('input', onPaste);
  pa.addEventListener('paste', () => setTimeout(onPaste, 50));

  /* Flow manage list — event delegation */
  document.getElementById('saved-list').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-action]');
    if (!btn) return;
    const id = btn.dataset.id;
    if (btn.dataset.action === 'edit')   openEditor(id);
    if (btn.dataset.action === 'del')    deleteFlow(id);
    if (btn.dataset.action === 'export') exportFlow(id);
  });

  allFlows = await loadAllFlows();
  renderRunList();

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === 'BG_FIELD_CAPTURED') {
      loadAllFlows().then(flows => { allFlows = flows; updateCaptureSection(); });
    }
  });

  const { captureState } = await chrome.storage.local.get('captureState');
  if (captureState?.active && !captureState?.midRun) {
    isCapturing = true;
    setCaptureListening(true);
  }
});

/* ── Running view ────────────────────────────────────────── */
function showRunningView(rs) {
  document.getElementById('normal-view').classList.add('hidden');
  document.getElementById('running-view').classList.remove('hidden');
  document.getElementById('running-text').textContent =
    rs.status === 'paused'
      ? `Paused at row ${rs.current} of ${rs.total}`
      : `Running row ${rs.current || 0} of ${rs.total}…`;
}

/* ── RC toggle ───────────────────────────────────────────── */
function setToggle(val) {
  document.getElementById('rc-toggle').classList.toggle('on', val);
}

/* ── Tabs ────────────────────────────────────────────────── */
function switchTab(name) {
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.panel').forEach(p => p.classList.add('hidden'));
  document.getElementById('tab-' + name).classList.add('active');
  document.getElementById('panel-' + name).classList.remove('hidden');
  if (name === 'flows') renderManageList();
}

/* ── Paste parser ────────────────────────────────────────── */
function onPaste() {
  const raw = document.getElementById('paste-area').value.trim();
  if (!raw) {
    parsedRows = [];
    document.getElementById('paste-info').classList.add('hidden');
    renderInlinePreview();
    checkReady(); return;
  }
  parsedRows = raw.split('\n')
    .map(l => l.split('\t').map(c => c.trim()))
    .filter(r => r.some(c => c !== ''));
  const cols = parsedRows.length > 0 ? Math.max(...parsedRows.map(r => r.length)) : 0;
  const info = document.getElementById('paste-info');
  info.textContent = `${parsedRows.length} row${parsedRows.length !== 1 ? 's' : ''} · ${cols} column${cols !== 1 ? 's' : ''}`;
  info.classList.remove('hidden');
  validateColumns();
  renderInlinePreview();
  checkReady();
}

/* ── Run list ────────────────────────────────────────────── */
function renderRunList() {
  const noMsg = document.getElementById('no-flows-msg');
  const list  = document.getElementById('flow-list');
  if (!allFlows.length) {
    noMsg.classList.remove('hidden');
    list.classList.add('hidden');
    checkReady(); return;
  }
  noMsg.classList.add('hidden');
  list.classList.remove('hidden');
  list.innerHTML = '';
  allFlows.forEach(flow => {
    /* Count only real executable steps, not separators */
    const stepCount = (flow.steps || []).filter(s => s.type !== 'separator').length;
    const el = document.createElement('div');
    el.className = 'layout-item' + (flow.id === selectedFlowId ? ' selected' : '');
    el.dataset.id = flow.id;
    el.innerHTML = `
      <div class="layout-dot"></div>
      <span class="layout-item-name">${esc(flow.name)}</span>
      <span class="layout-item-meta">${stepCount} steps · ${flow.wpm || 100} WPM</span>
    `;
    el.addEventListener('click', () => selectFlow(flow.id));
    list.appendChild(el);
  });
  checkReady();
}

function selectFlow(id) {
  selectedFlowId  = id;
  previewRowIndex = 0;
  document.querySelectorAll('.layout-item').forEach(el =>
    el.classList.toggle('selected', el.dataset.id === id));
  updateCaptureSection();
  validateColumns();
  renderInlinePreview();
  checkReady();
}

/* ── Inline preview ──────────────────────────────────────── */
function getTypeSteps(flow) {
  return (flow?.steps || []).filter(s => s.type === 'type');
}

function renderInlinePreview() {
  const section = document.getElementById('preview-section');
  const wrap    = document.getElementById('preview-table-wrap');
  const flow    = allFlows.find(f => f.id === selectedFlowId);

  if (!flow || !parsedRows.length) {
    section.classList.add('hidden');
    wrap.innerHTML = '';
    return;
  }

  const typeSteps = getTypeSteps(flow);
  if (!typeSteps.length) { section.classList.add('hidden'); return; }

  const firstRow  = parsedRows[0];
  const shown     = typeSteps.slice(0, PREVIEW_INLINE_MAX);
  const remaining = typeSteps.length - shown.length;

  const rows = shown.map(s => {
    const val = (firstRow[s.colIndex] != null) ? firstRow[s.colIndex] : '—';
    return `<tr>
      <td class="prev-step">${esc(s.label || `Col ${s.colIndex + 1}`)}</td>
      <td class="prev-val">${esc(val)}</td>
    </tr>`;
  }).join('');

  const moreRow = remaining > 0
    ? `<tr><td colspan="2" class="prev-more">+ ${remaining} more — click "See all rows"</td></tr>`
    : '';

  wrap.innerHTML = `<table class="preview-table"><tbody>${rows}${moreRow}</tbody></table>`;
  section.classList.remove('hidden');
  document.getElementById('preview-all-btn').classList.remove('hidden');
}

/* ── Full preview overlay ────────────────────────────────── */
function openPreviewOverlay() {
  const flow = allFlows.find(f => f.id === selectedFlowId);
  if (!flow || !parsedRows.length) return;
  previewRowIndex = 0;
  renderOverlayRow(flow);
  document.getElementById('preview-overlay').classList.remove('hidden');
}

function closePreviewOverlay() {
  document.getElementById('preview-overlay').classList.add('hidden');
}

function navigatePreview(dir) {
  const flow = allFlows.find(f => f.id === selectedFlowId);
  if (!flow) return;
  previewRowIndex = Math.max(0, Math.min(parsedRows.length - 1, previewRowIndex + dir));
  renderOverlayRow(flow);
}

function renderOverlayRow(flow) {
  const row   = parsedRows[previewRowIndex];
  const total = parsedRows.length;
  const idx   = previewRowIndex;

  document.getElementById('preview-overlay-title').textContent = esc(flow.name);
  document.getElementById('preview-row-label').textContent     = `Row ${idx + 1} of ${total}`;
  document.getElementById('prev-row-btn').disabled = idx === 0;
  document.getElementById('next-row-btn').disabled = idx === total - 1;

  /* Show all steps, skip separators, use correct step numbering */
  let stepNum  = 0;
  const bodyRows = (flow.steps || [])
    .filter(s => s.type !== 'separator')
    .map(s => {
      stepNum++;
      let desc, valCell;
      if (s.type === 'type') {
        const val = (row && row[s.colIndex] != null) ? row[s.colIndex] : '—';
        desc    = esc(s.label || `Col ${s.colIndex + 1}`);
        valCell = `<td class="prev-val">${esc(val)}</td>`;
      } else if (s.type === 'text') {
        desc    = 'Custom text';
        valCell = `<td class="prev-val prev-fixed">${esc(s.value || '')}</td>`;
      } else if (s.type === 'key') {
        desc    = 'Key';
        valCell = `<td class="prev-val prev-key">${esc(s.key)}</td>`;
      } else if (s.type === 'wait') {
        desc    = 'Wait';
        valCell = `<td class="prev-val prev-dim">${s.seconds}s</td>`;
      } else if (s.type === 'focusfield') {
        desc    = 'Focus field';
        valCell = `<td class="prev-val prev-dim">${s.focusOption === 'waitforclick' ? 'click to focus' : s.selector || 'capture'}</td>`;
      } else if (s.type === 'skip') {
        desc    = 'Skip';
        valCell = `<td class="prev-val prev-dim">condition</td>`;
      } else if (s.type === 'waituntil') {
        desc    = 'Wait until ready';
        valCell = `<td class="prev-val prev-dim">page ready</td>`;
      } else {
        desc    = s.type;
        valCell = `<td class="prev-val prev-dim">—</td>`;
      }
      return `<tr>
        <td class="prev-num">${stepNum}</td>
        <td class="prev-step">${desc}</td>
        ${valCell}
      </tr>`;
    }).join('');

  document.getElementById('preview-overlay-body').innerHTML =
    `<table class="preview-table preview-full"><tbody>${bodyRows}</tbody></table>`;
}

/* ── Capture ─────────────────────────────────────────────── */
function updateCaptureSection() {
  const flow    = allFlows.find(f => f.id === selectedFlowId);
  const section = document.getElementById('capture-section');
  if (!flow || flow.firstFieldOption !== 'A') { section.classList.add('hidden'); return; }
  section.classList.remove('hidden');
  const has = !!flow.firstFieldSelector;
  document.getElementById('capture-dot').className    = 'capture-dot' + (has ? ' captured' : '');
  document.getElementById('capture-text').textContent = has ? flow.firstFieldSelector : 'No field captured yet';
  document.getElementById('capture-hint').textContent = has
    ? 'Field captured — click "Capture field" to recapture'
    : 'Click "Capture field" then click the first input on the form';
  document.getElementById('capture-clear').classList.toggle('hidden', !has);
}

async function startCapture() {
  if (isCapturing) {
    isCapturing = false;
    await chrome.runtime.sendMessage({ type: 'POPUP_CAPTURE_CANCEL' });
    setCaptureListening(false);
    updateCaptureSection();
    return;
  }
  if (!selectedFlowId) return;
  isCapturing = true;
  setCaptureListening(true);
  await chrome.runtime.sendMessage({ type: 'POPUP_CAPTURE_START', flowId: selectedFlowId });
}

function setCaptureListening(active) {
  const btn = document.getElementById('capture-btn');
  btn.textContent = active ? '✕  Cancel capture' : '◎  Capture field';
  btn.classList.toggle('listening', active);
  if (active) {
    document.getElementById('capture-dot').className    = 'capture-dot listening';
    document.getElementById('capture-text').textContent = 'Listening — click the first field…';
    document.getElementById('capture-hint').textContent = 'Switch to the form tab and click the target field';
  }
}

async function clearCapture() {
  if (!selectedFlowId) return;
  allFlows = allFlows.map(f =>
    f.id === selectedFlowId ? { ...f, firstFieldSelector: '' } : f);
  await saveAllFlows(allFlows);
  updateCaptureSection();
  checkReady();
}

/* ── Flows tab — manage list ─────────────────────────────── */
function renderManageList() {
  const el = document.getElementById('saved-list');
  if (!allFlows.length) {
    el.innerHTML = '<div class="no-flows-msg">No saved flows yet</div>'; return;
  }
  el.innerHTML = '';
  allFlows.forEach(f => {
    const stepCount = (f.steps || []).filter(s => s.type !== 'separator').length;
    const item = document.createElement('div');
    item.className = 'manage-item';
    item.innerHTML = `
      <span class="manage-item-name">${esc(f.name)}</span>
      <span class="manage-item-meta">${stepCount} steps</span>
      <button class="icon-btn"     data-action="export" data-id="${f.id}" title="Export JSON">↓</button>
      <button class="icon-btn"     data-action="edit"   data-id="${f.id}" title="Edit">✎</button>
      <button class="icon-btn del" data-action="del"    data-id="${f.id}" title="Delete">✕</button>
    `;
    el.appendChild(item);
  });
}

function openEditor(id) {
  const url = chrome.runtime.getURL('editor.html') + (id ? '?id=' + id : '');
  chrome.tabs.create({ url });
  window.close();
}

async function deleteFlow(id) {
  if (!confirm('Delete this flow? This cannot be undone.')) return;
  allFlows = allFlows.filter(f => f.id !== id);
  if (selectedFlowId === id) {
    selectedFlowId = null;
    document.getElementById('capture-section').classList.add('hidden');
    document.getElementById('preview-section').classList.add('hidden');
  }
  await saveAllFlows(allFlows);
  renderRunList();
  renderManageList();
}

function exportFlow(id) {
  const flow = allFlows.find(f => f.id === id);
  if (!flow) return;
  const blob = new Blob([JSON.stringify(flow, null, 2)], { type: 'application/json' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = flow.name.replace(/[^a-z0-9_\- ]/gi, '_') + '.fillflow.json';
  a.click();
  URL.revokeObjectURL(url);
}

async function handleImport(e) {
  const file = e.target.files[0];
  if (!file) return;
  e.target.value = '';
  let imported;
  try { imported = JSON.parse(await file.text()); }
  catch { alert('Invalid file — could not parse JSON.'); return; }
  const list  = Array.isArray(imported) ? imported : [imported];
  let added = 0;
  for (const f of list) {
    if (!f.name || !Array.isArray(f.steps)) continue;
    allFlows.push({ ...f, id: 'flow_' + Date.now() + '_' + added + '_' + Math.random().toString(36).slice(2, 5) });
    added++;
  }
  if (!added) { alert('No valid flows found in file.'); return; }
  await saveAllFlows(allFlows);
  renderRunList();
  renderManageList();
  showToast(`Imported ${added} flow${added !== 1 ? 's' : ''}`);
}

/* ── Column validation ───────────────────────────────────── */
function validateColumns() {
  const warn = document.getElementById('col-warning');
  warn.classList.add('hidden');
  if (!selectedFlowId || !parsedRows.length) return;
  const flow      = allFlows.find(f => f.id === selectedFlowId);
  const typeSteps = (flow?.steps || []).filter(s => s.type === 'type');
  if (!typeSteps.length) return;
  const maxNeeded  = Math.max(...typeSteps.map(s => s.colIndex)) + 1;
  /* Guard against empty parsedRows causing Math.min to return Infinity */
  const actualCols = parsedRows.length > 0
    ? Math.min(...parsedRows.map(r => r.length))
    : 0;
  if (maxNeeded > actualCols) {
    warn.textContent = `Flow needs column ${maxNeeded} but your data only has ${actualCols} column(s).`;
    warn.classList.remove('hidden');
  }
}

/* ── Run readiness ───────────────────────────────────────── */
function checkReady() {
  const warn         = document.getElementById('col-warning');
  const flow         = allFlows.find(f => f.id === selectedFlowId);
  const needsCapture = flow?.firstFieldOption === 'A' && !flow?.firstFieldSelector;
  const ready = parsedRows.length > 0
    && !!selectedFlowId
    && warn.classList.contains('hidden')
    && !needsCapture;
  document.getElementById('run-btn').disabled     = !ready;
  document.getElementById('dry-run-btn').disabled = !ready;
}

/* ── Run ─────────────────────────────────────────────────── */
async function handleRun()    { await startRun(false); }
async function handleDryRun() { await startRun(true);  }

async function startRun(dryRun) {
  if (!selectedFlowId || !parsedRows.length) return;
  const flow = allFlows.find(f => f.id === selectedFlowId);
  if (!flow) return;

  const typeSteps = (flow.steps || []).filter(s => s.type === 'type');
  if (typeSteps.length) {
    const maxNeeded  = Math.max(...typeSteps.map(s => s.colIndex)) + 1;
    const actualCols = parsedRows.length > 0 ? Math.min(...parsedRows.map(r => r.length)) : 0;
    if (maxNeeded > actualCols) {
      document.getElementById('col-warning').classList.remove('hidden');
      return;
    }
  }

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab) {
      await chrome.sidePanel.setOptions({ tabId: tab.id, path: 'sidepanel.html', enabled: true });
      await chrome.sidePanel.open({ tabId: tab.id });
    }
  } catch (_) {}

  await chrome.runtime.sendMessage({ type: 'POPUP_RUN', layout: flow, rows: parsedRows, dryRun });
  window.close();
}

/* ── Toast ───────────────────────────────────────────────── */
function showToast(msg) {
  let toast = document.getElementById('ff-toast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'ff-toast';
    toast.className = 'ff-toast';
    document.body.appendChild(toast);
  }
  toast.textContent = msg;
  toast.classList.add('visible');
  setTimeout(() => toast.classList.remove('visible'), 2500);
}

/* ── Helpers ─────────────────────────────────────────────── */
function esc(str) {
  return String(str)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;')
    .replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

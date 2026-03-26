/* scripts.js — FillFlow Script Manager */
'use strict';

let allScripts    = [];
let editingId     = null;   /* null = new script */
let scriptSafetyTimer = null; /* safety-net timer for standalone script runs */

/* ── Storage ─────────────────────────────────────────────── */
async function loadAllScripts() {
  const { scripts } = await chrome.storage.local.get('scripts');
  return scripts || [];
}

async function saveAllScripts(list) {
  await chrome.storage.local.set({ scripts: list });
}

/* ── Init ────────────────────────────────────────────────── */
document.addEventListener('DOMContentLoaded', async () => {

  document.getElementById('close-btn').addEventListener('click', () => window.close());
  document.getElementById('export-btn').addEventListener('click', exportCurrentScript);
  document.getElementById('new-script-btn').addEventListener('click', () => openEditor(null));
  document.getElementById('import-btn').addEventListener('click', () =>
    document.getElementById('import-file-input').click());
  document.getElementById('import-file-input').addEventListener('change', handleImport);

  /* Keyboard shortcuts in code textarea */
  document.getElementById('script-code').addEventListener('keydown', (e) => {
    /* Ctrl+Enter / Cmd+Enter → Run */
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      e.preventDefault();
      handleRun();
      return;
    }
    /* Tab → indent with 2 spaces instead of losing focus */
    if (e.key === 'Tab') {
      e.preventDefault();
      const ta  = e.target;
      const s   = ta.selectionStart;
      const end = ta.selectionEnd;
      ta.value = ta.value.slice(0, s) + '  ' + ta.value.slice(end);
      ta.selectionStart = ta.selectionEnd = s + 2;
    }
  });

  /* URL guard toggle */
  document.getElementById('url-guard-enabled').addEventListener('change', (e) => {
    document.getElementById('url-guard-body').classList.toggle('hidden', !e.target.checked);
  });

  /* Test URL button */
  document.getElementById('test-url-btn').addEventListener('click', testUrlGuard);

  /* Console clear */
  document.getElementById('console-clear-btn').addEventListener('click', clearConsole);

  /* Run button */
  document.getElementById('run-btn').addEventListener('click', handleRun);

  /* Save button */
  document.getElementById('save-btn').addEventListener('click', saveScript);

  /* Delete button */
  document.getElementById('del-btn').addEventListener('click', deleteCurrentScript);

  /* Script list — event delegation */
  document.getElementById('script-list').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-action]');
    if (!btn) return;
    const id = btn.dataset.id;
    if (btn.dataset.action === 'run') runScriptById(id);
    if (btn.dataset.action === 'del') {
      if (confirm('Delete this script? This cannot be undone.')) deleteScriptById(id);
    }
  });

  /* Live messages from background — script running from popup */
  chrome.runtime.onMessage.addListener(onMessage);

  allScripts = await loadAllScripts();
  renderScriptList();

  /* BUG 5 FIX: read ?id= param — openScriptEditor(id) in popup passes this */
  const params = new URLSearchParams(window.location.search);
  const initId = params.get('id');
  if (initId && allScripts.find(s => s.id === initId)) openEditor(initId);
});

/* ── Render list ─────────────────────────────────────────── */
function renderScriptList() {
  const list  = document.getElementById('script-list');
  const empty = document.getElementById('empty-scripts');

  if (!allScripts.length) {
    empty.classList.remove('hidden');
    list.innerHTML = '';
    return;
  }
  empty.classList.add('hidden');
  list.innerHTML = '';

  allScripts.forEach(s => {
    const item = document.createElement('div');
    item.className = 'script-item' + (s.id === editingId ? ' active' : '');
    item.dataset.id = s.id;

    const lastRun = s.lastRunAt
      ? 'Ran ' + relativeTime(s.lastRunAt)
      : 'Never run';

    const guards = [];
    if (s.urlGuard?.enabled && s.urlGuard?.pattern) guards.push('🛡 URL');
    if (s.requireConfirm) guards.push('✋ Confirm');
    const guardBadges = guards.map(g =>
      `<span class="guard-chip">${g}</span>`).join('');

    item.innerHTML = `
      <div class="script-item-main" data-action="select" data-id="${s.id}" style="cursor:pointer; flex:1; min-width:0;">
        <div class="script-item-name">${esc(s.name || 'Untitled')}</div>
        <div class="script-item-meta">${lastRun}${guards.length ? ' · ' : ''}${guardBadges}</div>
      </div>
      <div class="script-item-acts">
        <button class="sact run-act" data-action="run" data-id="${s.id}" title="Run on current tab">▶</button>
        <button class="sact del-act" data-action="del" data-id="${s.id}" title="Delete">✕</button>
      </div>
    `;
    /* clicking the main area opens editor */
    item.querySelector('.script-item-main').addEventListener('click', () => openEditor(s.id));
    list.appendChild(item);
  });
}

/* ── Open editor ─────────────────────────────────────────── */
function openEditor(id) {
  editingId = id;

  document.getElementById('no-selection').classList.add('hidden');
  document.getElementById('editor-form').classList.remove('hidden');

  clearConsole();

  /* Update list selection */
  document.querySelectorAll('.script-item').forEach(el =>
    el.classList.toggle('active', el.dataset.id === id));

  if (!id) {
    /* New script */
    document.getElementById('topbar-context').textContent = 'New script';
    document.getElementById('script-name').value    = '';
    document.getElementById('script-desc').value    = '';
    document.getElementById('script-code').value    = '';
    document.getElementById('script-timeout').value = '30';
    document.getElementById('url-guard-enabled').checked = false;
    document.getElementById('url-guard-body').classList.add('hidden');
    document.getElementById('url-guard-mode').value    = 'contains';
    document.getElementById('url-guard-pattern').value = '';
    document.getElementById('confirm-before-run').checked = false;
    document.getElementById('del-btn').classList.add('hidden');
    document.getElementById('save-feedback').classList.add('hidden');
    return;
  }

  const script = allScripts.find(s => s.id === id);
  if (!script) return;

  document.getElementById('topbar-context').textContent = script.name || 'Untitled';
  document.getElementById('script-name').value    = script.name || '';
  document.getElementById('script-desc').value    = script.description || '';
  document.getElementById('script-code').value    = script.code || '';
  document.getElementById('script-timeout').value = script.timeout || 30;

  const guard = script.urlGuard || {};
  document.getElementById('url-guard-enabled').checked = !!guard.enabled;
  document.getElementById('url-guard-body').classList.toggle('hidden', !guard.enabled);
  document.getElementById('url-guard-mode').value    = guard.mode || 'contains';
  document.getElementById('url-guard-pattern').value = guard.pattern || '';

  document.getElementById('confirm-before-run').checked = !!script.requireConfirm;
  document.getElementById('del-btn').classList.remove('hidden');
  document.getElementById('save-feedback').classList.add('hidden');
}

/* ── Save script ─────────────────────────────────────────── */
async function saveScript() {
  const name = document.getElementById('script-name').value.trim();
  if (!name) { showFeedback('Enter a script name', false); return false; }
  const code = document.getElementById('script-code').value;
  if (!code.trim()) { showFeedback('Enter some JavaScript code', false); return false; }

  const script = {
    id:             editingId || generateId(),
    name,
    description:    document.getElementById('script-desc').value.trim(),
    code,
    timeout:        parseFloat(document.getElementById('script-timeout').value) || 30,
    urlGuard: {
      enabled: document.getElementById('url-guard-enabled').checked,
      mode:    document.getElementById('url-guard-mode').value,
      pattern: document.getElementById('url-guard-pattern').value.trim()
    },
    requireConfirm: document.getElementById('confirm-before-run').checked,
    updatedAt: Date.now(),
    createdAt: allScripts.find(s => s.id === editingId)?.createdAt || Date.now()
  };

  const idx = allScripts.findIndex(s => s.id === script.id);
  if (idx >= 0) allScripts[idx] = script;
  else allScripts.push(script);

  await saveAllScripts(allScripts);
  editingId = script.id;
  document.getElementById('topbar-context').textContent = script.name;
  document.getElementById('del-btn').classList.remove('hidden');
  showFeedback('Saved — ' + script.name, true);
  renderScriptList();
  return true;
}

/* ── Delete ──────────────────────────────────────────────── */
async function deleteCurrentScript() {
  if (!editingId) return;
  if (!confirm('Delete this script? This cannot be undone.')) return;
  await deleteScriptById(editingId);
}

async function deleteScriptById(id) {
  /* Note: caller is responsible for confirm when needed (deleteCurrentScript does it).
     Direct-from-list deletes call this with their own confirm in the event handler. */
  allScripts = allScripts.filter(s => s.id !== id);
  await saveAllScripts(allScripts);
  if (editingId === id) {
    editingId = null;
    document.getElementById('no-selection').classList.remove('hidden');
    document.getElementById('editor-form').classList.add('hidden');
    document.getElementById('topbar-context').textContent = 'Scripts';
  }
  renderScriptList();
}

/* ── Run ─────────────────────────────────────────────────── */
async function handleRun() {
  const currentCode = document.getElementById('script-code').value;
  if (!currentCode.trim()) { showFeedback('No code to run', false); return; }

  const name = document.getElementById('script-name').value.trim() || 'this script';

  /* URL guard — check before confirm so user isn't prompted for a blocked run */
  const urlGuardEnabled = document.getElementById('url-guard-enabled').checked;
  const pattern         = document.getElementById('url-guard-pattern').value.trim();
  if (urlGuardEnabled && pattern) {
    const { url: currentUrl } = await chrome.runtime.sendMessage({ type: 'QUERY_TAB_URL' });
    const matches = matchUrl(document.getElementById('url-guard-mode').value, pattern, currentUrl || '');
    if (!matches) {
      showConsole();
      appendConsole('error', `URL guard blocked — current page does not match "${pattern}" (${document.getElementById('url-guard-mode').value})`);
      appendConsole('info', `Web page URL: ${currentUrl || '(none found)'}`);
      return;
    }
  }

  /* Confirm */
  if (document.getElementById('confirm-before-run').checked) {
    if (!confirm(`Run "${name}" on the current tab?`)) return;
  }

  /* Save — after confirm; saveScript() returns false if validation fails */
  if (editingId) {
    const saved = await saveScript();
    if (!saved) return;
  }

  if (editingId) {
    runScriptById(editingId, { skipGuards: true });
  } else {
    runCodeInline(currentCode, parseFloat(document.getElementById('script-timeout').value) || 30);
  }
}

async function runScriptById(id, { skipGuards = false } = {}) {
  const script = allScripts.find(s => s.id === id);
  if (!script) return;

  /* requireConfirm — only when called directly (e.g. list ▶ button).
     handleRun already confirmed before saving, so it passes skipGuards=true. */
  if (!skipGuards && script.requireConfirm) {
    if (!confirm(`Run "${script.name}" on the current tab?`)) return;
  }

  /* URL guard — same: skip if caller already validated */
  if (!skipGuards && script.urlGuard?.enabled && script.urlGuard?.pattern) {
    const { url: currentUrl } = await chrome.runtime.sendMessage({ type: 'QUERY_TAB_URL' });
    const matches = matchUrl(script.urlGuard.mode || 'contains', script.urlGuard.pattern, currentUrl || '');
    if (!matches) {
      showConsole();
      appendConsole('error', `URL guard blocked — URL does not match "${script.urlGuard.pattern}"`);
      appendConsole('info', `Current URL: ${currentUrl || '(unknown)'}`);
      return;
    }
  }

  /* Disable run button for duration — onMessage re-enables it */
  updateRunBtn(true);
  showConsole();
  appendConsole('info', `Running "${esc(script.name)}"…`);

  /* TD 4 FIX: safety-net timeout in case the MV3 service worker is killed
     mid-run and SP_SCRIPT_DONE / SP_SCRIPT_ERROR never arrives.
     Give the script its full timeout plus a 5s grace period. */
  const safetyMs = ((script.timeout || 30) + 5) * 1000;
  const safetyTimer = setTimeout(() => {
    appendConsole('warn', 'No response from background — button re-enabled. The script may still be running.');
    updateRunBtn(false);
  }, safetyMs);

  /* Fire and forget — onMessage handles output display and clears the safety timer */
  chrome.runtime.sendMessage({ type: 'RUN_STANDALONE_SCRIPT', scriptId: id }).catch(() => {
    clearTimeout(scriptSafetyTimer);
    scriptSafetyTimer = null;
    appendConsole('error', 'Failed to send to background — try reloading the extension.');
    updateRunBtn(false);
  });

  /* Store the timer so onMessage can cancel it when a real result arrives.
     (Using a module-level variable — function-property approach is fragile.) */
  scriptSafetyTimer = safetyTimer;
}

async function runCodeInline(code, timeoutSecs) {
  showConsole();
  appendConsole('info', 'Running (unsaved script)…');
  updateRunBtn(true);

  /* RUN_INLINE_SCRIPT runs code directly in background without SP_SCRIPT_* broadcast */
  const result = await chrome.runtime.sendMessage({
    type:    'RUN_INLINE_SCRIPT',
    code,
    timeout: timeoutSecs
  });

  updateRunBtn(false);

  if (result?.logs?.length) {
    result.logs.forEach(l => appendConsole(l.level, l.text));
  }
  if (result?.ok) {
    if (result.result) appendConsole('result', result.result);  /* prefix added by appendConsole */
    appendConsole('done', '✓ Done');
  } else {
    appendConsole('error', result?.error || 'Unknown error');
  }
}

function updateRunBtn(running) {
  const btn = document.getElementById('run-btn');
  btn.disabled    = running;
  btn.textContent = running ? '⏳ Running…' : '▶  Run on current tab';
}

/* ── URL guard test ──────────────────────────────────────── */
async function testUrlGuard() {
  const mode    = document.getElementById('url-guard-mode').value;
  const pattern = document.getElementById('url-guard-pattern').value.trim();
  const el      = document.getElementById('test-url-result');

  if (!pattern) {
    el.textContent = '⚠ Enter a pattern first';
    el.className   = 'test-url-result warn';
    el.classList.remove('hidden');
    return;
  }

  const { url } = await chrome.runtime.sendMessage({ type: 'QUERY_TAB_URL' });
  if (!url) {
    el.textContent = '⚠ Cannot read current tab URL';
    el.className   = 'test-url-result warn';
    el.classList.remove('hidden');
    return;
  }

  const matches = matchUrl(mode, pattern, url);
  el.textContent = matches ? `✓ Matches  (${url.slice(0, 60)}${url.length > 60 ? '…' : ''})` : '✗ No match';
  el.className   = 'test-url-result ' + (matches ? 'ok' : 'fail');
  el.classList.remove('hidden');
}

/* ── Shared URL pattern matcher (kept in sync with background.js matchesUrl) ── */
function matchUrl(mode, pattern, url) {
  try {
    switch (mode) {
      case 'contains':   return url.includes(pattern);
      case 'startsWith': return url.startsWith(pattern);
      case 'exact':      return url === pattern;
      case 'regex':      return new RegExp(pattern).test(url);
    }
  } catch { return false; }
  /* BUG 2 FIX: default to true (fail-open) to match background.js matchesUrl.
     An unrecognised mode should allow the run, not silently block it. */
  return true;
}

/* ── Console output ──────────────────────────────────────── */
function showConsole() {
  document.getElementById('console-section').classList.remove('hidden');
}

function clearConsole() {
  document.getElementById('console-body').innerHTML = '';
  document.getElementById('console-status').textContent = '';
  document.getElementById('console-section').classList.add('hidden');
}

function appendConsole(level, text) {
  const body = document.getElementById('console-body');
  const line = document.createElement('div');
  line.className = 'console-line ' + level;

  const prefix = level === 'warn'   ? '⚠ '
               : level === 'error'  ? '✗ '
               : level === 'result' ? '↩ '
               : level === 'done'   ? '✓ '
               : level === 'info'   ? 'ℹ '
               : '> ';

  line.innerHTML = `<span class="console-prefix">${prefix}</span><span class="console-text">${esc(text)}</span>`;
  body.appendChild(line);
  body.scrollTop = body.scrollHeight;
}

/* ── Live messages (results from background for saved script runs) ───────── */
function onMessage(msg) {
  if (msg.type === 'SP_SCRIPT_START') {
    /* Already handled by runScriptById before firing — just ignore here */
    return;
  }
  if (msg.type === 'SP_SCRIPT_DONE') {
    /* TD 4 FIX: cancel the safety-net timer — a real result arrived */
    clearTimeout(scriptSafetyTimer);
    scriptSafetyTimer = null;
    (msg.logs || []).forEach(l => appendConsole(l.level, l.text));
    if (msg.result) appendConsole('result', msg.result);  /* prefix added by appendConsole */
    appendConsole('done', '✓ Done');
    updateRunBtn(false);
    loadAllScripts().then(list => { allScripts = list; renderScriptList(); });
  }
  if (msg.type === 'SP_SCRIPT_ERROR') {
    /* TD 4 FIX: cancel the safety-net timer — a real result arrived */
    clearTimeout(scriptSafetyTimer);
    scriptSafetyTimer = null;
    (msg.logs || []).forEach(l => appendConsole(l.level, l.text));
    appendConsole('error', msg.error || 'Unknown error');
    updateRunBtn(false);
  }
}

/* ── Export ──────────────────────────────────────────────── */
async function exportCurrentScript() {
  const id = editingId;
  if (!id) { showFeedback('Save the script first before exporting', false); return; }
  const script = allScripts.find(s => s.id === id);
  if (!script) return;
  const blob = new Blob([JSON.stringify(script, null, 2)], { type: 'application/json' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = (script.name || 'script').replace(/[^a-z0-9_\- ]/gi, '_') + '.fillflow-script.json';
  a.click();
  /* TD 5 FIX: defer revoke — a.click() is async and the download may not
     have started reading the blob by the time the next line runs. */
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/* ── Import ──────────────────────────────────────────────── */
async function handleImport(e) {
  const file = e.target.files[0];
  if (!file) return;
  e.target.value = '';
  let imported;
  try { imported = JSON.parse(await file.text()); }
  catch { alert('Invalid file — could not parse JSON.'); return; }

  const list = Array.isArray(imported) ? imported : [imported];
  let added  = 0;

  for (const s of list) {
    if (!s.name || typeof s.code !== 'string') continue;
    const newScript = {
      ...s,
      id:        generateId(),
      createdAt: Date.now(),
      updatedAt: Date.now(),
      lastRunAt: null
    };
    allScripts.push(newScript);
    added++;
  }

  if (!added) { alert('No valid scripts found in file.'); return; }
  await saveAllScripts(allScripts);
  renderScriptList();
  showFeedback(`Imported ${added} script${added !== 1 ? 's' : ''}`, true);
}

/* ── Helpers ─────────────────────────────────────────────── */
function showFeedback(msg, ok) {
  const el = document.getElementById('save-feedback');
  el.textContent = (ok ? '✓ ' : '⚠ ') + msg;
  el.className   = 'save-feedback ' + (ok ? 'ok' : 'err');
  el.classList.remove('hidden');
  setTimeout(() => el.classList.add('hidden'), 3000);
}

function relativeTime(ts) {
  const diff = Date.now() - ts;
  if (diff < 60_000)   return 'just now';
  if (diff < 3_600_000) return Math.floor(diff / 60_000) + 'm ago';
  if (diff < 86_400_000) return Math.floor(diff / 3_600_000) + 'h ago';
  return Math.floor(diff / 86_400_000) + 'd ago';
}

function generateId() {
  return 'scr_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7);
}

function esc(str) {
  return String(str)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;')
    .replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

/* sidepanel.js — FillFlow v2.1 */
'use strict';

const ss = chrome.storage.session;
let startedAt = null;
let isPaused  = false;
let runTabId  = null;  /* tabId of the tab currently running automation */

/* ── Init ────────────────────────────────────────────────── */
document.addEventListener('DOMContentLoaded', async () => {

  /* Restore state if panel opened mid-run */
  const { runState } = await ss.get('runState');
  if (runState) {
    const stale = ['running','starting'].includes(runState.status) &&
                  (Date.now() - (runState.startedAt || 0)) > 60_000;
    if (!stale) applyState(runState);
  }

  chrome.runtime.onMessage.addListener(onMessage);

  document.getElementById('btn-pause').addEventListener('click', () => {
    /* Use stored runTabId — querying the active tab would target the wrong tab
       if the user has switched tabs since automation started. */
    if (runTabId) chrome.runtime.sendMessage({ type: 'SIDEPANEL_TOGGLE_PAUSE', tabId: runTabId });
  });

  document.getElementById('btn-stop').addEventListener('click', () => {
    if (runTabId) chrome.runtime.sendMessage({ type: 'SIDEPANEL_STOP', tabId: runTabId });
  });

  document.getElementById('capture-cancel').addEventListener('click', () => {
    chrome.runtime.sendMessage({ type: 'POPUP_CAPTURE_CANCEL' });
    hideCapturePanel();
  });

  /* Script panel dismiss */
  document.getElementById('script-dismiss-btn').addEventListener('click', hideScriptPanel);

  /* Check if capture was already active when panel opened */
  const { captureState } = await ss.get('captureState');
  if (captureState?.active) showCapturePanel(captureState.midRun ? 'step' : 'first-field');
});

/* ── Capture panel ───────────────────────────────────────── */
function showCapturePanel(mode) {
  const panel = document.getElementById('capture-panel');
  const body  = document.getElementById('capture-body');
  body.textContent = mode === 'step'
    ? 'Switch to the page and click the field you want FillFlow to focus during the flow.'
    : 'Switch to the page and click the first field FillFlow should start from.';
  document.getElementById('capture-selector').classList.add('hidden');
  panel.classList.remove('hidden');
  setSubtitle('Click a field on the page…');
}

function hideCapturePanel() {
  document.getElementById('capture-panel').classList.add('hidden');
  setSubtitle('Ready');
}

function showCaptureSuccess(selector) {
  const selEl = document.getElementById('capture-selector');
  selEl.textContent = selector;
  selEl.classList.remove('hidden');
  document.getElementById('capture-body').textContent = 'Field captured successfully.';
  /* Auto-hide after 2s */
  setTimeout(hideCapturePanel, 2000);
}

/* ── Message handler ─────────────────────────────────────── */
function onMessage(msg) {
  switch (msg.type) {

    case 'SP_SCRIPT_START':
      showScriptPanel(msg.name);
      break;

    case 'SP_SCRIPT_DONE':
      (msg.logs || []).forEach(l => appendScriptConsole(l.level, l.text));
      if (msg.result) appendScriptConsole('result', '↩ ' + msg.result);
      appendScriptConsole('done', '✓ Done');
      finalizeScriptPanel(true);
      break;

    case 'SP_SCRIPT_ERROR':
      (msg.logs || []).forEach(l => appendScriptConsole(l.level, l.text));
      appendScriptConsole('error', '✗ ' + (msg.error || 'Unknown error'));
      finalizeScriptPanel(false);
      break;

    case 'SP_ROW_START':
      if (msg.tabId) runTabId = msg.tabId;  /* keep target tab pinned */
      /* BUG 1 FIX: startedAt is only set by applyState() on the restore path.
         For fresh runs the panel opens with startedAt=null, so elapsed_()
         always returned 0. Initialise here on first row; reset on row 1 so
         consecutive runs each get a fresh timer. */
      if (!startedAt || msg.current === 1) startedAt = Date.now();
      setStatus('running', 'Running…');
      setRow(msg.current, msg.total);
      hideMsg(); break;

    case 'SP_ROW_DONE':
      addLog(msg.current, 'done');
      clearTyping(); break;

    case 'SP_COMPLETE':
      setRow(msg.total, msg.total);
      setStatus('done', 'Done');
      clearTyping();
      showDone(); break;

    case 'SP_STOPPED':
      setStatus('stopped', 'Stopped');
      clearTyping();
      el('controls').classList.add('hidden');
      el('hint').textContent = 'Automation stopped'; break;

    case 'SP_PAUSE':
      isPaused = msg.paused;
      setStatus(isPaused ? 'paused' : 'running', isPaused ? 'Paused' : 'Running…');
      el('btn-pause').textContent = isPaused ? '▶  Resume' : '⏸  Pause  (F9)';
      el('btn-pause').classList.toggle('active', isPaused); break;

    case 'SP_COUNTDOWN':
      msg.seconds > 0 ? showMsg(`Starting in ${msg.seconds}… click the first field now`) : hideMsg(); break;

    case 'SP_WAITING_CLICK':
      showMsg('Click anywhere on the page to continue…'); break;

    case 'SP_STEP_TYPING':
      showTyping(msg.label, msg.value); break;

    case 'SP_WAITING_PAGE':
      showMsg(`Waiting for page… attempt ${msg.attempt} of ${msg.max}`); break;

    case 'SP_SEPARATOR_HIT':
      showMsg(msg.skipNavCheck
        ? 'Separator reached — will continue when next page loads…'
        : 'Separator reached — waiting for navigation (30s)…');
      clearTyping(); break;

    case 'SP_CAPTURE_START':
      showCapturePanel(msg.mode); break;

    case 'SP_CAPTURE_DONE':
      showCaptureSuccess(msg.selector); break;

    case 'SP_CAPTURE_CANCELLED':
      hideCapturePanel(); break;

    case 'SP_CAPTURE_STEP_NEEDED':
      showCapturePanel('step'); break;

    case 'SP_ERROR':
      setStatus('stopped', 'Error');
      showMsg('Error: ' + (msg.message || 'unknown'));
      el('controls').classList.add('hidden'); break;
  }
}

/* ── Restore on open ─────────────────────────────────────── */
function applyState(rs) {
  startedAt = rs.startedAt || Date.now();
  if (rs.tabId) runTabId = rs.tabId;
  el('fi-name').textContent = rs.layoutName || '—';
  el('fi-meta').textContent = `${rs.layoutStepCount || 0} steps · ${rs.wpm || 100} WPM`;
  el('dry-badge').classList.toggle('hidden', !rs.dryRun);
  setRow(rs.current || 0, rs.total || 0);

  if (rs.status === 'done') {
    setStatus('done', 'Done'); showDone();
    el('controls').classList.add('hidden');
  } else if (rs.status === 'stopped' || rs.status === 'error') {
    setStatus('stopped', rs.status === 'error' ? 'Error' : 'Stopped');
    el('controls').classList.add('hidden');
    el('hint').textContent = 'Automation stopped';
    if (rs.errorMessage) showMsg('Error: ' + rs.errorMessage);
  } else if (rs.status === 'paused') {
    setStatus('paused', 'Paused');
    el('btn-pause').textContent = '▶  Resume';
    el('btn-pause').classList.add('active');
    isPaused = true;
  } else if (rs.status === 'starting') {
    setStatus('starting', 'Starting…');
  } else {
    setStatus('running', 'Running…');
  }
  (rs.log || []).forEach(e => addLog(e.row, e.status, e.time));
}

/* ── Script panel ────────────────────────────────────────── */
function showScriptPanel(name) {
  const panel = document.getElementById('script-panel');
  document.getElementById('script-panel-name').textContent = name || 'Running script…';
  document.getElementById('script-panel-status').textContent = '';
  document.getElementById('script-console').innerHTML = '';
  document.getElementById('script-pulse').className = 'script-pulse';
  panel.classList.remove('hidden');
  setSubtitle('Script running…');
}

function finalizeScriptPanel(ok) {
  const now = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  document.getElementById('script-pulse').className = 'script-pulse ' + (ok ? 'done' : 'error');
  document.getElementById('script-panel-status').textContent = (ok ? 'Done' : 'Error') + ' · ' + now;
  setSubtitle(ok ? 'Script done' : 'Script error');
}

function hideScriptPanel() {
  document.getElementById('script-panel').classList.add('hidden');
  setSubtitle('Ready');
}

const SC_PREFIX = { log: '> ', info: 'ℹ ', warn: '⚠ ', error: '✗ ', result: '↩ ', done: '✓ ' };

function appendScriptConsole(level, text) {
  const body = document.getElementById('script-console');
  const line = document.createElement('div');
  line.className = 'sc-line ' + level;
  const prefix = SC_PREFIX[level] || '> ';
  line.textContent = prefix + text;
  body.appendChild(line);
  body.scrollTop = body.scrollHeight;
}

/* ── UI helpers ──────────────────────────────────────────── */
function el(id) { return document.getElementById(id); }

function setStatus(cls, label) {
  el('pulse').className       = 'pulse ' + cls;
  el('status-label').textContent = label;
  setSubtitle(label);
}

function setSubtitle(text) { el('sp-subtitle').textContent = text; }

function setRow(cur, tot) {
  el('row-big').textContent = cur || '—';
  el('row-of').textContent  = tot ? `of ${tot} rows` : 'waiting to start';
  const pct = tot ? Math.round((cur / tot) * 100) : 0;
  el('progress-bar').style.width = pct + '%';
}

function addLog(rowNum, status, timeStr) {
  const old = el('log-row-' + rowNum);
  if (old) old.remove();
  const item = document.createElement('div');
  item.className = 'log-item'; item.id = 'log-row-' + rowNum;
  const elapsed = timeStr || elapsed_();
  item.innerHTML = `<span class="log-n">Row ${rowNum}</span><span class="log-badge done">Done</span><span class="log-t">${elapsed}</span>`;
  const list = el('log-list');
  list.appendChild(item);
  list.scrollTop = list.scrollHeight;
}

function showDone() {
  el('done-banner').classList.remove('hidden');
  el('controls').classList.add('hidden');
  el('hint').textContent = 'All rows completed successfully';
}

function showMsg(text)  { const e = el('msg-box'); e.textContent = text; e.classList.remove('hidden'); }
function hideMsg()      { el('msg-box').classList.add('hidden'); }
function showTyping(l, v) { el('typing-label').textContent = l; el('typing-value').textContent = v || '(empty)'; el('typing-row').classList.remove('hidden'); }
function clearTyping()  { el('typing-row').classList.add('hidden'); }

function elapsed_() {
  const s = Math.round((Date.now() - (startedAt || Date.now())) / 1000);
  return `${Math.floor(s/60)}:${String(s%60).padStart(2,'0')}`;
}

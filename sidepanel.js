/* sidepanel.js — FillFlow */
'use strict';

let startedAt = null;
let isPaused  = false;

/* ── Init ────────────────────────────────────────────────── */
document.addEventListener('DOMContentLoaded', async () => {
  /* Restore state if side panel opened mid-run.
     Only apply if the status is meaningful — ignore orphaned 'running'
     states from a previous session that never cleaned up. */
  const { runState } = await chrome.storage.local.get('runState');
  if (runState) {
    /* If status is 'running' or 'starting' but the run started more than
       60 seconds ago with no row progress, it's likely a stale state */
    /* Treat as stale if running/starting but started more than 60s ago
       — covers both zero-progress and mid-run crashes */
    const stale = (
      (runState.status === 'running' || runState.status === 'starting') &&
      (Date.now() - (runState.startedAt || 0)) > 60000
    );
    if (!stale) applyState(runState);
  }

  /* Listen for live events forwarded by background */
  chrome.runtime.onMessage.addListener(onMessage);

  /* Pause button — sends F9 equivalent to active tab */
  document.getElementById('pause-btn').addEventListener('click', async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab) return;
    /* Toggle pause via background message rather than simulating F9
       so it works regardless of which element has focus */
    chrome.runtime.sendMessage({ type: 'SIDEPANEL_TOGGLE_PAUSE', tabId: tab.id });
  });

  /* Stop button — sends stop signal to active tab */
  document.getElementById('stop-btn').addEventListener('click', async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab) return;
    chrome.runtime.sendMessage({ type: 'SIDEPANEL_STOP', tabId: tab.id });
  });
});

/* ── Live message handler ────────────────────────────────── */
function onMessage(msg) {
  switch (msg.type) {

    case 'SP_ROW_START':
      setStatus('running', 'Running…');
      updateRow(msg.current, msg.total);
      hideMsg();
      break;

    case 'SP_ROW_DONE':
      addLog(msg.current, 'done');
      clearTyping();
      break;

    case 'SP_COMPLETE':
      updateRow(msg.total, msg.total);
      setStatus('done', 'Done');
      clearTyping();
      showDone();
      break;

    case 'SP_STOPPED':
      setStatus('stopped', 'Stopped');
      clearTyping();
      document.getElementById('controls').classList.add('hidden');
      document.getElementById('hint').textContent = 'Automation stopped';
      break;

    case 'SP_PAUSE':
      isPaused = msg.paused;
      if (isPaused) {
        setStatus('paused', 'Paused');
        document.getElementById('pause-btn').textContent = '▶  Resume';
        document.getElementById('pause-btn').classList.add('active');
      } else {
        setStatus('running', 'Running…');
        document.getElementById('pause-btn').textContent = '⏸  Pause';
        document.getElementById('pause-btn').classList.remove('active');
      }
      break;

    case 'SP_COUNTDOWN':
      if (msg.seconds > 0) {
        showMsg(`Starting in ${msg.seconds}… click the first field now`);
      } else {
        hideMsg();
      }
      break;

    case 'SP_WAITING_CLICK':
      showMsg('Click anywhere on the page to set the starting field…');
      break;

    case 'SP_STEP_TYPING':
      showTyping(msg.label, msg.value);
      break;

    case 'SP_WAITING_PAGE':
      showMsg(`Waiting for page ready… attempt ${msg.attempt} of ${msg.max}`);
      break;

    case 'SP_SEPARATOR_HIT':
      if (msg.skipNavCheck) {
        showMsg('Page separator reached — continuing when next page runs…');
      } else {
        showMsg('Page separator reached — waiting for navigation (30s timeout)…');
      }
      clearTyping();
      break;

    case 'SP_CAPTURE_STEP_NEEDED':
      setStatus('starting', 'Waiting for capture…');
      showMsg('Click the field you want to focus on the page');
      break;

    case 'SP_ERROR':
      setStatus('stopped', 'Error');
      showMsg('Error: ' + (msg.message || 'unknown'));
      document.getElementById('controls').classList.add('hidden');
      break;
  }
}

/* ── Restore state on open ───────────────────────────────── */
function applyState(rs) {
  startedAt = rs.startedAt || Date.now();

  document.getElementById('li-name').textContent = rs.layoutName || '—';
  document.getElementById('dry-run-badge').classList.toggle('hidden', !rs.dryRun);
  document.getElementById('li-meta').textContent =
    `${rs.layoutStepCount || 0} steps · ${rs.wpm || 100} WPM`;

  updateRow(rs.current || 0, rs.total || 0);

  if (rs.status === 'done') {
    setStatus('done', 'Done');
    showDone();
    document.getElementById('controls').classList.add('hidden');
  } else if (rs.status === 'stopped' || rs.status === 'error') {
    setStatus('stopped', rs.status === 'error' ? 'Error' : 'Stopped');
    document.getElementById('controls').classList.add('hidden');
    document.getElementById('hint').textContent = 'Automation stopped';
    if (rs.errorMessage) showMsg('Error: ' + rs.errorMessage);
  } else if (rs.status === 'paused') {
    setStatus('paused', 'Paused');
    document.getElementById('pause-btn').textContent = '▶  Resume';
    document.getElementById('pause-btn').classList.add('active');
    isPaused = true;
  } else if (rs.status === 'starting') {
    setStatus('starting', 'Starting…');
  } else {
    setStatus('running', 'Running…');
  }

  (rs.log || []).forEach(e => addLog(e.row, e.status, e.time));
}

/* ── UI helpers ──────────────────────────────────────────── */
function setStatus(cls, label) {
  document.getElementById('pulse').className       = 'pulse ' + cls;
  document.getElementById('status-label').textContent = label;
  document.getElementById('header-sub').textContent   = label;
}

function updateRow(current, total) {
  document.getElementById('row-big').textContent    = current || '—';
  document.getElementById('row-total').textContent  = total ? `of ${total} rows` : 'waiting to start';
  document.getElementById('status-val').textContent = total ? `Row ${current} of ${total}` : '';
  const pct = total ? Math.round((current / total) * 100) : 0;
  document.getElementById('progress-fill').style.width = pct + '%';
}

function addLog(rowNum, status, timeStr) {
  const old = document.getElementById('log-row-' + rowNum);
  if (old) old.remove();
  const elapsed = timeStr || getElapsed();
  const item    = document.createElement('div');
  item.className = 'log-item';
  item.id        = 'log-row-' + rowNum;
  item.innerHTML = `
    <span class="log-row-n">Row ${rowNum}</span>
    <span class="log-badge ${status}">${status === 'done' ? 'Done' : 'Running…'}</span>
    <span class="log-time">${elapsed}</span>
  `;
  const list = document.getElementById('log-list');
  list.appendChild(item);
  list.scrollTop = list.scrollHeight;
}

function showDone() {
  document.getElementById('done-msg').classList.remove('hidden');
  document.getElementById('controls').classList.add('hidden');
  document.getElementById('hint').textContent = 'All rows completed successfully';
}

function showMsg(text) {
  const el = document.getElementById('msg-box');
  el.textContent = text;
  el.classList.remove('hidden');
}
function hideMsg() {
  document.getElementById('msg-box').classList.add('hidden');
}

function showTyping(label, value) {
  document.getElementById('typing-label').textContent = label;
  document.getElementById('typing-value').textContent = value || '(empty)';
  document.getElementById('typing-indicator').classList.remove('hidden');
}
function clearTyping() {
  document.getElementById('typing-indicator').classList.add('hidden');
}

function getElapsed() {
  const s = Math.round((Date.now() - (startedAt || Date.now())) / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

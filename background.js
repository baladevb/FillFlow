/* background.js — FillFlow service worker
   Message hub between popup, side panel, and content script.

   Content script sends:   FF_ROW_START, FF_ROW_DONE, FF_COMPLETE, FF_STOPPED,
                           FF_PAUSE, FF_COUNTDOWN, FF_WAITING_CLICK, FF_ERROR,
                           FF_STEP_TYPING, FF_WAITING_PAGE, FF_CAPTURE_STEP_NEEDED,
                           FF_SEPARATOR_HIT, FF_FIELD_CAPTURED, FF_STEP_FIELD_CAPTURED
   Side panel receives:    SP_ versions of the above
   Popup/sidepanel sends:  POPUP_RUN, POPUP_CAPTURE_START, POPUP_CAPTURE_CANCEL,
                           SIDEPANEL_STOP, SIDEPANEL_TOGGLE_PAUSE, BG_CAPTURE_STEP_START
*/
'use strict';

chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false }).catch(() => {});

/* ── Message router ─────────────────────────────────────── */
chrome.runtime.onMessage.addListener((msg, _sender, respond) => {

  /* POPUP_RUN — async, needs sidePanel open + tab message */
  if (msg.type === 'POPUP_RUN') {
    startAutomation(msg).then(respond);
    return true;
  }

  /* POPUP_CAPTURE_START — async, needs active tab */
  if (msg.type === 'POPUP_CAPTURE_START') {
    chrome.storage.local.set({ captureState: { flowId: msg.flowId, active: true } });
    getActiveTab().then(tab => {
      if (!tab) { respond({ ok: false }); return; }
      chrome.tabs.sendMessage(tab.id, { type: 'CAPTURE_FIELD_START' }).catch(() => {});
      respond({ ok: true });
    });
    return true;
  }

  /* BG_CAPTURE_STEP_START — mid-run capture triggered by a focusfield step */
  if (msg.type === 'BG_CAPTURE_STEP_START') {
    const tabId = _sender?.tab?.id;
    if (!tabId) { respond({ ok: false }); return; }
    chrome.storage.local.set({
      captureState: { flowId: msg.flowId, stepIndex: msg.stepIndex, active: true, midRun: true }
    }).then(() => {
      chrome.tabs.sendMessage(tabId, {
        type: 'CAPTURE_STEP_START', stepIndex: msg.stepIndex
      }).catch(() => {});
      respond({ ok: true });
    });
    return true;   /* keep message channel open for async response */
  }

  /* POPUP_CAPTURE_CANCEL — async */
  if (msg.type === 'POPUP_CAPTURE_CANCEL') {
    chrome.storage.local.remove('captureState').catch(() => {});
    getActiveTab().then(tab => {
      if (tab) chrome.tabs.sendMessage(tab.id, { type: 'CANCEL_CAPTURE' }).catch(() => {});
      respond({ ok: true });
    });
    return true;
  }

  /* FF_STEP_FIELD_CAPTURED — mid-run step capture completed */
  if (msg.type === 'FF_STEP_FIELD_CAPTURED') {
    handleStepFieldCaptured(msg.selector, msg.stepIndex, _sender?.tab?.id);
    respond({ ok: true });
    return;
  }

  /* FF_FIELD_CAPTURED — save selector directly to storage (popup may be closed) */
  if (msg.type === 'FF_FIELD_CAPTURED') {
    handleFieldCaptured(msg.selector);
    respond({ ok: true });
    return;
  }

  if (msg.type === 'FF_CAPTURE_CANCELLED') {
    chrome.storage.local.remove('captureState');
    respond({ ok: true });
    return;
  }

  /* FF_SEPARATOR_HIT — separator reached, optionally watch for navigation */
  if (msg.type === 'FF_SEPARATOR_HIT') {
    handleSeparatorHit(msg, _sender?.tab?.id);
    toSidePanel({ ...msg, type: 'SP_SEPARATOR_HIT' });
    respond({ ok: true });
    return;
  }

  /* Display-only events — forward to side panel but don't touch runState.
     These fire very frequently (every keystroke) so skipping the storage
     read+write on each one is important for performance. */
  const displayOnlyEvents = [
    'FF_STEP_TYPING', 'FF_WAITING_PAGE', 'FF_CAPTURE_STEP_NEEDED'
  ];
  if (displayOnlyEvents.includes(msg.type)) {
    toSidePanel(msg);
    respond({ ok: true });
    return;
  }

  /* All other FF_ automation events — update persisted state + forward */
  const autoEvents = [
    'FF_ROW_START', 'FF_ROW_DONE', 'FF_COMPLETE', 'FF_STOPPED',
    'FF_PAUSE', 'FF_COUNTDOWN', 'FF_WAITING_CLICK', 'FF_ERROR'
  ];
  if (autoEvents.includes(msg.type)) {
    updateRunState(msg);
    toSidePanel(msg);
    respond({ ok: true });
    return;
  }

  /* FF_CANCEL_NAV_ALARM — ESC or stop pressed, cancel any pending separator alarm */
  if (msg.type === 'FF_CANCEL_NAV_ALARM') {
    chrome.alarms.clear(NAV_ALARM_NAME);
    if (handleSeparatorHit._prevListener) {
      chrome.tabs.onUpdated.removeListener(handleSeparatorHit._prevListener);
      handleSeparatorHit._prevListener = null;
    }
    chrome.storage.local.remove('navTimeoutTabId').catch(() => {});
    respond({ ok: true });
    return;
  }

  /* SIDEPANEL_STOP — stop button clicked in side panel */
  if (msg.type === 'SIDEPANEL_STOP') {
    chrome.tabs.sendMessage(msg.tabId, { type: 'FORCE_STOP' }).catch(() => {});
    respond({ ok: true });
    return;
  }

  /* SIDEPANEL_TOGGLE_PAUSE — pause button clicked in side panel */
  if (msg.type === 'SIDEPANEL_TOGGLE_PAUSE') {
    chrome.tabs.sendMessage(msg.tabId, { type: 'FORCE_TOGGLE_PAUSE' }).catch(() => {});
    respond({ ok: true });
    return;
  }

  /* Unknown message — respond to prevent "port closed" warnings */
  respond({ ok: false, error: 'unknown message type' });
});

/* ── Start automation ────────────────────────────────────── */
async function startAutomation(msg) {
  const tab = await getActiveTab();
  if (!tab) return { ok: false, error: 'No active tab found' };

  const runStateBase = {
    status:          'starting',
    dryRun:          !!msg.dryRun,
    layoutName:      msg.layout.name,
    layoutStepCount: msg.layout.steps.length,
    wpm:             msg.layout.wpm || 100,
    current:         0,
    total:           msg.rows.length,
    log:             [],
    tabId:           tab.id,
    startedAt:       Date.now()
  };
  /* Clear any stale state from previous run before starting fresh */
  await chrome.storage.local.remove(['resumeState']);
  await chrome.storage.local.set({ runState: runStateBase });

  /* Ping content script — catches file:// pages and restricted URLs */
  const alive = await pingTab(tab.id);
  if (!alive) {
    const errState = { ...runStateBase, status: 'error',
      errorMessage: 'FillFlow cannot reach this page. If testing a local file, enable "Allow access to file URLs" in chrome://extensions → FillFlow → Details.' };
    await chrome.storage.local.set({ runState: errState });
    /* Forward error to side panel */
    chrome.runtime.sendMessage({
      type: 'SP_ERROR',
      message: errState.errorMessage
    }).catch(() => {});
    return { ok: false, error: 'Content script unreachable' };
  }

  /* Small delay so side panel can open and read runState before first event */
  setTimeout(async () => {
    try {
      await chrome.tabs.sendMessage(tab.id, {
        type:   'START_AUTOMATION',
        layout: msg.layout,
        rows:   msg.rows,
        dryRun: !!msg.dryRun
      });
    } catch (e) {
      console.warn('[FillFlow] START_AUTOMATION failed:', e.message);
    }
  }, 600);

  return { ok: true };
}

/* ── Ping a tab's content script ─────────────────────────── */
async function pingTab(tabId) {
  try {
    const resp = await chrome.tabs.sendMessage(tabId, { type: 'PING' });
    return resp?.ok === true;
  } catch {
    return false;
  }
}

/* ── Save captured selector even if popup has closed ─────── */
async function handleFieldCaptured(selector) {
  const { captureState } = await chrome.storage.local.get('captureState');
  const flowId = captureState?.flowId;
  if (!captureState?.active || !flowId || captureState?.midRun) return;

  const data = await chrome.storage.local.get(['flows', 'layouts']);
  const all  = data.flows || data.layouts || [];
  const updated = all.map(l =>
    l.id === flowId ? { ...l, firstFieldSelector: selector } : l
  );
  await chrome.storage.local.set({ flows: updated });
  await chrome.storage.local.remove('captureState');

  chrome.runtime.sendMessage({ type: 'BG_FIELD_CAPTURED', selector }).catch(() => {});
}

/* ── Save mid-run step capture selector ──────────────────── */
async function handleStepFieldCaptured(selector, stepIndex, tabId) {
  const { captureState } = await chrome.storage.local.get('captureState');
  if (!captureState?.midRun || !captureState?.flowId) return;

  /* Save selector into the step inside the flow in storage */
  const data = await chrome.storage.local.get(['flows', 'layouts']);
  const all  = data.flows || data.layouts || [];
  const updated = all.map(flow => {
    if (flow.id !== captureState.flowId) return flow;
    const steps = (flow.steps || []).map((s, i) =>
      i === stepIndex ? { ...s, selector } : s
    );
    return { ...flow, steps };
  });
  await chrome.storage.local.set({ flows: updated });
  await chrome.storage.local.remove('captureState');

  /* Also update resumeState layout if present so cross-page resume has the new selector */
  const { resumeState } = await chrome.storage.local.get('resumeState');
  if (resumeState?.layout?.id === captureState.flowId &&
      Array.isArray(resumeState.layout.steps) &&
      stepIndex >= 0 && stepIndex < resumeState.layout.steps.length) {
    resumeState.layout.steps[stepIndex] = {
      ...resumeState.layout.steps[stepIndex], selector
    };
    await chrome.storage.local.set({ resumeState });
  }

  /* Tell content script to resume — send selector back */
  if (tabId) {
    chrome.tabs.sendMessage(tabId, {
      type: 'FF_STEP_CAPTURED', selector, stepIndex
    }).catch(() => {});
  }
}

/* ── Update persisted run state ──────────────────────────── */
async function updateRunState(msg) {
  const { runState } = await chrome.storage.local.get('runState');
  if (!runState) return;

  const sec = Math.round((Date.now() - (runState.startedAt || Date.now())) / 1000);
  const fmt = `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;

  switch (msg.type) {
    case 'FF_ROW_START':
      runState.status  = 'running';
      runState.current = msg.current;
      runState.total   = msg.total;
      break;
    case 'FF_ROW_DONE':
      runState.log.push({ row: msg.current, status: 'done', time: fmt });
      break;
    case 'FF_COMPLETE':
      runState.status  = 'done';
      runState.current = runState.total;
      break;
    case 'FF_STOPPED':
      runState.status = 'stopped';
      break;
    case 'FF_PAUSE':
      runState.status = msg.paused ? 'paused' : 'running';
      break;
    case 'FF_COUNTDOWN':
    case 'FF_WAITING_CLICK':
      runState.status = 'starting';
      break;
    case 'FF_ERROR':
      runState.status       = 'error';
      runState.errorMessage = msg.message;
      break;
  }

  await chrome.storage.local.set({ runState });
}

/* ── Forward to side panel — FF_ROW_DONE → SP_ROW_DONE ───── */
function toSidePanel(msg) {
  const type = 'SP_' + msg.type.replace(/^FF_/, '');
  chrome.runtime.sendMessage({ ...msg, type }).catch(() => {});
}

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab || null;
}

/* ── Separator hit — nav timeout guard ───────────────────── */
/* Uses chrome.alarms instead of setTimeout so the timeout survives
   service worker restarts — setTimeout state is lost when the SW is
   killed by Chrome between separator hit and the timeout firing. */
const NAV_ALARM_NAME = 'fillflow_nav_timeout';

function handleSeparatorHit(msg, tabId) {
  /* Clear any previous alarm */
  chrome.alarms.clear(NAV_ALARM_NAME);

  if (msg.skipNavCheck) {
    /* User opted out — resume state already saved, nothing else to do */
    return;
  }

  if (!tabId) return;

  /* Save tabId so the alarm handler can check the right tab */
  chrome.storage.local.set({ navTimeoutTabId: tabId });

  /* Watch for navigation — if tab navigates before alarm fires, cancel alarm.
     Remove any previous listener first to prevent accumulation across runs. */
  if (handleSeparatorHit._prevListener) {
    chrome.tabs.onUpdated.removeListener(handleSeparatorHit._prevListener);
  }
  function onUpdated(updatedTabId, changeInfo) {
    if (updatedTabId !== tabId || changeInfo.status !== 'complete') return;
    chrome.tabs.onUpdated.removeListener(onUpdated);
    handleSeparatorHit._prevListener = null;
    chrome.alarms.clear(NAV_ALARM_NAME);
    chrome.storage.local.remove('navTimeoutTabId');
  }
  handleSeparatorHit._prevListener = onUpdated;
  chrome.tabs.onUpdated.addListener(onUpdated);

  /* Schedule alarm — 30 seconds, survives SW restart */
  chrome.alarms.create(NAV_ALARM_NAME, { delayInMinutes: 0.5 });
}

/* ── Alarm handler ───────────────────────────────────────── */
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== NAV_ALARM_NAME) return;

  chrome.storage.local.remove('navTimeoutTabId').catch(() => {});

  const { resumeState } = await chrome.storage.local.get('resumeState');
  if (!resumeState) return;   /* already resumed — ignore */

  await chrome.storage.local.remove('resumeState');

  const { runState } = await chrome.storage.local.get('runState');
  if (runState) {
    runState.status = 'stopped';
    await chrome.storage.local.set({ runState });
  }

  chrome.runtime.sendMessage({
    type:    'SP_ERROR',
    message: 'Page navigation expected after the separator but did not happen within 30 seconds. ' +
             'If the page reloads silently (e.g. loads a table without full navigation), ' +
             'enable "Skip navigation check" on the separator in the flow editor.'
  }).catch(() => {});
});

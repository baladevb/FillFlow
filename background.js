/* background.js — FillFlow v2.2 service worker */
'use strict';

chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false }).catch(() => {});

/* ── Storage helpers ─────────────────────────────────────── */
const ss = chrome.storage.session;
const ps = chrome.storage.local;

/* ── Web-tab tracking ────────────────────────────────────── */
/* Scripts page (chrome-extension://) is NOT a web page. We track the last
   real web tab so script execution and URL guard tests target the right page
   even when the scripts editor tab is currently active.
   FIX (service worker state loss): lastWebTabId is persisted in session
   storage so it survives Chrome terminating and restarting the service worker
   mid-run. Module-level variable is the fast-path cache; session storage is
   the recovery path on cold start.                                           */
let lastWebTabId = null;

/* Restore lastWebTabId after a service worker restart. */
ss.get('lastWebTabId').then(({ lastWebTabId: saved }) => {
  if (saved) lastWebTabId = saved;
}).catch(() => {});

function isWebUrl(url) {
  if (!url) return false;
  return !url.startsWith('chrome://') &&
         !url.startsWith('chrome-extension://') &&
         !url.startsWith('about:') &&
         !url.startsWith('devtools://');
}

chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (tab && isWebUrl(tab.url)) {
    lastWebTabId = tabId;
    ss.set({ lastWebTabId }).catch(() => {});
  }
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === 'complete' && tab.active && isWebUrl(tab.url)) {
    lastWebTabId = tabId;
    ss.set({ lastWebTabId }).catch(() => {});
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  if (lastWebTabId === tabId) {
    lastWebTabId = null;
    ss.remove('lastWebTabId').catch(() => {});
  }
  if (frameTimers[tabId])     { clearTimeout(frameTimers[tabId]); delete frameTimers[tabId]; }
  if (frameCandidates[tabId]) { delete frameCandidates[tabId]; }
  /* FIX (event listener leak): if this tab was awaiting navigation, clean up
     the onUpdated listener that would never fire now that the tab is gone.   */
  const navKey = 'navTabId_' + tabId;
  ss.get(navKey).then(result => {
    if (result[navKey] && navListeners[tabId]) {
      chrome.tabs.onUpdated.removeListener(navListeners[tabId]);
      delete navListeners[tabId];
      chrome.alarms.clear('ff_nav_' + tabId);
      ss.remove([navKey, 'resume_' + tabId]).catch(() => {});
    }
  }).catch(() => {});
  ss.remove('resume_' + tabId).catch(() => {});
});

/* Returns the last real web tab the user was on. Falls back gracefully. */
async function getWebTab() {
  if (lastWebTabId) {
    const tab = await chrome.tabs.get(lastWebTabId).catch(() => null);
    if (tab && isWebUrl(tab.url) && !tab.discarded) return tab;
    lastWebTabId = null;
    ss.remove('lastWebTabId').catch(() => {});
  }
  /* Fallback 1: active tab in the last-focused window only.
     FIX (fragile tab targeting): using lastFocusedWindow instead of
     currentWindow avoids matching a background extension popup window
     which would have no meaningful web page to automate.              */
  const [active] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (active && isWebUrl(active.url)) return active;
  /* Fallback 2: active tab in any normal browser window (not popup/devtools) */
  const inWindows = await chrome.tabs.query({ active: true, windowType: 'normal' });
  const windowTab = inWindows.find(t => isWebUrl(t.url));
  if (windowTab) return windowTab;
  /* Fallback 3: any non-extension tab — last resort only */
  const all = await chrome.tabs.query({ windowType: 'normal' });
  return all.find(t => isWebUrl(t.url)) || null;
}

/* ── Message router ─────────────────────────────────────── */
chrome.runtime.onMessage.addListener((msg, sender, respond) => {
  const tabId   = sender?.tab?.id;
  const frameId = sender?.frameId;

  /* ── Automation start ──────────────────────────────────── */
  if (msg.type === 'POPUP_RUN') {
    startAutomation(msg).then(respond).catch(err => respond({ ok: false, error: err.message }));
    return true;
  }

  /* ── Standalone script run (from popup or scripts page) ── */
  if (msg.type === 'RUN_STANDALONE_SCRIPT') {
    runStandaloneScript(msg).then(respond).catch(err => respond({ ok: false, error: err.message, logs: [] }));
    return true;
  }

  /* ── Inline (unsaved) script run — no broadcast, returns result directly ── */
  if (msg.type === 'RUN_INLINE_SCRIPT') {
    if (!msg.code?.trim()) { respond({ ok: false, error: 'No code provided', logs: [] }); return; }
    getWebTab().then(async tab => {
      if (!tab) { respond({ ok: false, error: 'No web page found. Open a website and try again.', logs: [] }); return; }
      const alive = await pingTab(tab.id);
      if (!alive) { respond({ ok: false, error: 'FillFlow cannot reach that page. Reload it and try again.', logs: [] }); return; }
      const result = await execScript(msg.code, tab.id, null, (msg.timeout || 30) * 1000);
      respond(result);
    });
    return true;
  }

  /* ── In-flow script execution (from content.js) ─────────── */
  if (msg.type === 'BG_EXEC_FLOW_SCRIPT') {
    if (!tabId) { respond({ ok: false, error: 'No tab', logs: [] }); return; }
    execScript(msg.code, tabId, frameId ?? 0, (msg.timeout || 60) * 1000).then(respond);
    return true;
  }

  /* ── Query current tab URL (for URL guard test button) ─── */
  if (msg.type === 'QUERY_TAB_URL') {
    getWebTab().then(tab => respond({ url: tab?.url || '' }));
    return true;
  }

  /* ── Capture — first field (from popup) ────────────────── */
  if (msg.type === 'POPUP_CAPTURE_START') {
    getActiveTab().then(async tab => {
      if (!tab) { respond({ ok: false, error: 'no_tab' }); return; }
      const alive = await pingTab(tab.id);
      if (!alive) { respond({ ok: false, error: 'unreachable' }); return; }
      const fid = await findFormFrame(tab.id);
      await ss.set({ captureState: { flowId: msg.flowId, active: true } });
      chrome.tabs.sendMessage(tab.id, { type: 'CAPTURE_FIELD_START' }, { frameId: fid ?? 0 }).catch(() => {});
      chrome.runtime.sendMessage({ type: 'SP_CAPTURE_START', mode: 'first-field' }).catch(() => {});
      respond({ ok: true });
    });
    return true;
  }

  if (msg.type === 'POPUP_CAPTURE_CANCEL') {
    ss.remove('captureState').catch(() => {});
    chrome.runtime.sendMessage({ type: 'SP_CAPTURE_CANCELLED' }).catch(() => {});
    getActiveTab().then(async tab => {
      if (!tab) { respond({ ok: true }); return; }
      const fid = await findFormFrame(tab.id);
      const opts = fid != null ? { frameId: fid } : {};
      chrome.tabs.sendMessage(tab.id, { type: 'CANCEL_CAPTURE' }, opts).catch(() => {});
      respond({ ok: true });
    });
    return true;
  }

  /* ── Mid-run step capture ───────────────────────────────── */
  if (msg.type === 'BG_CAPTURE_STEP_START') {
    if (!tabId) { respond({ ok: false }); return; }
    ss.set({ captureState: {
      flowId:    msg.flowId,
      stepIndex: msg.stepIndex,
      active:    true,
      midRun:    true,
      frameId:   frameId ?? 0,
      tabId
    }}).then(() => {
      const opts = frameId != null ? { frameId } : {};
      chrome.tabs.sendMessage(tabId, {
        type: 'CAPTURE_STEP_START', stepIndex: msg.stepIndex
      }, opts).catch(() => {});
      chrome.runtime.sendMessage({ type: 'SP_CAPTURE_START', mode: 'step' }).catch(() => {});
      respond({ ok: true });
    });
    return true;
  }

  /* ── Capture results ───────────────────────────────────── */
  if (msg.type === 'FF_FIELD_CAPTURED') {
    saveFirstFieldSelector(msg.selector);
    respond({ ok: true });
    return;
  }

  if (msg.type === 'FF_STEP_FIELD_CAPTURED') {
    saveStepSelector(msg.selector, msg.stepIndex, tabId);
    respond({ ok: true });
    return;
  }

  if (msg.type === 'FF_CAPTURE_CANCELLED') {
    ss.remove('captureState').catch(() => {});
    chrome.runtime.sendMessage({ type: 'SP_CAPTURE_CANCELLED' }).catch(() => {});
    respond({ ok: true });
    return;
  }

  /* ── Separator / resume ────────────────────────────────── */
  if (msg.type === 'FF_SEPARATOR_HIT') {
    if (tabId && msg.resumePayload) {
      ss.set({ ['resume_' + tabId]: msg.resumePayload });
    }
    handleSeparatorHit(msg, tabId);
    toSidePanel({ ...msg, type: 'SP_SEPARATOR_HIT' });
    respond({ ok: true });
    return;
  }

  if (msg.type === 'FF_ENTER_SAVE_AHEAD') {
    if (tabId && msg.resumePayload) ss.set({ ['resume_' + tabId]: msg.resumePayload });
    respond({ ok: true });
    return;
  }

  if (msg.type === 'FF_CLEAR_RESUME') {
    if (tabId) ss.remove('resume_' + tabId).catch(() => {});
    respond({ ok: true });
    return;
  }

  if (msg.type === 'FF_CANCEL_NAV_ALARM') {
    /* Cancel the nav alarm for the specific tab that sent this message.
       msg.tabId is set by content.js; fall back to the sender tab.    */
    const cancelTabId = msg.tabId || tabId;
    if (cancelTabId) {
      chrome.alarms.clear('ff_nav_' + cancelTabId);
      if (navListeners[cancelTabId]) {
        chrome.tabs.onUpdated.removeListener(navListeners[cancelTabId]);
        delete navListeners[cancelTabId];
      }
      ss.remove('navTabId_' + cancelTabId).catch(() => {});
    }
    respond({ ok: true });
    return;
  }

  /* ── Frame ready — resume decision ────────────────────── */
  if (msg.type === 'FRAME_READY') {
    if (tabId != null && frameId != null) handleFrameReady(tabId, frameId, msg.hasForm);
    respond({ ok: true });
    return;
  }

  /* ── Display-only (high frequency) ─────────────────────── */
  if (['FF_STEP_TYPING','FF_WAITING_PAGE'].includes(msg.type)) {
    toSidePanel(msg);
    respond({ ok: true });
    return;
  }

  /* ── Automation events ──────────────────────────────────── */
  if (['FF_ROW_START','FF_ROW_DONE','FF_COMPLETE','FF_STOPPED',
       'FF_PAUSE','FF_COUNTDOWN','FF_WAITING_CLICK','FF_ERROR'].includes(msg.type)) {
    updateRunState(msg);
    toSidePanel(msg);
    respond({ ok: true });
    return;
  }

  /* ── Side panel controls ───────────────────────────────── */
  if (msg.type === 'SIDEPANEL_STOP') {
    chrome.tabs.sendMessage(msg.tabId, { type: 'FORCE_STOP' }).catch(() => {});
    respond({ ok: true });
    return;
  }
  if (msg.type === 'SIDEPANEL_TOGGLE_PAUSE') {
    chrome.tabs.sendMessage(msg.tabId, { type: 'FORCE_TOGGLE_PAUSE' }).catch(() => {});
    respond({ ok: true });
    return;
  }

  respond({ ok: false, error: 'unknown' });
});

/* ══════════════════════════════════════════════════════════
   SCRIPT EXECUTION
   ══════════════════════════════════════════════════════════ */

/* ── Script runner — injected into page via chrome.scripting ─
   IMPORTANT: This is serialized + deserialized by Chrome.
   No closures over outer variables are allowed.            */
function ffScriptRunner(code, timeoutMs) {
  return new Promise((resolve) => {
    const logs = [];
    const methods = ['log', 'warn', 'error', 'info'];
    const orig = {};

    methods.forEach(m => {
      orig[m] = console[m];
      console[m] = (...args) => {
        logs.push({
          level: m,
          text: args.map(a => {
            if (a === null) return 'null';
            if (a === undefined) return 'undefined';
            if (typeof a === 'object') {
              try { return JSON.stringify(a, null, 2); } catch { return String(a); }
            }
            return String(a);
          }).join(' ')
        });
        orig[m].apply(console, args);
      };
    });

    const restore = () => methods.forEach(m => { console[m] = orig[m]; });

    const timer = setTimeout(() => {
      restore();
      resolve({ ok: false, error: `Script timed out after ${timeoutMs / 1000}s`, logs });
    }, timeoutMs);

    try {
      const fn = new Function(`return (async function ffScript(){\n${code}\n})()`);
      fn()
        .then(result => {
          clearTimeout(timer); restore();
          resolve({ ok: true, logs, result: result !== undefined ? String(result) : '' });
        })
        .catch(err => {
          clearTimeout(timer); restore();
          resolve({ ok: false, error: err.message, logs });
        });
    } catch (e) {
      clearTimeout(timer); restore();
      resolve({ ok: false, error: e.message, logs });
    }
  });
}

/* ── Execute script in a tab via chrome.scripting ───────── */
async function execScript(code, tabId, frameId, timeoutMs) {
  const target = { tabId };
  if (frameId != null && frameId !== 0) target.frameIds = [frameId];
  try {
    const results = await chrome.scripting.executeScript({
      target,
      world: 'MAIN',
      func:  ffScriptRunner,
      args:  [code, timeoutMs]
    });
    return results?.[0]?.result ?? { ok: false, error: 'No result returned', logs: [] };
  } catch (e) {
    return { ok: false, error: e.message, logs: [] };
  }
}

/* ── URL guard matching ──────────────────────────────────── */
function matchesUrl(guard, url) {
  if (!guard?.enabled || !guard?.pattern?.trim()) return true;
  try {
    switch (guard.mode || 'contains') {
      case 'contains':   return url.includes(guard.pattern);
      case 'startsWith': return url.startsWith(guard.pattern);
      case 'exact':      return url === guard.pattern;
      case 'regex':      return new RegExp(guard.pattern).test(url);
      /* FIX (fail-open URL guard): unrecognized mode defaults to false
         (deny) instead of true (allow), so a corrupt config cannot
         accidentally permit execution on unintended domains.          */
      default:           return false;
    }
  } catch { return false; }
  return false;
}

/* ── Standalone script run ───────────────────────────────── */
async function runStandaloneScript(msg) {
  const { scripts } = await ps.get('scripts');
  const script = (scripts || []).find(s => s.id === msg.scriptId);
  if (!script) return { ok: false, error: 'Script not found' };

  /* Resolve tab — prefer explicitly passed tabId, else find last real web tab */
  const tabId = msg.tabId || (await getWebTab())?.id;
  if (!tabId) return { ok: false, error: 'No web page found. Open a website tab and try again.', logs: [] };

  /* Ping tab — make sure content script is reachable */
  const alive = await pingTab(tabId);
  if (!alive) return { ok: false, error: 'FillFlow cannot reach this page. Reload and try again.' };

  /* URL guard */
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  const currentUrl = tab?.url || '';
  if (!matchesUrl(script.urlGuard, currentUrl)) {
    return {
      ok: false,
      blocked: true,
      error: `URL guard blocked — current page does not match "${script.urlGuard.pattern}" (${script.urlGuard.mode || 'contains'})`,
      currentUrl
    };
  }

  /* Open side panel so user can see output */
  try {
    await chrome.sidePanel.setOptions({ tabId, path: 'sidepanel.html', enabled: true });
    await chrome.sidePanel.open({ tabId });
  } catch (_) {}

  /* Delay notification — sidePanel.open() resolves before the panel HTML has
     loaded its message listener. 250 ms gives the panel time to attach. */
  await new Promise(r => setTimeout(r, 250));
  chrome.runtime.sendMessage({ type: 'SP_SCRIPT_START', name: script.name }).catch(() => {});

  const timeoutMs = (script.timeout || 30) * 1000;
  const result = await execScript(script.code, tabId, null, timeoutMs);

  /* Forward to side panel */
  chrome.runtime.sendMessage({
    type: result.ok ? 'SP_SCRIPT_DONE' : 'SP_SCRIPT_ERROR',
    name: script.name,
    ...result
  }).catch(() => {});

  /* Update lastRunAt */
  await ps.set({
    scripts: (scripts || []).map(s =>
      s.id === msg.scriptId ? { ...s, lastRunAt: Date.now() } : s
    )
  });

  return result;
}

/* ══════════════════════════════════════════════════════════
   AUTOMATION (unchanged from v2)
   ══════════════════════════════════════════════════════════ */

async function startAutomation(msg) {
  const tab = await getActiveTab();
  if (!tab) return { ok: false, error: 'No active tab' };

  const runState = {
    status: 'starting', dryRun: !!msg.dryRun,
    layoutName: msg.layout.name, layoutStepCount: msg.layout.steps.length,
    wpm: msg.layout.wpm || 100, current: 0, total: msg.rows.length,
    log: [], tabId: tab.id, startedAt: Date.now()
  };

  await ss.remove('resume_' + tab.id);
  await ss.set({ runState });

  const alive = await pingTab(tab.id);
  if (!alive) {
    const err = { ...runState, status: 'error',
      errorMessage: 'FillFlow cannot reach this page. Reload the page and try again.' };
    await ss.set({ runState: err });
    chrome.runtime.sendMessage({ type: 'SP_ERROR', message: err.errorMessage }).catch(() => {});
    return { ok: false, error: 'unreachable' };
  }

  setTimeout(async () => {
    try {
      const frameId = await findFormFrame(tab.id);
      const opts = frameId != null ? { frameId } : {};
      await chrome.tabs.sendMessage(tab.id, {
        type: 'START_AUTOMATION', layout: msg.layout, rows: msg.rows, dryRun: !!msg.dryRun
      }, opts);
    } catch (e) {
      console.warn('[FillFlow] START_AUTOMATION failed:', e.message);
    }
  }, 600);

  return { ok: true };
}

async function pingTab(tabId) {
  try { const r = await chrome.tabs.sendMessage(tabId, { type: 'PING' }); return r?.ok === true; }
  catch { return false; }
}

async function findFormFrame(tabId) {
  let frames;
  try { frames = await chrome.webNavigation.getAllFrames({ tabId }); } catch { }
  if (!frames) { return (await pingTab(tabId)) ? 0 : null; }
  for (const f of frames) {
    try {
      const r = await chrome.tabs.sendMessage(tabId, { type: 'PING_FORM' }, { frameId: f.frameId });
      if (r?.hasForm) return f.frameId;
    } catch { }
  }
  return 0;
}

async function saveFirstFieldSelector(selector) {
  const { captureState } = await ss.get('captureState');
  if (!captureState?.active || !captureState?.flowId) return;
  const data  = await ps.get(['flows','layouts']);
  const flows = data.flows || data.layouts || [];
  await ps.set({ flows: flows.map(f =>
    f.id === captureState.flowId ? { ...f, firstFieldSelector: selector } : f
  )});
  await ss.remove('captureState');
  chrome.runtime.sendMessage({ type: 'BG_FIELD_CAPTURED', selector }).catch(() => {});
  chrome.runtime.sendMessage({ type: 'SP_CAPTURE_DONE', selector }).catch(() => {});
}

async function saveStepSelector(selector, stepIndex, tabId) {
  const { captureState } = await ss.get('captureState');
  const flowId = captureState?.flowId;
  if (!flowId) return;
  const data  = await ps.get(['flows','layouts']);
  const flows = data.flows || data.layouts || [];
  await ps.set({ flows: flows.map(flow => {
    if (flow.id !== flowId) return flow;
    const steps = (flow.steps || []).map((s, i) => i === stepIndex ? { ...s, selector } : s);
    return { ...flow, steps };
  })});
  await ss.remove('captureState');
  if (tabId) {
    const key = 'resume_' + tabId;
    const stored = await ss.get(key);
    const rs = stored[key];
    if (rs?.layout?.id === flowId && Array.isArray(rs.layout.steps) &&
        stepIndex >= 0 && stepIndex < rs.layout.steps.length) {
      rs.layout.steps[stepIndex] = { ...rs.layout.steps[stepIndex], selector };
      await ss.set({ [key]: rs });
    }
  }
  const runnerFrameId = captureState.frameId ?? 0;
  chrome.tabs.sendMessage(tabId, {
    type: 'FF_STEP_CAPTURED', selector, stepIndex
  }, { frameId: runnerFrameId }).catch(() => {});
  chrome.runtime.sendMessage({ type: 'SP_CAPTURE_DONE', selector }).catch(() => {});
}

const frameTimers     = {};
const frameCandidates = {};

async function handleFrameReady(tabId, frameId, hasForm) {
  const key = 'resume_' + tabId;
  const stored = await ss.get([key, 'runState']);
  const resumeState = stored[key];
  if (!resumeState) return;
  const rs = stored.runState;
  if (rs && ['done','stopped','error'].includes(rs.status)) {
    ss.remove(key).catch(() => {}); return;
  }
  if (!frameCandidates[tabId]) frameCandidates[tabId] = [];
  frameCandidates[tabId].push({ frameId, hasForm });
  if (frameTimers[tabId]) clearTimeout(frameTimers[tabId]);
  const delayMs = Math.round((resumeState.layout?.resumeDelay ?? 1) * 1000);
  frameTimers[tabId] = setTimeout(async () => {
    delete frameTimers[tabId];
    const candidates = frameCandidates[tabId] || [];
    delete frameCandidates[tabId];
    const check = await ss.get([key, 'runState']);
    const state = check[key];
    if (!state) return;
    const currentRs = check.runState;
    if (currentRs && ['done','stopped','error'].includes(currentRs.status)) {
      ss.remove(key).catch(() => {}); return;
    }
    const best = candidates.find(c => c.hasForm) || candidates.find(c => c.frameId === 0) || candidates[0];
    if (!best) return;
    await ss.remove(key);
    chrome.tabs.sendMessage(tabId, { type: 'START_RESUME', state }, { frameId: best.frameId })
      .catch(() => { ss.set({ [key]: state }); });
  }, delayMs);
}

/* FIX (navigation alarm race condition): use per-tab listener map and
   per-tab alarm names so concurrent runs in different tabs do not collide
   on a shared alarm name or a single session storage key.
   FIX (event listener leak): navListeners entries are also cleaned up in
   chrome.tabs.onRemoved so a closed tab cannot leave a dangling listener. */
const navListeners = {};

function handleSeparatorHit(msg, tabId) {
  const alarmName = 'ff_nav_' + tabId;
  const navKey    = 'navTabId_' + tabId;
  chrome.alarms.clear(alarmName);
  if (msg.skipNavCheck) return;
  if (!tabId) return;
  ss.set({ [navKey]: tabId });
  if (navListeners[tabId]) {
    chrome.tabs.onUpdated.removeListener(navListeners[tabId]);
    delete navListeners[tabId];
  }
  function onUpdated(id, info) {
    if (id !== tabId || info.status !== 'complete') return;
    chrome.tabs.onUpdated.removeListener(onUpdated);
    delete navListeners[tabId];
    chrome.alarms.clear(alarmName);
    ss.remove(navKey);
  }
  navListeners[tabId] = onUpdated;
  chrome.tabs.onUpdated.addListener(onUpdated);
  /* Chrome MV3 enforces a minimum alarm delay of 1 minute regardless of the
     value passed.  Use 1 to be explicit — 0.5 was being silently clamped. */
  chrome.alarms.create(alarmName, { delayInMinutes: 1 });
}

chrome.alarms.onAlarm.addListener(async alarm => {
  if (!alarm.name.startsWith('ff_nav_')) return;
  const tabId  = parseInt(alarm.name.slice('ff_nav_'.length), 10);
  const navKey = 'navTabId_' + tabId;
  const result = await ss.get(navKey);
  ss.remove(navKey).catch(() => {});
  if (!result[navKey]) return;
  /* Clean up any orphaned listener that may still be registered. */
  if (navListeners[tabId]) {
    chrome.tabs.onUpdated.removeListener(navListeners[tabId]);
    delete navListeners[tabId];
  }
  const key = 'resume_' + tabId;
  const stored = await ss.get(key);
  if (!stored[key]) return;
  await ss.remove(key);
  const { runState } = await ss.get('runState');
  if (runState) { runState.status = 'stopped'; await ss.set({ runState }); }
  chrome.runtime.sendMessage({ type: 'SP_ERROR', message:
    'Navigation expected after separator but did not happen within 60 seconds. ' +
    'Enable "Skip navigation check" on the separator if the page reloads silently.'
  }).catch(() => {});
});
async function updateRunState(msg) {
  const { runState } = await ss.get('runState');
  if (!runState) return;
  const sec = Math.round((Date.now() - (runState.startedAt || Date.now())) / 1000);
  const fmt = `${Math.floor(sec/60)}:${String(sec%60).padStart(2,'0')}`;
  switch (msg.type) {
    case 'FF_ROW_START':    runState.status = 'running'; runState.current = msg.current; runState.total = msg.total; break;
    case 'FF_ROW_DONE':     runState.log.push({ row: msg.current, status: 'done', time: fmt }); break;
    case 'FF_COMPLETE':     runState.status = 'done'; runState.current = runState.total; break;
    case 'FF_STOPPED':      runState.status = 'stopped'; break;
    case 'FF_PAUSE':        runState.status = msg.paused ? 'paused' : 'running'; break;
    case 'FF_COUNTDOWN':
    case 'FF_WAITING_CLICK': runState.status = 'starting'; break;
    case 'FF_ERROR':        runState.status = 'error'; runState.errorMessage = msg.message; break;
  }
  await ss.set({ runState });
}

function toSidePanel(msg) {
  const type = 'SP_' + msg.type.replace(/^FF_/, '');
  chrome.runtime.sendMessage({ ...msg, type }).catch(() => {});
}

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab || null;
}

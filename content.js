/* content.js — FillFlow
   Isolated-world content script, runs at document_start.
*/
(function () {
  'use strict';

  /* ── Inject page-context script for RC unlock ──────────── */
  const s = document.createElement('script');
  s.src = chrome.runtime.getURL('injected.js');
  (document.head || document.documentElement).appendChild(s);
  s.onload = () => s.remove();

  /* ── RC Unlock ─────────────────────────────────────────── */
  /* Wait for injected.js to signal it is ready before sending RC state.
     The script tag loads async — posting before it listens loses the message. */
  let injectedReady = false;
  let pendingRC     = null;

  function applyRC(value) {
    if (injectedReady) {
      window.postMessage({ __fillflow: true, type: 'SET_RC', value }, '*');
    } else {
      pendingRC = value;   /* will be sent once INJECTED_READY arrives */
    }
  }

  window.addEventListener('message', (e) => {
    /* Only accept messages from the same window — prevents spoofing from iframes */
    if (e.source !== window) return;
    if (!e.data || e.data.__fillflow !== true) return;
    if (e.data.type === 'INJECTED_READY') {
      injectedReady = true;
      if (pendingRC !== null) {
        window.postMessage({ __fillflow: true, type: 'SET_RC', value: pendingRC }, '*');
        pendingRC = null;
      }
    }
  });

  chrome.storage.local.get('rcUnlock', ({ rcUnlock }) => applyRC(!!rcUnlock));
  chrome.storage.onChanged.addListener((changes) => {
    if ('rcUnlock' in changes) applyRC(!!changes.rcUnlock.newValue);
  });

  /* ── Automation state ──────────────────────────────────── */
  let stopFlag    = false;
  let pauseFlag   = false;
  let isRunning   = false;
  let stoppedSent = false;

  let dryRun           = false;
  let captureMode         = false;
  let captureResolve      = null;
  let stepCaptureResolve  = null;   /* resolves when mid-run capture completes */

  let clickWaitMode    = false;
  let clickWaitResolve = null;

  let captureOverlay = null;

  /* ── Startup: check for pending cross-page resume ─────── */
  /* Declared after state vars so dryRun/isRunning etc. are initialised.
     Waits for DOM interactive so focusable elements exist before resuming. */
  function checkResumeOnLoad() {
    function tryResume() {
      chrome.storage.local.get(['resumeState', 'runState'], (data) => {
        const resumeState = data.resumeState;
        if (!resumeState) return;
        /* Don't resume if already running or if the run was stopped/completed */
        if (isRunning) return;
        const rs = data.runState;
        if (rs && (rs.status === 'done' || rs.status === 'stopped' || rs.status === 'error')) {
          chrome.storage.local.remove('resumeState').catch(() => {});
          return;
        }
        /* Validate shape before use — corrupt storage should not crash the runner */
        if (!resumeState.layout || !Array.isArray(resumeState.rows) ||
            !Array.isArray(resumeState.layout.steps)) {
          chrome.storage.local.remove('resumeState').catch(() => {});
          return;
        }
        dryRun = !!resumeState.dryRun;
        runAutomation(resumeState.layout, resumeState.rows,
          resumeState.startStepIndex, resumeState.startRowIndex);
      });
    }

    if (document.readyState === 'interactive' || document.readyState === 'complete') {
      tryResume();
    } else {
      document.addEventListener('DOMContentLoaded', tryResume, { once: true });
    }
  }
  checkResumeOnLoad();

  function showCaptureOverlay() {
    if (document.getElementById('__ff_capture_banner')) return;
    captureOverlay = document.createElement('div');
    captureOverlay.id = '__ff_capture_banner';
    captureOverlay.style.cssText = [
      'position:fixed','top:0','left:0','right:0','z-index:2147483647',
      'background:#2563eb','color:#fff','font-family:system-ui,sans-serif',
      'font-size:14px','font-weight:500','padding:12px 20px',
      'text-align:center','cursor:default','letter-spacing:0.01em',
      'box-shadow:0 2px 12px rgba(0,0,0,0.25)'
    ].join(';');
    captureOverlay.textContent = '🎯  FillFlow: Click the first field to capture it   ·   ESC to cancel';
    (document.body || document.documentElement).appendChild(captureOverlay);
  }

  function hideCaptureOverlay() {
    if (captureOverlay) { captureOverlay.remove(); captureOverlay = null; }
    const el = document.getElementById('__ff_capture_banner');
    if (el) el.remove();
  }

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && (isRunning || captureMode)) {
      e.stopImmediatePropagation();
      e.preventDefault();
      if (captureMode) {
        captureMode    = false;
        captureResolve = null;
        hideCaptureOverlay();
        chrome.runtime.sendMessage({ type: 'FF_CAPTURE_CANCELLED' }).catch(() => {});
        return;
      }
      stopFlag = true;
      /* Clear resume state and any pending nav alarm so ESC is fully clean */
      chrome.storage.local.remove('resumeState').catch(() => {});
      chrome.runtime.sendMessage({ type: 'FF_CANCEL_NAV_ALARM' }).catch(() => {});
      if (!stoppedSent) {
        stoppedSent = true;
        chrome.runtime.sendMessage({ type: 'FF_STOPPED', reason: 'esc' }).catch(() => {});
      }
      if (clickWaitMode && clickWaitResolve) {
        clickWaitMode = false;
        const r = clickWaitResolve;
        clickWaitResolve = null;
        r();
      }
    }
    if (e.key === 'F9' && isRunning) {
      e.stopImmediatePropagation();
      e.preventDefault();
      pauseFlag = !pauseFlag;
      chrome.runtime.sendMessage({ type: 'FF_PAUSE', paused: pauseFlag }).catch(() => {});
    }
  }, true);

  /* ── Click listener — field capture + wait-for-click ───── */
  document.addEventListener('click', (e) => {
    if (captureMode && captureResolve) {
      e.preventDefault();
      e.stopImmediatePropagation();
      captureMode = false;
      const resolve = captureResolve;
      captureResolve = null;
      resolve(buildSelector(e.target));
      return;
    }
    if (clickWaitMode && clickWaitResolve) {
      clickWaitMode = false;
      const resolve = clickWaitResolve;
      clickWaitResolve = null;
      resolve();
    }
  }, true);

  /* ── CSS selector builder ───────────────────────────────── */
  function buildSelector(el) {
    if (el.id) return '#' + CSS.escape(el.id);
    if (el.getAttribute('name'))
      return el.tagName.toLowerCase() + '[name="' + el.getAttribute('name') + '"]';
    const parts = [];
    let node = el;
    while (node && node !== document.body && node.tagName) {
      let part = node.tagName.toLowerCase();
      if (node.id) { part = '#' + CSS.escape(node.id); parts.unshift(part); break; }
      if (node.parentElement) {
        const siblings = Array.from(node.parentElement.children)
          .filter(n => n.tagName === node.tagName);
        if (siblings.length > 1)
          part += `:nth-of-type(${siblings.indexOf(node) + 1})`;
      }
      parts.unshift(part);
      node = node.parentElement;
    }
    return parts.length > 0 ? parts.join(' > ') : 'body';
  }

  /* ── Utilities ──────────────────────────────────────────── */
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  function wpmToDelay(wpm) {
    return Math.round(60000 / (Math.max(1, wpm) * 5));
  }

  async function waitIfPaused() {
    while (pauseFlag) {
      if (stopFlag) return false;
      await sleep(80);
    }
    return !stopFlag;
  }

  function send(type, data) {
    chrome.runtime.sendMessage({ type, ...data }).catch(() => {});
  }

  /* ── Tab focus navigation ────────────────────────────────── */
  function getFocusable() {
    return Array.from(document.querySelectorAll(
      'input:not([disabled]):not([type="hidden"]), select:not([disabled]), ' +
      'textarea:not([disabled]), button:not([disabled]), a[href], ' +
      '[tabindex]:not([tabindex="-1"])'
    )).filter(el => {
      if (el.offsetParent === null) return false;
      const st = window.getComputedStyle(el);
      return st.display !== 'none' && st.visibility !== 'hidden';
    });
  }

  function moveFocusForward() {
    const focusable = getFocusable();
    const idx = focusable.indexOf(document.activeElement);
    if (idx >= 0 && idx < focusable.length - 1) focusable[idx + 1].focus();
  }

  function moveFocusBackward() {
    const focusable = getFocusable();
    const idx = focusable.indexOf(document.activeElement);
    if (idx > 0) focusable[idx - 1].focus();
  }

  /* ── Key event dispatch (for character typing) ─────────── */
  function fireKey(el, evtType, key, keyCode) {
    /* code field for printable characters: letters → KeyA, digits → Digit1, others → key itself */
    const code = /^[a-zA-Z]$/.test(key) ? 'Key' + key.toUpperCase()
               : /^[0-9]$/.test(key)    ? 'Digit' + key
               : key;
    el.dispatchEvent(new KeyboardEvent(evtType, {
      key, code, keyCode, which: keyCode,
      bubbles: true, cancelable: true
    }));
  }

  /* ── Date / time input handling ─────────────────────────── */
  const DATE_INPUT_TYPES = new Set(['date', 'datetime-local', 'time', 'month', 'week']);

  function normaliseDateValue(raw, inputType) {
    const s = raw.trim();
    if (inputType === 'date') {
      if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
      const m = s.match(/^(\d{1,2})[-\/](\d{1,2})[-\/](\d{4})$/);
      if (m) return `${m[3]}-${m[2].padStart(2,'0')}-${m[1].padStart(2,'0')}`;
    }
    return s;
  }

  function fillDateInput(el, text) {
    const val   = normaliseDateValue(text, (el.type || '').toLowerCase());
    const proto = HTMLInputElement.prototype;
    const desc  = Object.getOwnPropertyDescriptor(proto, 'value');
    if (desc && desc.set) desc.set.call(el, val); else el.value = val;
    el.dispatchEvent(new Event('input',  { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function isDateField(el, fieldType) {
    if (!el || el.tagName !== 'INPUT') return false;
    if (fieldType === 'date') return true;
    if (fieldType && fieldType !== 'auto') return false;
    return DATE_INPUT_TYPES.has((el.type || '').toLowerCase());
  }

  /* ── Type text character by character ───────────────────── */
  async function typeText(text, delayMs, fieldType) {
    const el0 = document.activeElement;
    if (isDateField(el0, fieldType || 'auto')) {
      if (stopFlag) return false;
      if (!(await waitIfPaused())) return false;
      fillDateInput(el0, String(text));
      await sleep(delayMs);
      return !stopFlag;
    }

    for (const char of String(text)) {
      if (stopFlag) return false;
      if (!(await waitIfPaused())) return false;

      const el = document.activeElement;
      if (!el) { await sleep(delayMs); continue; }

      if (el.tagName === 'SELECT') {
        const lower = char.toLowerCase();
        const match = Array.from(el.options).find(o =>
          o.text.toLowerCase().startsWith(lower) ||
          o.value.toLowerCase().startsWith(lower)
        );
        if (match) {
          el.value = match.value;
          el.dispatchEvent(new Event('change', { bubbles: true }));
        }
        await sleep(delayMs);
        continue;
      }

      const code = char.charCodeAt(0);
      fireKey(el, 'keydown',  char, code);
      fireKey(el, 'keypress', char, code);

      const tag  = el.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') {
        const proto = window[tag === 'INPUT' ? 'HTMLInputElement' : 'HTMLTextAreaElement'].prototype;
        const desc  = Object.getOwnPropertyDescriptor(proto, 'value');
        if (desc && desc.set) desc.set.call(el, (el.value || '') + char);
        else el.value = (el.value || '') + char;
      }

      el.dispatchEvent(new Event('input',  { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      fireKey(el, 'keyup', char, code);

      await sleep(delayMs);
    }
    return !stopFlag;
  }

  /* ── Key maps and special key press ────────────────────── */

  /* keyCode (legacy but still checked by many sites) */
  const KEY_CODE_MAP = {
    Tab: 9, Enter: 13, Escape: 27,
    ArrowUp: 38, ArrowDown: 40, ArrowLeft: 37, ArrowRight: 39,
    Home: 36, End: 35, PageUp: 33, PageDown: 34,
    Backspace: 8, Delete: 46, Insert: 45,
    Space: 32,
    F1: 112, F2: 113, F3: 114, F4: 115, F5: 116,
    F6: 117, F7: 118, F8: 119, F9: 120, F10: 121, F11: 122, F12: 123,
    a: 65, c: 67, v: 86, x: 88, z: 90, y: 89
  };

  /* code field: physical key identifier per W3C UI Events spec.
     This is what sites check with e.code — different from e.key. */
  const KEY_CODE_FIELD_MAP = {
    Tab: 'Tab', Enter: 'Enter', Escape: 'Escape', Space: 'Space',
    ArrowUp: 'ArrowUp', ArrowDown: 'ArrowDown',
    ArrowLeft: 'ArrowLeft', ArrowRight: 'ArrowRight',
    Home: 'Home', End: 'End', PageUp: 'PageUp', PageDown: 'PageDown',
    Backspace: 'Backspace', Delete: 'Delete', Insert: 'Insert',
    F1: 'F1', F2: 'F2', F3: 'F3', F4: 'F4', F5: 'F5',
    F6: 'F6', F7: 'F7', F8: 'F8', F9: 'F9', F10: 'F10', F11: 'F11', F12: 'F12',
    a: 'KeyA', c: 'KeyC', v: 'KeyV', x: 'KeyX', z: 'KeyZ', y: 'KeyY'
  };

  /* Keys that produce a character — only these fire keypress in real browsers */
  const CHAR_KEYS = new Set([
    'Enter', 'Space',
    'a', 'c', 'v', 'x', 'z', 'y'
  ]);

  function parseKeyCombo(combo) {
    const parts = combo.split('+');
    const key   = parts[parts.length - 1];
    return {
      key,
      shift: parts.includes('Shift'),
      ctrl:  parts.includes('Ctrl'),
      alt:   parts.includes('Alt')
    };
  }

  function fireKeyWithMods(el, evtType, key, keyCode, codeField, mods) {
    el.dispatchEvent(new KeyboardEvent(evtType, {
      key,
      code:        codeField,
      keyCode,
      which:       keyCode,
      bubbles:     true,
      cancelable:  true,
      shiftKey:    !!mods.shift,
      ctrlKey:     !!mods.ctrl,
      altKey:      !!mods.alt
    }));
  }

  async function pressKey(combo) {
    const el   = document.activeElement || document.body;
    const { key, shift, ctrl, alt } = parseKeyCombo(combo);
    const kc        = KEY_CODE_MAP[key]       || 0;
    const codeField = KEY_CODE_FIELD_MAP[key] || key;
    const disp      = key === 'Space' ? ' ' : key;
    const mods      = { shift, ctrl, alt };

    fireKeyWithMods(el, 'keydown', disp, kc, codeField, mods);
    /* keypress only for keys that produce a character value —
       function keys, arrows, delete etc. never fire keypress in real browsers */
    if (CHAR_KEYS.has(key)) {
      fireKeyWithMods(el, 'keypress', disp, kc, codeField, mods);
    }
    fireKeyWithMods(el, 'keyup', disp, kc, codeField, mods);

    if (key === 'Tab') {
      if (shift) moveFocusBackward(); else moveFocusForward();
    }

    /* Browsers natively click focused buttons and links when Enter or Space
       is pressed. Replicate that behaviour so form submit buttons work. */
    if ((key === 'Enter' || key === 'Space') && !shift && !ctrl && !alt) {
      const tag  = el.tagName;
      const role = (el.getAttribute('role') || '').toLowerCase();
      const isClickable = tag === 'BUTTON' || tag === 'A' ||
        (tag === 'INPUT' && (el.type === 'submit' || el.type === 'button' || el.type === 'reset')) ||
        role === 'button' || role === 'link';
      if (isClickable) el.click();
    }

    await sleep(30);
  }

  /* ── Wait for click ──────────────────────────────────────── */
  function waitForClick() {
    return new Promise(resolve => {
      clickWaitMode    = true;
      clickWaitResolve = resolve;
    });
  }

  /* ── Wait for mid-run field capture ─────────────────────── */
  /* Asks background to trigger capture on the active tab, then waits
     for FF_STEP_CAPTURED to arrive with the saved selector. */
  function waitForStepCapture(flowId, stepIndex) {
    return new Promise(resolve => {
      stepCaptureResolve = resolve;
      chrome.runtime.sendMessage({
        type: 'BG_CAPTURE_STEP_START',
        flowId,
        stepIndex
      }).catch(() => resolve(null));
    });
  }

  /* ── Focus first field (Options A / B / C) ──────────────── */
  async function focusFirstField(layout) {
    const opt = layout.firstFieldOption || 'C';

    if (opt === 'A' && layout.firstFieldSelector) {
      const el = document.querySelector(layout.firstFieldSelector);
      if (!el) {
        send('FF_ERROR', { message: 'First field not found: ' + layout.firstFieldSelector });
        return false;
      }
      el.focus();
      await sleep(100);
      return true;
    }

    if (opt === 'B') {
      for (let i = 3; i >= 1; i--) {
        send('FF_COUNTDOWN', { seconds: i });
        await sleep(1000);
        if (stopFlag) return false;
      }
      send('FF_COUNTDOWN', { seconds: 0 });
      return true;
    }

    send('FF_WAITING_CLICK');
    await waitForClick();
    await sleep(80);
    return !stopFlag;
  }

  /* ── Condition evaluation for skip step ──────────────────── */
  function evaluateCondition(step, row) {
    const rawVal  = row[step.colIndex] != null ? String(row[step.colIndex]) : '';
    const colVal  = rawVal.trim().toLowerCase();
    const compare = (step.compareValue || '').trim().toLowerCase();

    let conditionMet;
    switch (step.operator) {
      case 'equals':   conditionMet = colVal === compare;  break;
      case 'empty':    conditionMet = colVal === '';        break;
      case 'notempty': conditionMet = colVal !== '';        break;
      default:         conditionMet = false;
    }

    /* behaviour: 'skip-if-met' or 'skip-if-not-met' */
    return step.behaviour === 'skip-if-met' ? conditionMet : !conditionMet;
  }

  /* ── Execute one step ────────────────────────────────────── */
  /* Returns: true = continue, false = abort, number = jump to flat step index */
  async function executeStep(step, row, delayMs) {
    if (stopFlag) return false;
    switch (step.type) {
      case 'type': {
        const val = row[step.colIndex] != null ? String(row[step.colIndex]) : '';
        send('FF_STEP_TYPING', { label: step.label || `Col ${step.colIndex + 1}`, value: val });
        if (dryRun) { await sleep(delayMs * Math.max(1, val.length)); return true; }
        return typeText(val, delayMs, step.fieldType || 'auto');
      }
      case 'text': {
        const val = step.value || '';
        send('FF_STEP_TYPING', { label: 'Custom text', value: val });
        if (dryRun) { await sleep(delayMs * Math.max(1, val.length)); return true; }
        return typeText(val, delayMs, step.fieldType || 'auto');
      }
      case 'key':
        send('FF_STEP_TYPING', { label: 'Key', value: step.key });
        await pressKey(step.key);
        return !stopFlag;
      case 'wait': {
        const total = Math.round((step.seconds || 1) * 1000);
        const chunk = 80;
        let done = 0;
        while (done < total) {
          if (stopFlag) return false;
          await waitIfPaused();
          await sleep(Math.min(chunk, total - done));
          done += chunk;
        }
        return !stopFlag;
      }
      case 'waitforclick':
        if (dryRun) { await sleep(delayMs); return true; }
        send('FF_WAITING_CLICK');
        await waitForClick();
        return !stopFlag;
      case 'waituntil': {
        /* Poll document.readyState until interactive or complete.
           Retry every step.retrySeconds seconds, up to step.maxRetries times. */
        const retryMs  = Math.round((step.retrySeconds || 2) * 1000);
        const maxTries = step.maxRetries || 10;
        for (let attempt = 0; attempt < maxTries; attempt++) {
          if (stopFlag) return false;
          const state = document.readyState;
          if (state === 'interactive' || state === 'complete') return true;
          send('FF_WAITING_PAGE', { attempt: attempt + 1, max: maxTries });
          await sleep(retryMs);
        }
        /* Timed out — continue anyway rather than aborting the whole flow */
        return !stopFlag;
      }
      case 'skip': {
        /* Evaluate condition — if should skip, return the jump target index.
           If jumpToIndex is null (target was deleted), treat as no-op. */
        if (step.jumpToIndex == null) return true;
        const shouldSkip = evaluateCondition(step, row);
        if (shouldSkip) return { jumpTo: step.jumpToIndex };
        return true;
      }
      case 'separator':
        /* Separator steps are markers only — execution never reaches here
           because runAutomation handles them before calling executeStep. */
        return true;
      case 'focusfield': {
        if (dryRun) { await sleep(delayMs); return true; }
        const opt = step.focusOption || 'capture';

        if (opt === 'waitforclick') {
          /* Ask user to click the desired field — every row */
          send('FF_WAITING_CLICK');
          await waitForClick();
          if (stopFlag) return false;
          /* Focus the clicked element — the click listener already handled it
             via the normal waitForClick path, focus follows naturally */
          return true;
        }

        /* Capture option */
        if (step.selector) {
          /* Selector already saved from a previous row — use it directly */
          const el = document.querySelector(step.selector);
          if (el) { el.focus(); await sleep(80); return !stopFlag; }
          /* Element not found — fall through to re-capture */
        }

        /* No selector yet (first run) — pause and ask user to click */
        send('FF_CAPTURE_STEP_NEEDED', { stepIndex: step._flatIndex });
        const selector = await waitForStepCapture(step._flowId, step._flatIndex);
        if (!selector || stopFlag) return false;

        const el = document.querySelector(selector);
        if (el) { el.focus(); await sleep(80); }
        /* Update step.selector in memory for remaining rows this session */
        step.selector = selector;
        return !stopFlag;
      }
      default:
        return true;
    }
  }

  /* ── Main runner ─────────────────────────────────────────── */
  async function runAutomation(layout, rows, startStepIndex, startRowIndex) {
    /* If already running (e.g. resume fired on a page that never navigated),
       ignore the duplicate call. */
    if (isRunning) return;

    isRunning   = true;
    stopFlag    = false;
    pauseFlag   = false;
    stoppedSent = false;

    /* Clear resume state now that we have picked it up */
    await chrome.storage.local.remove('resumeState');

    const steps        = layout.steps || [];
    const delayMs      = wpmToDelay(layout.wpm || 100);
    const firstRowIdx  = startRowIndex  || 0;
    const firstStepIdx = startStepIndex || 0;

    /* Only run focusFirstField at the very beginning of the flow.
       Skip entirely in dry run — no real page interaction needed. */
    if (!startStepIndex && !startRowIndex && !dryRun) {
      if (!(await focusFirstField(layout))) { isRunning = false; return; }
    }

    /* Annotate each step once with its flat index and flow id for mid-run capture.
       Done before the row loop so it runs exactly once, not once per row. */
    steps.forEach((st, i) => { st._flatIndex = i; st._flowId = layout.id; });

    let aborted = false;

    for (let ri = firstRowIdx; ri < rows.length && !aborted; ri++) {
      if (stopFlag || !(await waitIfPaused())) { aborted = true; break; }
      send('FF_ROW_START', { current: ri + 1, total: rows.length });

      const stepStart = (ri === firstRowIdx) ? firstStepIdx : 0;
      let si = stepStart;

      while (si < steps.length && !aborted) {
        if (stopFlag || !(await waitIfPaused())) { aborted = true; break; }

        const step = steps[si];

        /* Separator — the next step after this will be on a new page.
           Save-ahead: write resume state pointing past the separator,
           then execute the step immediately before us that caused navigation.
           Actually: separator itself is the signal. The step BEFORE the
           separator already executed (it was Enter). We just need to save
           from the step AFTER the separator and stop this page's runner. */
        if (step.type === 'separator') {
          const cleanStepsForResume = layout.steps.map(s => {
            const c = { ...s }; delete c._flatIndex; delete c._flowId; return c;
          });
          await chrome.storage.local.set({
            resumeState: {
              layout: { ...layout, steps: cleanStepsForResume },
              rows,
              startStepIndex: si + 1,
              startRowIndex:  ri,
              dryRun:         !!dryRun
            }
          });
          /* Notify background — it will start a nav timeout unless skipNavCheck is set */
          send('FF_SEPARATOR_HIT', {
            skipNavCheck: !!step.skipNavCheck,
            current: ri + 1,
            total:   rows.length
          });
          /* Stop running on this page — new page will pick up */
          isRunning = false;
          return;
        }

        /* For Enter key steps — save resume state BEFORE firing,
           pointing to the next step. If the page navigates instantly,
           the new page's startup check will find this and resume correctly.
           If no navigation happens, runAutomation continues normally and
           the resumeState will be cleared on next separator or completion. */
        const isEnter = step.type === 'key' &&
          parseKeyCombo(step.key).key === 'Enter';

        if (isEnter) {
          const cleanSteps = layout.steps.map(s => {
            const c = { ...s }; delete c._flatIndex; delete c._flowId; return c;
          });
          await chrome.storage.local.set({
            resumeState: {
              layout: { ...layout, steps: cleanSteps },
              rows,
              startStepIndex: si + 1,
              startRowIndex:  ri,
              dryRun:         !!dryRun
            }
          });
        }

        const result = await executeStep(step, rows[ri], delayMs);

        if (result === false) { aborted = true; break; }

        /* Skip step returned a jump target */
        if (result && typeof result === 'object' && 'jumpTo' in result) {
          si = result.jumpTo;
          continue;
        }

        si++;
      }

      if (!aborted) {
        send('FF_ROW_DONE', { current: ri + 1, total: rows.length });
      }
    }

    isRunning = false;

    /* Clear any leftover resume state on clean completion */
    await chrome.storage.local.remove('resumeState');

    if (!aborted) {
      send('FF_COMPLETE', { total: rows.length });
    } else if (!stoppedSent) {
      send('FF_STOPPED', { total: rows.length });
    }
    stoppedSent = false;
  }

  /* ── Message listener ────────────────────────────────────── */
  chrome.runtime.onMessage.addListener((msg, _s, respond) => {
    switch (msg.type) {
      case 'PING':
        respond({ ok: true }); break;
      case 'START_AUTOMATION':
        dryRun = !!msg.dryRun;
        runAutomation(msg.layout, msg.rows);
        respond({ ok: true }); break;
      case 'CAPTURE_FIELD_START':
        captureMode    = true;
        captureResolve = (selector) => {
          hideCaptureOverlay();
          chrome.runtime.sendMessage({ type: 'FF_FIELD_CAPTURED', selector }).catch(() => {});
        };
        showCaptureOverlay();
        respond({ ok: true }); break;
      case 'CAPTURE_STEP_START':
        /* Mid-run capture triggered by a focusfield step */
        captureMode    = true;
        captureResolve = (selector) => {
          hideCaptureOverlay();
          chrome.runtime.sendMessage({
            type: 'FF_STEP_FIELD_CAPTURED', selector, stepIndex: msg.stepIndex
          }).catch(() => {});
        };
        showCaptureOverlay();
        respond({ ok: true }); break;
      case 'FF_STEP_CAPTURED':
        /* Background confirmed selector saved — resolve the waiting Promise */
        if (stepCaptureResolve) {
          const r = stepCaptureResolve;
          stepCaptureResolve = null;
          r(msg.selector);
        }
        respond({ ok: true }); break;
      case 'CANCEL_CAPTURE':
        captureMode    = false;
        captureResolve = null;
        hideCaptureOverlay();
        if (stepCaptureResolve) {
          const r = stepCaptureResolve;
          stepCaptureResolve = null;
          r(null);   /* null = cancelled, executeStep will stop */
        }
        respond({ ok: true }); break;
      case 'FORCE_STOP':
        /* Stop button clicked in side panel */
        stopFlag = true;
        chrome.storage.local.remove('resumeState').catch(() => {});
        chrome.runtime.sendMessage({ type: 'FF_CANCEL_NAV_ALARM' }).catch(() => {});
        if (!stoppedSent) {
          stoppedSent = true;
          chrome.runtime.sendMessage({ type: 'FF_STOPPED', reason: 'button' }).catch(() => {});
        }
        /* Unblock any waiting Promises */
        if (clickWaitMode && clickWaitResolve) {
          clickWaitMode = false;
          const r = clickWaitResolve;
          clickWaitResolve = null;
          r();
        }
        if (stepCaptureResolve) {
          const r = stepCaptureResolve;
          stepCaptureResolve = null;
          r(null);
        }
        respond({ ok: true }); break;
      case 'FORCE_TOGGLE_PAUSE':
        /* Pause button clicked in side panel */
        if (isRunning) {
          pauseFlag = !pauseFlag;
          chrome.runtime.sendMessage({ type: 'FF_PAUSE', paused: pauseFlag }).catch(() => {});
        }
        respond({ ok: true }); break;
      default:
        respond({ ok: false, error: 'unknown message' });
    }
  });

})();

/* content.js — FillFlow v2.1
   Changes from v2.0:
   - Script step delegates to background via BG_EXEC_FLOW_SCRIPT
     (uses chrome.scripting.executeScript — not blocked by page CSP)
   - Removed old <script> tag injection + postMessage SCRIPT_DONE/ERROR logic
   - Added matchesUrlLocal() for in-flow script URL guard
*/
(function () {
  'use strict';

  /* ── RC Unlock ───────────────────────────────────────────── */
  const rcScript = document.createElement('script');
  rcScript.src = chrome.runtime.getURL('injected.js');
  (document.head || document.documentElement).appendChild(rcScript);
  rcScript.onload = () => rcScript.remove();

  let injectedReady = false;
  let pendingRC     = null;

  function applyRC(val) {
    if (injectedReady) window.postMessage({ __fillflow: true, type: 'SET_RC', value: val }, '*');
    else pendingRC = val;
  }

  window.addEventListener('message', (e) => {
    if (e.source !== window || !e.data?.__fillflow) return;
    if (e.data.type === 'INJECTED_READY') {
      injectedReady = true;
      if (pendingRC !== null) {
        window.postMessage({ __fillflow: true, type: 'SET_RC', value: pendingRC }, '*');
        pendingRC = null;
      }
    }
  });

  chrome.storage.local.get('rcUnlock', ({ rcUnlock }) => applyRC(!!rcUnlock));
  chrome.storage.onChanged.addListener((ch) => { if ('rcUnlock' in ch) applyRC(!!ch.rcUnlock.newValue); });

  /* ── State ───────────────────────────────────────────────── */
  let isRunning    = false;
  let stopFlag     = false;
  let pauseFlag    = false;
  let stoppedSent  = false;
  let dryRun       = false;

  let captureActive  = false;
  let captureType    = null;
  let captureStepIdx = null;

  let clickWaitResolve   = null;
  let stepCaptureResolve = null;

  /* ── Frame ready notification ────────────────────────────── */
  function notifyFrameReady() {
    const hasForm = !!document.querySelector(
      'input:not([type=hidden]):not([type=button]):not([type=submit]):not([type=reset]),select,textarea'
    );
    chrome.runtime.sendMessage({ type: 'FRAME_READY', hasForm }).catch(() => {});
  }

  if (document.readyState === 'interactive' || document.readyState === 'complete') notifyFrameReady();
  else document.addEventListener('DOMContentLoaded', notifyFrameReady, { once: true });

  /* ── Keyboard shortcuts ──────────────────────────────────── */
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && (isRunning || captureActive)) {
      e.stopImmediatePropagation(); e.preventDefault();
      if (captureActive) {
        captureActive = false; captureType = null; captureStepIdx = null;
        chrome.runtime.sendMessage({ type: 'FF_CAPTURE_CANCELLED' }).catch(() => {});
        if (stepCaptureResolve) { const r = stepCaptureResolve; stepCaptureResolve = null; r(null); }
        if (isRunning) doStop('esc');
        return;
      }
      doStop('esc');
    }
    if (e.key === 'F9' && isRunning) {
      e.stopImmediatePropagation(); e.preventDefault();
      pauseFlag = !pauseFlag;
      chrome.runtime.sendMessage({ type: 'FF_PAUSE', paused: pauseFlag }).catch(() => {});
    }
  }, true);

  function doStop(reason) {
    stopFlag = true;
    chrome.runtime.sendMessage({ type: 'FF_CLEAR_RESUME' }).catch(() => {});
    chrome.runtime.sendMessage({ type: 'FF_CANCEL_NAV_ALARM' }).catch(() => {});
    if (!stoppedSent) { stoppedSent = true; chrome.runtime.sendMessage({ type: 'FF_STOPPED', reason }).catch(() => {}); }
    if (captureActive) {
      captureActive = false; captureType = null; captureStepIdx = null;
      chrome.runtime.sendMessage({ type: 'FF_CAPTURE_CANCELLED' }).catch(() => {});
    }
    if (clickWaitResolve)   { const r = clickWaitResolve;   clickWaitResolve   = null; r(); }
    if (stepCaptureResolve) { const r = stepCaptureResolve; stepCaptureResolve = null; r(null); }
  }

  /* ── Click listener ──────────────────────────────────────── */
  document.addEventListener('click', (e) => {
    if (captureActive) {
      e.preventDefault(); e.stopImmediatePropagation();
      const sel = buildSelector(e.target);
      captureActive = false;
      if (captureType === 'first-field') {
        chrome.runtime.sendMessage({ type: 'FF_FIELD_CAPTURED', selector: sel }).catch(() => {});
      } else if (captureType === 'step') {
        chrome.runtime.sendMessage({ type: 'FF_STEP_FIELD_CAPTURED', selector: sel, stepIndex: captureStepIdx }).catch(() => {});
      }
      captureType = null; captureStepIdx = null;
      return;
    }
    if (clickWaitResolve) { const r = clickWaitResolve; clickWaitResolve = null; r(); }
  }, true);

  /* ── Selector builder ────────────────────────────────────── */
  /* Escape a string for use as a CSS attribute value in [attr="..."].
     Quotes and backslashes in the raw value would break the selector. */
  function escAttr(val) {
    return val.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  }

  function buildSelector(el) {
    if (!el?.tagName) return 'body';
    const tag = el.tagName.toLowerCase();
    if (el.id)                          return '#' + CSS.escape(el.id);
    if (el.getAttribute('name'))        return `${tag}[name="${escAttr(el.getAttribute('name'))}"]`;
    if (el.getAttribute('data-testid')) return `${tag}[data-testid="${escAttr(el.getAttribute('data-testid'))}"]`;
    if (el.getAttribute('aria-label'))  return `${tag}[aria-label="${escAttr(el.getAttribute('aria-label'))}"]`;
    if (el.getAttribute('placeholder')) return `${tag}[placeholder="${escAttr(el.getAttribute('placeholder'))}"]`;
    if (tag === 'input' && el.type && el.type !== 'text') {
      if (document.querySelectorAll(`input[type="${el.type}"]`).length === 1)
        return `${tag}[type="${el.type}"]`;
    }
    const parts = []; let node = el;
    while (node && node !== document.body && node.tagName) {
      let part = node.tagName.toLowerCase();
      if (node.id) { parts.unshift('#' + CSS.escape(node.id)); break; }
      if (node.parentElement) {
        const sibs = Array.from(node.parentElement.children).filter(n => n.tagName === node.tagName);
        if (sibs.length > 1) part += ':nth-of-type(' + (sibs.indexOf(node) + 1) + ')';
      }
      parts.unshift(part); node = node.parentElement;
    }
    return parts.length ? parts.join(' > ') : 'body';
  }

  /* ── URL guard — local check for flow script steps ─────── */
  function matchesUrlLocal(guard, url) {
    if (!guard?.enabled || !guard?.pattern?.trim()) return true;
    try {
      switch (guard.mode || 'contains') {
        case 'contains':   return url.includes(guard.pattern);
        case 'startsWith': return url.startsWith(guard.pattern);
        case 'exact':      return url === guard.pattern;
        case 'regex':      return new RegExp(guard.pattern).test(url);
        /* FIX (fail-open URL guard): unrecognized mode defaults to false. */
        default:           return false;
      }
    } catch { return false; }
    return false;
  }

  /* ── Utilities ───────────────────────────────────────────── */
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const wpmDelay = wpm => Math.round(60000 / (Math.max(1, wpm) * 5));
  const send = (type, data = {}) => chrome.runtime.sendMessage({ type, ...data }).catch(() => {});

  async function waitIfPaused() {
    while (pauseFlag) { if (stopFlag) return false; await sleep(80); }
    return !stopFlag;
  }

  /* ── Tab navigation ──────────────────────────────────────── */
  function focusable() {
    return Array.from(document.querySelectorAll(
      'input:not([disabled]):not([type=hidden]),select:not([disabled]),textarea:not([disabled]),button:not([disabled]),a[href],[tabindex]:not([tabindex="-1"])'
    )).filter(el => el.offsetParent && getComputedStyle(el).display !== 'none' && getComputedStyle(el).visibility !== 'hidden');
  }
  function tabForward()  { const f = focusable(), i = f.indexOf(document.activeElement); if (i >= 0 && i < f.length - 1) f[i+1].focus(); }
  function tabBackward() { const f = focusable(), i = f.indexOf(document.activeElement); if (i > 0) f[i-1].focus(); }

  /* ── Native field value helpers ──────────────────────────── */
  function nativeSet(el, val) {
    const tag   = el.tagName;
    const proto = window[tag === 'TEXTAREA' ? 'HTMLTextAreaElement' : 'HTMLInputElement'].prototype;
    const desc  = Object.getOwnPropertyDescriptor(proto, 'value');
    if (desc?.set) desc.set.call(el, val); else el.value = val;
  }

  function clearField() {
    const el = document.activeElement; if (!el) return;
    const tag = el.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA') {
      nativeSet(el, '');
      el.dispatchEvent(new Event('input',  { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    } else if (tag === 'SELECT') {
      el.selectedIndex = 0;
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }
  }

  function setField(el, val) {
    const tag = el.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA') {
      nativeSet(el, val);
      el.dispatchEvent(new Event('input',  { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    } else if (tag === 'SELECT') {
      const low = val.toLowerCase();
      const opt = Array.from(el.options).find(o => o.text.toLowerCase() === low || o.value.toLowerCase() === low);
      if (opt) { el.value = opt.value; el.dispatchEvent(new Event('change', { bubbles: true })); }
    }
  }

  /* ── Date handling ───────────────────────────────────────── */
  const DATE_TYPES = new Set(['date','datetime-local','time','month','week']);

  /* TD 6 FIX: support both DD/MM/YYYY and MM/DD/YYYY via step.dateFormat.
     Defaults to 'dmy' (DD/MM/YYYY) for historical compatibility.
     Set step.dateFormat = 'mdy' on type/paste steps to use US format. */
  function toDateValue(raw, type, dateFormat) {
    const s = String(raw).trim();
    if (type === 'date') {
      if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
        const [y, mth, d] = s.split('-').map(str => parseInt(str, 10));
        const dateObj = new Date(y, mth - 1, d);
        if (!isNaN(dateObj) && dateObj.getFullYear() === y && (dateObj.getMonth() + 1) === mth && dateObj.getDate() === d) {
          return s;
        }
        return s;
      }
      const m = s.match(/^(\d{1,2})[-\/](\d{1,2})[-\/](\d{4})$/);
      if (m) {
        const [, a, b, yearStr] = m;
        const [dayStr, monthStr] = (dateFormat === 'mdy') ? [b, a] : [a, b];
        const y = parseInt(yearStr, 10), mth = parseInt(monthStr, 10), d = parseInt(dayStr, 10);
        const dateObj = new Date(y, mth - 1, d);
        if (!isNaN(dateObj) && dateObj.getFullYear() === y && (dateObj.getMonth() + 1) === mth && dateObj.getDate() === d) {
          return `${y}-${String(mth).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
        }
        return s;
      }
    }
    return s;
  }

  function isDateInput(el, fieldType) {
    if (!el || el.tagName !== 'INPUT') return false;
    if (fieldType === 'date') return true;
    if (fieldType && fieldType !== 'auto') return false;
    return DATE_TYPES.has((el.type || '').toLowerCase());
  }

  /* ── Character-by-character typing ──────────────────────── */
  /* HTML spec: only these input types support selectionStart / selectionEnd.
     Reading returns null on others; *setting* them throws InvalidStateError
     (the reported crash).  Empty string covers type="" / missing type attr. */
  const SELECTION_SUPPORTED_TYPES = new Set(['text', 'search', 'url', 'tel', 'password', '']);

  function supportsSelection(el) {
    if (el.tagName === 'TEXTAREA') return true;
    if (el.tagName !== 'INPUT')    return false;
    return SELECTION_SUPPORTED_TYPES.has((el.type || '').toLowerCase());
  }

  /* Types where char-by-char simulation is wrong: intermediate values are
     invalid for the field type.  typeText routes these to setField() first;
     this set is a safety-net for any other call path. */
  const INSTANT_SET_TYPES = new Set(['number', 'range', 'color', 'email', 'month', 'week']);

  function dispatchChar(el, char) {
    const code    = char.charCodeAt(0);
    const codeStr = /^[a-zA-Z]$/.test(char) ? 'Key' + char.toUpperCase()
                  : /^\d$/.test(char)        ? 'Digit' + char : char;
    const opts = { key: char, code: codeStr, keyCode: code, which: code, bubbles: true, cancelable: true };
    el.dispatchEvent(new KeyboardEvent('keydown',  opts));
    el.dispatchEvent(new KeyboardEvent('keypress', opts));
    if (supportsSelection(el)) {
      /* BUG 3 FIX: insert at cursor position, not blindly at end of string */
      const start  = el.selectionStart ?? el.value.length;
      const end    = el.selectionEnd   ?? start;
      const before = el.value.slice(0, start);
      const after  = el.value.slice(end);
      nativeSet(el, before + char + after);
      el.selectionStart = el.selectionEnd = start + char.length;
    } else {
      /* type="number", "email", "range", "color" etc. do not support selection
         APIs — setting selectionStart/End throws InvalidStateError.  Append
         the character directly as a safe fallback. */
      nativeSet(el, el.value + char);
    }
    el.dispatchEvent(new Event('input',  { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.dispatchEvent(new KeyboardEvent('keyup', opts));
  }

  async function typeText(text, delay, fieldType, dateFormat) {
    const el0 = document.activeElement;
    if (isDateInput(el0, fieldType || 'auto')) {
      if (stopFlag || !(await waitIfPaused())) return false;
      setField(el0, toDateValue(text, (el0.type || '').toLowerCase(), dateFormat));
      await sleep(delay); return !stopFlag;
    }
    /* For input types where char-by-char produces invalid intermediate values,
       fall back to an instant set — same behaviour as the paste step type. */
    const el0b = document.activeElement;
    if (el0b?.tagName === 'INPUT' && INSTANT_SET_TYPES.has((el0b.type || '').toLowerCase())) {
      if (stopFlag || !(await waitIfPaused())) return false;
      setField(el0b, String(text));
      await sleep(delay);
      return !stopFlag;
    }

    for (const char of String(text)) {
      if (stopFlag) return false;
      if (!(await waitIfPaused())) return false;
      const el = document.activeElement;
      if (!el) { await sleep(delay); continue; }
      if (el.tagName === 'SELECT') {
        const low = char.toLowerCase();
        const opt = Array.from(el.options).find(o => o.text.toLowerCase().startsWith(low) || o.value.toLowerCase().startsWith(low));
        if (opt) { el.value = opt.value; el.dispatchEvent(new Event('change', { bubbles: true })); }
        await sleep(delay); continue;
      }
      if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') dispatchChar(el, char);
      await sleep(delay);
    }
    return !stopFlag;
  }

  /* ── Key press ───────────────────────────────────────────── */
  const KC = {
    Tab:9,Enter:13,Escape:27,Space:32,Backspace:8,Delete:46,Insert:45,
    ArrowUp:38,ArrowDown:40,ArrowLeft:37,ArrowRight:39,Home:36,End:35,PageUp:33,PageDown:34,
    F1:112,F2:113,F3:114,F4:115,F5:116,F6:117,F7:118,F8:119,F9:120,F10:121,F11:122,F12:123,
    a:65,c:67,v:86,x:88,z:90,y:89
  };
  const CF = {
    Tab:'Tab',Enter:'Enter',Escape:'Escape',Space:'Space',Backspace:'Backspace',Delete:'Delete',Insert:'Insert',
    ArrowUp:'ArrowUp',ArrowDown:'ArrowDown',ArrowLeft:'ArrowLeft',ArrowRight:'ArrowRight',
    Home:'Home',End:'End',PageUp:'PageUp',PageDown:'PageDown',
    F1:'F1',F2:'F2',F3:'F3',F4:'F4',F5:'F5',F6:'F6',F7:'F7',F8:'F8',
    F9:'F9',F10:'F10',F11:'F11',F12:'F12',
    a:'KeyA',c:'KeyC',v:'KeyV',x:'KeyX',z:'KeyZ',y:'KeyY'
  };
  const CHAR_KEYS = new Set(['Enter','Space','a','c','v','x','z','y']);

  function parseCombo(str) {
    const p = str.split('+');
    return { key: p[p.length-1], shift: p.includes('Shift'), ctrl: p.includes('Ctrl'), alt: p.includes('Alt') };
  }

  function fireKeyEvt(el, type, key, kc, cf, mods) {
    el.dispatchEvent(new KeyboardEvent(type, {
      key, code: cf, keyCode: kc, which: kc, bubbles: true, cancelable: true,
      shiftKey: !!mods.shift, ctrlKey: !!mods.ctrl, altKey: !!mods.alt
    }));
  }

  async function pressKey(combo) {
    const el = document.activeElement || document.body;
    const { key, shift, ctrl, alt } = parseCombo(combo);
    const kc = KC[key] || 0, cf = CF[key] || key, disp = key === 'Space' ? ' ' : key;
    const mods = { shift, ctrl, alt };
    fireKeyEvt(el, 'keydown', disp, kc, cf, mods);
    if (CHAR_KEYS.has(key)) fireKeyEvt(el, 'keypress', disp, kc, cf, mods);
    fireKeyEvt(el, 'keyup', disp, kc, cf, mods);
    if (key === 'Tab') { shift ? tabBackward() : tabForward(); }
    if ((key === 'Enter' || key === 'Space') && !shift && !ctrl && !alt) {
      const tag = el.tagName, role = (el.getAttribute('role') || '').toLowerCase();
      if (tag==='BUTTON'||tag==='A'||(tag==='INPUT'&&['submit','button','reset'].includes(el.type))||role==='button'||role==='link')
        el.click();
    }
    await sleep(30);
  }

  /* ── Focus first field ───────────────────────────────────── */
  async function focusFirstField(layout) {
    const opt = layout.firstFieldOption || 'C';
    if (opt === 'A' && layout.firstFieldSelector) {
      const el = document.querySelector(layout.firstFieldSelector);
      if (!el) { send('FF_ERROR', { message: 'First field not found: ' + layout.firstFieldSelector }); return false; }
      el.focus(); await sleep(100); return true;
    }
    if (opt === 'B') {
      for (let i = 3; i >= 1; i--) { send('FF_COUNTDOWN', { seconds: i }); await sleep(1000); if (stopFlag) return false; }
      send('FF_COUNTDOWN', { seconds: 0 }); return true;
    }
    send('FF_WAITING_CLICK');
    await new Promise(r => { clickWaitResolve = r; });
    await sleep(80); return !stopFlag;
  }

  /* ── Skip condition ──────────────────────────────────────── */
  function evalSkip(step, row) {
    const val  = (row[step.colIndex] != null ? String(row[step.colIndex]) : '').trim().toLowerCase();
    const cmp  = (step.compareValue || '').trim().toLowerCase();
    let met;
    switch (step.operator) {
      case 'equals':   met = val === cmp; break;
      case 'empty':    met = val === '';  break;
      case 'notempty': met = val !== '';  break;
      default:         met = false;
    }
    return step.behaviour === 'skip-if-met' ? met : !met;
  }

  /* ── Execute one step ────────────────────────────────────── */
  async function execStep(step, row, delay) {
    if (stopFlag) return false;

    switch (step.type) {

      case 'type': {
        const val = row[step.colIndex] != null ? String(row[step.colIndex]) : '';
        send('FF_STEP_TYPING', { label: step.label || `Col ${step.colIndex + 1}`, value: val });
        if (dryRun) { await sleep(delay * Math.max(1, val.length)); return true; }
        if (step.clearField !== false) clearField();
        return typeText(val, delay, step.fieldType || 'auto', step.dateFormat || 'dmy');
      }

      case 'paste': {
        const val = row[step.colIndex] != null ? String(row[step.colIndex]) : '';
        send('FF_STEP_TYPING', { label: (step.label || `Col ${step.colIndex + 1}`) + ' ⚡', value: val });
        if (dryRun) { await sleep(delay); return true; }
        if (step.clearField !== false) clearField();
        const el = document.activeElement;
        if (el) setField(el, val);
        await sleep(30); return !stopFlag;
      }

      case 'text': {
        const val = step.value || '';
        send('FF_STEP_TYPING', { label: 'Custom text', value: val });
        if (dryRun) { await sleep(delay * Math.max(1, val.length)); return true; }
        if (step.clearField !== false) clearField();
        return typeText(val, delay, step.fieldType || 'auto', step.dateFormat || 'dmy');
      }

      case 'key':
        send('FF_STEP_TYPING', { label: 'Key', value: step.key });
        await pressKey(step.key);
        return !stopFlag;

      case 'wait': {
        const total = Math.round((step.seconds || 1) * 1000), chunk = 80;
        let done = 0;
        while (done < total) {
          if (stopFlag) return false;
          if (!(await waitIfPaused())) return false;
          await sleep(Math.min(chunk, total - done)); done += chunk;
        }
        return !stopFlag;
      }

      case 'waitforclick':
        if (dryRun) { await sleep(delay); return true; }
        send('FF_WAITING_CLICK');
        await new Promise(r => { clickWaitResolve = r; });
        return !stopFlag;

      case 'waituntil': {
        /* BUG 4 FIX: document.readyState is always 'complete' in a running
           content script. Wait for a target element to appear in the DOM
           instead — step.selector targets an element that signals the page
           is ready. Falls back to a plain timed delay if no selector given. */
        const retryMs = Math.round((step.retrySeconds || 2) * 1000), max = step.maxRetries || 10;
        for (let i = 0; i < max; i++) {
          if (stopFlag) return false;
          if (!(await waitIfPaused())) return false;
          const ready = step.selector
            ? !!document.querySelector(step.selector)
            : document.readyState === 'complete';
          if (ready) return true;
          send('FF_WAITING_PAGE', { attempt: i + 1, max });
          await sleep(retryMs);
        }
        return !stopFlag;
      }

      case 'skip':
        if (step.jumpToIndex == null) return true;
        if (evalSkip(step, row)) return { jumpTo: step.jumpToIndex };
        return true;

      case 'separator': return true;

      case 'focusfield': {
        if (dryRun) { await sleep(delay); return true; }
        if (step.focusOption === 'waitforclick') {
          send('FF_WAITING_CLICK');
          await new Promise(r => { clickWaitResolve = r; });
          return !stopFlag;
        }
        if (step.selector) {
          const el = document.querySelector(step.selector);
          if (el) { el.focus(); await sleep(80); return !stopFlag; }
          send('FF_STEP_TYPING', { label: 'Focus', value: 'selector not found — re-capturing' });
        }
        const selector = await new Promise(resolve => {
          stepCaptureResolve = resolve;
          let attempts = 0;
          function trySend() {
            attempts++;
            chrome.runtime.sendMessage({ type: 'BG_CAPTURE_STEP_START', flowId: step._flowId, stepIndex: step._idx })
              .catch(() => { if (attempts < 3) setTimeout(trySend, 400); else resolve(null); });
          }
          trySend();
        });
        if (stopFlag) return false;
        if (!selector) { send('FF_ERROR', { message: 'Capture failed. Reload the page and try again.' }); return false; }
        const el = document.querySelector(selector);
        if (el) { el.focus(); await sleep(80); }
        step.selector = selector;
        return !stopFlag;
      }

      case 'script': {
        if (dryRun) { await sleep(delay); return true; }
        const code = step.code || '';
        if (!code.trim()) return true;

        send('FF_STEP_TYPING', { label: step.label || 'Script', value: '…running' });

        /* URL guard — skip this step if page URL doesn't match */
        if (step.urlGuard?.enabled && step.urlGuard?.pattern) {
          if (!matchesUrlLocal(step.urlGuard, window.location.href)) {
            send('FF_STEP_TYPING', { label: step.label || 'Script', value: '⏭ skipped (URL guard)' });
            await sleep(100);
            return !stopFlag;
          }
        }

        /* Delegate execution to background — CSP-safe via chrome.scripting.executeScript */
        const result = await new Promise(resolve => {
          chrome.runtime.sendMessage({
            type:    'BG_EXEC_FLOW_SCRIPT',
            code,
            timeout: step.timeout || 60
          }, r => resolve(r || { ok: false, error: 'No response from background', logs: [] }));
        });

        if (stopFlag) return false;
        if (!result?.ok) {
          send('FF_ERROR', { message: result?.error || 'Script error' });
          return false;
        }
        return !stopFlag;
      }

      default: return true;
    }
  }

  /* ── Main runner ─────────────────────────────────────────── */
  async function runAutomation(layout, rows, startStep, startRow) {
    if (isRunning) return;
    isRunning = true; stopFlag = false; pauseFlag = false; stoppedSent = false;

    const steps = layout.steps || [];
    const delay = wpmDelay(layout.wpm || 100);
    const ri0   = startRow  || 0;
    const si0   = startStep || 0;

    steps.forEach((s, i) => { s._idx = i; s._flowId = layout.id; });

    if (!si0 && !ri0 && !dryRun) {
      if (!(await focusFirstField(layout))) { isRunning = false; return; }
    }

    let aborted = false;

    for (let ri = ri0; ri < rows.length && !aborted; ri++) {
      if (stopFlag || !(await waitIfPaused())) { aborted = true; break; }
      send('FF_ROW_START', { current: ri + 1, total: rows.length });

      if (ri > ri0 && !dryRun && layout.firstFieldOption === 'A' && layout.firstFieldSelector) {
        const el = document.querySelector(layout.firstFieldSelector);
        if (el) { el.focus(); await sleep(80); }
      }

      let si = (ri === ri0) ? si0 : 0;

      while (si < steps.length && !aborted) {
        if (stopFlag || !(await waitIfPaused())) { aborted = true; break; }
        const step = steps[si];

        if (step.type === 'separator') {
          const clean = steps.map(s => { const c = {...s}; delete c._idx; delete c._flowId; return c; });
          send('FF_SEPARATOR_HIT', {
            skipNavCheck: !!step.skipNavCheck,
            current: ri + 1, total: rows.length,
            resumePayload: { layout: {...layout, steps: clean}, rows, startStep: si + 1, startRow: ri, dryRun: !!dryRun }
          });
          isRunning = false; return;
        }

        if (steps[si + 1]?.type === 'separator') {
          const clean = steps.map(s => { const c = {...s}; delete c._idx; delete c._flowId; return c; });
          await chrome.runtime.sendMessage({ type: 'FF_ENTER_SAVE_AHEAD',
            resumePayload: { layout: {...layout, steps: clean}, rows, startStep: si + 2, startRow: ri, dryRun: !!dryRun }
          }).catch(() => {});
        }

        const result = await execStep(step, rows[ri], delay);
        if (result === false) { aborted = true; break; }
        if (result?.jumpTo != null) { si = result.jumpTo; continue; }
        si++;
      }

      if (!aborted) send('FF_ROW_DONE', { current: ri + 1, total: rows.length });
    }

    isRunning = false;
    send('FF_CLEAR_RESUME', {});
    if (!aborted)       send('FF_COMPLETE', { total: rows.length });
    else if (!stoppedSent) send('FF_STOPPED', { total: rows.length });
    stoppedSent = false;
  }

  /* ── Message handler ─────────────────────────────────────── */
  chrome.runtime.onMessage.addListener((msg, _sender, respond) => {
    switch (msg.type) {

      case 'PING':
        respond({ ok: true }); break;

      case 'PING_FORM':
        respond({ ok: true, hasForm: !!document.querySelector(
          'input:not([type=hidden]):not([type=button]):not([type=submit]):not([type=reset]),select,textarea'
        )}); break;

      case 'START_AUTOMATION':
        dryRun = !!msg.dryRun;
        runAutomation(msg.layout, msg.rows, 0, 0);
        respond({ ok: true }); break;

      case 'START_RESUME':
        if (isRunning) { respond({ ok: false }); break; }
        dryRun = !!msg.state.dryRun;
        respond({ ok: true });
        runAutomation(msg.state.layout, msg.state.rows, msg.state.startStep, msg.state.startRow);
        break;

      case 'CAPTURE_FIELD_START':
        captureActive = true; captureType = 'first-field'; captureStepIdx = null;
        respond({ ok: true }); break;

      case 'CAPTURE_STEP_START':
        captureActive  = true;
        captureType    = 'step';
        captureStepIdx = msg.stepIndex;
        respond({ ok: true }); break;

      case 'CANCEL_CAPTURE':
        captureActive = false; captureType = null; captureStepIdx = null;
        if (stepCaptureResolve) { const r = stepCaptureResolve; stepCaptureResolve = null; r(null); }
        respond({ ok: true }); break;

      case 'FF_STEP_CAPTURED':
        if (stepCaptureResolve) { const r = stepCaptureResolve; stepCaptureResolve = null; r(msg.selector); }
        respond({ ok: true }); break;

      case 'FORCE_STOP':
        doStop('button'); respond({ ok: true }); break;

      case 'FORCE_TOGGLE_PAUSE':
        if (isRunning) { pauseFlag = !pauseFlag; chrome.runtime.sendMessage({ type: 'FF_PAUSE', paused: pauseFlag }).catch(() => {}); }
        respond({ ok: true }); break;

      default: respond({ ok: false, error: 'unknown' });
    }
  });

})();

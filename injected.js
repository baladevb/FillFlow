/* injected.js — FillFlow
   Runs in the PAGE context (MAIN world) so it can intercept page-registered
   event listeners. Loaded by content.js at document_start via a <script> tag.

   Strategy: use a high-priority CAPTURING listener at the window level that
   fires BEFORE any page listener. When RC unlock is on, we neutralise
   preventDefault on contextmenu, paste, selectstart, and dragstart events
   so the browser's default behaviour (right-click menu, paste, text selection)
   is never suppressed regardless of when page scripts registered their handlers.

   We also null out inline on* handlers and inject a style to re-enable
   user-select and pointer-events which CSS-based blockers use.
*/
(function () {
  'use strict';

  let rcEnabled = false;
  let styleEl   = null;

  /* ── Signal to content.js that we are ready ─────────────── */
  window.postMessage({ __fillflow: true, type: 'INJECTED_READY' }, '*');

  /* ── Listen for RC state from content.js ────────────────── */
  window.addEventListener('message', (e) => {
    /* Only accept messages from the same window — prevents iframe spoofing */
    if (e.source !== window) return;
    if (!e.data || e.data.__fillflow !== true) return;
    if (e.data.type === 'SET_RC') {
      rcEnabled = !!e.data.value;
      rcEnabled ? enableRC() : disableRC();
    }
  });

  /* ── Capturing interceptor ───────────────────────────────── */
  /* Fires before any page listener because useCapture = true and
     registered on window (above document). Neutralises preventDefault
     so the browser still shows the context menu / allows paste. */
  const BLOCKED_EVENTS = ['contextmenu', 'mousedown', 'paste', 'selectstart', 'dragstart', 'copy', 'cut'];

  function interceptor(e) {
    if (!rcEnabled) return;
    /* Override preventDefault so calling it does nothing */
    const real = e.preventDefault.bind(e);
    Object.defineProperty(e, 'preventDefault', {
      value: () => {},
      configurable: true,
      writable: true
    });
    /* Also stop any return false from inline handlers from blocking */
    /* We do NOT call stopPropagation — page code may need the event */
    /* Restore after a tick so the event system isn't permanently broken */
    setTimeout(() => {
      try {
        Object.defineProperty(e, 'preventDefault', {
          value: real,
          configurable: true,
          writable: true
        });
      } catch (_) {}
    }, 0);
  }

  BLOCKED_EVENTS.forEach(type => {
    window.addEventListener(type, interceptor, { capture: true, passive: false });
  });

  /* ── CSS unblock ─────────────────────────────────────────── */
  function enableRC() {
    clearInlineHandlers();
    if (!styleEl) {
      styleEl = document.createElement('style');
      styleEl.id = '__ff_rc_style';
    }
    styleEl.textContent = [
      '* { user-select: auto !important; -webkit-user-select: auto !important; }',
      '* { pointer-events: auto !important; }',
      'img { -webkit-user-drag: auto !important; }'
    ].join('\n');
    (document.head || document.documentElement || document.body).appendChild(styleEl);
  }

  function disableRC() {
    if (styleEl && styleEl.parentNode) styleEl.parentNode.removeChild(styleEl);
  }

  /* ── Clear inline on* handlers ───────────────────────────── */
  function clearInlineHandlers() {
    /* Top-level elements */
    const topTargets = [document, document.documentElement, document.head, document.body];
    const props = ['oncontextmenu','onmousedown','onpaste','onselectstart','ondragstart','oncopy','oncut'];
    topTargets.forEach(t => {
      if (!t) return;
      props.forEach(p => { try { t[p] = null; } catch (_) {} });
    });
    /* All elements in the document — sites often set onmousedown/oncontextmenu on
       specific inputs, forms, and divs rather than on body */
    try {
      document.querySelectorAll('[onmousedown],[oncontextmenu],[onselectstart]').forEach(el => {
        props.forEach(p => { try { el[p] = null; } catch (_) {} });
      });
    } catch (_) {}
  }

  /* Re-clear after DOM ready and again after load — some sites set handlers late */
  document.addEventListener('DOMContentLoaded', () => { if (rcEnabled) clearInlineHandlers(); });
  window.addEventListener('load', () => { if (rcEnabled) clearInlineHandlers(); });

  /* Also intercept future addEventListener calls for contextmenu/paste
     so dynamically added handlers are also wrapped */
  const _ael = EventTarget.prototype.addEventListener;
  EventTarget.prototype.addEventListener = function (type, fn, opts) {
    if (BLOCKED_EVENTS.includes(type) && typeof fn === 'function') {
      const wrapped = function (e) {
        if (rcEnabled) {
          const real = e.preventDefault.bind(e);
          e.preventDefault = () => {};
          try { fn.call(this, e); } finally {
            try { e.preventDefault = real; } catch (_) {}
          }
        } else {
          fn.call(this, e);
        }
      };
      return _ael.call(this, type, wrapped, opts);
    }
    return _ael.call(this, type, fn, opts);
  };

})();

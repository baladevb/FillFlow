# FillFlow

A Chrome extension for automating repetitive web form entry. Paste rows from a spreadsheet, select a saved flow, and FillFlow types everything in — including across multi-page forms. Includes a right-click and paste unlocker for sites that block them.

**Version 1.1.0**

---

## Contents

- [What it does](#what-it-does)
- [Installation](#installation)
- [Quick start](#quick-start)
- [The popup](#the-popup)
- [Building a flow](#building-a-flow)
- [Step types](#step-types)
- [Multi-page flows](#multi-page-flows)
- [First field focus](#first-field-focus)
- [Dry run](#dry-run)
- [Row preview](#row-preview)
- [Side panel](#side-panel)
- [Right-click and paste unlock](#right-click-and-paste-unlock)
- [Import and export](#import-and-export)
- [Keyboard shortcuts](#keyboard-shortcuts)
- [Data format](#data-format)
- [Known limitations](#known-limitations)
- [File structure](#file-structure)
- [Browser support](#browser-support)
- [Changelog](#changelog)
- [License](#license)

---

## What it does

You build a **flow** once: a sequence of steps describing how to fill one form — which column goes in which field, which keys to press, where to wait. Then you paste your data rows and run it. FillFlow replays the sequence for every row automatically.

It handles:
- Single-page forms with any number of fields
- Multi-page forms where submitting navigates to a new page
- Forms where a page reloads silently without a full navigation
- Fields that need focus set in a specific way
- Conditional logic — skipping a block of steps based on a column value
- Date inputs that require a specific format

The RC Unlock toggle is completely separate — it restores right-click and paste on any site that blocks them.

---

## Installation

FillFlow is not on the Chrome Web Store. Load it manually:

1. Download or clone this repository
2. Go to `chrome://extensions/` in Chrome
3. Turn on **Developer mode** (top-right toggle)
4. Click **Load unpacked**
5. Select the folder that contains `manifest.json`
6. Pin the FillFlow icon to your toolbar

To update after pulling changes, return to `chrome://extensions/` and click **↺ Reload** on the FillFlow card.

---

## Quick start

1. Open the popup → **Flows tab** → **+ New flow**
2. In the editor, add steps: **Type column** for each field, **Press key → Tab** to move between fields, **Press key → Enter** to submit
3. Set the first field focus option (see [First field focus](#first-field-focus))
4. Name the flow and click **Save flow**
5. In your spreadsheet, copy the data rows — no header, just the data
6. Open the popup → **Run tab** → paste data → select flow → **▶ Run**

---

## The popup

The popup has two tabs and a header.

**Header** — shows the current version and the RC Unlock toggle.

**Run tab:**
- Paste area — paste tab-separated rows from any spreadsheet. Row and column count shown immediately.
- Flow selector — click any saved flow to select it. Shows step count and WPM per flow.
- First row preview — appears when both data and a flow are selected. Shows the first five Type column steps mapped to your first data row. Click **See all rows →** for the full overlay.
- First field capture — appears when the selected flow uses option A. Shows capture status and a Capture / Clear button.
- Column warning — shown if the flow needs more columns than your data has.
- **⚙ Dry run** and **▶ Run** — disabled until the flow is ready.

**Flows tab** — manage saved flows. Each flow has **↓ Export**, **✎ Edit**, and **✕ Delete** buttons. **↑ Import** imports a `.fillflow.json` file. **+ New flow** opens the flow builder.

**Running view** — if automation is already running on the current tab when you open the popup, the normal UI is replaced with a status message pointing to the side panel.

**Keyboard shortcut:** `Alt+Shift+F` opens the popup from any tab. Customise at `chrome://extensions/shortcuts`.

---

## Building a flow

The flow builder opens in a full tab. The left side shows the step list. The right side is the configuration panel.

**Step list** — numbered steps with colour-coded type badges. Page separators appear as visual dividers between page sections. Use ↑ ↓ to reorder, ✕ to delete. Toggle between Normal and Compact view.

**Adding steps** — select a step type tab, configure it, then click **+ Add step**. The step appends to the end of the list.

**Typing speed** — a slider from 20 WPM to 100 WPM. Applies to all Type column and Custom text steps in the flow.

**Flow name** — required before saving.

**Export** — the **↓ Export** button in the topbar saves the current flow as a `.fillflow.json` file. Flow must be saved first.

---

## Step types

### Type column

Types the value from one column of your pasted data into the focused field, character by character at the configured speed.

| Setting | Description |
|---------|-------------|
| Column number | Which column to read. 1 = leftmost. The Excel-style letter (A, B, C…) updates live. |
| Label | Optional. Shown in the step list as "Col A — Invoice Number". |
| Field type | Auto-detect works for most fields. Set to **Date** to convert `dd-mm-yyyy` or `dd/mm/yyyy` → `yyyy-mm-dd` automatically for browser date inputs. |
| Quick Tab / Enter | Saves this step and immediately appends a Tab or Enter key step in one click. |

### Custom text

Types a fixed string on every row, not from your data. Useful for constant values, fixed codes, or default entries. Supports the same field type options as Type column.

### Press key

Dispatches a single keystroke. Tick Shift, Ctrl, and/or Alt for combinations. A live preview badge shows the exact combo.

**Available keys:** Tab, Enter, Escape, Space, Arrow Up/Down/Left/Right, Home, End, Page Up, Page Down, Backspace, Delete, Insert, F1–F12, and A/C/V/X/Z/Y for Ctrl combinations.

> **Browser-owned keys:** A warning appears for F5, F11, F12, Ctrl+W, Ctrl+T, and similar. These are intercepted by the browser before any page script sees them. FillFlow dispatches the event to the page but cannot trigger the browser-level action. Keys like F1–F4 and F6–F10 that most browsers do not claim work normally.

### Wait

Pauses for a fixed number of seconds. Use after steps that trigger server requests, animate UI, or open menus.

### Wait for click

Pauses indefinitely until you click anywhere on the page. Useful for mid-flow manual selections — for example, picking from a custom dropdown that needs a real click. ESC still works during this wait.

### Wait until ready

Polls `document.readyState` until the page reports `interactive` or `complete`. More reliable than a fixed Wait when load time varies. Configure the retry interval (seconds between checks) and max retries. If it times out, execution continues rather than stopping.

### Focus field

Moves focus to a specific field without Tab navigation. Two modes:

**Capture** — on the very first run, an overlay appears on the page. Click the field you want to focus. The CSS selector is saved permanently into this step. All subsequent rows use that selector directly with no interruption. Each Focus field step stores its own selector independently — a three-page flow can have three separate Focus field steps each pointing to a different field.

**Wait for click** — pauses on every row and waits for you to click the field. Nothing is saved. Use when the target changes between rows.

### Skip steps

Evaluates a condition on a column value and jumps to a different step if it is met.

| Setting | Description |
|---------|-------------|
| Column | Which column to check |
| Condition | `equals` (case-insensitive), `is empty`, `is not empty` |
| Value | Comparison value — only shown for `equals` |
| Behaviour | Skip if condition IS met, or skip if condition is NOT met |
| Jump to step | Target step number — drawn from the actual step list and updates when you reorder |

If the target step is deleted, the skip step is marked ⚠ invalid and becomes a no-op rather than crashing.

### Page separator

Marks a navigation boundary. Steps above run on the current page; steps below run on the next page. See [Multi-page flows](#multi-page-flows).

**Skip navigation check** — a checkbox on the separator. When ticked, FillFlow does not watch for or time out on navigation. It saves the resume position and waits for whatever happens next to trigger the content script. Use this for pages that reload content via AJAX without a full URL change.

---

## Multi-page flows

When the runner hits a separator it:

1. Saves its exact position — row index and step index — to Chrome local storage
2. Notifies the side panel
3. Stops the runner on the current page

When any new page loads, the content script checks storage on startup. If a saved position exists and the run has not been stopped or completed, it resumes from there.

**Enter key save-ahead** — because pressing Enter can tear down the page before any code runs after it, FillFlow saves the resume position *before* firing every Enter key step. If the page navigates instantly, the new page already has the correct resume point.

**Navigation timeout** — unless Skip navigation check is ticked, FillFlow watches for the tab to navigate within 30 seconds. If nothing happens, it clears the resume state and shows a clear error in the side panel with instructions.

**Recommended structure:**

```
[Page 1 steps]
Focus field — Capture     ← auto-focuses from row 2 onwards
Type Col A → Tab
Type Col B → Tab
Type Col C
Press key → Enter         ← submits and navigates
── Page 1 ↓ Page 2 ──    ← separator
Wait 2s                   ← let the new page render
[Page 2 steps]
Focus field — Capture     ← independent selector for page 2
Type Col D → Tab
Press key → Enter
```

---

## First field focus

Applies to the very first row only. From row two onwards, the cursor is expected to be on the form from the previous submission.

| Option | Behaviour |
|--------|-----------|
| **A — Capture** | Click **◎ Capture field** in the popup, then click the first input. The CSS selector is saved with the flow and used automatically every time. |
| **B — 3 second countdown** | A 3-second countdown runs after clicking Run. Click the first field during that window. |
| **C — On click** | Automation waits indefinitely after clicking Run. Your first click on the page becomes the starting point. |

---

## Dry run

Click **⚙ Dry run** instead of **▶ Run**.

FillFlow walks through the entire flow at realistic speed — the delay for each Type and Custom text step is proportional to how long typing the actual value would take — without touching the page at all. No typing, no clicking, no focus changes. First-field focus, Wait for click, and Focus field steps complete instantly.

The side panel shows **DRY RUN** in amber throughout. Row progress, step indicators, and timing all behave exactly as in a real run. Use dry run to verify step order and timing before using live data.

---

## Row preview

Once data is pasted and a flow is selected, a preview table appears showing the first five Type column steps mapped to your first data row.

Click **See all rows →** to open the full overlay. This shows every step — type steps, keys, waits, focus steps, separators — for any row. Use **‹** and **›** to navigate through all rows. Close with **✕**.

---

## Side panel

Opens automatically when a run starts. Updates in real time.

| Element | What it shows |
|---------|---------------|
| Status label | Starting, Running, Paused, Done, Stopped, Error |
| DRY RUN badge | Amber — visible throughout dry runs |
| Row counter | Large current row number and "of N rows" |
| Progress bar | Fills proportionally as rows complete |
| Flow info | Flow name, step count, WPM |
| Live typing indicator | Column label on top, current value being typed below — updates on every step |
| Message box | Countdown, waiting-for-click prompt, separator messages, errors |
| ⏸ Pause (F9) / ■ Stop | Work from the side panel without needing focus on the form tab |
| Record log | Each completed row with elapsed time |

---

## Right-click and paste unlock

Toggle **RC Unlock** to ON in the popup header. Works on any tab immediately.

FillFlow uses four techniques at once:

1. **Capturing event interceptor** — a high-priority `window` listener fires before any page handler and overrides `preventDefault` on `contextmenu`, `paste`, `selectstart`, `dragstart`, `copy`, and `cut` events
2. **Inline handler clearing** — sets `document.oncontextmenu`, `document.onpaste`, and four other inline handlers to `null`
3. **CSS override** — injects a stylesheet forcing `user-select: auto` and `pointer-events: auto` on every element
4. **Future listener wrapping** — intercepts `addEventListener` calls for the blocked event types so handlers added after the extension loads are also neutralised

Toggle OFF to return to normal behaviour everywhere.

---

## Import and export

**Export** — Flows tab: click **↓** next to any flow. Editor: click **↓ Export** in the topbar (save the flow first). Downloads as `flowname.fillflow.json`.

**Import** — Flows tab: click **↑ Import** and select a `.fillflow.json` file. Supports both a single flow object and an array of flows in the same file. Each imported flow gets a fresh ID.

---

## Keyboard shortcuts

| Shortcut | Where | Action |
|----------|-------|--------|
| `Alt+Shift+F` | Any tab | Open the popup |
| `F9` | Form tab, during run | Pause / Resume |
| `ESC` | Form tab, during run | Stop immediately |
| `ESC` | Form tab, during capture | Cancel field capture |

Change `Alt+Shift+F` at `chrome://extensions/shortcuts`.

---

## Data format

Paste tab-separated rows from Excel, Google Sheets, LibreOffice, or any spreadsheet. Copy your data rows — no header row — and paste into the popup textarea.

Columns are numbered from 1 and shown with their Excel-style letter (1 = A, 2 = B, 26 = Z, 27 = AA). You can reference columns in any order, skip columns, or use the same column in multiple steps.

---

## Known limitations

**Tab order** — FillFlow's Tab key moves to the next focusable element in DOM order. On forms with custom `tabindex` values or dynamically inserted fields this may differ from manual Tab. A **Focus field — Capture** step at the start of each page section eliminates this entirely.

**React and Angular forms** — FillFlow uses the native `HTMLInputElement` value setter to trigger framework change detection. This works in most cases. If values are not being registered, reduce the WPM speed.

**Cross-origin iframes** — the content script does not run inside cross-origin iframes. Forms embedded in a cross-origin iframe cannot be automated.

**Browser-owned shortcuts** — F5, F11, Ctrl+W, Ctrl+T, and similar shortcuts are handled by the browser before page scripts. FillFlow can dispatch the event to the page's own handlers but cannot trigger the browser action.

**`keypress` event** — FillFlow only fires `keypress` for keys that browsers actually produce it for: Enter, Space, and letter keys. Arrow keys, function keys, Delete, Backspace, and others do not fire `keypress` — this matches real browser behaviour.

---

## File structure

```
fillflow/
├── manifest.json           MV3 manifest — permissions, keyboard shortcut, icons
├── background.js           Service worker — message hub, capture coordinator,
│                           navigation timeout via chrome.alarms
├── content.js              Content script — automation engine, key dispatch,
│                           cross-page resume on load, F9/ESC/stop handlers
├── injected.js             Page-context script (MAIN world) — right-click and
│                           paste unlock via capturing event interceptors
├── popup.html / css / js   Popup — Run tab, Flows tab, preview overlay,
│                           capture section, running view
├── sidepanel.html / css / js  Side panel — live typing indicator, row progress,
│                              pause/stop controls, record log
├── editor.html / css / js  Flow builder — all step types, separators,
│                           first field options, WPM slider
└── icons/
    ├── icon16.png
    ├── icon48.png
    └── icon128.png
```

---

## Browser support

**Chrome 116 or later** — required for the Side Panel API (`chrome.sidePanel`).

Firefox is not supported. The Side Panel API is not available in Firefox's WebExtensions implementation. All other features are compatible and could be adapted with minor changes.

---

## Changelog

### v1.1.0

- **Keyboard shortcut** — `Alt+Shift+F` opens the popup from any tab
- **Version in header** — popup header now shows the current version read live from the manifest
- Stop button now cancels the navigation timeout alarm (ESC already did; Stop did not)
- Browser-owned key warning now correctly uses the `BROWSER_OWNED_KEYS` Set rather than duplicating the check
- All `chrome.runtime.sendMessage` calls in event handlers now have `.catch(() => {})` to prevent uncaught rejections when the service worker is sleeping
- `postMessage` listeners now verify `e.source === window` to prevent iframe spoofing
- `resumeState` is validated for correct shape before being passed to the runner — corrupt storage no longer leaves `isRunning` permanently stuck
- `Math.max` on paste parse guarded against empty arrays returning `-Infinity`
- Import ID generation includes a loop counter to prevent same-millisecond collisions
- Running view in popup now only shows when the active tab matches the run's tab
- Navigation alarm and `onUpdated` listener cleaned up on both ESC and Stop

### v1.0.0

- Initial release
- Form automation across single and multi-page flows
- Nine step types: Type column, Custom text, Press key, Wait, Wait for click, Wait until ready, Focus field, Skip steps, Page separator
- Per-step Focus field capture with independently saved selectors per step and per page
- Skip steps with equals / is empty / is not empty conditions and configurable jump targets
- Date auto-conversion: `dd-mm-yyyy` and `dd/mm/yyyy` → `yyyy-mm-dd` for browser date inputs
- Page separator with 30-second navigation timeout and Skip navigation check for silent reloads
- Enter key save-ahead for pages that navigate instantly on Enter
- Dry run mode with proportional timing — delay scales with value length
- First row preview and full overlay with row navigation
- Live typing indicator in side panel showing current column label and value
- Pause and Stop buttons in side panel, functional without form tab focus
- Right-click and paste unlock with four-layer interception
- Import and export flows as `.fillflow.json`
- Navigation timeout uses `chrome.alarms` — survives service worker restarts
- `tabs` permission for side panel tab queries

---

## License

MIT — see [LICENSE](LICENSE) for details.

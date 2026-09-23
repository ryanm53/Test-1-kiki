// Claude Page Agent — page side: scrapes the question, carries out the action,
// and draws the control bar.
//
// The whole file is wrapped so it can be injected a second time safely. The
// background injects it into tabs that were already open when the extension
// was installed or updated; without this, the second copy would redeclare every
// top-level const and die with a syntax error before reaching the guard.
(function pageAgent() {
if (window.__pageAgentLoaded) return;
window.__pageAgentLoaded = true;

// Selectors for elements worth interacting with
const INTERACTIVE_SEL = [
  'button',
  'a[href]',
  'input:not([type="hidden"])',
  'textarea',
  'select',
  '[role="button"]',
  '[role="link"]',
  '[role="menuitem"]',
  '[role="tab"]',
  '[role="checkbox"]',
  '[role="radio"]',
  '[role="option"]',
  '[role="listitem"]',
  '[draggable="true"]',
  '[contenteditable="true"]',
  '[data-automation-id]'
].join(', ');

// Cached element list from the last scrape — execute() uses these references
// so it operates on exactly the elements Claude was shown.
let _lastElements = [];

// On the page and drawn — but possibly scrolled out of view.
function isRendered(el) {
  const rect = el.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0) return false;
  const style = window.getComputedStyle(el);
  return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
}

function inViewport(el) {
  const r = el.getBoundingClientRect();
  return r.bottom >= 0 && r.top <= window.innerHeight
      && r.right >= 0 && r.left <= window.innerWidth;
}

function isVisible(el) {
  return isRendered(el) && inViewport(el);
}

// Resolve an element's accessible label, including aria-labelledby chains.
// Many platforms (e.g. Angular quiz apps) store the visible answer text in a
// separate <span> pointed to by aria-labelledby rather than inside the input.
function accessibleText(el) {
  // 1. aria-labelledby — follow every referenced ID and join their text
  const labelledBy = el.getAttribute('aria-labelledby');
  if (labelledBy) {
    const text = labelledBy.split(/\s+/)
      .map(id => document.getElementById(id)?.innerText?.trim() ?? '')
      .filter(Boolean)
      .join(' ');
    if (text) return text;
  }
  // 2. aria-label attribute
  const ariaLabel = el.getAttribute('aria-label');
  if (ariaLabel?.trim()) return ariaLabel.trim();
  // 3. <label for="..."> element
  if (el.id) {
    const label = document.querySelector(`label[for="${el.id.replace(/"/g, '\\"')}"]`);
    if (label) return label.innerText.trim();
  }
  // 4. Ancestor <label> (inputs nested inside their label)
  const ancestorLabel = el.closest('label');
  if (ancestorLabel) return ancestorLabel.innerText.trim();
  // 5. Element's own visible text
  return (el.innerText || el.getAttribute('title') || '').trim();
}

// Find the question text a radio/checkbox belongs to.
// For fieldsets, the legend's aria-labelledby usually points to the prompt element.
function nearestQuestionText(el) {
  const fieldset = el.closest('fieldset');
  if (fieldset) {
    const legend = fieldset.querySelector('legend');
    if (legend) {
      // Follow aria-labelledby on the legend to the prompt element
      const promptId = legend.getAttribute('aria-labelledby');
      if (promptId) {
        const promptEl = document.getElementById(promptId);
        const t = promptEl?.innerText?.trim();
        if (t) return t.slice(0, 200);
      }
      // Fallback: use the legend text itself if it's meaningful
      const legendText = legend.innerText?.trim();
      if (legendText && legendText.length > 5) return legendText.slice(0, 200);
    }
  }
  // Generic fallback: walk up looking for a .prompt or similar container
  let node = el.parentElement;
  for (let i = 0; i < 8 && node; i++) {
    const prompt = node.querySelector('.prompt, [class*="question-text"], [class*="questionText"]');
    if (prompt) {
      const t = prompt.innerText?.trim();
      if (t) return t.slice(0, 200);
    }
    node = node.parentElement;
  }
  return null;
}

// Matches real tables and ARIA grids alike — Angular apps often build the
// latter out of divs, which a `table`/`tr`/`td` selector would miss entirely.
const CELL_SEL  = 'td, th, [role="cell"], [role="gridcell"], [role="columnheader"], [role="rowheader"]';
const ROW_SEL   = 'tr, [role="row"]';
const TABLE_SEL = 'table, [role="table"], [role="grid"]';

// innerText is preferred because it reflects only what's actually visible; the
// ?? keeps an intentional empty string and falls through only when innerText
// isn't implemented at all.
const cellText = el => (el?.innerText ?? el?.textContent ?? '').trim();

// Worksheet cells carry no label of their own — their meaning comes from the
// intersection of a column header and a row header. Reconstruct that so an
// otherwise anonymous box reads as "Deferred Revenue — December 31 Adjustment".
function tableLabel(el) {
  const cell = el.closest(CELL_SEL);
  const row = cell?.closest(ROW_SEL);
  const table = cell?.closest(TABLE_SEL);
  if (!cell || !row || !table) return null;

  const cells = Array.from(row.children);
  const col = cells.indexOf(cell);
  if (col === -1) return null;

  // Row header: the nearest text to the left of this cell
  let rowLabel = '';
  for (const c of cells) {
    if (c === cell) break;
    const t = cellText(c);
    if (t) { rowLabel = t; break; }
  }

  // Column header: walk up this column for the account name. Data rows have to
  // be stepped over, or a value sitting above a blank — a pre-filled "$ 0", or
  // a figure in the row above — gets mistaken for the header and the label
  // loses the account entirely.
  //
  // A data row is recognised two ways: it holds something answerable, or it
  // carries a row label in the first column ("Balance before adjustment"),
  // whereas a header row leaves that column empty. The second test matters for
  // spreadsheet widgets, whose data rows are plain <td>s with nothing
  // answerable to detect. Stopping at the nearest match keeps each section of a
  // table on its own headers.
  const rows = Array.from(table.querySelectorAll(ROW_SEL));
  const start = rows.indexOf(row) - 1;
  const hasTargets = r =>
    r.querySelector('input, textarea, select') ||
    Array.from(r.children).some(isSheetCell);

  let colLabel = '';
  for (let i = start; i >= 0 && !colLabel; i--) {
    if (hasTargets(rows[i]) || cellText(rows[i].children[0])) continue;
    colLabel = cellText(rows[i].children[col]);
  }
  // Layouts that label every row (a leading row-number column, say) leave the
  // strict pass with nothing, so fall back to skipping only answerable rows.
  for (let i = start; i >= 0 && !colLabel; i--) {
    if (hasTargets(rows[i])) continue;
    colLabel = cellText(rows[i].children[col]);
  }

  const label = [colLabel, rowLabel].filter(Boolean).join(' — ');
  return label || null;
}

function isTableField(el) {
  return /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) && !!el.closest(TABLE_SEL);
}

// Spreadsheet widgets (McGraw Hill's accounting tool runs on jQuery.sheet)
// have no inputs at all — answers go into focusable <td> cells that you click
// and type into. Read-only cells are tagged, so the editable ones are whatever
// is focusable and isn't marked read-only.
function isSheetCell(el) {
  return el.tagName === 'TD'
    && el.matches('[tabindex]:not([tabindex="-1"]), .responseCell')
    && !el.classList.contains('td-readOnly');
}

// SIMnet's Excel simulation addresses every cell as id="cell-B7", which is far
// more useful to work from than a position in a list.
const cellAddress = el => {
  const m = /^cell-([A-Z]+\d+)$/.exec(el.id || '');
  return m ? m[1] : null;
};

function describeEl(el) {
  const question = nearestQuestionText(el);
  // Fall back to table headers when the field has no label of its own
  const text = accessibleText(el) || tableLabel(el) || '';
  return {
    tag: el.tagName.toLowerCase(),
    type: el.getAttribute('type') || null,
    text: text.slice(0, 100),
    placeholder: el.getAttribute('placeholder') || null,
    name: el.getAttribute('name') || null,
    question: question || null,
    sheet: isSheetCell(el) || undefined,
    cell: cellAddress(el) || undefined,
    // Only meaningful for spreadsheet cells. Scoped to them deliberately:
    // plenty of ordinary elements carry an "active" or "is-selected" class for
    // styling, and flagging those would tell Claude an answer had already been
    // chosen when it had not.
    selected: (cellAddress(el) && /select|active|focused/i.test(el.className))
      // A ticked radio or checkbox is the real state, not a styling guess, and
      // knowing it stops a second pass from re-answering (and so un-ticking)
      // a select-all-that-apply choice.
      || (/^(radio|checkbox)$/.test(el.getAttribute('type') || '') && el.checked === true)
      || undefined
  };
}

function scrape() {
  // Prefer the main content area to skip nav/header/footer noise
  const root = document.querySelector('[role="main"], main, article, form')
             ?? document.body;

  const all = Array.from(document.querySelectorAll(INTERACTIVE_SEL)).filter(isRendered);

  // Spreadsheet cells are plain <td>s, so they never match INTERACTIVE_SEL
  const sheetCells = Array.from(document.querySelectorAll('td')).filter(
    el => isSheetCell(el) && isRendered(el)
  );

  // A grid of fields inside a table is a worksheet — many blanks that have to be
  // filled together and kept consistent, rather than one answer to pick.
  // Deliberately not viewport-filtered: a worksheet is usually taller than the
  // screen, so requiring cells to be on-screen would hide most of the question
  // and make it look like there was nothing to answer.
  const fields = [...all.filter(isTableField), ...sheetCells];
  const isWorksheet = fields.length >= 4;

  // Drag questions need spatial reasoning over several sequential moves
  const isDrag = !!document.querySelector(
    '[data-rbd-drag-handle-draggable-id], [data-react-beautiful-dnd-drag-handle]'
  );

  // SIMnet renders a full Excel simulation: ~1500 grid cells and ~130 buttons,
  // far too much to send. Cells are addressable (id="cell-B7"), so only the
  // ones carrying data or currently selected are worth including, alongside the
  // simulated ribbon minus the surrounding page chrome.
  const simCells = Array.from(document.querySelectorAll('td.grdbdy-cell'));
  if (simCells.length > 50) {
    // The surrounding exam page's own furniture. Matched on the element itself
    // and deliberately NOT with closest(): the exam shell wraps the whole
    // simulation in a Launch_* container, so an ancestor test excludes every
    // button inside it — which is the entire ribbon.
    const CHROME = '[class*="Launch_"], .rsbtn_play, .read-speaker-btn, [class*="read-instruct"]';

    // The workbook arrives already populated and each task asks for a single
    // operation, so the ribbon is what the answer is actually made of. It gets
    // the lion's share of the budget; cells are context.
    const controls = all
      .filter(el => !el.matches(CHROME))
      // A control with no name of any kind is unusable to act on and would
      // only crowd out the ones that can be identified.
      .filter(el => (el.innerText || '').trim() || el.getAttribute('aria-label') || el.getAttribute('title'))
      .slice(0, 110);

    // Whatever cells the task names ("...to cell C7") must be present even when
    // empty, or the one cell the question is about can be the one left out.
    const named = new Set((root.innerText ?? '').slice(0, 600).match(/\b[A-Z]{1,3}\d{1,4}\b/g) ?? []);
    const cells = simCells.filter(isRendered);
    const referenced = cells.filter(c => named.has(cellAddress(c)));
    const populated = cells.filter(c =>
      !named.has(cellAddress(c)) &&
      (c.classList.contains('has-value') || /select|active|focused/i.test(c.className))
    ).slice(0, 30);

    _lastElements = [...controls, ...referenced, ...populated];
    return {
      text: (root.innerText ?? '').slice(0, 5000),
      elements: _lastElements.map(describeEl),
      isSimnet: true,      // multi-step procedure, worth the stronger model
      isWorksheet: false,
      isDrag: false
    };
  }

  // Canvas Classic Quizzes put every question on one page by default, usually
  // far taller than the window. Each choice's wording is in a <label> beside
  // the input and the question itself sits in .question_text. The ordinary
  // path below only sees what's on screen and tags every choice with the
  // screen-reader legend ("Answers"), so choices lose track of which question
  // they belong to. Take every question on the page, and name each choice's
  // question explicitly.
  const canvasQs = Array.from(document.querySelectorAll('#questions .display_question'))
    .filter(isRendered);
  if (canvasQs.length) {
    const questionOf = q => {
      const name = q.querySelector('.question_name')?.innerText?.trim() ?? '';
      const text = (q.querySelector('.question_text')?.innerText ?? '').trim();
      return name ? `${name}: ${text}` : text;
    };

    const els = [], owners = [];
    for (const q of canvasQs) {
      // Not filtered by visibility: themes restyle the native radio, and a
      // hidden input still answers the question when clicked.
      const inputs = q.querySelectorAll(
        'input[type="radio"], input[type="checkbox"], input[type="text"], input[type="number"], select'
      );
      for (const el of inputs) { els.push(el); owners.push(q); }
    }

    // Deliberately nothing else. Next is clicked by the background once the
    // page is answered, and Submit Quiz is final — handing in the quiz is the
    // student's call, never the model's.
    _lastElements = els.slice(0, 150);
    const described = _lastElements.map((el, i) => ({
      ...describeEl(el),
      question: questionOf(owners[i]).slice(0, 200)
    }));

    return {
      text: canvasQs.map(questionOf).join('\n\n').slice(0, 5000),
      elements: described,
      isCanvas: true,
      // Typed answers go in a second step after the choices are clicked
      hasBlanks: _lastElements.some(el => el.tagName === 'SELECT' || /^(text|number)$/.test(el.type)),
      isWorksheet: false,
      isDrag: false
    };
  }

  if (isWorksheet) {
    // Every cell, on-screen or not, first — so the cap can never truncate one
    // away. Remaining slots go to on-screen controls (submit, nav).
    const rest = all.filter(el => !isTableField(el) && inViewport(el));
    _lastElements = [...fields, ...rest].slice(0, 60);
  } else {
    // Ordinary questions fit on screen, so staying in the viewport keeps
    // offscreen nav and footer links out of the list.
    _lastElements = all.filter(inViewport).slice(0, 25);
  }

  return {
    text: (root.innerText ?? '').slice(0, 5000),
    elements: _lastElements.map(describeEl),
    isWorksheet,
    isDrag
  };
}

// Set a field's value so framework bindings notice. Assigning .value directly
// is invisible to React (it tracks the last value it set), so go through the
// native prototype setter and then fire the events the frameworks listen for.
function setFieldValue(el, value) {
  el.focus();
  const tag = el.tagName.toLowerCase();

  if (tag === 'select') {
    const opt = Array.from(el.options).find(
      o => o.textContent.trim().toLowerCase() === value.toLowerCase() || o.value === value
    );
    el.value = opt ? opt.value : value;
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return;
  }

  if (el.isContentEditable) {
    el.textContent = value;
    el.dispatchEvent(new InputEvent('input', { bubbles: true, data: value }));
    return;
  }

  const proto = tag === 'textarea'
    ? window.HTMLTextAreaElement.prototype
    : window.HTMLInputElement.prototype;
  const nativeSetter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
  if (nativeSetter) nativeSetter.call(el, value); else el.value = value;

  el.dispatchEvent(new InputEvent('input', { bubbles: true, data: value }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  el.dispatchEvent(new FocusEvent('blur', { bubbles: false }));
}

// A bare el.click() dispatches only a click event. Grids and toolbars commonly
// act on mousedown/mouseup instead, so a click alone leaves the selection
// untouched — the element appears clicked while nothing actually happens.
// Sending the whole sequence matches what a real click produces.
function realClick(el) {
  const r = el.getBoundingClientRect();
  const o = { bubbles: true, cancelable: true,
              clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 };
  el.dispatchEvent(new PointerEvent('pointerover', { ...o, isPrimary: true }));
  el.dispatchEvent(new MouseEvent('mouseover', o));
  el.dispatchEvent(new PointerEvent('pointerdown', { ...o, isPrimary: true }));
  el.dispatchEvent(new MouseEvent('mousedown', { ...o, buttons: 1 }));
  if (typeof el.focus === 'function') el.focus({ preventScroll: true });
  el.dispatchEvent(new PointerEvent('pointerup', { ...o, isPrimary: true }));
  el.dispatchEvent(new MouseEvent('mouseup', o));
  el.click();
}

async function execute(action) {
  try {
    // ── Fill in the blank(s) ───────────────────────────────────────────────
    if (action.action === 'fill') {
      const { fills } = action;
      if (!Array.isArray(fills) || fills.length === 0) {
        return { success: false, error: 'fill requires a non-empty fills array' };
      }

      // Worksheets are dozens of cells — smooth-scrolling each one is slow and
      // makes the page lurch, so go instant once there are more than a handful.
      const bulk = fills.length > 5;
      const scroll = bulk ? 'auto' : 'smooth';
      const settle = bulk ? 60 : 200;

      const failed = [];
      for (const f of fills) {
        const i = f?.index;
        if (typeof i !== 'number' || i < 0 || i >= _lastElements.length) {
          failed.push(`[${i}] out of range`);
          continue;
        }
        const el = _lastElements[i];
        // A cell can go stale if the page re-renders mid-fill; skip it and keep
        // going rather than throwing away every value already entered.
        if (!document.contains(el)) {
          failed.push(`[${i}] left the page`);
          continue;
        }
        el.scrollIntoView({ behavior: scroll, block: 'center' });
        await new Promise(r => setTimeout(r, bulk ? 20 : 120));
        setFieldValue(el, String(f.value ?? ''));
        await new Promise(r => setTimeout(r, settle));
      }

      if (failed.length === fills.length) {
        return { success: false, error: `No fields could be filled: ${failed.join(', ')}` };
      }
      if (failed.length) {
        return { success: false, error: `Filled ${fills.length - failed.length}/${fills.length}; missed ${failed.join(', ')}` };
      }
      return { success: true };
    }

    // ── Multi-select ───────────────────────────────────────────────────────
    if (action.action === 'clickMany') {
      const { indexes } = action;
      if (!Array.isArray(indexes) || indexes.length === 0) {
        return { success: false, error: 'clickMany requires a non-empty indexes array' };
      }
      for (const idx of indexes) {
        if (typeof idx !== 'number' || idx < 0 || idx >= _lastElements.length) {
          return { success: false, error: `Index ${idx} out of range (${_lastElements.length} elements)` };
        }
        const el = _lastElements[idx];
        if (!document.contains(el)) {
          return { success: false, error: `Element [${idx}] is no longer in the DOM` };
        }
        // Skip choices already selected, so we never toggle one back off
        if (el.checked === true || el.getAttribute('aria-checked') === 'true') continue;

        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        await new Promise(r => setTimeout(r, 120));
        el.focus();
        el.click();
        await new Promise(r => setTimeout(r, 250));
      }
      return { success: true };
    }

    // ── Single click ───────────────────────────────────────────────────────
    if (action.action === 'click') {
      const { index } = action;
      if (typeof index !== 'number' || index < 0 || index >= _lastElements.length) {
        return { success: false, error: `Index ${index} out of range (${_lastElements.length} elements)` };
      }
      const el = _lastElements[index];
      if (!document.contains(el)) {
        return { success: false, error: `Element [${index}] is no longer in the DOM` };
      }
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      await new Promise(r => setTimeout(r, 150));
      realClick(el);
      return { success: true };
    }

    return { success: false, error: `Unknown action type: ${action.action}` };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

// After the extension is reloaded or updated, an already-open page keeps
// running this old copy, but its link back to the extension is dead: every
// chrome.* call throws "Extension context invalidated". Nothing here may throw
// on that, or pressing play does nothing at all with no explanation.
function extensionAlive() {
  try { return !!chrome.runtime?.id; } catch (_) { return false; }
}

const RELOAD_MSG = 'The extension was updated. Refresh this page to reconnect.';

const store = {
  get(keys, cb) {
    // The fallback must not fire once the real callback has run: an error
    // thrown inside cb would otherwise land in this catch and run cb again
    // with empty settings, quietly undoing whatever it had just done.
    let answered = false;
    const once = res => { if (answered) return; answered = true; cb(res ?? {}); };
    if (!extensionAlive()) { once({}); return; }
    try { chrome.storage.local.get(keys, once); }
    catch (_) { once({}); }
  },
  set(obj, cb) {
    if (!extensionAlive()) { cb && cb(); return; }
    try { chrome.storage.local.set(obj, cb); }
    catch (_) { cb && cb(); }
  }
};

// The background reports each step of a run through here. It is set by the
// control bar once that exists, and stays null in iframes, which have none.
let progressHook = null;

// Every message to the background comes through here, so a dead connection is
// always reported as something the user can act on.
function bgSend(msg, cb) {
  if (!extensionAlive()) { cb?.(null, RELOAD_MSG); return; }
  try {
    chrome.runtime.sendMessage(msg, res => {
      const err = chrome.runtime.lastError?.message;
      if (err) cb?.(null, /context invalidated|port closed|receiving end/i.test(err) ? RELOAD_MSG : err);
      else cb?.(res, null);
    });
  } catch (_) {
    cb?.(null, RELOAD_MSG);
  }
}

// ── Floating widget ──────────────────────────────────────────────────────────

(function injectWidget() {
  // The script runs in every frame so it can reach questions rendered inside an
  // iframe, but only the top frame gets the control bar.
  if (window.top !== window) return;
  if (document.getElementById('__cap-host')) return;

  const host = document.createElement('div');
  host.id = '__cap-host';
  host.style.cssText = 'position:fixed;bottom:22px;left:22px;z-index:2147483647;';

  const shadow = host.attachShadow({ mode: 'open' });

  const ICON_PLAY  = '<svg viewBox="0 0 24 24" width="15" height="15"><path d="M8 5.14v13.72L19 12z"/></svg>';
  const ICON_PAUSE = '<svg viewBox="0 0 24 24" width="15" height="15"><path d="M6.5 5h3.5v14H6.5zM14 5h3.5v14H14z"/></svg>';
  const ICON_GEAR  = '<svg viewBox="0 0 24 24" width="15" height="15"><path d="M12 15.5a3.5 3.5 0 1 1 0-7 3.5 3.5 0 0 1 0 7zm7.4-2.6l1.8 1.4-1.9 3.3-2.2-.7a7.8 7.8 0 0 1-1.6.9l-.4 2.2h-3.8l-.4-2.2a7.8 7.8 0 0 1-1.6-.9l-2.2.7-1.9-3.3 1.8-1.4a7.6 7.6 0 0 1 0-1.8L2.8 9.7l1.9-3.3 2.2.7a7.8 7.8 0 0 1 1.6-.9l.4-2.2h3.8l.4 2.2c.6.2 1.1.5 1.6.9l2.2-.7 1.9 3.3-1.8 1.4a7.6 7.6 0 0 1 0 1.8z"/></svg>';

  shadow.innerHTML = `
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

  :host, #root {
    font-family: -apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Helvetica Neue', sans-serif;
    -webkit-font-smoothing: antialiased;
  }

  /* ── Surfaces ── */
  .glass {
    background: rgba(28, 28, 30, 0.72);
    backdrop-filter: blur(22px) saturate(180%);
    -webkit-backdrop-filter: blur(22px) saturate(180%);
    border: 0.5px solid rgba(255, 255, 255, 0.12);
    box-shadow: 0 8px 32px rgba(0, 0, 0, 0.44), 0 1px 2px rgba(0, 0, 0, 0.3);
  }

  /* ── Status bar ── */
  #bar {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 7px 8px 7px 7px;
    border-radius: 15px;
    user-select: none;
    cursor: grab;
    touch-action: none;          /* so a touch drag moves the bar, not the page */
  }
  #bar.dragging { cursor: grabbing; }
  #bar button { cursor: pointer; }

  #go {
    width: 30px; height: 30px;
    flex-shrink: 0;
    border: none;
    border-radius: 50%;
    background: #0A84FF;
    color: #fff;
    display: flex; align-items: center; justify-content: center;
    cursor: pointer;
    transition: background 0.2s, transform 0.12s;
  }
  #go svg { fill: currentColor; display: block; }
  #go:hover { background: #3D9EFF; }
  #go:active { transform: scale(0.93); }
  #go.active { background: rgba(120, 120, 128, 0.38); }
  #go.active:hover { background: rgba(120, 120, 128, 0.5); }

  #status {
    display: flex;
    align-items: center;
    gap: 7px;
    min-width: 96px;
    max-width: 230px;
    font-size: 13px;
    letter-spacing: -0.01em;
    color: #f5f5f7;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  #statusText { overflow: hidden; text-overflow: ellipsis; }
  #statusText.err { color: #FF9F96; white-space: normal; font-size: 12px; line-height: 1.35; }
  #status.err { max-width: 250px; white-space: normal; }

  .dot { width: 7px; height: 7px; border-radius: 50%; flex-shrink: 0; }
  .dot.idle { background: rgba(235, 235, 245, 0.32); }
  .dot.run  { background: #30D158; animation: breathe 1.8s ease-in-out infinite; }
  .dot.hold { background: #FF9F0A; }
  .dot.err  { background: #FF453A; }
  @keyframes breathe { 0%,100% { opacity: 1; } 50% { opacity: 0.35; } }

  #gear {
    width: 26px; height: 26px;
    flex-shrink: 0;
    border: none;
    background: transparent;
    border-radius: 7px;
    color: rgba(235, 235, 245, 0.45);
    display: flex; align-items: center; justify-content: center;
    cursor: pointer;
    transition: color 0.18s, background 0.18s;
  }
  #gear svg { fill: currentColor; display: block; }
  #gear:hover { color: #f5f5f7; background: rgba(120, 120, 128, 0.26); }
  #gear.open { color: #0A84FF; }

  /* ── Panel ── */
  #panel {
    position: absolute;
    bottom: 52px; left: 0;
    width: 318px;
    max-height: 74vh;
    overflow-y: auto;
    border-radius: 17px;
    opacity: 0;
    transform: translateY(6px) scale(0.98);
    transform-origin: bottom left;
    transition: opacity 0.2s cubic-bezier(0.32,0.72,0,1), transform 0.2s cubic-bezier(0.32,0.72,0,1);
    pointer-events: none;
  }
  /* The panel hangs off the bar, so once the bar can be dragged anywhere the
     panel has to pick a side — otherwise it opens off the edge of the screen. */
  #panel.below {
    bottom: auto; top: 52px;
    transform: translateY(-6px) scale(0.98);
    transform-origin: top left;
  }
  #panel.alignRight { left: auto; right: 0; transform-origin: bottom right; }
  #panel.below.alignRight { transform-origin: top right; }

  #panel.show { opacity: 1; transform: translateY(0) scale(1); pointer-events: auto; }
  #panel::-webkit-scrollbar { width: 0; }

  #head {
    display: flex; align-items: center; justify-content: space-between;
    padding: 13px 14px 11px;
    border-bottom: 0.5px solid rgba(255, 255, 255, 0.1);
    position: sticky; top: 0;
    background: rgba(28, 28, 30, 0.82);
    backdrop-filter: blur(22px);
    -webkit-backdrop-filter: blur(22px);
    border-radius: 17px 17px 0 0;
  }
  #head span { font-size: 14px; font-weight: 600; color: #f5f5f7; letter-spacing: -0.01em; }
  #close {
    width: 22px; height: 22px; border: none;
    background: rgba(120, 120, 128, 0.3);
    border-radius: 50%; color: rgba(235, 235, 245, 0.6);
    font-size: 13px; line-height: 1; cursor: pointer;
    display: flex; align-items: center; justify-content: center;
    transition: background 0.15s, color 0.15s;
  }
  #close:hover { background: rgba(120, 120, 128, 0.45); color: #f5f5f7; }

  #body { padding: 12px 14px 15px; }

  .label {
    font-size: 11px; font-weight: 600;
    letter-spacing: 0.05em; text-transform: uppercase;
    color: rgba(235, 235, 245, 0.42);
    margin: 0 0 6px 3px;
  }
  .label:not(:first-child) { margin-top: 15px; }
  .opt {
    font-size: 10px; font-weight: 500;
    text-transform: none; letter-spacing: 0;
    color: rgba(235, 235, 245, 0.28);
    margin-left: 5px;
  }

  .group {
    background: rgba(118, 118, 128, 0.18);
    border-radius: 10px;
    overflow: hidden;
  }

  .row {
    display: flex; align-items: center; gap: 9px;
    padding: 0 11px;
    min-height: 40px;
  }
  .row + .row { border-top: 0.5px solid rgba(255, 255, 255, 0.08); }
  .row-label { flex: 1; font-size: 13.5px; color: #f5f5f7; letter-spacing: -0.01em; }
  .row-hint { font-size: 11.5px; color: rgba(235,235,245,0.4); margin: 6px 3px 0; line-height: 1.4; }

  /* Inputs */
  select, textarea, input[type="password"], input[type="url"] {
    width: 100%;
    background: transparent;
    border: none;
    outline: none;
    color: #f5f5f7;
    font-family: inherit;
    font-size: 13.5px;
    letter-spacing: -0.01em;
  }
  select {
    padding: 10px 0;
    cursor: pointer;
    appearance: none;
    -webkit-appearance: none;
  }
  select option { background: #2c2c2e; color: #f5f5f7; }
  textarea {
    padding: 10px 11px;
    resize: none;
    min-height: 66px;
    line-height: 1.45;
  }
  input[type="password"], input[type="url"] {
    flex: 1;
    padding: 10px 0;
    font-size: 12.5px;
  }
  ::placeholder { color: rgba(235, 235, 245, 0.28); }

  .chev {
    flex-shrink: 0; font-size: 10px;
    color: rgba(235, 235, 245, 0.35);
    pointer-events: none;
  }

  .inline-btn {
    flex-shrink: 0; border: none; background: transparent;
    color: #0A84FF; font-family: inherit;
    font-size: 13.5px; font-weight: 500;
    cursor: pointer; padding: 4px 0;
    transition: opacity 0.15s;
  }
  .inline-btn:hover { opacity: 0.7; }
  .inline-btn.done { color: #30D158; }

  /* iOS switch */
  .switch {
    width: 40px; height: 24px; flex-shrink: 0;
    border-radius: 999px;
    background: rgba(120, 120, 128, 0.36);
    position: relative; cursor: pointer;
    transition: background 0.26s cubic-bezier(0.32,0.72,0,1);
  }
  .switch.on { background: #30D158; }
  .switch::after {
    content: ''; position: absolute; top: 2px; left: 2px;
    width: 20px; height: 20px; border-radius: 50%;
    background: #fff;
    box-shadow: 0 2px 5px rgba(0,0,0,0.28);
    transition: transform 0.26s cubic-bezier(0.32,0.72,0,1);
  }
  .switch.on::after { transform: translateX(16px); }

  /* Reference list */
  .ref-row span {
    flex: 1; font-size: 12px;
    color: rgba(235, 235, 245, 0.62);
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .ref-del {
    flex-shrink: 0; border: none; background: transparent;
    color: rgba(235, 235, 245, 0.3);
    font-size: 15px; line-height: 1; cursor: pointer; padding: 2px 0;
    transition: color 0.15s;
  }
  .ref-del:hover { color: #FF453A; }
  .empty { font-size: 12.5px; color: rgba(235,235,245,0.3); padding: 11px; text-align: center; }
</style>

<div id="root">
  <div id="panel" class="glass">
    <div id="head">
      <span>Page Agent</span>
      <button id="close">✕</button>
    </div>
    <div id="body">

      <div class="label">Mode</div>
      <div class="group">
        <div class="row">
          <select id="preset"></select>
          <span class="chev">▼</span>
        </div>
        <div class="row">
          <span class="row-label">Auto-continue</span>
          <div class="switch" id="autoSw"></div>
        </div>
      </div>
      <div class="row-hint">Keeps going to the next question on its own.</div>

      <div class="label">Model</div>
      <div class="group">
        <div class="row">
          <select id="model"></select>
          <span class="chev">▼</span>
        </div>
        <div class="row">
          <span class="row-label">Upgrade on hard questions</span>
          <div class="switch" id="upgradeSw"></div>
        </div>
      </div>
      <div class="row-hint" id="modelHint"></div>
      <div class="row-hint">Worksheets and drag questions use one tier up, where the cheap model tends to slip. Everything else stays on your pick.</div>

      <div class="label">Notes <span class="opt">Optional</span></div>
      <div class="group">
        <textarea id="notes" rows="3" placeholder="e.g. This is financial accounting — use GAAP conventions."></textarea>
      </div>
      <div class="row-hint">Course context or hints. Leave blank if you don't need it.</div>

      <div class="label">API Key</div>
      <div class="group">
        <div class="row">
          <input type="password" id="key" placeholder="sk-ant-api03-…" autocomplete="off" spellcheck="false" />
          <button class="inline-btn" id="saveKey">Save</button>
        </div>
      </div>

      <div class="label">Reference Tabs</div>
      <div class="group">
        <div class="row">
          <input type="url" id="refUrl" placeholder="https://…" spellcheck="false" />
          <button class="inline-btn" id="addRef">Add</button>
        </div>
        <div id="refList"></div>
      </div>
      <div class="row-hint">Open tabs it can read as source material.</div>

      <div class="label">Troubleshooting</div>
      <div class="group">
        <div class="row">
          <span class="row-label">Copy last prompt</span>
          <button class="inline-btn" id="copyPrompt">Copy</button>
        </div>
      </div>
      <div class="row-hint">Copies exactly what was last sent to Claude, for diagnosing wrong answers.</div>

    </div>
  </div>

  <div id="bar" class="glass">
    <button id="go"></button>
    <div id="status"><span class="dot idle" id="dot"></span><span id="statusText">Ready</span></div>
    <button id="gear"></button>
  </div>
</div>
  `;

  const $ = id => shadow.getElementById(id);
  const goBtn = $('go'), gear = $('gear'), panel = $('panel'), closeBtn = $('close');
  const bar = $('bar');
  const dot = $('dot'), statusText = $('statusText'), statusWrap = $('status');
  const presetSel = $('preset'), notesInput = $('notes'), autoSw = $('autoSw');
  const modelSel = $('model'), modelHint = $('modelHint'), upgradeSw = $('upgradeSw');
  const keyInput = $('key'), saveKeyBtn = $('saveKey');
  const refInput = $('refUrl'), addRefBtn = $('addRef'), refList = $('refList');
  const copyPromptBtn = $('copyPrompt');

  gear.innerHTML = ICON_GEAR;

  // ── State ──────────────────────────────────────────────────────────────────
  let presetIndex = 0;     // which post-answer flow; also supplies postClicks
  let notes = '';          // optional user context, sent only when non-empty
  let autoContinue = true;
  let autoUpgrade = true;
  let refUrls = [];
  let hasKey = false;
  let lastModel = '';    // model the most recent question actually used

  let isRunning = false;   // a request is in flight
  let waiting   = false;   // between questions, watching for the page to change
  let paused    = false;
  let answered  = 0;
  let errorMsg  = '';
  let rateSecs  = 0;
  let stepNote  = '';      // "step 2/6" during a multi-step task
  let infoMsg   = '';      // a finished run's closing note — not an error

  let runToken = 0;        // bumped on stop so in-flight replies are ignored
  let pollTimer = null, rateTimer = null, watchdog = null;

  const PRESETS = [
    {
      label: 'Answer, confidence, next',
      postClicks: [
        // Optional: Connect's worksheets and other sites have no confidence
        // rating, and should go straight to Next rather than stop with an error.
        // Where Connect does need it, Next stays disabled without it — so a
        // genuinely missed click still surfaces, just one step later.
        { label: 'High Confidence', optional: true, candidates: [{ selector: '[data-automation-id="confidence-buttons--high_confidence"]' }, { ariaLabel: 'High Confidence' }] },
        { label: 'Next Question',   candidates: [{ selector: '.next-button' }, { text: 'Next Question' }, { text: 'Next' }] }
      ]
    },
    { label: 'Answer only', postClicks: [] }
  ];

  PRESETS.forEach((p, i) => {
    const o = document.createElement('option');
    o.value = i; o.textContent = p.label;
    presetSel.appendChild(o);
  });

  // Keep in sync with MODELS in background.js
  const MODEL_LIST = [
    { id: 'claude-haiku-4-5', label: 'Haiku 4.5', note: 'Fastest and cheapest — about $0.05 per 100 questions.' },
    { id: 'claude-sonnet-5',  label: 'Sonnet 5',  note: 'Noticeably better at the subject matter. Roughly 2× the cost.' },
    { id: 'claude-opus-5',    label: 'Opus 5',    note: 'Most capable, and slower. Roughly 5× the cost.' }
  ];
  const DEFAULT_MODEL = 'claude-haiku-4-5';

  MODEL_LIST.forEach(m => {
    const o = document.createElement('option');
    o.value = m.id; o.textContent = m.label;
    modelSel.appendChild(o);
  });

  function showModelHint() {
    modelHint.textContent = MODEL_LIST.find(m => m.id === modelSel.value)?.note ?? '';
  }

  modelSel.addEventListener('change', () => {
    store.set({ model: modelSel.value });
    showModelHint();
  });

  // ── Render ─────────────────────────────────────────────────────────────────
  function render() {
    const active = isRunning || waiting || rateSecs > 0;
    goBtn.innerHTML = active ? ICON_PAUSE : ICON_PLAY;
    goBtn.classList.toggle('active', active);
    goBtn.title = active ? 'Stop' : 'Start';

    let cls = 'idle', text = 'Ready';
    if (errorMsg)        { cls = 'err';  text = errorMsg; }
    else if (infoMsg && !isRunning && !waiting) { cls = 'idle'; text = infoMsg; }
    else if (rateSecs)   { cls = 'hold'; text = `Rate limited · ${rateSecs}s`; }
    else if (paused)     { cls = 'hold'; text = 'Paused'; }
    else if (isRunning)  { cls = 'run';  text = 'Answering…' + stepNote; }
    else if (waiting)    { cls = 'run';  text = 'Next question…'; }

    if (answered > 0 && !errorMsg) text += ` · ${answered}`;
    // Show the model only when it differs from the one picked in settings
    if (lastModel && lastModel !== modelSel.value && !errorMsg) {
      text += ` · ↑ ${MODEL_LIST.find(m => m.id === lastModel)?.label ?? lastModel}`;
    }

    dot.className = 'dot ' + cls;
    statusText.textContent = text;
    statusText.classList.toggle('err', !!errorMsg);
    statusWrap.classList.toggle('err', !!errorMsg);
  }

  // Some quizzes load a whole new page for every question — Canvas's one-at-a-
  // time Next does — and that restarts this script with the loop forgotten.
  // A note in the tab's sessionStorage carries it across. Only a fresh note
  // counts, and anything that ends a run deletes it, so a page opened later
  // never starts clicking by itself.
  const RESUME_KEY = '__pageAgentResume';
  const RESUME_WINDOW_MS = 60000;
  function markResume() {
    try { sessionStorage.setItem(RESUME_KEY, JSON.stringify({ at: Date.now(), answered })); } catch (_) {}
  }
  function clearResume() {
    try { sessionStorage.removeItem(RESUME_KEY); } catch (_) {}
  }
  function takeResume() {
    try {
      const v = JSON.parse(sessionStorage.getItem(RESUME_KEY) || 'null');
      sessionStorage.removeItem(RESUME_KEY);
      return v && Date.now() - v.at < RESUME_WINDOW_MS ? v : null;
    } catch (_) { return null; }
  }

  function fail(msg) {
    clearResume();
    errorMsg = msg;
    isRunning = waiting = false;
    render();
  }

  // ── Persistence ────────────────────────────────────────────────────────────
  store.get(
    ['lastPresetIndex', 'notes', 'autoContinue', 'autoUpgrade', 'apiKey', 'refUrls', 'model', 'barPos'],
    s => {
      presetIndex = PRESETS[s.lastPresetIndex] ? s.lastPresetIndex : 0;
      presetSel.value = String(presetIndex);

      notes = s.notes ?? '';
      notesInput.value = notes;

      autoContinue = s.autoContinue !== false;
      autoSw.classList.toggle('on', autoContinue);

      autoUpgrade = s.autoUpgrade !== false;
      upgradeSw.classList.toggle('on', autoUpgrade);

      modelSel.value = MODEL_LIST.some(m => m.id === s.model) ? s.model : DEFAULT_MODEL;
      showModelHint();

      if (s.apiKey) { keyInput.value = s.apiKey; hasKey = true; }
      if (Array.isArray(s.refUrls)) refUrls = s.refUrls;

      // Where the user last parked the bar. Clamped on the way in, so a
      // position saved on a bigger screen still lands somewhere visible.
      if (s.barPos && Number.isFinite(s.barPos.left) && Number.isFinite(s.barPos.top)) {
        placeAt(s.barPos.left, s.barPos.top);
      } else {
        orientPanel();
      }

      renderRefs();
      render();

      // Arrived here by the loop's own Next click: carry on. The previous
      // page's run finished (it clicked Next), so count it.
      const resume = takeResume();
      if (resume && hasKey && autoContinue) {
        answered = (Number(resume.answered) || 0) + 1;
        setTimeout(() => { if (!isRunning && !waiting) triggerRun(); }, 1200);
      }
    }
  );

  presetSel.addEventListener('change', () => {
    presetIndex = parseInt(presetSel.value) || 0;
    store.set({ lastPresetIndex: presetIndex });
  });

  let notesDebounce = null;
  notesInput.addEventListener('input', () => {
    clearTimeout(notesDebounce);
    notesDebounce = setTimeout(() => {
      notes = notesInput.value.trim();
      store.set({ notes });
    }, 400);
  });

  upgradeSw.addEventListener('click', () => {
    autoUpgrade = !autoUpgrade;
    upgradeSw.classList.toggle('on', autoUpgrade);
    store.set({ autoUpgrade });
  });

  autoSw.addEventListener('click', () => {
    autoContinue = !autoContinue;
    autoSw.classList.toggle('on', autoContinue);
    store.set({ autoContinue });
  });

  saveKeyBtn.addEventListener('click', () => {
    const k = keyInput.value.trim();
    if (!k) return;
    store.set({ apiKey: k }, () => {
      hasKey = true;
      saveKeyBtn.textContent = 'Saved';
      saveKeyBtn.classList.add('done');
      setTimeout(() => {
        saveKeyBtn.textContent = 'Save';
        saveKeyBtn.classList.remove('done');
      }, 1600);
    });
  });
  keyInput.addEventListener('keydown', e => { if (e.key === 'Enter') saveKeyBtn.click(); });

  function renderRefs() {
    refList.innerHTML = '';
    if (!refUrls.length) {
      const d = document.createElement('div');
      d.className = 'empty';
      d.textContent = 'None added';
      refList.appendChild(d);
      return;
    }
    refUrls.forEach((url, i) => {
      const row = document.createElement('div');
      row.className = 'row ref-row';
      const s = document.createElement('span');
      s.textContent = url.replace(/^https?:\/\//, '');
      s.title = url;
      const b = document.createElement('button');
      b.className = 'ref-del';
      b.textContent = '✕';
      b.addEventListener('click', () => {
        refUrls.splice(i, 1);
        store.set({ refUrls });
        renderRefs();
      });
      row.append(s, b);
      refList.appendChild(row);
    });
  }

  function addRef() {
    const u = refInput.value.trim();
    if (!u) return;
    if (!/^https?:\/\//.test(u)) { fail('URL must start with http:// or https://'); return; }
    if (!refUrls.includes(u)) {
      refUrls.push(u);
      store.set({ refUrls });
      renderRefs();
    }
    refInput.value = '';
  }
  addRefBtn.addEventListener('click', addRef);
  refInput.addEventListener('keydown', e => { if (e.key === 'Enter') addRef(); });

  copyPromptBtn.addEventListener('click', () => {
    store.get('lastPrompt', ({ lastPrompt }) => {
      const flash = msg => {
        copyPromptBtn.textContent = msg;
        copyPromptBtn.classList.add('done');
        setTimeout(() => {
          copyPromptBtn.textContent = 'Copy';
          copyPromptBtn.classList.remove('done');
        }, 1800);
      };
      if (!lastPrompt) { flash('Run it first'); return; }
      navigator.clipboard.writeText(lastPrompt)
        .then(() => flash('Copied'))
        .catch(() => {
          // Clipboard API can be blocked on some pages — fall back to a
          // selection the page can still copy from.
          const ta = document.createElement('textarea');
          ta.value = lastPrompt;
          ta.style.cssText = 'position:fixed;top:-9999px';
          document.body.appendChild(ta);
          ta.select();
          try { document.execCommand('copy'); flash('Copied'); }
          catch (_) { flash('Copy failed'); }
          ta.remove();
        });
    });
  });

  // ── Panel open/close ───────────────────────────────────────────────────────
  function togglePanel(open) {
    const show = open ?? !panel.classList.contains('show');
    panel.classList.toggle('show', show);
    gear.classList.toggle('open', show);
  }
  gear.addEventListener('click', () => togglePanel());
  closeBtn.addEventListener('click', () => togglePanel(false));
  shadow.addEventListener('keydown', e => { if (e.key === 'Escape') togglePanel(false); });

  // ── Moving the bar ─────────────────────────────────────────────────────────
  // Drag it anywhere by its background; the buttons stay buttons. Where it
  // ends up is remembered, because a bar that covers the Next button on one
  // site would otherwise have to be moved on every page load.
  function placeAt(left, top) {
    const EDGE = 8;   // a little breathing room from the window edge
    const r = host.getBoundingClientRect();
    const maxLeft = Math.max(EDGE, window.innerWidth  - r.width  - EDGE);
    const maxTop  = Math.max(EDGE, window.innerHeight - r.height - EDGE);
    const l = Math.min(Math.max(left, EDGE), maxLeft);
    const t = Math.min(Math.max(top,  EDGE), maxTop);
    host.style.left = `${l}px`;
    host.style.top  = `${t}px`;
    host.style.bottom = 'auto';
    host.style.right  = 'auto';
    orientPanel();
    return { left: l, top: t };
  }

  function orientPanel() {
    const r = host.getBoundingClientRect();
    panel.classList.toggle('below', r.top < window.innerHeight / 2);
    panel.classList.toggle('alignRight', r.left > window.innerWidth / 2);
  }

  let dragging = false, moved = false, startX = 0, startY = 0, origin = null;

  bar.addEventListener('pointerdown', e => {
    if (e.button !== 0) return;
    if (e.target.closest('button')) return;   // play and gear are not handles
    dragging = true;
    moved = false;
    startX = e.clientX;
    startY = e.clientY;
    const r = host.getBoundingClientRect();
    origin = { left: r.left, top: r.top };
    try { bar.setPointerCapture(e.pointerId); } catch (_) {}
    bar.classList.add('dragging');
  });

  bar.addEventListener('pointermove', e => {
    if (!dragging) return;
    const dx = e.clientX - startX, dy = e.clientY - startY;
    // A few pixels of wobble while clicking shouldn't count as a drag
    if (!moved && Math.hypot(dx, dy) < 4) return;
    moved = true;
    placeAt(origin.left + dx, origin.top + dy);
  });

  function endDrag(e) {
    if (!dragging) return;
    dragging = false;
    bar.classList.remove('dragging');
    try { bar.releasePointerCapture(e.pointerId); } catch (_) {}
    if (!moved) return;
    const r = host.getBoundingClientRect();
    store.set({ barPos: { left: r.left, top: r.top } });
  }
  bar.addEventListener('pointerup', endDrag);
  bar.addEventListener('pointercancel', endDrag);

  // A bar parked against the right edge of a wide window would be off-screen
  // in a narrow one, so pull it back into view whenever the window changes.
  window.addEventListener('resize', () => {
    if (host.style.top) {
      const r = host.getBoundingClientRect();
      placeAt(r.left, r.top);
    } else {
      orientPanel();
    }
  });

  // ── Run control ────────────────────────────────────────────────────────────
  goBtn.addEventListener('click', () => {
    if (isRunning || waiting || rateSecs > 0) { stopAll(); return; }
    if (!extensionAlive()) { fail(RELOAD_MSG); return; }
    errorMsg = '';
    infoMsg = '';
    paused = false;
    answered = 0;
    lastModel = '';
    if (!hasKey) { togglePanel(true); keyInput.focus(); return; }
    triggerRun();
  });

  function stopAll() {
    runToken++;                     // invalidates any in-flight reply
    // The background runs a multi-step loop of its own; without telling it to
    // stop, this would only quieten the widget while it kept on clicking.
    bgSend({ type: 'STOP_RUN' });
    clearResume();
    clearTimeout(pollTimer);
    clearTimeout(rateTimer);
    clearTimeout(watchdog);
    isRunning = waiting = false;
    paused = false;
    rateSecs = 0;
    stepNote = '';
    render();
  }

  // If the background worker is torn down mid-run its reply never arrives,
  // leaving this on "Answering…" with nothing to reset it. A run can legitimately
  // take minutes, though — a six-step spreadsheet task on Opus does — so the
  // clock measures silence, not total length: every step the background starts
  // pushes it back. Only a genuinely stalled run runs it out.
  function armWatchdog(token) {
    clearTimeout(watchdog);
    watchdog = setTimeout(() => {
      if (token !== runToken) return;
      stopAll();
      fail('Nothing came back for a while. Press play to try again, or pick a faster model in settings.');
    }, 90000);
  }

  function triggerRun() {
    if (isRunning) return;
    const token = ++runToken;
    isRunning = true;
    waiting = false;
    errorMsg = '';
    stepNote = '';
    infoMsg = '';
    if (autoContinue) markResume(); else clearResume();
    render();

    armWatchdog(token);

    bgSend(
      { type: 'RUN_GOAL', notes, postClicks: PRESETS[presetIndex].postClicks },
      (result, sendError) => {
        clearTimeout(watchdog);
        if (token !== runToken) return;   // stopped, or superseded
        isRunning = false;

        if (sendError || !result) {
          fail(sendError ?? 'No response from the extension. Refresh this page and try again.');
          return;
        }

        if (!result.success) {
          const err = result.error ?? 'Unknown error.';
          if (err.includes('Rate limit')) startRateCountdown();
          else fail(err);
          return;
        }

        if (result.noAnswer) {
          // Nothing clickable — likely a question type we can't do yet.
          paused = true;
          fail("Couldn't find an answer here. Do this one yourself, then press play.");
          return;
        }

        lastModel = result.usedModel ?? '';
        answered++;

        if (result.finished) {
          // The page is answered and the rest is up to the student
          clearResume();
          infoMsg = result.finished;
          render();
          return;
        }

        if (!autoContinue) { render(); return; }

        // Wait for the page to actually change before the next question
        const root = document.querySelector('[role="main"], main, article, form') ?? document.body;
        waitForPageChange((root.innerText ?? '').slice(0, 400), token);
      }
    );
  }

  // Poll until the question content changes, then run again. 5s fallback so a
  // page that re-renders identically never strands the loop.
  function waitForPageChange(snapshot, token) {
    waiting = true;
    render();
    const deadline = Date.now() + 5000;
    (function check() {
      if (token !== runToken) return;
      const root = document.querySelector('[role="main"], main, article, form') ?? document.body;
      const now = (root.innerText ?? '').slice(0, 400);
      if (now !== snapshot || Date.now() > deadline) {
        waiting = false;
        triggerRun();
      } else {
        pollTimer = setTimeout(check, 150);
      }
    })();
  }

  function startRateCountdown() {
    const token = runToken;
    rateSecs = 65;
    render();
    (function tick() {
      if (token !== runToken) return;
      if (rateSecs <= 0) { rateSecs = 0; triggerRun(); return; }
      render();
      rateSecs--;
      rateTimer = setTimeout(tick, 1000);
    })();
  }

  progressHook = (step, budget) => {
    if (!isRunning) return;
    armWatchdog(runToken);
    if (autoContinue) markResume();
    // A one-step question is the normal case and needs no commentary; a
    // procedure that takes several says where it has got to.
    stepNote = budget > 1 ? ` · step ${step}/${budget}` : '';
    render();
  };


  render();
  document.body.appendChild(host);

  // Some course pages swap out the whole body between questions, which takes
  // the control bar with it. Put it back rather than leaving the user staring
  // at a page with no controls.
  setInterval(() => {
    if (!document.body) return;
    if (!document.body.contains(host)) document.body.appendChild(host);
  }, 2000);
})();

// ── Message listener ─────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === 'PROGRESS') {
    progressHook?.(msg.step, msg.budget);
    sendResponse({ ok: true });
    return false;
  }

  if (msg.type === 'PING') {
    sendResponse({ ok: true });
    return false;
  }

  if (msg.type === 'SCRAPE') {
    try {
      sendResponse(scrape());
    } catch (e) {
      sendResponse({ error: e.message, text: '', elements: [] });
    }
    return false;
  }

  if (msg.type === 'EXECUTE') {
    execute(msg.action)
      .then(sendResponse)
      .catch(e => sendResponse({ success: false, error: e.message }));
    return true;
  }

  if (msg.type === 'FOCUS_CELL') {
    // Open a spreadsheet cell for editing, so the real keystrokes the
    // background sends next land in it.
    (async () => {
      const { index } = msg;
      if (typeof index !== 'number' || index < 0 || index >= _lastElements.length) {
        sendResponse({ success: false, error: `Index ${index} out of range` });
        return;
      }
      const el = _lastElements[index];
      if (!document.contains(el)) {
        sendResponse({ success: false, error: `Cell [${index}] is no longer in the DOM` });
        return;
      }
      el.scrollIntoView({ behavior: 'auto', block: 'center' });
      await new Promise(r => setTimeout(r, 120));

      const rect = el.getBoundingClientRect();
      const cx = rect.left + rect.width / 2, cy = rect.top + rect.height / 2;
      const mo = { bubbles: true, cancelable: true, clientX: cx, clientY: cy };
      el.dispatchEvent(new PointerEvent('pointerdown', { ...mo, isPrimary: true }));
      el.dispatchEvent(new MouseEvent('mousedown', { ...mo, buttons: 1 }));
      el.dispatchEvent(new PointerEvent('pointerup', { ...mo, isPrimary: true }));
      el.dispatchEvent(new MouseEvent('mouseup', mo));
      el.click();

      // Clicking dispatches events but does not move real browser focus into
      // this frame, and debugger keystrokes follow focus — without this they
      // are delivered to the top document and lost. Sheet cells carry a
      // tabindex precisely so they can be focused.
      if (typeof el.focus === 'function') el.focus({ preventScroll: true });
      await new Promise(r => setTimeout(r, 150));

      // Report where focus actually ended up, so a failure here is legible
      // rather than showing up as silently empty cells.
      const active = document.activeElement;
      const landed = active === el || el.contains(active) ||
                     (active && active.tagName === 'TEXTAREA'); // sheet's own editor
      if (!landed) {
        sendResponse({
          success: false,
          error: `Cell [${index}] would not take focus (focus went to ${active?.tagName ?? 'nothing'})`
        });
        return;
      }

      sendResponse({ success: true });
    })().catch(e => sendResponse({ success: false, error: e?.message ?? String(e) }));
    return true;
  }

  if (msg.type === 'FOCUS_DRAG') {
    // Focus the drag card so the real keystrokes the background sends next
    // (via the debugger protocol) land on the right element.
    (async () => {
      const { index } = msg;
      if (typeof index !== 'number' || index < 0 || index >= _lastElements.length) {
        sendResponse({ success: false, error: `Index ${index} out of range (${_lastElements.length} elements)` });
        return;
      }
      const el = _lastElements[index];
      if (!document.contains(el)) {
        sendResponse({ success: false, error: `Element [${index}] is no longer in the DOM` });
        return;
      }
      const handle = el.closest('[data-rbd-drag-handle-draggable-id], [data-react-beautiful-dnd-drag-handle]') || el;
      handle.scrollIntoView({ behavior: 'smooth', block: 'center' });
      await new Promise(r => setTimeout(r, 200));
      handle.focus();
      await new Promise(r => setTimeout(r, 120));

      if (document.activeElement !== handle && !handle.contains(document.activeElement)) {
        sendResponse({ success: false, error: 'Could not focus the drag item' });
        return;
      }
      sendResponse({ success: true });
    })().catch(e => sendResponse({ success: false, error: e?.message ?? String(e) }));
    return true;
  }

  if (msg.type === 'CLICK_TEXT') {
    // Poll until the button appears and is not disabled (up to 5s)
    (async () => {
      const candidates = msg.candidates || [];
      // Optional buttons (Canvas's Next, absent on the last page) shouldn't
      // cost the full wait before we conclude they aren't there.
      const deadline = Date.now() + (Number(msg.timeoutMs) > 0 ? Number(msg.timeoutMs) : 5000);

      function findIt() {
        const all = Array.from(document.querySelectorAll('button, [role="button"], a'));
        for (const c of candidates) {
          let el = null;
          if (c.selector) el = document.querySelector(c.selector);
          else if (c.ariaLabel) el = all.find(b => (b.getAttribute('aria-label') || '').toLowerCase().includes(c.ariaLabel.toLowerCase()));
          else if (c.text) el = all.find(b => (b.innerText || b.textContent || '').trim().toLowerCase().includes(c.text.toLowerCase()));
          // Rendered rather than on-screen: we scroll to it before clicking,
          // and on a long page the button is often below the fold.
          if (el && isRendered(el) && !el.disabled && el.getAttribute('aria-disabled') !== 'true') return el;
        }
        return null;
      }

      let found = null;
      while (!found && Date.now() < deadline) {
        found = findIt();
        if (!found) await new Promise(r => setTimeout(r, 150));
      }

      if (!found) {
        sendResponse({ success: false, error: 'Button not found after 5s' });
        return;
      }

      found.scrollIntoView({ behavior: 'smooth', block: 'center' });
      await new Promise(r => setTimeout(r, 80));
      const rect = found.getBoundingClientRect();
      const cx = rect.left + rect.width / 2, cy = rect.top + rect.height / 2;
      const mo = { bubbles: true, cancelable: true, clientX: cx, clientY: cy };
      found.dispatchEvent(new PointerEvent('pointerdown', { ...mo, isPrimary: true }));
      found.dispatchEvent(new MouseEvent('mousedown', { ...mo, buttons: 1 }));
      found.dispatchEvent(new PointerEvent('pointerup', { ...mo, isPrimary: true }));
      found.dispatchEvent(new MouseEvent('mouseup', mo));
      found.click();
      sendResponse({ success: true });
    })().catch(e => sendResponse({ success: false, error: e?.message ?? String(e) }));
    return true; // async response
  }

  sendResponse({ success: false, error: `Unknown message type: ${msg?.type}` });
  return false;
});

})();

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
// What a SIMnet look saw, so the next look can tell what has just appeared.
// Cleared on each task's first look; a peek never changes it.
let _simSeen = null;
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
    // Never a password; never a tick box, whose value is just "on"
    value: (isTextBox(el) && el.type !== 'password' && !el.isContentEditable && el.value)
      ? String(el.value).slice(0, 60)
      : el.tagName === 'SELECT' ? (el.selectedOptions?.[0]?.textContent.trim() || undefined) : undefined,
    // A dropdown list's choices, so one can be picked by its text
    options: el.tagName === 'SELECT'
      ? Array.from(el.options).slice(0, 20).map(o => o.textContent.trim()).filter(Boolean) : undefined,
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
    //
    // What a step just opened — a dropdown, a submenu, a dialog — is what the
    // next step acts on, and it's usually added at the END of the page, after
    // a ribbon that alone nearly fills the list. Taken in page order, a menu
    // opened by "Format" fell past the cutoff: the model never saw "Tab
    // Color", clicked elsewhere, the menu closed, and round it went. So
    // anything new since the previous look, and anything inside an open menu
    // or dialog, goes first, marked as just appeared.
    const POPUP = '[role="menu"], [role="listbox"], [role="dialog"], [role="alertdialog"], [aria-modal="true"]';
    const inPopup = el => !!el.closest(POPUP);
    const baseline = _simSeen;               // null on a task's first look
    const allSet = new Set(all);
    // Colour swatches and the like are often bare shapes with only a title,
    // which the general selector doesn't treat as clickable. Those count
    // inside a menu or dialog, or once they've newly appeared.
    const titled = Array.from(document.querySelectorAll('[title], [aria-label]'))
      .filter(el => !el.matches('td.grdbdy-cell') && isRendered(el));
    const extras = [
      ...Array.from(document.querySelectorAll(POPUP)).flatMap(p =>
        Array.from(p.querySelectorAll('[title], [aria-label], [tabindex], li'))).filter(isRendered),
      ...(baseline ? titled.filter(el => !baseline.has(el)) : [])
    ].filter(el => !allSet.has(el));

    // A control with no name of any kind is unusable to act on and would
    // only crowd out the ones that can be identified. Text boxes count even
    // unlabelled: the name box that opens on a sheet tab, a dialog field —
    // often exactly what the next step types into.
    const labelled = el => isTextBox(el) || (el.innerText || '').trim() || el.getAttribute('aria-label') || el.getAttribute('title');
    const candidates = [...new Set([...all, ...extras])].filter(el => !el.matches(CHROME)).filter(labelled);
    const isNew = el => inPopup(el) || (baseline !== null && !baseline.has(el));
    const controls = [...candidates.filter(isNew), ...candidates.filter(el => !isNew(el))].slice(0, 130);
    const fresh = new Set(controls.filter(isNew));
    _simSeen = new WeakSet([...candidates, ...titled]);

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
      elements: _lastElements.map(el => ({ ...describeEl(el), state: stateOf(el), fresh: fresh.has(el) || undefined })),
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
// Typing into a box that's being edited — a sheet tab's name, a dialog field.
// Unlike setFieldValue it leaves the box open (no change, no blur), so the
// Enter that follows is what commits it, as it would be for a person.
function typeIntoBox(el, text) {
  if (el.isContentEditable) {
    el.textContent = text;
  } else {
    const proto = el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    if (setter) setter.call(el, text); else el.value = text;
  }
  el.dispatchEvent(new InputEvent('input', { bubbles: true, data: text }));
  el.dispatchEvent(new KeyboardEvent('keyup', { key: text.slice(-1), bubbles: true }));
}

const isTextBox = el => !!el && (el.isContentEditable || el.tagName === 'TEXTAREA' ||
  (el.tagName === 'INPUT' && !/^(checkbox|radio|button|submit|hidden|file|image|reset)$/i.test(el.type)));

// Whatever the page is editing — never the control bar itself, which holds
// focus right after play is pressed.
function editingNow() {
  const a = document.activeElement;
  return a && a !== document.body && a.id !== '__cap-host' ? a : null;
}

// Whether a ribbon toggle is on, a tab chosen, a menu open, a control usable —
// without it a step can't tell a task done from a task not started
function stateOf(el) {
  const s = [];
  if (el.getAttribute('aria-pressed') === 'true' ||
      (el.getAttribute('aria-checked') === 'true' && !/^(checkbox|radio)$/.test(el.type || ''))) s.push('on');
  if (el.getAttribute('aria-selected') === 'true') s.push('selected');
  if (el.getAttribute('aria-expanded') === 'true') s.push('open');
  if (el.disabled || el.getAttribute('aria-disabled') === 'true') s.push('disabled');
  return s.length ? s.join(', ') : undefined;
}

function centreOf(el) {
  const r = el.getBoundingClientRect();
  return { bubbles: true, cancelable: true, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 };
}

// The same range and still-on-the-page checks every action needs
function pickElement(index) {
  if (typeof index !== 'number' || index < 0 || index >= _lastElements.length) {
    return { error: `Index ${index} out of range (${_lastElements.length} elements)` };
  }
  const el = _lastElements[index];
  if (!document.contains(el)) return { error: `Element [${index}] is no longer in the DOM` };
  return { el };
}

// SIMnet's cells carry their address in the id (cell-B7), so any cell can
// be named directly — listed or not
function cellByAddress(ref) {
  return document.getElementById(`cell-${String(ref).toUpperCase()}`);
}
function pickTarget(action) {
  if (action.cell !== undefined) {
    const el = cellByAddress(action.cell);
    return el ? { el } : { error: `Cell ${action.cell} isn't on this sheet` };
  }
  return pickElement(action.index);
}

// SIMnet grades a task with a popup: a heading "Correct" or "Incorrect", on a
// wrong answer a hint with the exact steps, and a Continue button — back to
// the question after a wrong try, on to the next after a right one. Found by
// its wording rather than its markup: the heading's text, with a Continue
// button in the same box. That pairing is what keeps a cell that happens to
// say "Correct" from counting.
function findVerdict() {
  if (!document.body) return null;
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  let node;
  while ((node = walker.nextNode())) {
    const t = node.nodeValue.trim();
    if (!/^(in)?correct!?$/i.test(t)) continue;
    const heading = node.parentElement;
    if (!heading || !isRendered(heading)) continue;
    let box = heading.parentElement, cont = null;
    for (let i = 0; i < 6 && box && box !== document.body; i++, box = box.parentElement) {
      cont = Array.from(box.querySelectorAll('button, [role="button"], a'))
        .find(b => /^continue$/i.test((b.innerText ?? b.textContent ?? '').trim()) && isRendered(b));
      if (cont) break;
    }
    if (!cont) continue;
    const hint = (box.innerText ?? box.textContent ?? '')
      .replace(t, '').replace(/\bContinue\b/i, '').replace(/\s+/g, ' ').trim();
    return { verdict: /^in/i.test(t) ? 'incorrect' : 'correct', hint: hint.slice(0, 600), button: cont };
  }
  return null;
}

// "1 of 3 Attempts": which try this is, so a retry never spends the last one
function attemptsShown() {
  const m = /(\d+)\s+of\s+(\d+)\s+Attempts?/i.exec(document.body?.innerText ?? document.body?.textContent ?? '');
  return m ? { current: Number(m[1]), total: Number(m[2]) } : null;
}

const KEY_CODES = {
  Enter: 13, Escape: 27, Tab: 9, Delete: 46, Backspace: 8, F2: 113, F4: 115,
  ArrowUp: 38, ArrowDown: 40, ArrowLeft: 37, ArrowRight: 39, Home: 36, End: 35
};

// A block of cells: click the first, shift-click the last, as a person would
function selectRange(from, to) {
  const a = cellByAddress(from), b = cellByAddress(to);
  if (!a) return { success: false, error: `Cell ${from} isn't on this sheet` };
  if (!b) return { success: false, error: `Cell ${to} isn't on this sheet` };
  a.scrollIntoView({ behavior: 'auto', block: 'center' });
  realClick(a);
  realClick(b, { shift: true });
  return { success: true };
}

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
function realClick(el, mods = {}) {
  const r = el.getBoundingClientRect();
  const o = { bubbles: true, cancelable: true,
              clientX: r.left + r.width / 2, clientY: r.top + r.height / 2,
              shiftKey: !!mods.shift, ctrlKey: !!mods.ctrl, metaKey: !!mods.ctrl };
  el.dispatchEvent(new PointerEvent('pointerover', { ...o, isPrimary: true }));
  el.dispatchEvent(new MouseEvent('mouseover', o));
  el.dispatchEvent(new PointerEvent('pointerdown', { ...o, isPrimary: true }));
  el.dispatchEvent(new MouseEvent('mousedown', { ...o, buttons: 1 }));
  if (typeof el.focus === 'function') el.focus({ preventScroll: true });
  el.dispatchEvent(new PointerEvent('pointerup', { ...o, isPrimary: true }));
  el.dispatchEvent(new MouseEvent('mouseup', o));
  // el.click() can't carry Shift or Ctrl; a held key needs a click event of
  // its own
  if (mods.shift || mods.ctrl) el.dispatchEvent(new MouseEvent('click', o));
  else el.click();
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

    // ── Excel moves (SIMnet) ───────────────────────────────────────────────
    // Simulated rather than real input: SIMnet acts on simulated clicks, and
    // simulated events can't be misrouted by where the browser's focus is.
    if (action.action === 'selectRange') return selectRange(action.from, action.to);

    if (action.action === 'doubleClick' || action.action === 'rightClick') {
      const { el, error } = pickTarget(action);
      if (error) return { success: false, error };
      el.scrollIntoView({ behavior: 'auto', block: 'center' });
      await new Promise(r => setTimeout(r, 120));
      const o = centreOf(el);
      if (action.action === 'doubleClick') {
        realClick(el);
        el.dispatchEvent(new MouseEvent('mousedown', { ...o, detail: 2, buttons: 1 }));
        el.dispatchEvent(new MouseEvent('mouseup', { ...o, detail: 2 }));
        el.dispatchEvent(new MouseEvent('click', { ...o, detail: 2 }));
        el.dispatchEvent(new MouseEvent('dblclick', { ...o, detail: 2 }));
      } else {
        el.dispatchEvent(new PointerEvent('pointerdown', { ...o, button: 2, buttons: 2, isPrimary: true }));
        el.dispatchEvent(new MouseEvent('mousedown', { ...o, button: 2, buttons: 2 }));
        el.dispatchEvent(new PointerEvent('pointerup', { ...o, button: 2, isPrimary: true }));
        el.dispatchEvent(new MouseEvent('mouseup', { ...o, button: 2 }));
        el.dispatchEvent(new MouseEvent('contextmenu', { ...o, button: 2 }));
      }
      return { success: true };
    }

    if (action.action === 'type') {
      let target = null;
      if (action.index !== undefined || action.cell !== undefined) {
        const { el, error } = pickTarget(action);
        if (error) return { success: false, error };
        el.scrollIntoView({ behavior: 'auto', block: 'center' });
        realClick(el);
        target = el;
        await new Promise(r => setTimeout(r, 150));
      }
      // Clicking may open an editor; type into whichever is a text box
      const box = [target, editingNow()].find(isTextBox);
      if (box) {
        typeIntoBox(box, action.text);
        return { success: true };
      }
      if (!target) {
        return { success: false, error: 'Nothing is being edited to type into — name the element to type into.' };
      }
      // A grid cell: edits only on real key presses, which the background
      // sends once the cell has focus
      if (typeof target.focus === 'function') target.focus({ preventScroll: true });
      return { success: true, needsKeys: true };
    }

    if (action.action === 'key') {
      const code = KEY_CODES[action.key];
      if (!code) return { success: false, error: `Unsupported key ${JSON.stringify(action.key)}` };
      const target = editingNow() ?? document.body;
      for (const type of ['keydown', 'keypress', 'keyup']) {
        if (type === 'keypress' && action.key !== 'Enter') continue;
        const ev = new KeyboardEvent(type, {
          key: action.key, code: action.key, bubbles: true, cancelable: true,
          ctrlKey: !!action.ctrl, metaKey: !!action.ctrl, shiftKey: !!action.shift
        });
        // Older page code reads keyCode/which, which the constructor won't set
        Object.defineProperty(ev, 'keyCode', { get: () => code });
        Object.defineProperty(ev, 'which', { get: () => code });
        target.dispatchEvent(ev);
      }
      return { success: true };
    }

    // ── Single click ───────────────────────────────────────────────────────
    if (action.action === 'click') {
      const { el, error } = pickTarget(action);
      if (error) return { success: false, error };
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      await new Promise(r => setTimeout(r, 150));
      realClick(el, { shift: action.shift, ctrl: action.ctrl });
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
  const ICON_THUMB_DOWN = '<svg viewBox="0 0 24 24" width="15" height="15"><path d="M15 3H6c-.8 0-1.5.5-1.8 1.2l-3 7c-.1.3-.2.5-.2.8v2c0 1.1.9 2 2 2h6.3l-1 4.6v.3c0 .4.2.8.4 1.1L9.8 23l6.6-6.6c.4-.4.6-.9.6-1.4V5c0-1.1-.9-2-2-2zm4 0v12h4V3h-4z"/></svg>';
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
  #checkResult { margin: 8px 3px 0; font-size: 12px; line-height: 1.55; color: rgba(235,235,245,0.75); }
  #checkResult:empty { display: none; }
  #checkResult .ok::before  { content: '✓  '; color: #30D158; font-weight: 600; }
  #checkResult .bad         { color: #FF9F96; }
  #checkResult .bad::before { content: '✗  '; font-weight: 600; }
  #checkResult .info        { color: rgba(235,235,245,0.45); }
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

  /* Author styles like .row { display: flex } would otherwise beat the
     browser's own [hidden] rule and leave hidden rows showing */
  [hidden] { display: none !important; }

  .spaced { margin-top: 15px; }

  /* Segmented control, as in iOS */
  .seg {
    display: flex; gap: 2px; padding: 2px;
    background: rgba(118, 118, 128, 0.24);
    border-radius: 9px;
  }
  .seg button {
    flex: 1; border: none; background: transparent;
    color: #f5f5f7; font-family: inherit;
    font-size: 12.5px; font-weight: 500; letter-spacing: -0.01em;
    padding: 7px 0; border-radius: 7px; cursor: pointer;
    transition: background 0.2s cubic-bezier(0.32,0.72,0,1);
  }
  .seg button:hover { background: rgba(255, 255, 255, 0.06); }
  .seg button.on { background: rgba(99, 99, 102, 0.95); box-shadow: 0 1px 4px rgba(0,0,0,0.3); }

  .saved-mark { font-size: 13px; color: #30D158; }

  /* "That answer was wrong" — only while the answer log is on */
  #flag {
    width: 26px; height: 26px; flex-shrink: 0;
    border: none; background: transparent; border-radius: 7px;
    color: rgba(235, 235, 245, 0.45);
    display: flex; align-items: center; justify-content: center;
    cursor: pointer; transition: color 0.18s, background 0.18s;
  }
  #flag svg { fill: currentColor; display: block; }
  #flag:hover { color: #FF9F0A; background: rgba(120, 120, 128, 0.26); }

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
  .inline-btn:disabled { opacity: 0.35; cursor: default; }
  .inline-btn.quiet { color: rgba(235, 235, 245, 0.45); }

  /* "More" disclosure */
  .disclosure {
    display: flex; align-items: center; gap: 7px;
    margin: 17px 0 0 3px; padding: 2px 0;
    border: none; background: transparent; cursor: pointer;
    color: rgba(235, 235, 245, 0.6); font-family: inherit; font-size: 13px;
  }
  .disclosure:hover { color: #f5f5f7; }
  .disc-chev { display: inline-block; font-size: 16px; line-height: 1; transition: transform 0.2s; }
  .disclosure[aria-expanded="true"] .disc-chev { transform: rotate(90deg); }
  #more > .label:first-child { margin-top: 12px; }


</style>

<div id="root">
  <div id="panel" class="glass">
    <div id="head">
      <span>Page Agent</span>
      <button id="close">✕</button>
    </div>
    <div id="body">

      <div class="label">Mode</div>
      <div class="seg" id="mode" role="radiogroup" aria-label="Mode">
        <button data-mode="autopilot" role="radio">Autopilot</button>
        <button data-mode="one" role="radio">One question</button>
        <button data-mode="answer" role="radio">Answer only</button>
      </div>
      <div class="row-hint" id="modeHint"></div>

      <div class="group spaced">
        <div class="row" id="keySaved">
          <span class="row-label">API key</span>
          <span class="saved-mark">✓ Saved</span>
          <button class="inline-btn" id="changeKey">Change</button>
        </div>
        <div class="row" id="keyEdit">
          <input type="password" id="key" placeholder="Paste your API key" autocomplete="off" spellcheck="false" />
          <button class="inline-btn quiet" id="cancelKey">Cancel</button>
          <button class="inline-btn" id="saveKey">Save</button>
        </div>
      </div>
      <div class="row-hint" id="keyHint">Needed to start. It begins sk-ant-api03- — the setup guide shows where to get one.</div>

      <button class="disclosure" id="moreBtn" aria-expanded="false" aria-controls="more">
        <span class="disc-chev">›</span>More
      </button>
      <div id="more" hidden>
        <div class="label">Model</div>
        <div class="group">
          <div class="row">
            <select id="model"></select>
            <span class="chev">▼</span>
          </div>
        </div>
        <div class="row-hint" id="modelHint"></div>

        <div class="label">Notes <span class="opt">Optional</span></div>
        <div class="group">
          <textarea id="notes" rows="3" placeholder="e.g. This is financial accounting — use GAAP conventions."></textarea>
        </div>
        <div class="row-hint">Course context or hints. Leave blank if you don't need it.</div>

        <div class="label">Answer log</div>
        <div class="group">
          <div class="row">
            <span class="row-label">Keep a log</span>
            <div class="switch" id="logSw" role="switch" aria-checked="false" tabindex="0"></div>
          </div>
          <div class="row" id="logRow" hidden>
            <span class="row-label" id="logCount">Nothing logged yet</span>
            <button class="inline-btn quiet" id="logClear">Clear</button>
            <button class="inline-btn" id="logDownload">Download</button>
          </div>
        </div>
        <div class="row-hint">Saves each question it answers, and how the page looked afterwards, in this browser only. When an answer was wrong, tap the thumbs-down on the bar. Download the log to share it.</div>

        <div class="label">Troubleshooting</div>
        <div class="group">
          <div class="row">
            <span class="row-label">Check this page</span>
            <button class="inline-btn" id="checkPage">Run</button>
          </div>
          <div class="row">
            <span class="row-label">Copy last prompt</span>
            <button class="inline-btn" id="copyPrompt">Copy</button>
          </div>
        </div>
        <div id="checkResult"></div>
        <div class="row-hint">Check this page shows what it can see here and whether your key works. Copy last prompt copies exactly what was last sent to Claude, for diagnosing wrong answers.</div>
      </div>

    </div>
  </div>

  <div id="bar" class="glass">
    <button id="go"></button>
    <div id="status"><span class="dot idle" id="dot"></span><span id="statusText">Ready</span></div>
    <button id="flag" title="That answer was wrong" aria-label="That answer was wrong" hidden></button>
    <button id="gear"></button>
  </div>
</div>
  `;

  const $ = id => shadow.getElementById(id);
  const goBtn = $('go'), gear = $('gear'), panel = $('panel'), closeBtn = $('close');
  const bar = $('bar');
  const dot = $('dot'), statusText = $('statusText'), statusWrap = $('status');
  const modeSeg = $('mode'), modeHint = $('modeHint'), notesInput = $('notes');
  const modelSel = $('model'), modelHint = $('modelHint');
  const keyInput = $('key'), saveKeyBtn = $('saveKey'), cancelKeyBtn = $('cancelKey');
  const keySavedRow = $('keySaved'), keyEditRow = $('keyEdit'), keyHint = $('keyHint');
  const changeKeyBtn = $('changeKey'), moreBtn = $('moreBtn'), more = $('more');
  const copyPromptBtn = $('copyPrompt');
  const flagBtn = $('flag'), logSw = $('logSw'), logRow = $('logRow'), logCount = $('logCount');
  const logDownloadBtn = $('logDownload'), logClearBtn = $('logClear');
  const checkPageBtn = $('checkPage'), checkResult = $('checkResult');

  gear.innerHTML = ICON_GEAR;
  flagBtn.innerHTML = ICON_THUMB_DOWN;

  // ── State ──────────────────────────────────────────────────────────────────
  let mode = 'autopilot';  // one of MODES, below
  let presetIndex = 0;     // which post-answer flow; set by the mode
  let autoContinue = true; // whether to go on to the next question; set by the mode
  let notes = '';          // optional user context, sent only when non-empty
  let hasKey = false;
  let keepLog = false;     // the answer log, off unless switched on
  let canFlag = false;     // a run has finished here since the last thumbs-down
  let pageKind = '';       // what the page looks like — "Canvas quiz" — shown when idle
  // Declared up here, not beside the detection code, because the settings
  // loader below can call into it synchronously (when the extension has just
  // been reloaded) — before a later `let` would exist.
  let detectTimer = null, detectedHref = '', retriedHref = '';
  let lastModel = '';    // model the most recent question actually used

  let isRunning = false;   // a request is in flight
  let waiting   = false;   // between questions, watching for the page to change
  let paused    = false;
  let answered  = 0;
  let errorMsg  = '';
  let rateSecs  = 0;
  let stepNote  = '';      // "step 2/6" during a multi-step task
  let infoMsg   = '';      // a finished run's closing note — not an error
  let waitingForUser = false;  // answer-only: the student clicks Next

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

  // One choice for the user, standing for a post-answer flow plus whether to
  // continue. These used to be two controls whose combinations weren't named
  // anywhere; the old settings are still written, so the run logic is unchanged.
  const MODES = {
    autopilot: { label: 'Autopilot',    preset: 0, autoContinue: true,
                 hint: 'Answers, rates confidence, clicks Next, and keeps going.' },
    one:       { label: 'One question', preset: 0, autoContinue: false,
                 hint: 'Answers one question and clicks Next, then stops. Press play for each.' },
    answer:    { label: 'Answer only',  preset: 1, autoContinue: true,
                 hint: 'Picks the answer, then waits for you to click Next — and answers each new question as it appears.' }
  };

  // For someone upgrading: read the mode their old two settings amounted to
  function legacyMode(s) {
    if (s.lastPresetIndex === 1) return 'answer';
    if (s.autoContinue === false) return 'one';
    return 'autopilot';
  }

  function setMode(m, save) {
    mode = MODES[m] ? m : 'autopilot';
    presetIndex = MODES[mode].preset;
    autoContinue = MODES[mode].autoContinue;
    for (const b of modeSeg.querySelectorAll('button')) {
      const on = b.dataset.mode === mode;
      b.classList.toggle('on', on);
      b.setAttribute('aria-checked', String(on));
    }
    modeHint.textContent = MODES[mode].hint;
    if (save) store.set({ mode, lastPresetIndex: presetIndex, autoContinue });
  }

  modeSeg.addEventListener('click', e => {
    const b = e.target.closest('button[data-mode]');
    if (b) setMode(b.dataset.mode, true);
  });

  // Keep in sync with MODELS in background.js
  const MODEL_LIST = [
    { id: 'claude-haiku-4-5', label: 'Haiku 4.5', note: 'Fastest and cheapest — about $0.05 per 100 questions.' },
    { id: 'claude-sonnet-5',  label: 'Sonnet 5',  note: 'Noticeably better at the subject matter. Roughly 2× the cost.' },
    { id: 'claude-opus-5-5',  label: 'Opus 5.5',  note: 'Most capable, and slower. Roughly 4× the cost.' }
  ];
  const DEFAULT_MODEL = 'claude-haiku-4-5';

  // Auto is the cheap model with an upgrade for hard questions — what the old
  // "Upgrade on hard questions" switch did, without a second control. Picking
  // a model by name means that model every time.
  const AUTO = {
    id: 'auto', label: 'Auto',
    note: 'Recommended. The cheapest model for most questions, and a smarter one for SIMnet, worksheets and drag-and-drop.'
  };
  [AUTO, ...MODEL_LIST].forEach(m => {
    const o = document.createElement('option');
    o.value = m.id; o.textContent = m.label;
    modelSel.appendChild(o);
  });

  // The model a run starts on; Auto may upgrade from it
  const baseModel = () => modelSel.value === 'auto' ? DEFAULT_MODEL : modelSel.value;

  function showModelHint() {
    modelHint.textContent = [AUTO, ...MODEL_LIST].find(m => m.id === modelSel.value)?.note ?? '';
  }

  modelSel.addEventListener('change', () => {
    const auto = modelSel.value === 'auto';
    store.set({ model: baseModel(), autoUpgrade: auto });
    showModelHint();
  });

  // ── Render ─────────────────────────────────────────────────────────────────
  function render() {
    const active = isRunning || waiting || rateSecs > 0;
    goBtn.innerHTML = active ? ICON_PAUSE : ICON_PLAY;
    goBtn.classList.toggle('active', active);
    goBtn.title = active ? 'Stop' : 'Start';

    let cls = 'idle', text = hasKey ? 'Ready' : 'Add your API key to start';
    if (errorMsg)        { cls = 'err';  text = errorMsg; }
    else if (infoMsg && !isRunning && !waiting) { cls = 'idle'; text = infoMsg; }
    else if (rateSecs)   { cls = 'hold'; text = `Rate limited · ${rateSecs}s`; }
    else if (paused)     { cls = 'hold'; text = 'Paused'; }
    else if (isRunning)  { cls = 'run';  text = 'Answering…' + stepNote; }
    else if (waiting)    { cls = 'run';  text = waitingForUser ? 'Click Next when ready' : 'Next question…'; }

    // Before anything has happened, say what the page looks like, so it's
    // plain the question was recognised before anything is spent on it
    const idle = hasKey && !errorMsg && !infoMsg && !isRunning && !waiting && !paused && !rateSecs;
    if (idle && answered === 0 && pageKind) text += ` · ${pageKind}`;

    if (answered > 0 && !errorMsg) text += ` · ${answered}`;
    // Show the model only when it differs from the one the run started on
    if (lastModel && lastModel !== baseModel() && !errorMsg) {
      text += ` · ↑ ${MODEL_LIST.find(m => m.id === lastModel)?.label ?? lastModel}`;
    }

    flagBtn.hidden = !(keepLog && canFlag && !isRunning);

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
    ['mode', 'lastPresetIndex', 'notes', 'autoContinue', 'autoUpgrade', 'apiKey', 'model', 'barPos', 'keepLog'],
    s => {
      setMode(MODES[s.mode] ? s.mode : legacyMode(s), false);

      notes = s.notes ?? '';
      notesInput.value = notes;

      // Opus 5.5 replaced Opus 5 in the menu; a saved Opus 5 carries over
      if (s.model === 'claude-opus-5') {
        s.model = 'claude-opus-5-5';
        store.set({ model: s.model });
      }

      // Auto is the old default pairing: cheapest model, upgrade switched on
      const named = MODEL_LIST.some(m => m.id === s.model) ? s.model : DEFAULT_MODEL;
      const auto = s.autoUpgrade !== false && named === DEFAULT_MODEL;
      modelSel.value = auto ? 'auto' : named;
      // An older pairing like "Sonnet, upgrading on hard questions" has no
      // place in the new list; it becomes plain Sonnet, as the menu shows it
      if (!auto && s.autoUpgrade !== false) store.set({ autoUpgrade: false });
      showModelHint();

      hasKey = !!s.apiKey;
      showKeyEditor(!hasKey);

      keepLog = s.keepLog === true;
      logSw.classList.toggle('on', keepLog);
      logSw.setAttribute('aria-checked', String(keepLog));

      // Where the user last parked the bar. Clamped on the way in, so a
      // position saved on a bigger screen still lands somewhere visible.
      if (s.barPos && Number.isFinite(s.barPos.left) && Number.isFinite(s.barPos.top)) {
        placeAt(s.barPos.left, s.barPos.top);
      } else {
        orientPanel();
      }

      render();
      scheduleDetect(1500);

      // Arrived here by the loop's own Next click: carry on. The previous
      // page's run finished (it clicked Next), so count it.
      const resume = takeResume();
      if (resume && hasKey && autoContinue) {
        answered = (Number(resume.answered) || 0) + 1;
        setTimeout(() => { if (!isRunning && !waiting) triggerRun(); }, 1200);
      }
    }
  );

  let notesDebounce = null;
  notesInput.addEventListener('input', () => {
    clearTimeout(notesDebounce);
    notesDebounce = setTimeout(() => {
      notes = notesInput.value.trim();
      store.set({ notes });
    }, 400);
  });

  // A saved key is set-and-forget, so it shrinks to one line. The editor never
  // shows the saved key back: Change starts from an empty box.
  function showKeyEditor(editing) {
    keySavedRow.hidden = editing;
    keyEditRow.hidden = !editing;
    cancelKeyBtn.hidden = !hasKey;     // nothing to go back to without one
    keyHint.hidden = hasKey;
    keyInput.value = '';
  }

  saveKeyBtn.addEventListener('click', () => {
    const k = keyInput.value.trim();
    if (!k) { keyInput.focus(); return; }
    store.set({ apiKey: k }, () => {
      hasKey = true;
      errorMsg = '';
      showKeyEditor(false);
      render();
      scheduleDetect(0, true);
    });
  });
  changeKeyBtn.addEventListener('click', () => { showKeyEditor(true); keyInput.focus(); });
  cancelKeyBtn.addEventListener('click', () => showKeyEditor(false));
  keyInput.addEventListener('keydown', e => { if (e.key === 'Enter') saveKeyBtn.click(); });

  // Model, notes and troubleshooting: available, out of the way
  moreBtn.addEventListener('click', () => {
    const open = more.hidden;
    more.hidden = !open;
    moreBtn.setAttribute('aria-expanded', String(open));
    if (open) refreshLogCount();
  });

  // ── Answer log ────────────────────────────────────────────────────────────
  function refreshLogCount() {
    bgSend({ type: 'LOG_COUNT' }, res => {
      const n = res?.count ?? 0;
      logCount.textContent = n ? `${n} answer${n === 1 ? '' : 's'} logged` : 'Nothing logged yet';
      logDownloadBtn.disabled = logClearBtn.disabled = n === 0;
      logRow.hidden = !keepLog && n === 0;
    });
  }

  function setKeepLog(on) {
    keepLog = on;
    logSw.classList.toggle('on', on);
    logSw.setAttribute('aria-checked', String(on));
    store.set({ keepLog: on });
    render();
    refreshLogCount();
  }
  logSw.addEventListener('click', () => setKeepLog(!keepLog));
  logSw.addEventListener('keydown', e => {
    if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); setKeepLog(!keepLog); }
  });

  flagBtn.addEventListener('click', () => {
    bgSend({ type: 'LOG_FLAG' }, res => {
      if (!res?.ok) return;
      canFlag = false;        // one mark per answer
      const note = 'Marked as wrong';
      infoMsg = note;
      render();
      setTimeout(() => { if (infoMsg === note) { infoMsg = ''; render(); } }, 2000);
    });
  });

  logDownloadBtn.addEventListener('click', () => {
    bgSend({ type: 'LOG_EXPORT' }, res => {
      const entries = res?.entries ?? [];
      if (!entries.length) return;
      const json = JSON.stringify({ exported: new Date().toISOString(), entries }, null, 1);
      const a = document.createElement('a');
      a.download = `page-agent-log-${new Date().toISOString().slice(0, 10)}.json`;
      let url;
      try { url = URL.createObjectURL(new Blob([json], { type: 'application/json' })); }
      catch (_) { url = 'data:application/json;charset=utf-8,' + encodeURIComponent(json); }
      a.href = url;
      shadow.appendChild(a);
      a.click();
      a.remove();
      if (url.startsWith('blob:')) setTimeout(() => URL.revokeObjectURL(url), 5000);
    });
  });

  // Two taps, so the log isn't lost to a stray click
  let clearArmed = null;
  logClearBtn.addEventListener('click', () => {
    if (!clearArmed) {
      logClearBtn.textContent = 'Tap again to clear';
      clearArmed = setTimeout(() => { clearArmed = null; logClearBtn.textContent = 'Clear'; }, 3000);
      return;
    }
    clearTimeout(clearArmed);
    clearArmed = null;
    logClearBtn.textContent = 'Clear';
    bgSend({ type: 'LOG_CLEAR' }, () => refreshLogCount());
  });

  // ── Recognising the page ──────────────────────────────────────────────────
  // Asks the background what the page is — it knows which frame holds the
  // question — once the page has had a moment to draw, and again when the
  // address changes. Reading the page never involves Claude, and is done as a
  // peek that leaves a run's element list alone.
  function scheduleDetect(delay, force) {
    clearTimeout(detectTimer);
    detectTimer = setTimeout(() => detectPage(force), delay);
  }
  function detectPage(force) {
    if (!hasKey || isRunning || waiting || document.hidden) return;
    if (!force && location.href === detectedHref) return;
    const href = detectedHref = location.href;
    bgSend({ type: 'DETECT_PAGE', host: location.hostname }, res => {
      if (href !== location.href) return;      // moved on in the meantime
      pageKind = res?.kind ?? '';
      render();
      // A page that draws its question late gets exactly one more look.
      // Most pages aren't quizzes at all, so never more than one.
      if (!pageKind && retriedHref !== href) {
        retriedHref = href;
        scheduleDetect(3500, true);
      }
    });
  }
  // Web apps change address without reloading the page
  let seenHref = location.href;
  setInterval(() => {
    if (location.href === seenHref) return;
    seenHref = location.href;
    pageKind = '';
    render();
    scheduleDetect(1500);
  }, 1000);


  checkPageBtn.addEventListener('click', () => {
    checkPageBtn.textContent = 'Checking…';
    checkPageBtn.disabled = true;
    bgSend({ type: 'CHECK_PAGE' }, (res, sendError) => {
      checkPageBtn.textContent = 'Run';
      checkPageBtn.disabled = false;
      const lines = sendError ? [{ ok: false, text: sendError }]
                  : res?.lines ?? [{ ok: false, text: 'No response from the extension. Refresh this page and try again.' }];
      if (!sendError) {
        lines.push({ info: true, text: `Mode: ${MODES[mode].label}` });
      }
      // textContent, never innerHTML: these lines carry page and API text
      checkResult.replaceChildren(...lines.map(l => {
        const d = document.createElement('div');
        d.className = l.info ? 'info' : l.ok ? 'ok' : 'bad';
        d.textContent = l.text;
        return d;
      }));
    });
  });

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
        if (keepLog) canFlag = true;

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

        // The run already moved to the next question (SIMnet's Continue), so
        // there's no change left to wait for: go on once it has settled
        if (result.advanced) {
          waiting = true;
          render();
          pollTimer = setTimeout(() => {
            if (token !== runToken) return;
            waiting = false;
            triggerRun();
          }, 1000);
          return;
        }

        // Wait for the page to actually change before the next question
        const root = document.querySelector('[role="main"], main, article, form') ?? document.body;
        waitForPageChange((root.innerText ?? '').slice(0, 400), token);
      }
    );
  }

  // Poll until the question content changes, then run again. When we clicked
  // Next ourselves, a 5s fallback means a page that re-renders identically
  // never strands the loop. In answer-only mode the student clicks Next, and
  // however long they take, running again before they do would only go back
  // over the question just answered — so there, wait for them.
  function waitForPageChange(snapshot, token) {
    waiting = true;
    waitingForUser = PRESETS[presetIndex].postClicks.length === 0;
    render();
    const deadline = waitingForUser ? Infinity : Date.now() + 5000;
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

  if (msg.type === 'SIMNET_VERDICT') {
    const v = findVerdict();
    sendResponse({ verdict: v?.verdict ?? null, hint: v?.hint ?? '', attempts: attemptsShown() });
    return false;
  }

  if (msg.type === 'SIMNET_CONTINUE') {
    const v = findVerdict();
    if (!v) { sendResponse({ success: false, error: 'No result popup to continue from' }); return false; }
    realClick(v.button);
    sendResponse({ success: true });
    return false;
  }

  if (msg.type === 'PING') {
    sendResponse({ ok: true });
    return false;
  }

  if (msg.type === 'SCRAPE') {
    // A peek (recognising the page, Check this page) must leave alone the
    // list a run's clicks point into, or an idle look could shift an index
    // between a run's read and its click.
    const kept = _lastElements, keptSeen = _simSeen;
    if (msg.firstLook && !msg.peek) _simSeen = null;
    try {
      sendResponse(scrape());
    } catch (e) {
      sendResponse({ error: e.message, text: '', elements: [] });
    } finally {
      if (msg.peek) { _lastElements = kept; _simSeen = keptSeen; }
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

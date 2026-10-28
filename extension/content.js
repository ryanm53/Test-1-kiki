// Page Agent — page side: scrapes the question, carries out the action,
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
const DRAG_SEL = '[data-rbd-drag-handle-draggable-id], [data-react-beautiful-dnd-drag-handle], [data-rfd-drag-handle-draggable-id], [data-rfd-draggable-id], [aria-roledescription="draggable"]';
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
  '[role="combobox"]',
  '[aria-haspopup="listbox"]',
  'mat-select',
  'ng-select',
  '[role="listitem"]',
  '[draggable="true"]',
  // Drag handles of the libraries that tag them (react-beautiful-dnd, its
  // successor hello-pangea, dnd-kit), whether or not they say role="button"
  '[data-rbd-drag-handle-draggable-id]',
  '[data-rfd-drag-handle-draggable-id]',
  '[aria-roledescription="draggable"]',
  '[contenteditable="true"]',
  '[data-automation-id]'
].join(', ');

// Cached element list from the last scrape — execute() uses these references
// so it operates on exactly the elements Claude was shown.
let _lastElements = [];
let _lastDesc = [];   // what each of those was described as, to find it again if the page redraws it

// What a SIMnet look saw, so the next look can tell what has just appeared.
// Cleared on each task's first look; a peek never changes it.
let _simSeen = null;

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

// The part of the page the question is in, to skip nav, header and footer.
// Not simply the first main/article/form: a page can have several, and the
// first may be empty — McGraw Hill's has one, which left the model the first
// 120 characters of each question and none of its dollar amounts. The one
// holding the most controls wins; if none has any text, the whole page.
function pageRoot() {
  let best = null, most = -1;
  for (const el of document.querySelectorAll('[role="main"], main, article, form')) {
    if ((el.innerText ?? '').trim().length < 20) continue;
    const n = el.querySelectorAll(INTERACTIVE_SEL).length;
    if (n > most) { best = el; most = n; }
  }
  return best ?? document.body;
}

// Resolve an element's accessible label, including aria-labelledby chains.
// Many platforms (e.g. Angular quiz apps) store the visible answer text in a
// separate <span> pointed to by aria-labelledby rather than inside the input.
function accessibleText(el, ownText = true) {
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
  // 5. Element's own visible text — except a dropdown's, which is its
  // options (a <select>) or what is chosen (a custom one), not its name
  if (!ownText) return (el.getAttribute('title') || '').trim();
  return (el.innerText || el.getAttribute('title') || '').trim();
}

// A dropdown built from divs rather than a <select>: a box that opens a list
// of options when clicked. Its options often aren't in the page until then.
function isDropdown(el) {
  return !/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)
    && el.matches('[role="combobox"], [aria-haspopup="listbox"], mat-select, ng-select');
}
const DROPDOWN_SEL = '[role="combobox"], [aria-haspopup="listbox"], mat-select, ng-select';

// What a dropdown offers, read off its list, and what it shows as chosen.
// Lists a closed dropdown keeps out of the page are learnt by opening it
// (learnDropdowns) and remembered here.
const _dropChoices = new WeakMap();
const _dropTried = new WeakSet();   // opened once already, list or not
const optionText = o => (o.innerText ?? o.textContent ?? '').trim();
function listOf(el) {
  for (const id of (el.getAttribute('aria-controls') || el.getAttribute('aria-owns') || '').split(/\s+/)) {
    const list = id && document.getElementById(id);
    if (list) return list;
  }
  return null;
}
function dropdownOptions(el) {
  const list = listOf(el);
  const found = list ? Array.from(list.querySelectorAll('[role="option"]')).map(optionText).filter(Boolean) : [];
  return found.length ? found : (_dropChoices.get(el) ?? null);
}
const chosenText = el => el.tagName === 'SELECT'
  ? (el.selectedIndex > 0 || el.options[el.selectedIndex]?.value ? optionText(el.options[el.selectedIndex]) : '')
  : (el.innerText ?? '').trim();

// Options on screen right now: a dropdown's own list if it names one, else
// whatever list just opened.
function visibleOptions(el) {
  const list = listOf(el);
  const scope = list && isRendered(list) ? list : document;
  return Array.from(scope.querySelectorAll('[role="option"], [role="listbox"] li, mat-option, .ng-option'))
    .filter(o => isRendered(o) && optionText(o));
}

// The option meant by `value`: the same words first, then one containing the
// other — "Less: Allowance" for "Less: Allowance for uncollectible accounts".
const squash = t => t.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
function bestOption(options, value, textOf) {
  const want = squash(value);
  if (!want) return null;
  return options.find(o => squash(textOf(o)) === want)
      ?? options.find(o => squash(textOf(o)).startsWith(want))
      ?? options.find(o => { const t = squash(textOf(o)); return t && (t.includes(want) || want.includes(t)); })
      ?? null;
}

const waitFor = async (get, ms) => {
  const end = Date.now() + ms;
  for (;;) {
    const v = get();
    if (v || Date.now() > end) return v;
    await new Promise(r => setTimeout(r, 50));
  }
};

function closeDropdown(el) {
  for (const t of [el, document.activeElement, document.body]) {
    t?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, bubbles: true }));
  }
}

// Open a custom dropdown and pick an option by its text
async function chooseFromDropdown(el, value) {
  realClick(el);
  const options = await waitFor(() => { const o = visibleOptions(el); return o.length ? o : null; }, 1500);
  const pick = options && bestOption(options, value, optionText);
  if (!pick) { closeDropdown(el); return false; }
  pick.scrollIntoView?.({ block: 'nearest' });
  realClick(pick);
  return true;
}

// Learn the choices of custom dropdowns whose lists aren't in the page until
// opened, so the model is shown them. Each is opened, read and closed.
// Only those in the question area, and each only once: a menu button that
// merely calls itself a listbox shouldn't be reopened on every look.
function unreadDropdowns() {
  return Array.from(pageRoot().querySelectorAll(DROPDOWN_SEL))
    .filter(el => isDropdown(el) && !_dropTried.has(el) && isRendered(el) && !dropdownOptions(el));
}
// A financial statement has a dropdown on every line — twenty or more — so
// there's no small cap, only a time budget: the page is asked about within 20s
async function learnDropdowns() {
  const end = Date.now() + 12000;
  for (const el of unreadDropdowns()) {
    if (Date.now() > end) break;
    _dropTried.add(el);
    realClick(el);
    const options = await waitFor(() => { const o = visibleOptions(el); return o.length ? o : null; }, 600);
    if (options) _dropChoices.set(el, options.map(optionText));
    closeDropdown(el);
    await new Promise(r => setTimeout(r, 40));
    if (el.getAttribute('aria-expanded') === 'true') realClick(el);
  }
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
        if (t) return t.slice(0, 1500);
      }
      // Fallback: use the legend text itself if it's meaningful
      const legendText = legend.innerText?.trim();
      if (legendText && legendText.length > 5) return legendText.slice(0, 1500);
    }
  }
  // Generic fallback: walk up looking for a .prompt or similar container
  let node = el.parentElement;
  for (let i = 0; i < 8 && node; i++) {
    const prompt = node.querySelector('.prompt, [class*="question-text"], [class*="questionText"]');
    if (prompt) {
      const t = prompt.innerText?.trim();
      if (t) return t.slice(0, 1500);
    }
    node = node.parentElement;
  }
  return null;
}

// ── Quiz pages that aren't Canvas Classic ───────────────────────────────────
// The newer Canvas quizzes (and other sites') put every question on one page, each
// as a block of its own, and draw the choices themselves: the real radio input is
// laid, see-through, over a styled circle. A see-through input counts as not on the
// page, so the page looked to have no choices at all ("Couldn't find an answer
// here"), and anyway the ordinary path takes the page to be one question.
const isTick = el => el.tagName === 'INPUT' && /^(radio|checkbox)$/.test(el.type);
// A radio or checkbox that is only see-through (opacity 0), not hidden: clicking it answers
function seeThrough(el) {
  if (!isTick(el)) return false;
  const r = el.getBoundingClientRect();
  if (!r.width || !r.height) return false;
  const cs = getComputedStyle(el);
  return cs.display !== 'none' && cs.visibility !== 'hidden';
}
const choiceOk = el => !el.closest('#__cap-host, #__cap-marks') && (isRendered(el) || seeThrough(el));
const byDocumentOrder = (a, b) => (a.compareDocumentPosition(b) & 4) ? -1 : 1;

// The questions of a page of several: each is the widest box that holds one group of
// choices and no other group's. Null unless there are at least two.
function quizBlocks() {
  const choices = Array.from(document.querySelectorAll('input[type="radio"], [role="radio"]'))
    .filter(choiceOk)
    // a styled wrapper is not a second choice beside the input inside it
    .filter(el => !(el.matches('[role="radio"]') && el.querySelector('input[type="radio"]')));
  const ids = new WeakMap();
  const idOf = el => { if (!ids.has(el)) ids.set(el, ids.size + 1); return ids.get(el); };
  const keyOf = el => {
    if (el.name) return `n:${el.name}`;
    const g = el.closest('[role="radiogroup"], fieldset, [role="group"]');
    return g ? `g:${idOf(g)}` : null;
  };
  const groups = new Map();
  for (const el of choices) {
    const k = keyOf(el);
    if (!k) continue;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(el);
  }
  const blocks = [];
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const mine = new Set(group);
    const others = choices.filter(c => !mine.has(c));
    let box = null;
    for (let node = group[0].parentElement; node && node !== document.body; node = node.parentElement) {
      if (others.some(c => node.contains(c))) break;
      box = node;
    }
    if (!box || !group.every(c => box.contains(c)) || !isRendered(box)) continue;
    const text = (box.innerText ?? '').trim();
    if (text.length < 25) continue;   // a rating scale, not a question
    blocks.push({ box, group, text });
  }
  return blocks.length >= 2 ? blocks : null;
}

// The prose of a question in its block: the longest piece of text in it that isn't a
// choice or a control (the number, "True or False" and "2 points" around it are short)
function blockQuestion(block, labels) {
  const parts = [];
  const walker = document.createTreeWalker(block.box, NodeFilter.SHOW_TEXT);
  let n;
  while ((n = walker.nextNode())) {
    const t = n.nodeValue.replace(/\s+/g, ' ').trim();
    const host = n.parentElement;
    if (!t || labels.has(t) || !host || /^(SCRIPT|STYLE)$/.test(host.tagName)) continue;
    if (host.closest('label, [role="radio"], [role="checkbox"], button, option')) continue;
    parts.push(t);
  }
  const longest = parts.reduce((a, t) => t.length > a.length ? t : a, '');
  const all = parts.join(' ');
  return (longest.length >= 25 && longest.length >= all.length * 0.5 ? longest : all).slice(0, 500);
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
// Each cell's place in the table as drawn. A rowspan ("September 17" over
// two lines) or colspan ("Balance Sheet" over four columns) shifts everything
// after it, so a cell's position among its row's children isn't its column.
function tableGrid(table) {
  const rows = Array.from(table.querySelectorAll(ROW_SEL));
  const grid = rows.map(() => []);
  const where = new Map();
  rows.forEach((row, r) => {
    let c = 0;
    for (const cell of row.children) {
      while (grid[r][c]) c++;
      const rs = Math.max(1, Number(cell.getAttribute('rowspan') || cell.getAttribute('aria-rowspan')) || 1);
      const cs = Math.max(1, Number(cell.getAttribute('colspan') || cell.getAttribute('aria-colspan')) || 1);
      for (let i = 0; i < rs && r + i < rows.length; i++)
        for (let j = 0; j < cs; j++) grid[r + i][c + j] = cell;
      where.set(cell, { r, c });
      c += cs;
    }
  });
  return { rows, grid, where };
}

const DROP_SEL = 'select, [role="combobox"], [aria-haspopup="listbox"], mat-select, ng-select';

function tableLabel(el) {
  const cell = el.closest(CELL_SEL);
  const table = cell?.closest(TABLE_SEL);
  if (!cell || !table) return null;
  const { rows, grid, where } = tableGrid(table);
  const at = where.get(cell);
  if (!at) return null;

  const hasTargets = i =>
    rows[i].querySelector('input, textarea, ' + DROP_SEL) ||
    Array.from(rows[i].children).some(isSheetCell);
  // A data row holds something answerable or names itself in the first column
  const isData = i => hasTargets(i) || !!cellText(grid[i][0]);

  // Dropdowns in several columns of one row — a balance sheet and an income
  // statement side by side, each line an account's name and its amount. A
  // dropdown there names only the box right beside it: taking the leftmost
  // would call the Liabilities amount "named by" the Assets dropdown. And the
  // heading rows that start with a word ("Assets") aren't lines to count.
  const paired = Array.from(new Set(grid[at.r])).filter(x => x?.querySelector?.(DROP_SEL)).length >= 2;
  const rowNo = () => rows.slice(0, at.r + 1).filter((_, i) => paired ? hasTargets(i) : isData(i)).length;

  // Row header: the first real text left of this cell. A "$" beside a box
  // names nothing; a row named by a dropdown ("Less: Allowance…", picked by
  // the student) says so, and which row it is.
  let rowLabel = '';
  if (paired) {
    const left = at.c > 0 ? grid[at.r][at.c - 1] : null;
    const drop = left && left !== cell ? left.querySelector(DROP_SEL) : null;
    rowLabel = drop ? `row ${rowNo()}, named by its dropdown (${chosenText(drop) ? `"${chosenText(drop)}"` : 'not chosen yet'})`
      : el.matches(DROP_SEL) ? `row ${rowNo()}'s name` : `row ${rowNo()}`;
  }
  for (let c = 0; c < at.c && !rowLabel; c++) {
    const left = grid[at.r][c];
    if (!left || left === cell) continue;
    const drop = left.querySelector(DROP_SEL);
    if (drop) {
      const chosen = chosenText(drop);
      rowLabel = `row ${rowNo()}, named by its dropdown (${chosen ? `"${chosen}"` : 'not chosen yet'})`;
      break;
    }
    const t = cellText(left);
    if (t && !/^[\s$€£%().,-]*$/.test(t)) {
      rowLabel = t;
      // One label over several lines — a date with two entries — says which
      const span = Number(left.getAttribute('rowspan') || left.getAttribute('aria-rowspan')) || 1;
      if (span > 1) rowLabel += ` (line ${at.r - where.get(left).r + 1} of ${span})`;
    }
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
  const headerAt = i => (grid[i][at.c] && grid[i][at.c] !== cell) ? cellText(grid[i][at.c]) : '';
  let colLabel = '';
  for (let i = at.r - 1; i >= 0 && !colLabel; i--) {
    if (isData(i)) continue;
    colLabel = headerAt(i);
  }
  // Layouts that label every row (a leading row-number column, say) leave the
  // strict pass with nothing, so fall back to skipping only answerable rows.
  for (let i = at.r - 1; i >= 0 && !colLabel; i--) {
    if (hasTargets(i)) continue;
    colLabel = headerAt(i);
  }

  // A dropdown that names its own row
  if (!rowLabel && el.matches(DROP_SEL)) rowLabel = `row ${rowNo()}'s name`;

  const label = [colLabel, rowLabel].filter(Boolean).join(' — ');
  return label || null;
}

function isTableField(el) {
  return (/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) || isDropdown(el)) && !!el.closest(TABLE_SEL);
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

// A blank with no label of its own, outside any table (a statement drawn with
// divs): the closest text just before it — in its row, or just above it
function nearbyLabel(el) {
  if (el.type === 'radio' || el.type === 'checkbox') return '';
  let node = el;
  for (let i = 0; i < 4 && node && node !== document.body; i++, node = node.parentElement) {
    for (let sib = node.previousElementSibling, n = 0; sib && n < 3; sib = sib.previousElementSibling, n++) {
      if (sib.querySelector('input, select, textarea, button')) continue;
      const t = (sib.innerText ?? sib.textContent ?? '').trim().replace(/\s+/g, ' ');
      if (t && t.length <= 80) return t;
    }
  }
  return '';
}

function describeEl(el) {
  const question = nearestQuestionText(el);
  // Fall back to table headers when the field has no label of its own
  const drop = el.tagName === 'SELECT' || isDropdown(el);
  // A worksheet cell (not SIMnet's, which is named by what it holds) is named by its row
  // and column, with what it holds shown apart: once filled, a cell listed as "Current
  // liability" no longer says which row it is
  const worksheetCell = isSheetCell(el) && !cellAddress(el);
  const own = accessibleText(el, !drop);
  const held = worksheetCell ? (el.innerText ?? el.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 80) : '';
  // (only where the label was nothing but what the cell holds: any other label is as it was)
  const text = (worksheetCell && own && own.replace(/\s+/g, ' ').trim().slice(0, 80) === held)
    ? (tableLabel(el) || own)
    : (own || tableLabel(el) || nearbyLabel(el) || '');
  return {
    tag: el.tagName.toLowerCase(),
    type: el.getAttribute('type') || null,
    text: text.slice(0, 100),
    placeholder: el.getAttribute('placeholder') || null,
    // Never a password; never a tick box, whose value is just "on"
    value: (isTextBox(el) && el.type !== 'password' && !el.isContentEditable && el.value)
      ? String(el.value).slice(0, 60)
      : drop ? (chosenText(el).slice(0, 80) || undefined) : held || undefined,
    // A dropdown list's choices, so one can be picked by its text
    options: el.tagName === 'SELECT'
      ? Array.from(el.options).slice(0, 100).map(o => o.textContent.trim()).filter(Boolean)
      : isDropdown(el) ? (dropdownOptions(el)?.slice(0, 100) ?? undefined) : undefined,
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

// The tables in a question — an inventory schedule, a list of events — that
// the answer area's text may not hold: a table sitting beside the question
// rather than in it is outside whatever pageRoot picked. Cells joined by " | ",
// one row a line, which reads as columns where innerText's tabs run together.
// Tables holding blanks are the worksheet, and are labelled cell by cell.
function dataTables() {
  const out = [];
  for (const t of document.querySelectorAll('table, [role="table"], [role="grid"]')) {
    if (out.length >= 3) break;
    if (t.closest('#__cap-host') || t.querySelector('table') || !isRendered(t)) continue;
    if (t.querySelector('input:not([type="hidden"]), textarea, select, ' + DROPDOWN_SEL)) continue;
    if (Array.from(t.querySelectorAll('td')).some(isSheetCell)) continue;
    const rows = Array.from(t.querySelectorAll(ROW_SEL)).slice(0, 40)
      .map(r => Array.from(r.children).map(c => cellText(c).replace(/\s+/g, ' ')).join(' | '))
      .filter(l => l.replace(/[|\s]/g, ''));
    if (rows.length >= 2) out.push(rows.join('\n'));
  }
  return out.join('\n\n').slice(0, 2500);
}

// The page's text without the contents of dropdowns: a <select>'s innerText is
// all its options, and a statement with a dozen of them would put the same long
// list into the prompt a dozen times — the real list is sent once, with the
// dropdown itself. Each select's own text is cut out of the page's, where it
// stands in it as one piece; the page itself is never touched (hiding them for
// the moment instead would be seen by any script watching the page).
function textOf(root) {
  let text = root.innerText ?? '';
  for (const sel of root.querySelectorAll('select')) {
    const own = sel.innerText ?? '';
    const at = own ? text.indexOf(own) : -1;
    if (at >= 0) text = text.slice(0, at) + text.slice(at + own.length);
  }
  return text;
}

// Whether the text alone is likely not enough to read the question: a picture
// on screen (a chart, an exhibit or a table drawn as an image) or hardly any
// text at all. The background then attaches a screenshot. Only what's in view
// counts, since a screenshot only holds that — and never the page's own chrome
// (logos, icons, nav).
function pictureNeeded(root, text) {
  const big = el => {
    if (el.closest('#__cap-host, header, nav, footer, button, [role="button"]')) return false;
    const r = el.getBoundingClientRect();
    return r.width >= 120 && r.height >= 60 && isRendered(el) && inViewport(el);
  };
  const pictures = Array.from(root.querySelectorAll('img, canvas, svg, [role="img"]')).filter(big);
  if (pictures.length) return 'picture';
  // Next to no text, though there are answers to give: the question is drawn
  return (text ?? '').replace(/\s+/g, ' ').trim().length < 50 ? 'sparse' : undefined;
}


function scrape() {
  // Prefer the main content area to skip nav/header/footer noise
  const root = pageRoot();

  let all = Array.from(document.querySelectorAll(INTERACTIVE_SEL)).filter(isRendered);
  // No choice listed, but see-through ones on the page: those are the choices
  if (!all.some(isTick)) {
    const hidden = Array.from(document.querySelectorAll('input[type="radio"], input[type="checkbox"]')).filter(choiceOk);
    if (hidden.length) all = [...new Set([...all, ...hidden])].sort(byDocumentOrder);
  }

  // Spreadsheet cells are plain <td>s, so they never match INTERACTIVE_SEL
  const sheetCells = Array.from(document.querySelectorAll('td')).filter(
    el => isSheetCell(el) && isRendered(el)
  );

  // A grid of fields inside a table is a worksheet — many blanks that have to be
  // filled together and kept consistent, rather than one answer to pick.
  // Deliberately not viewport-filtered: a worksheet is usually taller than the
  // screen, so requiring cells to be on-screen would hide most of the question
  // and make it look like there was nothing to answer.
  // A financial statement can be a grid of divs rather than a <table>, so a
  // dropdown counts as a blank wherever it is — and, once there are a couple
  // of them, so does every text box (the amounts beside the account names)
  const dropdowns = all.filter(el => el.tagName === 'SELECT' || isDropdown(el));
  const looseBoxes = dropdowns.length >= 2 ? all.filter(el => isTextBox(el) && el.type !== 'password' && !el.isContentEditable) : [];
  const fields = [...new Set([...all.filter(isTableField), ...sheetCells, ...dropdowns, ...looseBoxes])]
    .sort((a, b) => (a.compareDocumentPosition(b) & 4 /* b follows a */) ? -1 : 1);
  const isWorksheet = fields.length >= 4;
  const isField = new Set(fields);

  // Drag questions need spatial reasoning over several sequential moves
  const isDrag = !!document.querySelector(DRAG_SEL);

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
    // anything new since the previous look goes first, marked as just
    // appeared.
    const POPUP = '[role="menu"], [role="listbox"], [role="dialog"], [role="alertdialog"], [aria-modal="true"]';
    const baseline = _simSeen;               // null on a task's first look
    const allSet = new Set(all);
    // Colour swatches and the like are often bare shapes with only a title,
    // which the general selector doesn't treat as clickable. Those count
    // inside a menu or dialog, or once they've newly appeared.
    const titled = Array.from(document.querySelectorAll('[title], [aria-label]'))
      .filter(el => !el.matches('td.grdbdy-cell') && isRendered(el));
    // Short text with nothing inside it: a menu entry, a dialog option, a
    // label. Plain ones don't look clickable to the general selector, so they
    // count once they've newly appeared — what a click just opened. Read
    // with textContent, which unlike innerText costs no layout, since this
    // looks at every element on the page.
    const leaves = Array.from(document.body.querySelectorAll('*')).filter(el => {
      if (el.firstElementChild || el.tagName === 'TD' || el.tagName === 'SCRIPT' || el.tagName === 'STYLE') return false;
      const n = (el.textContent || '').trim().length;
      return n > 0 && n <= 40 && !el.closest('td.grdbdy-cell');
    });
    const extras = [
      ...Array.from(document.querySelectorAll(POPUP)).flatMap(p =>
        Array.from(p.querySelectorAll('[title], [aria-label], [tabindex], li'))).filter(isRendered),
      ...(baseline ? titled.filter(el => !baseline.has(el)) : []),
      ...(baseline ? leaves.filter(el => !baseline.has(el) && isRendered(el)).slice(0, 40) : [])
    ].filter(el => !allSet.has(el));

    // A control with no name of any kind is unusable to act on and would
    // only crowd out the ones that can be identified. Text boxes count even
    // unlabelled: the name box that opens on a sheet tab, a dialog field —
    // often exactly what the next step types into.
    const labelled = el => isTextBox(el) || (el.innerText || '').trim() || el.getAttribute('aria-label') || el.getAttribute('title');
    // The Excel window's own minimize / restore / close buttons: nothing a task
    // asks for, and a real run clicked Close ("In the application header, you
    // clicked the Close button") and lost the question
    const windowButton = el => /^(minimize|maximize|restore|close)Button$/i.test(accessibleText(el).trim());
    const candidates = [...new Set([...all, ...extras])].filter(el => !el.matches(CHROME) && !windowButton(el)).filter(labelled);
    // "New" means new since the previous look — never merely "inside a menu":
    // part of SIMnet's own toolbar sits in menu-like containers, which marked
    // ribbon buttons as just appeared on a task's very first look
    const isNew = el => baseline !== null && !baseline.has(el);

    // The strip under the grid: sheet tabs, the New Sheet (+) button, sheet
    // scrolling. Plain elements, so the general selector missed them — and
    // with them every task about sheets (group, rename, add, unhide). Taken by
    // position: anything short and labelled below the grid's last row.
    // ~1500 cells: which are drawn is worked out once and used twice
    const cells = simCells.filter(isRendered);
    const gridBottom = Math.max(...cells.slice(-400).map(c => c.getBoundingClientRect().bottom));
    // Cheapest tests first — the page has thousands of elements, and reading
    // text is what's costly
    const textOf = el => (el.innerText ?? el.textContent ?? '').trim();
    const underGrid = Number.isFinite(gridBottom) ? Array.from(root.querySelectorAll('*')).filter(el => {
      if (el.children.length > 2 || el.tagName === 'TD' || el.matches(CHROME)) return false;
      const r = el.getBoundingClientRect();
      if (r.top < gridBottom - 1 || !r.width || !r.height) return false;
      const t = textOf(el);
      if (!(t && t.length <= 30) && !el.getAttribute('aria-label') && !el.getAttribute('title')) return false;
      // The innermost of a wrapper and its child saying the same thing
      if (t && Array.from(el.children).some(c => textOf(c) === t)) return false;
      return isRendered(el);
    }).slice(0, 30) : [];
    const under = new Set(underGrid);
    const pool = [...new Set([...candidates, ...underGrid])];
    const controls = [
      ...pool.filter(isNew),
      ...underGrid.filter(el => !isNew(el)),
      ...pool.filter(el => !isNew(el) && !under.has(el))
    ].slice(0, 130);
    const fresh = new Set(controls.filter(isNew));
    _simSeen = new WeakSet([...pool, ...titled, ...leaves]);

    // Whatever cells the task names ("...to cell C7") must be present even when
    // empty, or the one cell the question is about can be the one left out.
    const named = new Set((root.innerText ?? '').slice(0, 600).match(/\b[A-Z]{1,3}\d{1,4}\b/g) ?? []);
    const referenced = cells.filter(c => named.has(cellAddress(c)));
    const populated = cells.filter(c =>
      !named.has(cellAddress(c)) &&
      (c.classList.contains('has-value') || /select|active|focused/i.test(c.className))
    ).slice(0, 30);

    _lastElements = [...controls, ...referenced, ...populated];
    const described = _lastElements.map(el => ({ ...describeEl(el), state: stateOf(el), fresh: fresh.has(el) || undefined }));
    // Labels that repeat — Sheet Options has two "Print" boxes, one under
    // Gridlines and one under Headings — mean nothing alone, and picking the
    // wrong one was graded wrong. Each gets the name of the group it's in.
    const counts = new Map();
    for (const d of described) if (d.text && !d.cell) counts.set(d.text, (counts.get(d.text) ?? 0) + 1);
    const repeated = new Set([...counts].filter(([, n]) => n > 1).map(([t]) => t));
    described.forEach((d, i) => {
      if (repeated.has(d.text)) d.group = groupOf(_lastElements[i], d.text, repeated);
    });
    return {
      text: textOf(root).slice(0, 5000),
      elements: described,
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
      needsPicture: pictureNeeded(document.querySelector('#questions') ?? document.body, canvasQs.map(questionOf).join('')) === 'picture' ? 'picture' : undefined,
      // Typed answers go in a second step after the choices are clicked
      hasBlanks: _lastElements.some(el => el.tagName === 'SELECT' || /^(text|number)$/.test(el.type)),
      isWorksheet: false,
      isDrag: false
    };
  }

  // A page of several questions that isn't Canvas Classic: all of them at once, as
  // for Canvas. (Not Connect, which puts one question on a page.)
  const quiz = isWorksheet || /(^|\.)mheducation\.com$/.test(window.location.hostname) ? null : quizBlocks();
  if (quiz) {
    const els = [], owners = [], questions = [];
    quiz.forEach((b, qi) => {
      const members = Array.from(b.box.querySelectorAll(
        'input[type="radio"], input[type="checkbox"], [role="radio"], [role="checkbox"], input[type="text"], input[type="number"], textarea, select'))
        .filter(el => choiceOk(el) || (!isTick(el) && isRendered(el)))
        .filter(el => !(el.matches('[role="radio"], [role="checkbox"]') && el.querySelector('input[type="radio"], input[type="checkbox"]')));
      const labels = new Set(members.map(el => accessibleText(el).trim()).filter(Boolean));
      const q = blockQuestion(b, labels);
      questions.push(`Question ${qi + 1}: ${q}`);
      for (const el of members) { els.push(el); owners.push(q); }
    });
    _lastElements = els.slice(0, 150);
    const described = _lastElements.map((el, i) => {
      const d = describeEl(el);
      // A choice with no label of its own reads as what is around it
      if (!d.text) d.text = (el.closest('label, [role="radio"], [role="checkbox"]')?.innerText ?? el.parentElement?.innerText ?? '').trim().slice(0, 100);
      return { ...d, question: owners[i].slice(0, 200) };
    });
    return {
      text: questions.join('\n\n').slice(0, 5000),
      elements: described,
      isCanvas: true,        // the whole page at once, never submitted for the student
      quizLabel: 'Quiz page',
      hasBlanks: _lastElements.some(el => el.tagName === 'SELECT' || /^(text|number)$/.test(el.type)),
      needsPicture: pictureNeeded(document.body, questions.join('')) === 'picture' ? 'picture' : undefined,
      isWorksheet: false,
      isDrag: false
    };
  }

  if (isWorksheet) {
    // Every cell, on-screen or not, first. Remaining slots go to on-screen
    // controls (submit, nav). The cap on cells is far above any real
    // worksheet: it was once 60 in all, and a 74-box accounting table had its
    // last two dates silently dropped.
    const rest = all.filter(el => !isField.has(el) && inViewport(el));
    _lastElements = [...fields.slice(0, 250), ...rest.slice(0, 20)];
  } else {
    // Ordinary questions fit on screen, so staying in the viewport keeps
    // offscreen nav and footer links out of the list.
    _lastElements = all.filter(inViewport).slice(0, 25);
  }

  const parts = partTabs();
  const text = textOf(root).slice(0, 5000);
  return {
    text,
    needsPicture: _lastElements.length ? pictureNeeded(root, text) : undefined,
    tables: dataTables() || undefined,
    elements: _lastElements.map(describeEl),
    isWorksheet,
    isDrag,
    // A question in parts: which there are, and which is on screen
    parts: parts.length > 1 ? parts.map(p => ({ text: p.text, current: p.current })) : undefined
  };
}

// Connect splits a long question into parts behind tabs: "Required 1",
// "Required 2", sometimes "Req A" or "Part 1". Each is answered in turn.
const PART_RE = /^(required|req\.?|part)\s*([0-9]{1,2}[a-z]?|[a-z])$/i;
function partTabs() {
  const seen = new Set();
  const tabs = [];
  for (const el of document.querySelectorAll('[role="tab"], button, a, li')) {
    const text = (el.innerText ?? el.textContent ?? '').trim().replace(/\s+/g, ' ');
    if (!PART_RE.test(text) || !isRendered(el)) continue;
    // A tab drawn as <li><a>Required 1</a></li> is one tab, not two
    if (tabs.some(t => t.el.contains(el) || el.contains(t.el))) {
      const i = tabs.findIndex(t => t.el.contains(el));
      if (i !== -1) tabs[i].el = el;   // keep the clickable inner one
      continue;
    }
    if (seen.has(text.toLowerCase())) continue;
    seen.add(text.toLowerCase());
    tabs.push({ el, text });
  }
  for (const t of tabs) {
    const li = t.el.parentElement?.tagName === 'LI' ? t.el.parentElement : null;
    const marks = [t.el, li].filter(Boolean);
    t.current = marks.some(m =>
      m.getAttribute('aria-selected') === 'true'
      || (m.getAttribute('aria-current') ?? 'false') !== 'false'
      || /(^|[\s_-])(active|selected|current)($|[\s_-])/i.test(m.className || ''));
  }
  return tabs;
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

// The entries of a list that is open on the page: options of a listbox, menu or
// autocomplete, or of a select. (A bare <li> counts only inside such a list: the
// page's own bullet points are not choices.)
const LIST_BOX = '[role="listbox"], [role="menu"], .ui-autocomplete, .ui-menu, .dropdown-menu, datalist, select, [class*="autocomplete"], [class*="suggest"], [class*="dropdown"], [class*="option-list"]';
function listedOptions() {
  return Array.from(document.querySelectorAll('[role="option"], [role="menuitem"], .ui-menu-item, li, option'))
    .filter(o => !o.closest('#__cap-host, #__cap-marks') && isRendered(o)
      && (o.matches('[role="option"], [role="menuitem"], .ui-menu-item') || o.closest(LIST_BOX)));
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

// The nearest heading-like text around an element: the first short text in
// an enclosing container that isn't the element's own and isn't itself one of
// the repeated labels. "Gridlines" for the Print box in the Gridlines column.
function groupOf(el, ownText, repeated) {
  let box = el.parentElement;
  for (let i = 0; i < 5 && box && box !== document.body; i++, box = box.parentElement) {
    const label = box.getAttribute('aria-label');
    if (label && label !== ownText && !repeated.has(label)) return label.slice(0, 40);
    const walker = document.createTreeWalker(box, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      const t = node.nodeValue.trim();
      if (!t || t.length > 40 || el.contains(node) || t === ownText || repeated.has(t)) continue;
      return t;
    }
  }
  return undefined;
}

function centreOf(el) {
  const r = el.getBoundingClientRect();
  return { bubbles: true, cancelable: true, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 };
}

// An element the model chose from the list, or — if the page has redrawn it in
// the seconds it spent thinking, as the Function Arguments dialog does after each
// box is filled ("[16] left the page", twice, in a real log) — its twin in the
// page as it is now: the same kind of thing, saying the same, the same number of
// times along. The list the model chose from is left as it was.
function liveElement(i) {
  const el = _lastElements[i];
  if (!el || document.contains(el)) return el;
  const want = _lastDesc[i];
  if (!want) return null;
  const sig = d => `${d.tag}|${d.text}|${d.type ?? ''}|${d.name ?? ''}`;
  const rank = _lastDesc.slice(0, i).filter(d => sig(d) === sig(want)).length;
  const keptEls = _lastElements, keptSeen = _simSeen, keptDesc = _lastDesc;
  let found = null;
  try {
    const now = scrape();
    const same = now.elements.map((d, j) => sig(d) === sig(want) ? j : -1).filter(j => j >= 0);
    if (same.length) found = _lastElements[same[Math.min(rank, same.length - 1)]];
  } catch (_) { /* nothing to go by */ }
  _lastElements = keptEls; _simSeen = keptSeen; _lastDesc = keptDesc;
  return found;
}

// The same range and still-on-the-page checks every action needs
function pickElement(index) {
  if (typeof index !== 'number' || index < 0 || index >= _lastElements.length) {
    return { error: `Index ${index} out of range (${_lastElements.length} elements)` };
  }
  const el = liveElement(index);
  if (!el) return { error: `Element [${index}] is no longer in the DOM` };
  return { el };
}

// SIMnet's cells carry their address in the id (cell-B7), so any cell can
// be named directly — listed or not
// The cells marked selected — the same marks the list shows as "(selected)"
function selectedSheetCells() {
  return Array.from(document.querySelectorAll('td.grdbdy-cell'))
    .filter(c => /select|active|focused/i.test(c.className) && isRendered(c));
}
function cellByAddress(ref) {
  return document.getElementById(`cell-${String(ref).toUpperCase()}`);
}
// The column and row "selectors" — the header letters and numbers. SIMnet's
// markup for them isn't known, but Excel's layout is: a column's header is the
// element reading "B" that sits above column B's cells, lined up with them; a
// row's header reads "5" and sits left of row 5, level with it. Found by text
// through a text walk (cheap), then by position.
function headerFor(text, isColumn) {
  const cells = Array.from(document.querySelectorAll(
    isColumn ? `[id^="cell-${text}"]` : 'td.grdbdy-cell'))
    .filter(c => (isColumn ? new RegExp(`^cell-${text}\\d+$`) : new RegExp(`^cell-[A-Z]+${text}$`)).test(c.id))
    .filter(isRendered);
  if (!cells.length) return null;
  const ref = cells[0].getBoundingClientRect();
  const gridTop = Math.min(...Array.from(document.querySelectorAll('td.grdbdy-cell')).filter(isRendered)
    .slice(0, 200).map(c => c.getBoundingClientRect().top));
  const gridLeft = Math.min(...Array.from(document.querySelectorAll('td.grdbdy-cell')).filter(isRendered)
    .slice(0, 200).map(c => c.getBoundingClientRect().left));

  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  let node, best = null;
  while ((node = walker.nextNode())) {
    if (node.nodeValue.trim() !== String(text)) continue;
    const el = node.parentElement;
    if (!el || el.closest('td.grdbdy-cell') || !isRendered(el)) continue;
    const r = el.getBoundingClientRect();
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    const fits = isColumn
      ? cx >= ref.left - 1 && cx <= ref.right + 1 && r.bottom <= gridTop + 2
      : cy >= ref.top - 1 && cy <= ref.bottom + 1 && r.right <= gridLeft + 2;
    // The one nearest the grid, if a letter happens to appear twice above it
    if (fits && (!best || (isColumn ? r.bottom > best.r.bottom : r.right > best.r.right))) best = { el, r };
  }
  return best?.el ?? null;
}

function pickTarget(action) {
  if (action.column !== undefined) {
    const el = headerFor(String(action.column).toUpperCase(), true);
    return el ? { el } : { error: `Couldn't find the header for column ${action.column}` };
  }
  if (action.row !== undefined) {
    const el = headerFor(String(action.row), false);
    return el ? { el } : { error: `Couldn't find the header for row ${action.row}` };
  }
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
    // By its words, loosely — or by its value. Never a value the list
    // doesn't have, which would leave the dropdown blank.
    const options = Array.from(el.options);
    const opt = options.find(o => o.value === value && o.value !== '')
             ?? bestOption(options, value, o => o.textContent);
    if (!opt) return false;
    // Through the native setter, as for text boxes below: React tracks the
    // value it last set, and a plain assignment can go unnoticed
    const setSelect = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value')?.set;
    if (setSelect) setSelect.call(el, opt.value); else el.value = opt.value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.dispatchEvent(new FocusEvent('blur', { bubbles: false }));
    return true;
  }

  if (el.isContentEditable) {
    el.textContent = value;
    el.dispatchEvent(new InputEvent('input', { bubbles: true, data: value }));
    return true;
  }

  // A number box silently blanks anything that isn't a plain number, so
  // "7,200", "$7,200" or an accountant's "(7,200)" is cleaned up first
  if (el.type === 'number') value = plainNumber(value);

  const proto = tag === 'textarea'
    ? window.HTMLTextAreaElement.prototype
    : window.HTMLInputElement.prototype;
  const nativeSetter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
  if (nativeSetter) nativeSetter.call(el, value); else el.value = value;

  el.dispatchEvent(new InputEvent('input', { bubbles: true, data: value }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  el.dispatchEvent(new FocusEvent('blur', { bubbles: false }));
  // A box that refused the value is a miss, not a success
  return !(value !== '' && el.value === '');
}

function plainNumber(v) {
  const t = String(v).trim();
  const neg = /^\(.*\)$/.test(t) || /^-/.test(t.replace(/^\$/, ''));
  const digits = t.replace(/[^0-9.]/g, '');
  if (!/^\d*\.?\d+$|^\d+\.$/.test(digits)) return t;
  return (neg ? '-' : '') + digits;
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
        const el = liveElement(i);
        // A cell can go stale if the page re-renders mid-fill; skip it and keep
        // going rather than throwing away every value already entered.
        if (!el) {
          failed.push(`[${i}] left the page`);
          continue;
        }
        el.scrollIntoView({ behavior: scroll, block: 'center' });
        await new Promise(r => setTimeout(r, bulk ? 20 : 120));
        const value = String(f.value ?? '');
        const ok = isDropdown(el) ? await chooseFromDropdown(el, value) : setFieldValue(el, value);
        if (ok === false) {
          failed.push(isDropdown(el) || el.tagName === 'SELECT'
            ? `[${i}] has no option "${value.slice(0, 40)}"`
            : `[${i}] wouldn't take "${value.slice(0, 40)}"`);
        }
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
        const el = liveElement(idx);
        if (!el) {
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

    // "Point to" a menu item: submenus like Hide & Unhide or Tab Color open on
    // hover, and SIMnet grades a click on them as a wrong answer
    if (action.action === 'hover') {
      const { el, error } = pickTarget(action);
      if (error) return { success: false, error };
      el.scrollIntoView({ behavior: 'auto', block: 'nearest' });
      const o = centreOf(el);
      el.dispatchEvent(new PointerEvent('pointerover', { ...o, isPrimary: true }));
      el.dispatchEvent(new PointerEvent('pointerenter', { ...o, bubbles: false, isPrimary: true }));
      el.dispatchEvent(new MouseEvent('mouseover', o));
      el.dispatchEvent(new MouseEvent('mouseenter', { ...o, bubbles: false }));
      el.dispatchEvent(new PointerEvent('pointermove', { ...o, isPrimary: true }));
      el.dispatchEvent(new MouseEvent('mousemove', o));
      await new Promise(r => setTimeout(r, 350));   // submenus animate open
      return { success: true };
    }

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
      // The cells SIMnet has selected: where typing goes when no cell is named
      // ("enter a formula in the selected cell"), and, for a block chosen for an
      // array formula's results, a block that must stay selected
      const picked = selectedSheetCells();
      if (action.index !== undefined || action.cell !== undefined) {
        const { el, error } = pickTarget(action);
        if (error) return { success: false, error };
        el.scrollIntoView({ behavior: 'auto', block: 'center' });
        // Clicking one cell of a selected block would shrink it to that cell
        if (!(picked.length > 1 && picked.includes(el))) realClick(el);
        target = el;
        await new Promise(r => setTimeout(r, 150));
      }
      // Clicking may open an editor; type into whichever is a text box
      const box = [target, editingNow()].find(isTextBox);
      if (box) {
        typeIntoBox(box, action.text);
        return { success: true };
      }
      // Nothing named and nothing open for editing: the selected cell (the first
      // of a selected block, which is where Excel types)
      if (!target && picked.length) target = picked.find(c => /active|focused/i.test(c.className)) ?? picked[0];
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

// ── Numbers on the screenshot ───────────────────────────────────────────────
// For the instant of a screenshot, every item the model has been listed that is
// on screen gets a small tag with its number — the number in the list — and a
// thin outline, like Vimium's hints. The model can then tell similar items
// apart and point at one it can't name ("click 14"). Drawn on a layer of its
// own that takes no clicks, in a shadow root so the page's CSS can't reach it,
// and taken down straight after the capture, and by a timer if that message
// never comes. It reads the page and changes nothing in it.
const MARK_LIMIT = 150;
const MARK_LIFE_MS = 6000;
let _markHost = null, _markTimer = null;

function unmark() {
  clearTimeout(_markTimer);
  _markTimer = null;
  _markHost?.remove();
  _markHost = null;
  // Any stray one (a script running twice) goes too
  document.querySelectorAll('#__cap-marks').forEach(e => e.remove());
}

function mark() {
  unmark();
  const vw = window.innerWidth, vh = window.innerHeight;
  const host = document.createElement('div');
  host.id = '__cap-marks';
  host.setAttribute('aria-hidden', 'true');
  host.style.cssText = 'position:fixed;left:0;top:0;width:100vw;height:100vh;z-index:2147483646;pointer-events:none;margin:0;padding:0;border:0;background:none;';
  const root = host.attachShadow({ mode: 'closed' });
  const style = document.createElement('style');
  style.textContent = `
    * { box-sizing: border-box; pointer-events: none; }
    .box { position: fixed; border: 1px solid rgba(255, 59, 48, 0.9); }
    .tag { position: fixed; background: #FFD60A; color: #000; border: 1px solid #000; border-radius: 3px;
           font: 700 11px/12px -apple-system, Helvetica, Arial, sans-serif; padding: 0 3px; white-space: nowrap; }`;
  root.appendChild(style);

  const placed = [];       // tags already down, to keep them from landing on each other
  const boxes = [];        // what was drawn, for the caller (and the tests)
  let outlined = 0;
  const overlaps = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

  for (let i = 0; i < _lastElements.length && boxes.length < MARK_LIMIT; i++) {
    const el = _lastElements[i];
    if (!el || !document.contains(el) || el.closest('#__cap-host') || !isRendered(el) || !inViewport(el)) continue;
    const r = el.getBoundingClientRect();
    // The part of it that's actually on screen
    const left = Math.max(r.left, 0), top = Math.max(r.top, 0);
    const w = Math.min(r.right, vw) - left, h = Math.min(r.bottom, vh) - top;
    if (w < 2 || h < 2) continue;

    // An outline, except round something that fills much of the screen (the
    // question's own container, say), where it would only be a frame
    if (w * h < vw * vh * 0.4) {
      const box = document.createElement('div');
      box.className = 'box';
      box.style.cssText = `left:${left}px;top:${top}px;width:${w}px;height:${h}px;`;
      root.appendChild(box);
      outlined++;
    }

    const label = String(i);
    const tw = 8 + label.length * 7, th = 14;
    // Beside a small item (a radio button, a checkbox) so it doesn't hide it;
    // on the corner of a larger one
    const x0 = (w < 40 && left > tw + 4) ? left - tw - 2 : left;
    const y0 = top;
    const clamp = t => ({ ...t, x: Math.min(Math.max(t.x, 0), Math.max(vw - tw, 0)), y: Math.min(Math.max(t.y, 0), Math.max(vh - th, 0)) });
    // Down, then across, until it has a clear place; failing that, where it began
    let tag = clamp({ x: x0, y: y0, w: tw, h: th });
    search: for (let dx = 0; dx < 4; dx++) {
      for (let dy = 0; dy < 6; dy++) {
        const t = clamp({ x: x0 + dx * (tw + 2), y: y0 + dy * (th + 1), w: tw, h: th });
        if (!placed.some(o => overlaps(t, o))) { tag = t; break search; }
      }
    }
    placed.push(tag);
    const tagEl = document.createElement('div');
    tagEl.className = 'tag';
    tagEl.textContent = label;
    tagEl.style.cssText = `left:${tag.x}px;top:${tag.y}px;`;
    root.appendChild(tagEl);
    boxes.push({ i, x: Math.round(tag.x), y: Math.round(tag.y), w: tw, h: th });
  }

  (document.documentElement || document.body).appendChild(host);
  // A modal dialog (<dialog>.showModal()) is drawn in the browser's top layer,
  // above everything however high its z-index — including these tags, which
  // would then be hidden behind the very dialog they point into. A popover goes
  // into the top layer too, after the dialog, so on top of it.
  try {
    host.setAttribute('popover', 'manual');
    host.style.overflow = 'visible';
    host.showPopover?.();
  } catch (_) { /* an older browser: the z-index has to do */ }
  _markHost = host;
  _markTimer = setTimeout(unmark, MARK_LIFE_MS);   // never left up if the capture never comes
  return { marked: boxes.length, outlined, boxes };
}

// Time for the tags to reach the screen before the capture is made: two frames
// have been drawn, and then a moment more for the browser to hand the last one
// to the compositor. (Without that, the first capture on a page can be taken a
// frame early, with no tags in it — seen in real Chrome, not in a test.)
const painted = () => new Promise(resolve => {
  let done = false;
  const finish = () => { if (!done) { done = true; resolve(); } };
  const settle = () => setTimeout(finish, 90);
  try { requestAnimationFrame(() => requestAnimationFrame(settle)); } catch (_) { /* no frames */ }
  setTimeout(finish, 400);   // a background tab never draws frames: don't wait on them
});

// ── A formula being typed into a spreadsheet ────────────────────────────────
// SIMnet opens a list of function names after "=" and three letters, and an
// argument hint after "(". In a real log each one reset the editor, and what had
// been typed before it was gone: "=RIGHT(A2,2)" came out as "HT(A2,2)". The
// background types in stages and asks here, after each, what the editor holds.
// match: it holds exactly this. have: it holds only the tail of it — the symptom,
// and the only thing taken as damage. Neither: it can't be told from here.
const CELL_REF = /^\$?[A-Z]{1,3}\$?\d{1,7}(:\$?[A-Z]{1,3}\$?\d{1,7})?$/;
function readEdit(expect) {
  const clean = t => String(t ?? '').replace(/\u00a0/g, ' ').replace(/\s+$/, '');
  const want = clean(expect);
  const boxes = [document.activeElement, ...document.querySelectorAll('[contenteditable], input:not([type="hidden"]):not([type="checkbox"]):not([type="radio"]):not([type="password"]), textarea')]
    .filter((el, i, all) => el && all.indexOf(el) === i && el.matches?.('[contenteditable], input, textarea')
      && !el.closest('#__cap-host, #__cap-marks') && isRendered(el));
  const texts = boxes.map(el => ({
    t: clean(el.matches('input, textarea') ? el.value : el.innerText),
    active: el === document.activeElement, rich: el.matches('[contenteditable]')
  }));
  const lines = (document.body?.innerText ?? '').split('\n').map(clean);
  if (texts.some(x => x.t === want) || lines.includes(want)) return { match: true, have: want };

  const tail = t => t !== want && want.endsWith(t) && !CELL_REF.test(t.trim());
  // Characters dropped from the middle (a "(" gone, in a real report): what is in
  // the focused editor is all of it but for some letters. Only the editor in use
  // is judged this way — another box on the page would match by chance.
  const subseq = (a, b) => { let k = 0; for (const ch of b) if (ch === a[k]) k++; return k === a.length; };
  const dropped = t => t !== want && t.length > 1 && t.length < want.length && subseq(t, want) && !CELL_REF.test(t.trim());
  // A box being edited: even an empty one that has the focus has lost it. Other
  // boxes (font size, search) are not the editor, however they read
  const box = texts.find(x => (x.active || x.rich)
    && (x.t.length > 1 || (x.active && x.t === '')) && (tail(x.t) || (x.active && dropped(x.t))));
  if (box) return { match: false, have: box.t };
  // The formula bar and the cell both show the editor: the same remnant twice
  const seen = new Map();
  for (const l of lines) if (l.length > 1 && tail(l)) seen.set(l, (seen.get(l) ?? 0) + 1);
  const twice = [...seen].find(([, n]) => n >= 2);
  return { match: false, have: twice ? twice[0] : null };
}

// ── Connect: getting from a graded question to the next one ─────────────────
// A question answered wrongly isn't the end of it. Connect greys out Next
// Question and says "Select a concept resource to continue."; picking one
// ("Read About the Concept") opens the reading, and a To Questions / Back to
// Questions button at the top right closes it again — after which Next works.
// None of those buttons is worded or marked the same on every page, so they're
// found by what they say, not by a selector.
const BUTTON_SEL = 'button, [role="button"], a[href], [role="link"], input[type="button"], input[type="submit"]';
const labelOf = el => (el.getAttribute('aria-label') || el.innerText || el.value || el.getAttribute('title') || '')
  .replace(/\s+/g, ' ').trim();
const isDisabled = el => !!el.disabled || el.getAttribute('aria-disabled') === 'true'
  || /(^|[\s_-])disabled($|[\s_-])/i.test(el.className || '');

// How well a button is the one meant by `kind` (0: not it)
function buttonScore(el, kind) {
  const t = labelOf(el);
  if (!t || t.length > 60) return 0;
  const id = el.getAttribute('data-automation-id') || '';
  if (kind === 'next') {
    // Never the way back, and never the one that hands the assignment in
    if (/previous|prior|\bback\b|skip|submit|finish|\bexit\b|\bend\b/i.test(t)) return 0;
    if (/^next( question)?[\s>›»→]*$/i.test(t)) return 4;
    if (/^(next|continue)\b/i.test(t)) return 3;
    if (/\bnext\b/i.test(t) && t.length < 30) return 2;
    if (/next/i.test(id) || /(^|[\s_-])next[-_ ]?(button|question)?($|[\s_-])/i.test(el.className || '')) return 1;
    return 0;
  }
  if (kind === 'resource') {
    if (/read about the concept/i.test(t)) return 3;
    if (/clarify with ai reader/i.test(t)) return 1;   // a chat panel, not the page; the last choice
    return 0;
  }
  if (kind === 'back') {
    if (/^(back |return )?to questions?$/i.test(t)) return 3;
    if (/\b(to|back to|return to) (the )?questions?\b/i.test(t)) return 2;
    return 0;
  }
  return 0;
}

// The best usable button of a kind, or null. `disabled` finds the best
// greyed-out one instead — to know a Next is there but waiting for something.
function smartFind(kind, { disabled = false } = {}) {
  let best = null, top = 0;
  for (const el of document.querySelectorAll(BUTTON_SEL)) {
    if (el.closest('#__cap-host, #__cap-marks') || !isRendered(el)) continue;
    if (isDisabled(el) !== disabled) continue;
    const sc = buttonScore(el, kind);
    if (sc > top) { top = sc; best = el; }
  }
  return best;
}

// Where a stuck Connect page is, for the background to decide what to press
function connectState() {
  const text = document.body?.innerText ?? '';
  return {
    graded: GRADED.test(text),
    needsResource: /select a concept resource to continue/i.test(text),
    resource: !!smartFind('resource'),
    back: !!smartFind('back'),
    next: !!smartFind('next'),
    nextWaiting: !!smartFind('next', { disabled: true }),
    // What can be pressed, so a failure says what was there
    buttons: Array.from(document.querySelectorAll(BUTTON_SEL))
      .filter(el => isRendered(el) && !el.closest('#__cap-host, #__cap-marks'))
      .map(labelOf).filter(Boolean).slice(0, 14)
  };
}

const sameText = (a, b) => squash(a) === squash(b);
// Connect's "Your Answer <pill>" line: the pill says correct or incorrect
const GRADED = /Your Answer\s*([a-z ]*?)\s*(incorrect|correct)\b/i;

// Connect's verdict on the answer just given, with what the right one was. The
// page says "Your Answer" with a pill reading correct or incorrect; a wrong
// answer is followed by a "Correct Answer" box listing the right ones. The
// right ones are taken as the page's own choices whose words appear in that
// box — so a stray line of explanation can't be mistaken for an answer.
function connectResult() {
  const text = document.body?.innerText ?? '';
  const m = GRADED.exec(text);
  const verdict = m ? (/incorrect|partially|not/i.test(m[0]) ? 'incorrect' : 'correct') : null;

  const choices = Array.from(document.querySelectorAll('input[type="radio"], input[type="checkbox"], [role="radio"], [role="checkbox"]'))
    .filter(isRendered)
    .map(el => ({ label: accessibleText(el).trim(), on: el.checked === true || el.getAttribute('aria-checked') === 'true' }))
    .filter(c => c.label);

  // The lines under a "Correct Answer" heading
  let lines = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  let node;
  while ((node = walker.nextNode())) {
    if (!/^Correct Answers?:?$/i.test(node.nodeValue.trim())) continue;
    const heading = node.parentElement;
    if (!heading || !isRendered(heading)) continue;
    for (let box = heading.parentElement, i = 0; box && box !== document.body && i < 4; box = box.parentElement, i++) {
      const got = (box.innerText ?? '').split('\n').map(l => l.trim()).filter(Boolean)
        .filter(l => !/^Correct Answers?:?$/i.test(l));
      if (got.length) { lines = got; break; }
    }
    break;
  }
  // The box may say a choice with its letter, or in part: when no line matches
  // a choice exactly, one that holds the other will do
  // (a line holding the whole choice, or a line that is most of it; and where
  // one choice is part of another, only the longer)
  const near = (line, label) => {
    const x = squash(line), y = squash(label);
    return y.length >= 6 && (x.includes(y) || (y.includes(x) && x.length >= y.length * 0.6));
  };
  let correct = choices.filter(c => lines.some(l => sameText(l, c.label))).map(c => c.label);
  if (!correct.length) {
    const hit = choices.filter(c => lines.some(l => near(l, c.label))).map(c => c.label);
    correct = hit.filter(a => !hit.some(b => b !== a && squash(b).includes(squash(a))));
  }
  return {
    verdict,
    yours: choices.filter(c => c.on).map(c => c.label),
    correct,
    lines: lines.slice(0, 12)
  };
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
  const ICON_HIDE  = '<svg viewBox="0 0 24 24" width="15" height="15"><path d="M5 11h14v2H5z"/></svg>';
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
    max-width: 290px;
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
  /* A closing note ("Answered. Check it over, then submit it yourself.") is
     read whole, like an error, not cut off */
  #statusText.note { white-space: normal; font-size: 12px; line-height: 1.35; }
  #status.note { max-width: 250px; white-space: normal; }

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

  /* Put the bar away */
  #hide {
    width: 22px; height: 26px; margin-left: -6px;
    flex-shrink: 0; border: none; background: transparent; border-radius: 7px;
    color: rgba(235, 235, 245, 0.32);
    display: flex; align-items: center; justify-content: center;
    cursor: pointer; transition: color 0.18s, background 0.18s;
  }
  #hide svg { fill: currentColor; display: block; }
  #hide:hover { color: #f5f5f7; background: rgba(120, 120, 128, 0.26); }

  /* Says how to bring a hidden bar back, then goes */
  #toast {
    max-width: 290px; padding: 10px 13px; border-radius: 13px;
    font-size: 12.5px; line-height: 1.45; color: #f5f5f7;
    opacity: 0; transition: opacity 0.25s;
    pointer-events: none;
  }
  #toast.show { opacity: 1; }
  #toast b { font-weight: 600; }

  /* ── Panel ── */
  #panel {
    position: absolute;
    /* From the bar's real height, not a fixed offset: an error message wraps
       and makes the bar taller, and a fixed 52px let the bar cover the bottom
       of the panel — the More button with it */
    bottom: calc(100% + 8px); left: 0;
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
    bottom: auto; top: calc(100% + 8px);
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

        <div class="label">Right answers</div>
        <div class="group">
          <div class="row">
            <span class="row-label">Remember them</span>
            <div class="switch on" id="bookSw" role="switch" aria-checked="true" tabindex="0"></div>
          </div>
          <div class="row" id="bookRow" hidden>
            <span class="row-label" id="bookCount">Nothing remembered yet</span>
            <button class="inline-btn quiet" id="bookClear">Clear</button>
          </div>
        </div>
        <div class="row-hint">On McGraw Hill Connect, when an answer is marked wrong the page shows the right one. Page Agent keeps it, in this browser only, and gives it the next time that question comes up, with no call to Claude.</div>

        <div class="label">Cost</div>
        <div class="group">
          <div class="row">
            <span class="row-label" id="spendText">Nothing spent yet</span>
            <button class="inline-btn quiet" id="spendReset">Reset</button>
          </div>
          <div class="row">
            <span class="row-label">Cheapest formulas</span>
            <div class="switch" id="cheapSw" role="switch" aria-checked="false" tabindex="0"></div>
          </div>
        </div>
        <div class="row-hint" id="spendDetail">What the questions answered have cost, as Anthropic reported it, since you last pressed Reset.</div>
        <div class="row-hint">Cheapest formulas is off, and answers are exactly as they were. Turn it on to try SIMnet formulas on the cheapest model first (Sonnet is used if SIMnet marks it wrong, on Autopilot) and with less of the page sent. It costs far less; try it on a practice exam before a graded one.</div>

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
          <div class="row">
            <span class="row-label">Copy page details</span>
            <button class="inline-btn" id="copyDetails">Copy</button>
          </div>
        </div>
        <div id="checkResult"></div>
        <div class="row-hint">Check this page shows what it can see here and whether your key works. Copy last prompt copies exactly what was last sent to Claude, for diagnosing wrong answers. Copy page details copies how this page is built, for a question it can't read.</div>
      </div>

    </div>
  </div>

  <div id="bar" class="glass">
    <button id="go"></button>
    <div id="status"><span class="dot idle" id="dot"></span><span id="statusText">Ready</span></div>
    <button id="flag" title="That answer was wrong" aria-label="That answer was wrong" hidden></button>
    <button id="gear"></button>
    <button id="hide" title="Hide the bar" aria-label="Hide the bar"></button>
  </div>
</div>
<div id="toast" class="glass" role="status" hidden></div>
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
  const copyPromptBtn = $('copyPrompt'), copyDetailsBtn = $('copyDetails');
  const flagBtn = $('flag'), logSw = $('logSw'), logRow = $('logRow'), logCount = $('logCount');
  const logDownloadBtn = $('logDownload'), logClearBtn = $('logClear');
  const bookSw = $('bookSw'), bookRow = $('bookRow'), bookCount = $('bookCount'), bookClearBtn = $('bookClear');
  const spendText = $('spendText'), spendDetail = $('spendDetail'), spendResetBtn = $('spendReset'), cheapSw = $('cheapSw');
  const checkPageBtn = $('checkPage'), checkResult = $('checkResult');
  const root = $('root'), hideBtn = $('hide'), toast = $('toast');

  gear.innerHTML = ICON_GEAR;
  hideBtn.innerHTML = ICON_HIDE;
  flagBtn.innerHTML = ICON_THUMB_DOWN;

  // ── State ──────────────────────────────────────────────────────────────────
  let mode = 'autopilot';  // one of MODES, below
  let presetIndex = 0;     // which post-answer flow; set by the mode
  let autoContinue = true; // whether to go on to the next question; set by the mode
  let notes = '';          // optional user context, sent only when non-empty
  let hasKey = false;
  let keepLog = false;     // the answer log, off unless switched on
  let remember = true;     // keep the right answers Connect shows, on unless switched off
  let cheapFormulas = false;   // SIMnet formulas on the cheapest model first, with less sent: off unless switched on
  let canFlag = false;     // a run has finished here since the last thumbs-down
  let pageKind = '';       // what the page looks like — "Canvas quiz" — shown when idle
  // Declared up here, not beside the detection code, because the settings
  // loader below can call into it synchronously (when the extension has just
  // been reloaded) — before a later `let` would exist.
  let detectTimer = null, detectedHref = '', retriedHref = '';
  let lastModel = '';    // model the most recent question actually used
  let fromMemory = false;  // ...or the answer came from the memory, not a model

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
        { label: 'Next Question',   advance: true, candidates: [{ selector: '.next-button' }, { text: 'Next Question' }, { text: 'Next' }, { smart: 'next' }] }
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
    { id: 'claude-haiku-5-5',  label: 'Haiku 5.5',  note: 'Fastest and cheapest — a few cents per 100 questions.' },
    { id: 'claude-sonnet-5-5', label: 'Sonnet 5.5', note: 'Better at hard subjects — around a cent a question.' }
  ];
  const DEFAULT_MODEL = 'claude-haiku-5-5';

  // Auto is the cheap model with an upgrade for hard questions — what the old
  // "Upgrade on hard questions" switch did, without a second control. Picking
  // a model by name means that model every time.
  const AUTO = {
    id: 'auto', label: 'Auto',
    note: 'Recommended. The cheapest model for most questions, and Sonnet 5.5 for SIMnet, worksheets, drag-and-drop and calculations.'
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
    if (fromMemory && !errorMsg) text += ' · remembered';
    else if (lastModel && lastModel !== baseModel() && !errorMsg) {
      text += ` · ↑ ${MODEL_LIST.find(m => m.id === lastModel)?.label ?? lastModel}`;
    }

    flagBtn.hidden = !(keepLog && canFlag && !isRunning);

    dot.className = 'dot ' + cls;
    statusText.textContent = text;
    statusText.classList.toggle('err', !!errorMsg);
    statusWrap.classList.toggle('err', !!errorMsg);
    const note = !errorMsg && !!infoMsg && !isRunning && !waiting;
    statusText.classList.toggle('note', note);
    statusWrap.classList.toggle('note', note);
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
    ['mode', 'lastPresetIndex', 'notes', 'autoContinue', 'autoUpgrade', 'apiKey', 'model', 'barPos', 'keepLog', 'barHidden', 'rememberAnswers', 'cheapFormulas'],
    s => {
      setHidden(s.barHidden === true, false);

      setMode(MODES[s.mode] ? s.mode : legacyMode(s), false);

      notes = s.notes ?? '';
      notesInput.value = notes;

      // Newer models replaced older ones in the menu, at the same price or
      // less; a saved older choice carries over
      const REPLACED = { 'claude-haiku-4-5': 'claude-haiku-5-5', 'claude-sonnet-5': 'claude-sonnet-5-5',
                         'claude-opus-5': 'claude-sonnet-5-5', 'claude-opus-5-5': 'claude-sonnet-5-5' };
      if (REPLACED[s.model]) {
        s.model = REPLACED[s.model];
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

      remember = s.rememberAnswers !== false;
      bookSw.classList.toggle('on', remember);
      bookSw.setAttribute('aria-checked', String(remember));

      cheapFormulas = s.cheapFormulas === true;
      cheapSw.classList.toggle('on', cheapFormulas);
      cheapSw.setAttribute('aria-checked', String(cheapFormulas));

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
    if (open) { refreshLogCount(); refreshBookCount(); refreshSpend(); }
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

  // ── Cost ──────────────────────────────────────────────────────────────────
  const money = usd => usd < 0.1 ? `$${usd.toFixed(3)}` : `$${usd.toFixed(2)}`;
  function refreshSpend() {
    bgSend({ type: 'SPEND_GET' }, res => {
      const s = res?.spend;
      if (!s || !s.calls) {
        spendText.textContent = 'Nothing spent yet';
        spendDetail.textContent = 'What the questions answered have cost, as Anthropic reported it, since you last pressed Reset.';
        spendResetBtn.disabled = true;
        return;
      }
      spendResetBtn.disabled = false;
      spendText.textContent = `${money(s.usd)} · ${s.calls} call${s.calls === 1 ? '' : 's'}`;
      const label = id => id.replace(/^claude-/, '').replace(/-(\d)-(\d)$/, ' $1.$2').replace(/^./, c => c.toUpperCase());
      const parts = Object.entries(s.byModel ?? {}).map(([id, m]) => `${label(id)} ${money(m.usd)} (${m.calls})`);
      const cached = s.input + s.cached > 0 ? ` · ${Math.round(100 * s.cached / (s.input + s.cached))}% of what was read came from the cache` : '';
      spendDetail.textContent = `${parts.join(' · ')}${cached}. Since ${new Date(s.since).toLocaleDateString()}.`;
    });
  }
  spendResetBtn.addEventListener('click', () => bgSend({ type: 'SPEND_RESET' }, () => refreshSpend()));
  function setCheap(on) {
    cheapFormulas = on;
    cheapSw.classList.toggle('on', on);
    cheapSw.setAttribute('aria-checked', String(on));
    store.set({ cheapFormulas: on });
  }
  cheapSw.addEventListener('click', () => setCheap(!cheapFormulas));
  cheapSw.addEventListener('keydown', e => {
    if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); setCheap(!cheapFormulas); }
  });

  // ── Right answers ─────────────────────────────────────────────────────────
  function refreshBookCount() {
    bgSend({ type: 'BOOK_COUNT' }, res => {
      const n = res?.count ?? 0;
      bookCount.textContent = n ? `${n} answer${n === 1 ? '' : 's'} remembered` : 'Nothing remembered yet';
      bookClearBtn.disabled = n === 0;
      bookRow.hidden = n === 0;
    });
  }
  function setRemember(on) {
    remember = on;
    bookSw.classList.toggle('on', on);
    bookSw.setAttribute('aria-checked', String(on));
    store.set({ rememberAnswers: on });
  }
  bookSw.addEventListener('click', () => setRemember(!remember));
  bookSw.addEventListener('keydown', e => {
    if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); setRemember(!remember); }
  });
  let bookArmed = null;
  bookClearBtn.addEventListener('click', () => {
    if (!bookArmed) {
      bookClearBtn.textContent = 'Tap again to clear';
      bookArmed = setTimeout(() => { bookArmed = null; bookClearBtn.textContent = 'Clear'; }, 3000);
      return;
    }
    clearTimeout(bookArmed);
    bookArmed = null;
    bookClearBtn.textContent = 'Clear';
    bgSend({ type: 'BOOK_CLEAR' }, () => refreshBookCount());
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

  // Text to the clipboard from a button, which says how it went
  function copyFrom(btn, text) {
    const flash = msg => {
      btn.textContent = msg;
      btn.classList.add('done');
      setTimeout(() => {
        btn.textContent = 'Copy';
        btn.classList.remove('done');
      }, 1800);
    };
    if (!text) { flash('Run it first'); return; }
    navigator.clipboard.writeText(text)
      .then(() => flash('Copied'))
      .catch(() => {
        // Clipboard API can be blocked on some pages — fall back to a
        // selection the page can still copy from.
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.cssText = 'position:fixed;top:-9999px';
        document.body.appendChild(ta);
        ta.select();
        try { document.execCommand('copy'); flash('Copied'); }
        catch (_) { flash('Copy failed'); }
        ta.remove();
      });
  }
  copyPromptBtn.addEventListener('click', () => {
    store.get('lastPrompt', ({ lastPrompt }) => copyFrom(copyPromptBtn, lastPrompt));
  });
  copyDetailsBtn.addEventListener('click', () => {
    copyDetailsBtn.textContent = '…';
    bgSend({ type: 'PAGE_DETAILS' }, res => copyFrom(copyDetailsBtn, res?.text ?? 'No response from the extension. Refresh this page and try again.'));
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

  // ── Putting the bar away ───────────────────────────────────────────────────
  // Hidden everywhere until brought back — by the shortcut, or the switch in
  // the toolbar button's popup — since a bar that's in the way on one page is
  // in the way on the next. A run carries on while it's hidden.
  let toastTimer = null;
  function setHidden(hidden, fromHere) {
    root.hidden = hidden;
    if (hidden) togglePanel(false);
    else if (host.style.top) placeAt(parseFloat(host.style.left) || 0, parseFloat(host.style.top) || 0);
    if (!hidden) { toast.hidden = true; toast.classList.remove('show'); }
    if (hidden && fromHere) showHiddenToast();
  }

  function showHiddenToast() {
    bgSend({ type: 'SHORTCUT' }, res => {
      const key = res?.shortcut;
      // textContent pieces, not innerHTML: the shortcut is the user's own setting
      const b = t => { const e = document.createElement('b'); e.textContent = t; return e; };
      toast.replaceChildren('Hidden. Bring it back with ', ...(key ? [b(key), ' or '] : []),
        'the Page Agent button in Chrome\'s toolbar.');
      toast.hidden = false;
      requestAnimationFrame(() => toast.classList.add('show'));
      clearTimeout(toastTimer);
      toastTimer = setTimeout(() => {
        toast.classList.remove('show');
        toastTimer = setTimeout(() => { toast.hidden = true; }, 300);
      }, 5000);
    });
  }

  hideBtn.addEventListener('click', () => {
    setHidden(true, true);
    store.set({ barHidden: true });
  });

  // The shortcut and the popup's switch change the setting; every open page
  // follows it
  try {
    chrome.storage.onChanged?.addListener((changes, area) => {
      if (area === 'local' && changes.barHidden) setHidden(changes.barHidden.newValue === true, false);
    });
  } catch (_) { /* extension reloaded under this page */ }

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
    fromMemory = false;
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
  // take minutes, though — a six-step spreadsheet task does — so the
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
        if (!more.hidden) refreshSpend();

        if (!result.success) {
          const err = result.error ?? 'Unknown error.';
          if (err.includes('Rate limit')) startRateCountdown();
          else fail(err);
          return;
        }

        if (result.noAnswer) {
          // Nothing clickable — likely a question type we can't do yet.
          paused = true;
          fail("Couldn't find an answer here. Do this one yourself, then press play. (If it keeps saying this on a page that has questions, tap More and press Copy next to Copy page details, and send that to whoever looks after Page Agent.)");
          return;
        }

        lastModel = result.usedModel ?? '';
        fromMemory = result.fromMemory === true;
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
        waitForPageChange((pageRoot().innerText ?? '').slice(0, 3000), token);
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
      const now = (pageRoot().innerText ?? '').slice(0, 3000);
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

  if (msg.type === 'SCRAPE') {
    // A peek (recognising the page, Check this page) must leave alone the
    // list a run's clicks point into, or an idle look could shift an index
    // between a run's read and its click.
    const kept = _lastElements, keptSeen = _simSeen, keptDesc = _lastDesc;
    if (msg.firstLook && !msg.peek) _simSeen = null;
    const look = () => {
      try {
        const out = scrape();
        _lastDesc = out.elements ?? [];
        sendResponse(out);
      } catch (e) {
        sendResponse({ error: e.message, text: '', elements: [] });
      } finally {
        if (msg.peek) { _lastElements = kept; _simSeen = keptSeen; _lastDesc = keptDesc; }
      }
    };
    // Custom dropdowns whose choices aren't on the page are opened and read
    // first, so the model sees what it can pick. Never on a peek, which only
    // looks; never on SIMnet, whose ribbon is full of drop-downs it has to
    // operate step by step itself.
    const unread = !msg.peek && !document.querySelector('td.grdbdy-cell') && unreadDropdowns().length > 0;
    if (!unread) { look(); return false; }
    learnDropdowns().catch(() => {}).then(look);
    return true;
  }

  if (msg.type === 'EXECUTE') {
    execute(msg.action)
      .then(sendResponse)
      .catch(e => sendResponse({ success: false, error: e.message }));
    return true;
  }

  if (msg.type === 'READ_CELL') {
    // What a cell shows now, to tell whether what was typed into it took
    const el = liveElement(msg.index);
    sendResponse(el ? { text: (el.innerText ?? el.textContent ?? '').replace(/\s+/g, ' ').trim() } : { text: null });
    return false;
  }

  if (msg.type === 'LIST_OPTIONS') {
    sendResponse({ options: listedOptions().map(o => (o.innerText ?? o.textContent ?? '').replace(/\s+/g, ' ').trim()).filter(Boolean).slice(0, 30) });
    return false;
  }

  if (msg.type === 'CLICK_OPTION') {
    // A list that has opened beside an editor: click the entry that says exactly this
    const want = squash(String(msg.text ?? ''));
    const hit = listedOptions().find(o => squash(o.innerText ?? o.textContent ?? '') === want);
    if (!hit) { sendResponse({ success: false }); return false; }
    hit.scrollIntoView({ block: 'nearest' });
    realClick(hit);
    sendResponse({ success: true });
    return false;
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
      const handle = el.closest(DRAG_SEL) || el;
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

  if (msg.type === 'READ_EDIT') {
    sendResponse(readEdit(String(msg.expect ?? '')));
    return false;
  }

  if (msg.type === 'CONNECT_STATE') {
    sendResponse(connectState());
    return false;
  }

  if (msg.type === 'CONNECT_RESULT') {
    sendResponse(connectResult());
    return false;
  }

  if (msg.type === 'SCROLL_END') {
    // A button that's below the fold: the page, and any box of its own that scrolls
    window.scrollTo(0, document.documentElement.scrollHeight);
    for (const el of document.querySelectorAll('*')) {
      if (el.scrollHeight > el.clientHeight + 40 && /(auto|scroll)/.test(getComputedStyle(el).overflowY)) el.scrollTop = el.scrollHeight;
    }
    sendResponse({ ok: true });
    return false;
  }

  if (msg.type === 'MARK') {
    // Tags on the listed items, then a paint, then the answer — the caller
    // captures the screen once it has it
    let result;
    try { result = mark(); } catch (e) { unmark(); sendResponse({ marked: 0, error: e.message }); return false; }
    painted().then(() => sendResponse(result), () => sendResponse(result));
    return true;
  }

  if (msg.type === 'UNMARK') {
    unmark();
    sendResponse({ ok: true });
    return false;
  }

  if (msg.type === 'OPEN_PART') {
    const tab = partTabs().find(t => t.text === msg.text);
    if (!tab) { sendResponse({ success: false, error: `No "${msg.text}" tab` }); return false; }
    tab.el.scrollIntoView({ block: 'center' });
    realClick(tab.el);
    sendResponse({ success: true });
    return false;
  }

  if (msg.type === 'CLICK_TEXT') {
    // Poll until the button appears and is not disabled (up to 5s)
    (async () => {
      const candidates = msg.candidates || [];
      // Optional buttons (Canvas's Next, absent on the last page) shouldn't
      // cost the full wait before we conclude they aren't there.
      const deadline = Date.now() + (Number(msg.timeoutMs) > 0 ? Number(msg.timeoutMs) : 5000);

      // Rendered rather than on-screen: we scroll to it before clicking, and
      // on a long page the button is often below the fold.
      const usable = b => isRendered(b) && !b.disabled && b.getAttribute('aria-disabled') !== 'true';
      function findIt() {
        // Only usable buttons are matched. Taking the first match and then
        // checking it gave up whenever that one was greyed out — a question's
        // own disabled "Next" (on its last Required tab) hid the real one.
        const all = Array.from(document.querySelectorAll('button, [role="button"], a')).filter(usable);
        for (const c of candidates) {
          let el = null;
          if (c.smart) el = smartFind(c.smart);
          else if (c.selector) el = Array.from(document.querySelectorAll(c.selector)).find(usable);
          else if (c.ariaLabel) el = all.find(b => (b.getAttribute('aria-label') || '').toLowerCase().includes(c.ariaLabel.toLowerCase()));
          else if (c.text) el = all.find(b => (b.innerText || b.textContent || '').trim().toLowerCase().includes(c.text.toLowerCase()));
          if (el) return el;
        }
        return null;
      }

      let found = null;
      while (!found && Date.now() < deadline) {
        found = findIt();
        if (!found) await new Promise(r => setTimeout(r, 150));
      }

      if (!found) {
        // What was on the page to press, so a failure can say so
        const seen = connectState();
        sendResponse({ success: false, error: `Button not found after ${Math.round((Number(msg.timeoutMs) > 0 ? Number(msg.timeoutMs) : 5000) / 1000)}s`,
                       buttons: seen.buttons, waiting: seen.nextWaiting });
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

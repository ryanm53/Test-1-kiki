// Per-model request differences. All three reject a prefill (seeding the reply
// with `{"action":"`) and a non-default `temperature` with a 400, so every
// request gets structured outputs instead — which constrains the response to
// the schema at the API level, a stronger guarantee than prefill anyway.
// (`prefill` and `temperature` stay as options for a model that wants them.)
//
// All three think by default — no thinking setting is sent — and the thinking
// counts against max_tokens, so each gets more room than the reply itself
// needs; only what's used is billed. Effort is set explicitly, low for one
// answer: the defaults are medium (Haiku 5.5) and high (Sonnet 5.5).
//
// Safety filters can decline a question outright (biology is among them).
// Sonnet 5.5 opts into Anthropic's server-side fallback, which re-runs a
// declined question on the model recommended for that kind of decline. Haiku
// 5.5 has no such fallback, so on Auto a question it declines goes to
// Sonnet 5.5 (see runGoal). Opus was dropped: for coursework it cost twice
// as much as Sonnet 5.5 and added nothing worth it.
// price: dollars per million tokens (Anthropic's list prices; Haiku's are for
// prompts up to 100K tokens, far above anything sent here). Cache reads cost a
// tenth of input and cache writes 1.25x, for both.
const MODELS = {
  'claude-haiku-5-5':  { label: 'Haiku 5.5',  maxTokens: 2048, effort: 'low', price: { in: 0.10, out: 0.50 } },
  'claude-sonnet-5-5': { label: 'Sonnet 5.5', maxTokens: 8000, effort: 'low', fallbacks: true, price: { in: 2.00, out: 10.00 } }
};

// What one call cost, from the usage Anthropic sent back. Thinking is billed as
// output, and in a real day's bill was most of it.
function costOf(model, usage) {
  const p = MODELS[model]?.price;
  if (!p || !usage) return 0;
  return ((usage.input_tokens ?? 0) * p.in
        + (usage.cache_creation_input_tokens ?? 0) * p.in * 1.25
        + (usage.cache_read_input_tokens ?? 0) * p.in * 0.1
        + (usage.output_tokens ?? 0) * p.out) / 1e6;
}

// A running total of what the extension has spent, kept in this browser and shown
// under More → Cost, so what a change saves can be seen rather than guessed
let spendQueue = Promise.resolve();
const freshSpend = () => ({ since: Date.now(), usd: 0, calls: 0, input: 0, output: 0, cached: 0, byModel: {} });
function recordSpend(model, usage) {
  if (!usage) return;
  const usd = costOf(model, usage);
  const done = spendQueue.then(async () => {
    const { spend } = await chrome.storage.local.get('spend').catch(() => ({}));
    const s = spend && typeof spend === 'object' && spend.byModel ? spend : freshSpend();
    s.usd += usd; s.calls += 1;
    s.input += usage.input_tokens ?? 0; s.output += usage.output_tokens ?? 0; s.cached += usage.cache_read_input_tokens ?? 0;
    const m = s.byModel[model] = s.byModel[model] ?? { usd: 0, calls: 0 };
    m.usd += usd; m.calls += 1;
    await chrome.storage.local.set({ spend: s });
  });
  spendQueue = done.catch(() => {});
}
const DEFAULT_MODEL = 'claude-haiku-5-5';

// Newer models replaced older ones in the menu, each at the same price or
// less (Haiku 5.5 at a tenth of Haiku 4.5's). A saved choice of a model that's
// no longer offered carries over to the nearest one that is.
const MODEL_ALIASES = {
  'claude-haiku-4-5': 'claude-haiku-5-5',
  'claude-sonnet-5':  'claude-sonnet-5-5',
  // Opus was dropped as too dear: its users go to the strongest model left
  'claude-opus-5':    'claude-sonnet-5-5',
  'claude-opus-5-5':  'claude-sonnet-5-5'
};
const resolveModel = id => MODELS[id] ? id : MODELS[MODEL_ALIASES[id]] ? MODEL_ALIASES[id] : DEFAULT_MODEL;

// Worksheets, drag questions and SIMnet need real reasoning — multi-step
// arithmetic, spatial planning over several moves, a procedure — where the
// cheap model tends to fumble. Those go to Sonnet 5.5, which thinks them
// through; everything else keeps costing what it costs.
const UPGRADE_TO = {
  'claude-haiku-5-5':  'claude-sonnet-5-5',
  'claude-sonnet-5-5': 'claude-sonnet-5-5'
};

function pickModel(baseModel, pageData, autoUpgrade) {
  if (!autoUpgrade) return baseModel;
  const hard = pageData?.isWorksheet || pageData?.isDrag || pageData?.isSimnet || isMath(pageData);
  return hard ? (UPGRADE_TO[baseModel] ?? baseModel) : baseModel;
}

// A multiple-choice page answered with a click that picks no choice at all
const isChoice = e => e?.tag === 'input' && /^(radio|checkbox)$/.test(e.type ?? '');
function missedTheChoices(action, elements) {
  if (!elements.some(isChoice)) return false;
  const picked = action.action === 'click' ? [action.index]
               : action.action === 'clickMany' ? (action.indexes ?? []) : null;
  return !!picked && !picked.some(i => isChoice(elements[i]));
}

// A question to work out rather than recall: "Allowance of $5,000, write-offs
// of $4,000, estimate of $9,000 — by how much did assets change?" The cheap
// model answers in one breath with no room to work, and in a real accounting
// log it got every one of these wrong or gave up. Three or more amounts
// (dollars or percentages) across the question and its choices marks one.
// Canvas is left out: a whole quiz on one page would count every question's.
const AMOUNT = /\$\s?\d[\d,]*(?:\.\d+)?|\b\d+(?:\.\d+)?\s?%/g;
function isMath(pageData) {
  if (!pageData || pageData.isCanvas) return false;
  const questions = [...new Set((pageData.elements ?? []).map(e => e.question).filter(Boolean))];
  const choices = (pageData.elements ?? []).map(e => e.text ?? '').join('\n');
  const text = `${pageData.text ?? ''}\n${questions.join('\n')}\n${choices}`;
  return new Set(text.match(AMOUNT) ?? []).size >= 3;
}

// Keys a SIMnet step may press. Kept in step with KEY_CODES in content.js.
const KEY_NAMES = ['Enter', 'Escape', 'Tab', 'Delete', 'Backspace', 'F2', 'F4',
                   'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End'];
const CELL_REF = /^[A-Z]{1,3}[1-9]\d{0,6}$/;

const ACTION_SCHEMA = {
  type: 'object',
  properties: {
    action:  { type: 'string', enum: ['click', 'clickMany', 'fill', 'dragMove', 'doubleClick', 'rightClick', 'type', 'key', 'selectRange', 'hover', 'none'] },
    index:   { type: 'integer' },
    indexes: { type: 'array', items: { type: 'integer' } },
    fills:   {
      type: 'array',
      items: {
        type: 'object',
        properties: { index: { type: 'integer' }, value: { type: 'string' } },
        required: ['index', 'value'],
        additionalProperties: false
      }
    },
    dir:     { type: 'string', enum: ['up', 'down', 'left', 'right'] },
    text:    { type: 'string' },
    key:     { type: 'string', enum: KEY_NAMES },
    cell:    { type: 'string' },
    column:  { type: 'string' },
    row:     { type: 'integer' },
    from:    { type: 'string' },
    to:      { type: 'string' },
    shift:   { type: 'boolean' },
    ctrl:    { type: 'boolean' },
    steps:   { type: 'integer' }
  },
  required: ['action'],
  additionalProperties: false
};

const MAX_RETRIES = 1;

const SYSTEM_PROMPT = `Answer the quiz question on screen correctly. Reply with only this JSON:
{"action":"click","index":N} — one answer
{"action":"clickMany","indexes":[N,M]} — "select all that apply"; include every correct choice
{"action":"dragMove","index":N,"dir":"up|down|left|right","steps":K} — drag question. up/down reorders an item within its own list; left/right moves it into a DIFFERENT list or drop zone. Item labels state which list they're in and their position — to place an unplaced choice into a drop zone use left/right, not up/down. One move per reply; you see the result and can move again.
{"action":"fill","fills":[{"index":N,"value":"answer"}]} — fill in the blank(s); one entry per input box, fill every blank in the question. A dropdown (shown with options=[...]) is filled the same way, with the exact text of the option to pick
{"action":"none"} — question fully answered, or nothing answerable on screen
N = an index from the list. Never invent an index. Output only the JSON completion.`;

// Appended only for worksheet-style questions, so ordinary questions don't pay
// for guidance they don't need.
const WORKSHEET_HINT = `

This is a worksheet with many blanks. Fill EVERY blank in one reply, as one fills array.
Field labels read "Column — Row", so "Deferred Revenue — December 31 Adjustment" is the
adjustment cell of the Deferred Revenue column.
Work the amounts out from the prose above the table, and keep the columns internally
consistent: ending balance = balance before adjustment + adjustment.
Prorate by the months actually elapsed, not a full year.
Values must be plain numbers — no $, no commas, minus sign for a reduction. Where
the page gives its own rule for signs ("amounts to be deducted should be indicated
by a minus sign"), follow it.
A blank that is already correct at 0 still needs 0 entered.
A date with two lines ("(line 1 of 2)", "(line 2 of 2)") is one event recorded as two
entries — for instance, the two sides of a collection or a write-off.
Dropdowns are filled with the exact text of one of their options; a row named by a
dropdown needs its dropdown filled as well as its amounts.
If the question is split into parts (tabs such as Required 1, Required 2), answer
only the part on screen — the others get their own turn.

A financial statement (income statement, balance sheet, statement of cash flows) has
a dropdown on each line for the account's name and a box for its amount. Work it out
in full before answering:
- The page text gives the figures — an adjusted trial balance, or a list of events.
  Compute every amount from it, in the order a statement is laid out: for an income
  statement revenues, then expenses, then net income; for a balance sheet assets,
  then liabilities, then equity. Totals must add up.
- Pick each line's account from its dropdown (a list shown "(same as [N])" is [N]'s
  list). Use each account once, only accounts that have a balance, and no distractor
  from the list — an account with no amount isn't on the statement.
- Fill the dropdown AND the amount on each line, in page order: a dropdown and the
  box after it are one line, even where the boxes carry no label.
- Amounts as plain numbers: contra accounts and deductions as the page directs,
  usually shown positive in a deduction line. Where a total box is given, enter the
  total of the lines above it.

A table asking for the EFFECTS of a transaction on the financial statements has a
Balance Sheet (Assets, Liabilities, and Stockholders' Equity with Common Stock and
Retained Earnings) above an Income Statement (Revenues, Expenses, Net Income). It
is not a statement of balances; every box is a change:
- Under Assets, Liabilities, Revenues and Expenses each line is one account: its
  name from the dropdown, its amount in the box beside it. One line per account
  affected; leave the other lines empty. Common Stock, Retained Earnings and Net
  Income have no dropdown: an amount only (leave one empty if nothing changes).
- An increase is a plain number and a decrease takes a minus sign, as the page's
  note says: cash paid is a decrease in Cash. An expense is a deduction, so it is
  entered with a minus sign, and Net Income is revenues and expenses as entered
  added up. Net Income also flows to Retained Earnings, by the same amount, unless
  a dividend is stated.
- It must balance: the change in assets equals the change in liabilities plus the
  change in stockholders' equity. Check before answering.
- A question that first asks for a cost ("the initial cost of the equipment") has
  its figures in the prose above: costs to buy the asset and get it ready for use
  are its cost; costs of owning it afterward (insurance, upkeep) are expenses.`;

// SIMnet simulates Excel, so a task is a procedure rather than an answer, and
// the procedure itself is graded.
const SIMNET_HINT = `

This is a simulated Excel. The task is stated in the page text above; cells are
marked cell=B7 and the ribbon is in the element list.

The workbook is already filled in. Each task asks for ONE operation — a ribbon
command, a dialog, a formatting change — so the answer is almost always a
ribbon click rather than editing data. Do not change cell values unless the
task explicitly says to enter something.

Do ONE step per reply — you will see the result before choosing the next.
Follow the method the task names: if it says to use a particular dialog, open
that dialog rather than typing the answer straight into the cell, because how
it was done is what gets graded.
Click a ribbon tab first when the control you need is on another tab.
Items marked (just appeared) are what your last step opened — a dropdown, a
submenu, a dialog — and are listed first. Continue in them rather than
clicking the button that opened them again, which usually closes them.

Besides click, Excel needs these:
{"action":"doubleClick","index":N} — e.g. double-click a sheet tab to rename it
{"action":"rightClick","index":N} — open an item's context menu
{"action":"type","text":"...","index":N} — type into element N (a box, a cell).
  Leave out index to type into whatever is already being edited, such as the
  name box that appears after double-clicking a sheet tab.
{"action":"key","key":"Enter"} — press a key: Enter, Escape, Tab, Delete,
  Backspace, F2 (edit the cell), F4, ArrowUp/Down/Left/Right, Home, End. Add
  "ctrl":true or "shift":true for a shortcut such as Ctrl+Home.
{"action":"selectRange","from":"A4","to":"G9"} — select a block of cells.

{"action":"hover","index":N} — point to an item without clicking. When a
  task or hint says "Point to X", or X opens a submenu (Hide & Unhide, Tab
  Color, and the like), HOVER it, then click the item in the submenu that
  appears. SIMnet grades a click on a submenu's parent as a WRONG answer.

Any cell can be named directly: use "cell":"B7" in place of "index" with
click, doubleClick, rightClick or type — listed or not. A column or row
selector (the header letter or number) likewise: "column":"B" or "row":5 —
e.g. click column A, then shift-click column C to select columns A to C.
The sheet tabs and the New Sheet (+) button are listed near the top. Click a
tab to select it, ctrl-click tabs to group them, right-click one for Insert,
Delete, Rename, Move or Copy, Tab Color, Hide, Unhide and Ungroup. Add "shift":true to a
click to extend a selection, or "ctrl":true to add to it (e.g. ctrl-click a
second sheet tab to group the sheets).
Formatting applies to what is selected: select the cells first, then use the
ribbon or dialog.
A dropdown list shows its choices as options=[...]; pick one with
{"action":"fill","fills":[{"index":N,"value":"<the option's text>"}]}.
A label that appears more than once shows its group as (in: Gridlines) — pick
the one in the group the task or hint names.
Marks after an item: (on) a toggle that is on, like Bold; (selected) the
current tab or item; (open) an expanded menu; (disabled) not usable yet.

An array formula — the task says so, or a block of cells is already selected for the
results, as with MODE.MULT — is typed with "text" and NO "cell" (naming a cell
clicks it and shrinks the selected block to that one cell), and then entered with
{"action":"key","key":"Enter","ctrl":true,"shift":true}: Ctrl+Shift+Enter, not
Ctrl+Enter or Enter alone.
"In the selected cell" means the cell marked (selected) in the list: type with no
"cell" and it goes there.
Use Excel's current function names: RANK.EQ (not RANK), STDEV.S and STDEV.P, MODE.SNGL,
and SYD for sum-of-the-years' digits (not SOYD), SLN, DB, DDB.
A dialog with several boxes (Function Arguments) is filled in ONE reply: a fill with
every box in "fills" — not one box a reply — and then click OK.
Typing a formula into a cell is one reply, then Enter: the whole formula, with
no line break in it. Do not open a ribbon dialog to enter a formula the task
lets you type. Never click the window's own Close, Minimize or Restore buttons.

Reply {"action":"none"} only once the page shows the task is complete — the
new name on the tab, the value in the cell, the dialog closed. If it doesn't
show yet, take the next step instead.`;

// Canvas shows a whole quiz on one page, so one reply has to cover every
// question rather than the single one the base prompt assumes.
const CANVAS_HINT = `

This page holds SEVERAL questions. Each choice is tagged with the question it
belongs to. Answer ALL of them in ONE reply using clickMany: exactly one choice
for each single-answer question, and every correct choice for a "select all"
question. Choices marked (selected) are already ticked — leave them out.
If there are typed blanks as well, answer the choices first; you will get a
second turn for the blanks, using fill.
Reply {"action":"none"} once every question has an answer.`;

// A short account of what has already been done this question. Without it each
// step is decided from a bare screenshot of the DOM, with no way to tell step
// one of a procedure from step four — so steps get repeated or skipped.
// Claude occasionally names an index that isn't in the list — usually right
// after the page has re-rendered under it. Acting on that would click whatever
// happens to sit at that position, so catch it before anything moves.
function badIndexes(action, count) {
  const out = [];
  const check = i => {
    if (!Number.isInteger(i) || i < 0 || i >= count) out.push(String(i));
  };
  if (action.action === 'dragMove') check(action.index);
  const named = ['cell', 'column', 'row'].some(f => action[f] !== undefined);
  if (['click', 'doubleClick', 'rightClick', 'hover'].includes(action.action) && !named) check(action.index);
  if (action.action === 'type' && action.index !== undefined) check(action.index);
  if (action.action === 'clickMany') (action.indexes ?? []).forEach(check);
  if (action.action === 'fill') (action.fills ?? []).forEach(f => check(f?.index));
  return out;
}

function actionSummary(action, elements) {
  const mods = (action.ctrl ? 'ctrl+' : '') + (action.shift ? 'shift+' : '');
  const name = i => {
    if (i === action.index) {
      if (action.cell) return `cell ${action.cell}`;
      if (action.column) return `the column ${action.column} header`;
      if (action.row) return `the row ${action.row} header`;
    }
    const e = elements[i];
    if (!e) return `[${i}]`;
    return `"${(e.text || e.cell || e.tag || '').slice(0, 40)}"`;
  };
  switch (action.action) {
    case 'click':     return `${mods}clicked ${name(action.index)}`;
    case 'clickMany': return `selected ${(action.indexes ?? []).map(name).join(', ')}`;
    case 'fill':      return (action.fills ?? []).map(f => `typed "${f.value}" into ${name(f.index)}`).join('; ');
    case 'dragMove':  return `moved ${name(action.index)} ${action.dir} x${action.steps ?? 1}`;
    case 'doubleClick': return `double-clicked ${name(action.index)}`;
    case 'rightClick':  return `right-clicked ${name(action.index)}`;
    case 'type':      return `typed "${action.text}"${action.cell || action.index !== undefined ? ` into ${name(action.index)}` : ''}`;
    case 'key':       return `pressed ${(action.ctrl ? 'Ctrl+' : '') + (action.shift ? 'Shift+' : '')}${action.key}`;
    case 'selectRange': return `selected ${action.from}:${action.to}`;
    case 'hover':     return `pointed to ${name(action.index)}`;
    default:          return action.action;
  }
}

// Turns an API failure into something a non-technical user can act on. The
// raw body is kept as a last resort so an unfamiliar error is still diagnosable.
function apiErrorMessage(status, body) {
  if (status === 401 || status === 403) {
    return 'Your API key was rejected. Make sure you pasted the key itself — it starts with '
         + 'sk-ant-api03- and is very long — and not the short key ID.';
  }
  if (status === 429) {
    return 'Rate limit hit — wait about a minute and try again.';
  }
  if (status === 400 && /credit balance|billing/i.test(body)) {
    return 'Your Anthropic account is out of credit. Add some at console.anthropic.com under Billing.';
  }
  if (status === 404 && /model/i.test(body)) {
    return 'That model is not available on your account. Pick a different one in settings.';
  }
  if (status >= 500) {
    return `Claude is having trouble right now (error ${status}). Wait a moment and try again.`;
  }
  return `Claude API ${status}: ${body.slice(0, 300)}`;
}

// Overloads and dropped connections are common and temporary, so retry them
// once before surfacing anything to the user.
async function postToApi(apiKey, requestBody, betas = []) {
  let lastNetworkError = null;

  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt) await new Promise(r => setTimeout(r, 1500));
    try {
      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
          'anthropic-dangerous-direct-browser-access': 'true',
          ...(betas.length ? { 'anthropic-beta': betas.join(',') } : {})
        },
        body: JSON.stringify(requestBody)
      });
      // Only server-side wobbles are worth a second go; a bad key or a bad
      // request will fail exactly the same way twice.
      if (response.status >= 500 && attempt === 0) continue;
      return response;
    } catch (e) {
      lastNetworkError = e;
    }
  }

  // Already retried above; final, like the other API failures
  const err = new Error(
    'Could not reach Claude. Check your internet connection and try again.'
    + (lastNetworkError ? ` (${lastNetworkError.message})` : '')
  );
  err.final = true;
  throw err;
}

// The instructions are the same on every call of a kind, which makes them the
// cheap part to keep: marked for caching, a repeat within five minutes reads them
// at a tenth of the price. Below the cacheable minimum (512 tokens, about 1,800
// characters) a marker does nothing, so short ones are sent plain.
function systemFor(hint) {
  const text = SYSTEM_PROMPT + hint;
  return text.length >= 1800 ? [{ type: 'text', text, cache_control: { type: 'ephemeral' } }] : text;
}

async function callClaude(apiKey, notes, pageText, elements, modelId = DEFAULT_MODEL, isWorksheet = false, isSimnet = false, history = [], isCanvas = false, retryHint = '', picture = null, instruction = '', only = null) {
  const model = resolveModel(modelId);
  const cfg = MODELS[model];

  // The question each control belongs to. Usually one for the whole page,
  // and then it's stated once, in full: repeated beside every element it was
  // cut to 120 characters, which dropped the amounts a calculation needs.
  // (Canvas already puts every question in the page text.)
  const questions = [...new Set(elements.map(el => el.question).filter(Boolean))]
    .filter((q, _, all) => !all.some(o => o !== q && o.includes(q)));
  const perElementQuestion = isCanvas || questions.length > 1;
  const questionSection = !isCanvas && questions.length
    ? `Question${questions.length > 1 ? 's' : ''}:\n${questions.slice(0, 3).map(q => q.slice(0, 1500)).join('\n\n')}\n\n`
    : '';

  const seenOptions = new Map();
  // `only`: the indexes worth listing. The numbers stay what they are, so a reply
  // still names the right item; the rest are left out to save sending them
  const elementList = elements
    .map((el, i) => {
      if (only && !only.has(i)) return null;
      const parts = [`[${i}]`, el.tag];
      if (el.type) parts.push(`type="${el.type}"`);
      if (el.text) parts.push(`"${el.text.slice(0, 80)}"`);
      if (el.placeholder) parts.push(`placeholder="${el.placeholder}"`);
      if (el.value) parts.push(`value="${el.value}"`);
      if (el.options) {
        // A statement has a dropdown on every line, all with one list: it's
        // written out once and the rest point to it
        const key = el.options.join('\u0001');
        if (seenOptions.has(key)) parts.push(`options=(same as [${seenOptions.get(key)}])`);
        else { seenOptions.set(key, i); parts.push(`options=[${el.options.join(' | ')}]`); }
      }
      if (el.group) parts.push(`(in: ${el.group})`);
      if (el.state) parts.push(`(${el.state})`);
      if (el.fresh) parts.push('(just appeared)');
      if (el.name) parts.push(`name="${el.name}"`);
      if (el.cell) parts.push(`cell=${el.cell}`);
      if (el.selected) parts.push('(selected)');
      if (el.question && perElementQuestion) parts.push(`(question: "${el.question.slice(0, 120)}")`);
      return parts.join(' ');
    })
    .filter(Boolean)
    .join('\n');

  // Optional user context (subject, conventions, hints) — omitted when blank
  const notesSection = notes ? `Notes from the user: ${notes}\n\n` : '';

  const historySection = history.length
    ? `Steps you have ALREADY done for this question:\n${history.map((h, i) => `${i + 1}. ${h}`).join('\n')}\nDo the NEXT step, not one of these again.\n\n`
    : '';

  // A second try at a SIMnet task, after it was marked wrong. SIMnet's hint
  // spells out the steps it wanted, which beats anything the model guesses.
  const retrySection = retryHint
    ? `SIMnet marked your previous attempt at this task INCORRECT and gave this hint:\n"${retryHint}"\nThe task has been reset. Follow the hint's steps exactly, one per reply.\n\n`
    : '';

  const pictureNote = !picture ? ''
    : picture.marked > 0
      ? 'A screenshot of the page is attached. Every item in the list below that is on screen is tagged in it with a small yellow number — the same number as in the list ([7] below is the tag 7 in the picture), outlined in red; an item with no tag is off screen. Use it to read anything the text leaves out — a picture, a chart, a table drawn as an image — and to tell apart items the list describes alike. You still answer with the numbers in the list.\n\n'
      : 'A screenshot of the page is attached. Use it to read anything the text below leaves out — a picture, a chart, a table drawn as an image. You still answer with the items listed below, by their numbers: the screenshot shows you the page, it does not replace the list.\n\n';
  const instructionSection = instruction ? `${instruction}\n\n` : '';
  const userContent = `${instructionSection}${pictureNote}${notesSection}${retrySection}${historySection}${questionSection}Page text:
${pageText.slice(0, isWorksheet || isCanvas ? 4000 : isSimnet ? 1500 : 3500)}

Elements (click by index):
${elementList || '(none found)'}`;

  // Kept so the exact prompt can be inspected from the widget without opening
  // the service worker console.
  const mode = isSimnet ? '  (simnet mode)' : isWorksheet ? '  (worksheet mode)' : isCanvas ? '  (canvas mode)' : '';
  const debugText = `model: ${model}${mode}\n\n${userContent}`;
  chrome.storage.local.set({ lastPrompt: debugText });

  const requestBody = {
    model,
    // A fills array covering a whole worksheet needs far more room than a
    // single index does
    // One index per question adds up on a long quiz
    // — and thinking first, on a model that thinks: twice its usual room.
    max_tokens: isWorksheet ? Math.max(cfg.maxTokens * 2, 1500 + 20 * elements.length)
              : isCanvas    ? Math.max(cfg.maxTokens, 600)
              : cfg.maxTokens,
    system: systemFor(isSimnet ? SIMNET_HINT : isWorksheet ? WORKSHEET_HINT : isCanvas ? CANVAS_HINT : ''),
    // A screenshot, when the page's text wasn't enough, goes ahead of the words
    messages: [{ role: 'user', content: picture
      ? [{ type: 'image', source: { type: 'base64', media_type: picture.type, data: picture.data } },
         { type: 'text', text: userContent }]
      : userContent }]
  };

  if (cfg.temperature) requestBody.temperature = 0;

  if (cfg.prefill) {
    // Seeding the reply mid-JSON makes prose structurally impossible
    requestBody.messages.push({ role: 'assistant', content: '{"action":"' });
  } else {
    // Prefill 400s on these models; constrain the response shape instead
    requestBody.output_config = { format: { type: 'json_schema', schema: ACTION_SCHEMA } };
    // A retry is the last automatic chance at the task, and a worksheet is a
    // whole problem's worth of linked entries, so those think harder
    if (cfg.effort) requestBody.output_config.effort = (retryHint || isWorksheet) ? 'medium' : cfg.effort;
  }

  // "default" lets Anthropic pick the fallback by the reason for the decline,
  // so there's no fallback model here to keep up to date. Its beta header is
  // this exact value; the older array form uses a different one.
  const betas = [];
  if (cfg.fallbacks) {
    requestBody.fallbacks = 'default';
    betas.push('server-side-fallback-2026-07-01');
  }

  const response = await postToApi(apiKey, requestBody, betas);

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    // Final: a bad key, no credit or a bad request fails identically every
    // time, so it's reported as it is — no "Stuck on step 1" wrapping, and no
    // second request. (Rate limits go their own way, to the countdown.)
    const err = new Error(apiErrorMessage(response.status, body));
    err.final = true;
    throw err;
  }

  let data;
  try {
    data = await response.json();
  } catch (_) {
    throw new Error('Claude sent back a reply that could not be read. Try again.');
  }
  recordSpend(model, data.usage);
  // A decline arrives as a normal reply with stop_reason "refusal" — after any
  // fallback has also declined — and carries no answer. Reading on would
  // report it as garbled JSON; and trying the same question again would only
  // be declined again.
  if (data.stop_reason === 'refusal') {
    const err = new Error(
      "Claude declined to answer this one. Do it yourself, or pick a different model under More → Model."
    );
    err.final = true;
    err.refusal = true;   // Auto hands it to the stronger model (runGoal)
    throw err;
  }

  // Find the text block specifically — thinking models emit other block types
  // first, and a fallback adds a marker block of its own
  const text = data.content?.find(b => b.type === 'text')?.text ?? '';
  // Prefill responses are only the completion, so restore the seeded prefix
  const cleaned = (cfg.prefill ? '{"action":"' + text : text).trim();

  // Extract the first complete {...} block in case Claude adds trailing text
  function extractJson(text) {
    try { return JSON.parse(text); } catch (_) {}
    const start = text.indexOf('{');
    if (start === -1) return null;
    let depth = 0, inStr = false, esc = false;
    for (let i = start; i < text.length; i++) {
      const ch = text[i];
      if (esc) { esc = false; continue; }
      if (ch === '\\' && inStr) { esc = true; continue; }
      if (ch === '"') { inStr = !inStr; continue; }
      if (inStr) continue;
      if (ch === '{') depth++;
      if (ch === '}' && --depth === 0) {
        try { return JSON.parse(text.slice(start, i + 1)); } catch (_) { return null; }
      }
    }
    return null;
  }

  const parsed = extractJson(cleaned);
  if (!parsed) {
    if (data.stop_reason === 'max_tokens') {
      throw new Error('Claude ran out of room before answering. Try again, or pick a different model under More → Model.');
    }
    throw new Error(`Claude returned invalid JSON: ${cleaned.slice(0, 300)}`);
  }

  if (!['click', 'clickMany', 'fill', 'dragMove', 'doubleClick', 'rightClick', 'type', 'key', 'selectRange', 'hover', 'none'].includes(parsed.action)) {
    throw new Error(`Unexpected action: ${JSON.stringify(parsed.action)}`);
  }
  // The reply is shaped by a schema that names every field, and the model fills
  // the ones it has no use for with "" or null (a real log: six runs stopped on
  // `from must be a cell address, got: ""` after a perfectly good click). An
  // empty field is an absent one.
  for (const k of Object.keys(parsed)) {
    if (parsed[k] === '' || parsed[k] === null || (k === 'row' && parsed[k] === 0)) delete parsed[k];
  }
  // A line break on the end of typed text is the model meaning Enter; that is a
  // key press of its own, and typed as text it was one more character in the cell
  if (parsed.action === 'type' && typeof parsed.text === 'string') parsed.text = parsed.text.replace(/[\r\n]+$/, '');
  // A cell address stands in for an index; normalise and check it
  for (const f of ['cell', 'from', 'to']) {
    if (parsed[f] === undefined) continue;
    parsed[f] = String(parsed[f]).trim().toUpperCase().replace(/\$/g, '');
    if (!CELL_REF.test(parsed[f])) throw new Error(`${f} must be a cell address like B7, got: ${JSON.stringify(parsed[f])}`);
  }
  if (parsed.column !== undefined) {
    parsed.column = String(parsed.column).trim().toUpperCase();
    if (!/^[A-Z]{1,3}$/.test(parsed.column)) throw new Error(`column must be a letter like B, got: ${JSON.stringify(parsed.column)}`);
  }
  if (parsed.row !== undefined && !(Number.isInteger(parsed.row) && parsed.row > 0)) {
    throw new Error(`row must be a row number like 5, got: ${JSON.stringify(parsed.row)}`);
  }
  const hasTarget = typeof parsed.index === 'number' || ['cell', 'column', 'row'].some(f => parsed[f] !== undefined);
  if (['click', 'doubleClick', 'rightClick', 'hover'].includes(parsed.action) && !hasTarget) {
    throw new Error(`${parsed.action} needs an index, a cell, a column or a row`);
  }
  if (parsed.action === 'selectRange' && (!parsed.from || !parsed.to)) {
    throw new Error(`selectRange needs from and to, got: ${JSON.stringify({ from: parsed.from, to: parsed.to })}`);
  }
  if (parsed.action === 'type' && (typeof parsed.text !== 'string' || !parsed.text.length)) {
    throw new Error(`type requires the text to type, got: ${JSON.stringify(parsed.text)}`);
  }
  if (parsed.action === 'key' && !KEY_NAMES.includes(parsed.key)) {
    throw new Error(`key must be one of ${KEY_NAMES.join(', ')}; got: ${JSON.stringify(parsed.key)}`);
  }
  if (parsed.action === 'fill') {
    const ok = Array.isArray(parsed.fills)
      && parsed.fills.length > 0
      && parsed.fills.every(f => f && typeof f.index === 'number' && f.value != null);
    if (!ok) {
      throw new Error(`fill requires a non-empty fills array of {index,value}, got: ${JSON.stringify(parsed.fills)}`);
    }
  }
  if (parsed.action === 'click' && !hasTarget) {
    throw new Error(`click requires a numeric index, got: ${JSON.stringify(parsed.index)}`);
  }
  if (parsed.action === 'clickMany') {
    const ok = Array.isArray(parsed.indexes)
      && parsed.indexes.length > 0
      && parsed.indexes.every(n => typeof n === 'number');
    if (!ok) {
      throw new Error(`clickMany requires a non-empty numeric indexes array, got: ${JSON.stringify(parsed.indexes)}`);
    }
  }
  if (parsed.action === 'dragMove') {
    if (typeof parsed.index !== 'number') {
      throw new Error(`dragMove requires a numeric index, got: ${JSON.stringify(parsed.index)}`);
    }
    if (!['up', 'down', 'left', 'right'].includes(parsed.dir)) {
      throw new Error(`dragMove requires dir up/down/left/right, got: ${JSON.stringify(parsed.dir)}`);
    }
  }

  // What was asked comes back with the answer, so the answer log can record
  // exactly the prompt a model saw — enough to replay it against another model.
  return {
    action: parsed,
    request: { model, usage: data.usage ?? undefined, kind: isSimnet ? 'simnet' : isWorksheet ? 'worksheet' : isCanvas ? 'canvas' : 'question',
               // The image itself isn't kept in the log, only that there was one
               prompt: picture ? `[a screenshot of the page was attached]\n${userContent}` : userContent }
  };
}

// ── Trusted input via the Chrome debugger protocol ───────────────────────────
// react-beautiful-dnd ignores synthetic events (they reach the page but never
// satisfy its drag state machine), so drag moves are driven with real input
// events instead. These arrive with isTrusted=true, indistinguishable from a
// person pressing the keys.

const attachedTabs = new Set();

chrome.debugger.onDetach.addListener(source => attachedTabs.delete(source.tabId));

async function attachDebugger(tabId) {
  if (attachedTabs.has(tabId)) return;
  try {
    await chrome.debugger.attach({ tabId }, '1.3');
    attachedTabs.add(tabId);
  } catch (e) {
    const msg = String(e?.message ?? e);
    if (msg.includes('Another debugger') || msg.includes('already attached')) {
      throw new Error('Close DevTools on this tab — drag questions need the debugger, and only one can attach at a time.');
    }
    throw new Error(`Could not attach debugger: ${msg}`);
  }
}

async function detachDebugger(tabId) {
  if (!attachedTabs.has(tabId)) return;
  attachedTabs.delete(tabId);
  try { await chrome.debugger.detach({ tabId }); } catch (_) {}
}

const KEYS = {
  space: { key: ' ',          code: 'Space',      vk: 32, text: ' ' },
  up:    { key: 'ArrowUp',    code: 'ArrowUp',    vk: 38 },
  down:  { key: 'ArrowDown',  code: 'ArrowDown',  vk: 40 },
  left:  { key: 'ArrowLeft',  code: 'ArrowLeft',  vk: 37 },
  right: { key: 'ArrowRight', code: 'ArrowRight', vk: 39 },
  enter: { key: 'Enter',      code: 'Enter',      vk: 13, text: '\r' },
  escape:    { key: 'Escape',    code: 'Escape',    vk: 27 },
  backspace: { key: 'Backspace', code: 'Backspace', vk: 8 },
  tab:   { key: 'Tab',        code: 'Tab',        vk:  9, text: '\t' }
};

async function pressKey(tabId, name) {
  const k = KEYS[name];
  const base = { key: k.key, code: k.code, windowsVirtualKeyCode: k.vk, nativeVirtualKeyCode: k.vk };
  await chrome.debugger.sendCommand({ tabId }, 'Input.dispatchKeyEvent', {
    // printable keys need text so a keypress is generated; arrows don't
    type: k.text ? 'keyDown' : 'rawKeyDown',
    ...base,
    ...(k.text ? { text: k.text, unmodifiedText: k.text } : {})
  });
  await chrome.debugger.sendCommand({ tabId }, 'Input.dispatchKeyEvent', { type: 'keyUp', ...base });
}

// Virtual key code for a character, which the sheet's keydown handler reads.
function virtualKey(ch) {
  if (ch >= '0' && ch <= '9') return ch.charCodeAt(0);
  if (ch >= 'a' && ch <= 'z') return ch.toUpperCase().charCodeAt(0);
  if (ch >= 'A' && ch <= 'Z') return ch.charCodeAt(0);
  return { '-': 189, '.': 190, ',': 188, ' ': 32, '/': 191, '(': 57, ')': 48 }[ch] ?? 0;
}

// Type a value as real keystrokes. Input.insertText would be simpler, but it
// inserts text without ever producing a keydown — and a spreadsheet only opens
// its editor once it sees a real keypress, so the characters go nowhere.
async function typeText(tabId, text, pace = 25) {
  for (const ch of text) {
    const vk = virtualKey(ch);
    const base = { key: ch, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk };
    await chrome.debugger.sendCommand({ tabId }, 'Input.dispatchKeyEvent', {
      type: 'keyDown', text: ch, unmodifiedText: ch, ...base
    });
    await chrome.debugger.sendCommand({ tabId }, 'Input.dispatchKeyEvent', {
      type: 'keyUp', ...base
    });
    await new Promise(r => setTimeout(r, pace));
  }
}

// ── A formula, typed so that it arrives whole ───────────────────────────────
// In a real SIMnet log, 7 formulas of 8 were graded wrong though each was the
// right one. SIMnet's own report says why: "typed =RIG in cell D2, typed
// HT(A2,2) in cell D2". The list of function names that opens after "=RIG", and
// the argument hint that opens after "(", reset the editor, and everything typed
// before them was gone. The one that came out right was typed in one go.
//
// So a formula goes in stages, each ending where one of those opens, with a
// look at the editor after each (READ_EDIT in content.js). Text that has gone is
// cleared and typed again, slower. Failing that, the cell is cancelled and
// tried again a different way: "=" as a key press and the rest inserted whole,
// then one key at a time, slowly. Enter is never pressed on text that is known
// to be damaged: the last resort is to say so.
function stagesOf(text) {
  const stops = new Set([Math.min(3, text.length), text.length]);
  [...text].forEach((ch, i) => { if (ch === '(') stops.add(i + 1); });
  for (let i = 12; i < text.length; i += 12) stops.add(i);
  return [...stops].filter(n => n > 0).sort((a, b) => a - b);
}

async function checkEdit(tabId, frameId, expected, wait) {
  await new Promise(r => setTimeout(r, wait));
  const r = await sendToTab(tabId, { type: 'READ_EDIT', expect: expected }, frameId).catch(() => null);
  if (r?.match) return { state: 'ok' };
  if (r && typeof r.have === 'string') return { state: 'lost', have: r.have };
  return { state: 'unknown' };
}

async function typeInStages(tabId, frameId, text, pace, repairs) {
  let done = 0, seen = false, fixed = 0;
  for (const stop of stagesOf(text)) {
    await typeText(tabId, text.slice(done, stop), pace);
    done = stop;
    for (let tries = 0; ; tries++) {
      const c = await checkEdit(tabId, frameId, text.slice(0, done), done <= 3 ? 600 : 350);
      if (c.state === 'ok') { seen = true; break; }
      if (c.state === 'unknown') break;     // nothing to go by: carry on, as before
      if (tries >= repairs) return { ok: false, have: c.have, seen, fixed };
      fixed++;
      for (let i = 0; i < c.have.length + 2; i++) await pressKey(tabId, 'backspace');
      await new Promise(r => setTimeout(r, 150));
      await typeText(tabId, text.slice(0, done), 110);
    }
    reportProgress(tabId, 1, 1);
  }
  return { ok: true, seen, fixed };
}

async function typeInserted(tabId, frameId, text) {
  await typeText(tabId, text.slice(0, 1), 60);
  if (text.length > 1) await chrome.debugger.sendCommand({ tabId }, 'Input.insertText', { text: text.slice(1) });
  const c = await checkEdit(tabId, frameId, text, 700);
  return { ok: c.state === 'ok', have: c.have, seen: c.state === 'ok', fixed: 0 };
}

// `reopen` opens the cell for typing again; `trail` collects what each way came to
async function typeFormula(tabId, frameId, text, reopen, trail) {
  const ways = [
    ['keys', () => typeInStages(tabId, frameId, text, 60, 2)],
    ['inserted', () => typeInserted(tabId, frameId, text)],
    ['slow', async () => { const r = await typeInStages(tabId, frameId, text, 200, 0); return { ...r, ok: r.ok && r.seen }; }]
  ];
  let have = '';
  for (const [i, [how, go]] of ways.entries()) {
    if (i) {
      await pressKey(tabId, 'escape');
      await new Promise(r => setTimeout(r, 300));
      if (!(await reopen())?.success) break;
      await attachDebugger(tabId);
    }
    const r = await go();
    trail.push({ way: how, ok: r.ok, repaired: r.fixed, verified: r.seen, ...(r.have !== undefined ? { have: r.have } : {}) });
    if (r.ok) return r;
    have = r.have ?? have;
  }
  await pressKey(tabId, 'escape').catch(() => {});
  const err = new Error(`SIMnet's formula box kept losing what was typed: it should read ${text} but shows ${have || 'something else'}. Type this one in yourself.`);
  err.final = true;
  throw err;
}

// Spreadsheet cells (jQuery.sheet) have no input to set — the cell is selected
// by clicking it, then typed into. The click is left to the content script,
// which addresses the element directly; a debugger mouse click cannot be used
// here because its coordinates are relative to the top-level page while the
// sheet lives in an iframe, so it would land somewhere else and move the
// selection off the cell just chosen. Keystrokes are safe to send this way:
// they follow focus rather than coordinates.
//
// Typing and pressing Enter 60ms later is not enough where the cell's editor is a
// dropdown: its list opens a beat after the letters, Enter before that commits
// nothing, and the cell stays empty — in a real run, some cells took and some
// didn't, and every one was reported as filled. So a cell is read back afterwards,
// and one that didn't take is tried again, slower, picking the entry from the list
// if it can be seen; and one that still won't is said to be missed.
const num = s => {
  const t = String(s ?? '').replace(/[,$\s]/g, '');
  return /^\(?-?\d*\.?\d+\)?$/.test(t) ? (/^\(.*\)$/.test(t) ? -1 : 1) * parseFloat(t.replace(/[()]/g, '')) : null;
};
const letters = s => String(s ?? '').toLowerCase().replace(/[^a-z0-9.\-]/g, '');
// Whether a cell shows what was typed into it. Unknown (null) counts as yes: a cell
// that can't be read is no reason to type into it again.
function cellHolds(shown, want) {
  if (shown === null) return true;
  if (!shown) return false;
  const a = num(shown), b = num(want);
  if (a !== null && b !== null) return Math.abs(a - b) <= Math.max(0.5, Math.abs(b) * 0.005);   // formatting rounds
  if (b !== null) return true;                  // a number typed, shown some other way
  // Exactly the name asked for (a longer one that merely contains it is another entry)
  return letters(shown) === letters(want);
}

async function typeIntoCell(tabId, frameId, index, value) {
  const want = String(value ?? '');
  const wordy = /[A-Za-z]/.test(want);          // a name from a list, not an amount
  const read = async () => (await sendToTab(tabId, { type: 'READ_CELL', index }, frameId).catch(() => null))?.text ?? null;
  const focus = async () => sendToTab(tabId, { type: 'FOCUS_CELL', index }, frameId);

  // Ways of getting a choice into a cell, each read back before the next is tried:
  // typed and given time for its list to open; typed slowly and the entry clicked in
  // the list if it can be seen; the cell opened a second time first. (Arrow keys are
  // left out: on a sheet they move the selection to another cell.)
  const ways = wordy
    ? [{ pace: 25, settle: 350 }, { pace: 90, settle: 700, pick: true }, { pace: 60, settle: 600, pick: true, again: true }]
    : [{ pace: 25, settle: 60 }, { pace: 90, settle: 200 }];
  for (const way of ways) {
    const focused = await focus();
    if (!focused?.success) {
      return { success: false, error: focused?.error ?? `Could not open cell [${index}]` };
    }
    if (way.again) { await new Promise(r => setTimeout(r, 300)); await focus(); }
    await attachDebugger(tabId);
    await typeText(tabId, want, way.pace);
    // A list of names opens a moment after the letters; Enter before it does nothing
    await new Promise(r => setTimeout(r, way.settle));
    const picked = way.pick
      ? (await sendToTab(tabId, { type: 'CLICK_OPTION', text: want }, frameId).catch(() => null))?.success
      : false;
    if (!picked) await pressKey(tabId, 'enter');
    await new Promise(r => setTimeout(r, 160));
    if (cellHolds(await read(), want)) return { success: true };
  }

  // Nothing worked. Say what is in the cell and what the list offers, so a wrong label
  // can be seen to be one — then close the editor rather than leave it half-open
  const shown = await read();
  const offered = (await sendToTab(tabId, { type: 'LIST_OPTIONS' }, frameId).catch(() => null))?.options ?? [];
  await pressKey(tabId, 'escape').catch(() => {});
  return {
    success: false, options: offered,
    error: `[${index}] shows "${shown ?? ''}", not "${want.slice(0, 40)}"${offered.length ? ` (the list showed: ${offered.slice(0, 8).join(' | ')})` : ''}`
  };
}

// rbd keyboard drag: Space lifts, arrows move, Space drops.
async function trustedKeyDrag(tabId, dir, steps) {
  await attachDebugger(tabId);
  await pressKey(tabId, 'space');
  await new Promise(r => setTimeout(r, 300));
  for (let i = 0; i < steps; i++) {
    await pressKey(tabId, dir);
    await new Promise(r => setTimeout(r, 250));
  }
  await pressKey(tabId, 'space');
  await new Promise(r => setTimeout(r, 400));
}

// A content script that never answers would hang the run forever, so every
// message gets a deadline. Generous, because a scrape of a big worksheet is
// not instant.
const MSG_TIMEOUT_MS = 20000;

// Filling is the one message whose length scales with the page: a 250-box
// worksheet, or a dozen dropdowns opened one by one, outlasts a flat 20s.
function timeoutFor(msg) {
  const fills = msg.type === 'EXECUTE' && Array.isArray(msg.action?.fills) ? msg.action.fills.length : 0;
  // A scrape that opens every dropdown to read it (a statement has dozens) is
  // as slow as a fill of that many
  return MSG_TIMEOUT_MS + fills * 2000 + (msg.type === 'SCRAPE' && !msg.peek ? 15000 : 0);
}

function rawSend(tabId, msg, frameId) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error('The page stopped responding. Refresh it and try again.'));
    }, timeoutFor(msg));

    chrome.tabs.sendMessage(tabId, msg, { frameId }, response => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve(response);
    });
  });
}

const NO_RECEIVER = /Receiving end does not exist|Could not establish connection/i;

async function sendToTab(tabId, msg, frameId = 0) {
  try {
    return await rawSend(tabId, msg, frameId);
  } catch (e) {
    if (!NO_RECEIVER.test(e.message)) throw e;

    // No content script in that frame: the tab was open before the extension
    // was installed or updated. Inject one and retry, rather than making the
    // user work out for themselves that a refresh is needed. content.js is
    // guarded against loading twice, so this is safe even in a race.
    try {
      await chrome.scripting.executeScript({
        target: { tabId, frameIds: [frameId] },
        files: ['content.js']
      });
    } catch (_) {
      throw new Error('Could not reach this page. Refresh it and try again.');
    }
    await new Promise(r => setTimeout(r, 300));
    return await rawSend(tabId, msg, frameId);
  }
}

// Some question types render inside an iframe — McGraw Hill's accounting
// worksheet is served from a separate origin — so the frame holding the
// question isn't always the top one. Score each frame by whether it actually
// contains something answerable, rather than just navigation chrome.
async function findQuestionFrame(tabId) {
  let probes;
  try {
    probes = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      func: () => {
        const n = sel => document.querySelectorAll(sel).length;
        const fields = n('input:not([type="hidden"]), textarea, select');
        const choices = n('[role="radio"], [role="checkbox"], input[type="radio"], input[type="checkbox"]');
        const gridFields = [...document.querySelectorAll('input:not([type="hidden"]), textarea, select')]
          .filter(el => el.closest('table, [role="table"], [role="grid"]')).length;
        // Spreadsheet widgets answer into focusable <td>s, not inputs
        const cells = n('td[tabindex]:not([tabindex="-1"]):not(.td-readOnly), td.responseCell:not(.td-readOnly)');
        // A matching question has no inputs at all: cards to drag and buttons are what it has
        const drags = n('[data-rbd-drag-handle-draggable-id], [data-react-beautiful-dnd-drag-handle], [data-rfd-drag-handle-draggable-id], [data-rfd-draggable-id], [aria-roledescription="draggable"], [draggable="true"]');
        const buttons = Math.min(10, n('button, [role="button"]'));
        return { fields, choices, drags, buttons, gridFields: gridFields + cells };
      }
    });
  } catch (_) {
    return 0; // can't enumerate (restricted page) — fall back to the top frame
  }

  let best = { frameId: 0, score: -1 };
  for (const p of probes) {
    const r = p.result;
    if (!r) continue;
    // A worksheet grid is the strongest signal; then any answerable input.
    // The top frame gets a nudge so it still wins a genuine tie.
    let score = (r.gridFields >= 4 ? 1000 : 0) + r.fields * 10 + r.choices * 10 + (r.drags ?? 0) * 10 + (r.buttons ?? 0) * 2;
    if (p.frameId === 0) score += 1;
    if (score > best.score) best = { frameId: p.frameId, score };
  }
  return best.frameId;
}

// When the frame chosen turns out to hold nothing to act on (a stray frame with
// one hidden input outscored the page with a matching question, which has no
// inputs), the frame with the most things in it
async function busiestFrame(tabId, except) {
  let probes;
  try {
    probes = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      func: () => document.querySelectorAll('button, [role="button"], a[href], input:not([type="hidden"]), select, textarea, [draggable="true"], [role="listitem"], [role="radio"], [role="checkbox"], [data-rbd-drag-handle-draggable-id], [data-rfd-drag-handle-draggable-id], [aria-roledescription="draggable"]').length
    });
  } catch (_) { return null; }
  let best = null;
  for (const p of probes) {
    if (p.frameId === except || !(p.result > 0)) continue;
    if (!best || p.result > best.n) best = { frameId: p.frameId, n: p.result };
  }
  return best?.frameId ?? null;
}

// What is on the page, structurally, in every frame — for when something can't be
// read and someone has to see how it is built. Runs inside each frame, so it can
// use nothing from here.
function probeStructure() {
  const trim = (s, n) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
  const attrs = el => Array.from(el.attributes).slice(0, 14).map(a => `${a.name}="${trim(a.value, 60)}"`).join(' ');
  const mark = el => {
    const cs = getComputedStyle(el);
    return el.getAttribute('draggable') === 'true' || /grab|move/.test(cs.cursor)
      || Array.from(el.attributes).some(a => /^(data-rbd|data-rfd|data-dnd|aria-roledescription|aria-grabbed|aria-dropeffect)/.test(a.name))
      || /drag|drop/i.test(String(el.className?.baseVal ?? el.className));
  };
  const seen = [];
  for (const el of document.querySelectorAll('body *')) {
    if (seen.length >= 14) break;
    if (el.closest('#__cap-host')) continue;
    if (mark(el)) seen.push(el);
  }
  const hosts = Array.from(document.querySelectorAll('*')).filter(el => el.shadowRoot);
  return {
    url: location.origin + location.pathname,
    title: trim(document.title, 80),
    elements: document.querySelectorAll('*').length,
    text: trim(document.body?.innerText, 240),
    iframes: Array.from(document.querySelectorAll('iframe')).map(f => ({ src: trim(f.src, 90), w: f.clientWidth, h: f.clientHeight })).slice(0, 8),
    shadowHosts: hosts.length,
    insideShadow: hosts.reduce((n, h) => n + h.shadowRoot.querySelectorAll('button, [role="button"], [draggable], [tabindex], input').length, 0),
    counts: {
      buttons: document.querySelectorAll('button').length, roleButtons: document.querySelectorAll('[role="button"]').length,
      links: document.querySelectorAll('a[href]').length, inputs: document.querySelectorAll('input:not([type="hidden"]), select, textarea').length,
      draggableAttr: document.querySelectorAll('[draggable="true"]').length, tabindex: document.querySelectorAll('[tabindex]').length,
      listitems: document.querySelectorAll('[role="listitem"]').length
    },
    // For a cell whose editor is a dropdown: the cell, whatever has the focus, and any
    // list that is open (press Copy page details while a cell is being edited)
    focus: document.activeElement && document.activeElement !== document.body ? trim(document.activeElement.outerHTML, 260) : null,
    cells: Array.from(document.querySelectorAll('td[tabindex], td.responseCell')).slice(0, 3).map(td => trim(td.outerHTML, 240)),
    lists: Array.from(document.querySelectorAll('[role="listbox"], [role="menu"], .ui-autocomplete, .ui-menu, .dropdown-menu, [class*="autocomplete"], [class*="suggest"], [class*="dropdown"] ul'))
      .filter(l => l.getClientRects().length).slice(0, 3).map(l => trim(l.outerHTML, 320)),
    dragLike: seen.map(el => ({
      tag: el.tagName.toLowerCase(), attrs: attrs(el), text: trim(el.innerText, 60),
      size: `${Math.round(el.getBoundingClientRect().width)}x${Math.round(el.getBoundingClientRect().height)}`,
      cursor: getComputedStyle(el).cursor, html: trim(el.outerHTML, 220)
    }))
  };
}

async function pageDetails(tabId) {
  let probes;
  try {
    probes = await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, func: probeStructure });
  } catch (e) { return `Couldn't read this page: ${e.message}`; }
  const chosen = await findQuestionFrame(tabId).catch(() => 0);
  return JSON.stringify({ version: chrome.runtime.getManifest?.().version, chosenFrame: chosen,
    frames: probes.map(p => ({ frameId: p.frameId, ...(p.result ?? { error: 'unreadable' }) })) }, null, 1);
}

// Click / clickMany answer a question in a single call. Drag questions need
// several sequential moves, so the budget is raised only once a drag actually
// starts — multiple choice still costs exactly one API call.
const MAX_STEPS_SIMPLE = 1;
const MAX_STEPS_DRAG   = 8;
// Most tasks are 2-5 steps; a dialog task runs to 6-7 (select the cells, open
// the dialog, switch its tab, set a field or two, OK). Every step is a model
// call, so no more than that: a task still unfinished after 8 is stuck, and
// says so. Heartbeats keep a long run from being mistaken for a hung one.
const MAX_STEPS_SIMNET = 10;

// True when every question on the page has at least one choice ticked.
// Pages with typed blanks don't qualify: an empty blank carries no flag, so
// whether it's answered can't be told from here.
function everyQuestionAnswered(elements) {
  const byQuestion = new Map();
  for (const e of elements) {
    if (e.type !== 'radio' && e.type !== 'checkbox') return false;
    const q = e.question ?? '';
    byQuestion.set(q, byQuestion.get(q) || !!e.selected);
  }
  return byQuestion.size > 0 && [...byQuestion.values()].every(Boolean);
}

// SIMnet's result popup may be drawn by the exam shell rather than the
// simulation, so both the question frame and the top frame are asked.
async function readVerdict(tabId, frameId) {
  let attempts = null;
  for (const f of new Set([frameId, 0])) {
    const r = await sendToTab(tabId, { type: 'SIMNET_VERDICT' }, f).catch(() => null);
    attempts ??= r?.attempts ?? null;
    if (r?.verdict) return { verdict: r.verdict, hint: r.hint, attempts, frameId: f };
  }
  return { verdict: null, attempts };
}

async function waitForVerdict(tabId, frameId, ms) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await readVerdict(tabId, frameId);
    if (v.verdict || Date.now() > end) return v;
    await new Promise(r => setTimeout(r, 300));
  }
}

// Continue, then wait for the popup to go and the page behind it to settle
async function pressContinue(tabId, v) {
  const r = await sendToTab(tabId, { type: 'SIMNET_CONTINUE' }, v.frameId).catch(() => null);
  if (!r?.success) return false;
  const end = Date.now() + 6000;
  while (Date.now() < end && (await readVerdict(tabId, v.frameId)).verdict) {
    await new Promise(r => setTimeout(r, 300));
  }
  await new Promise(r => setTimeout(r, 1200));
  return true;
}

// Tells the control bar the run is still moving. Fire and forget: the bar
// lives in the top frame, may not have finished loading, and a
// failure to report progress must never stop the run itself.
function reportProgress(tabId, step, budget) {
  try {
    chrome.tabs.sendMessage(tabId, { type: 'PROGRESS', step, budget }, { frameId: 0 }, () => {
      void chrome.runtime.lastError;   // read it so Chrome doesn't log it
    });
  } catch (_) { /* no listener — nothing to report to */ }
}

// Tells the bar the run is alive while a long request is out
function heartbeat(tabId, step, budget) {
  let timer;
  const beat = () => { reportProgress(tabId, step, budget); timer = setTimeout(beat, 20000); };
  timer = setTimeout(beat, 20000);
  return () => clearTimeout(timer);
}

// ── Screenshots ────────────────────────────────────────────────────────────
// When a question is partly a picture, or the text of the page isn't enough to
// read it, the visible part of the tab goes to Claude as an image alongside the
// text. Only of the tab the user is looking at (the capture is of whatever tab
// is showing), only when needed, and never for SIMnet. A failure to capture
// just means the question goes by its text, as before.
const SHOT_MAX_SIDE = 1568;   // larger is shrunk by the API anyway; smaller is quicker to send

// A message to the page that gives up after a couple of seconds: the tags are an
// extra, and a page that won't answer must not hold up the question
const quickly = (promise, ms = 2500) => Promise.race([promise, new Promise(r => setTimeout(() => r(null), ms))]);

// A tag is about 15×14 pixels of the one yellow; fewer than this many such pixels
// per tag in a capture means the tags aren't in it
const TAG_PIXELS = 25;

// How many pixels of the tags' yellow a capture holds — or null where it can't
// be counted (no canvas here), in which case the tags are taken to be there
async function tagPixels(dataUrl) {
  try {
    if (typeof OffscreenCanvas === 'undefined' || typeof createImageBitmap === 'undefined') return null;
    const bitmap = await createImageBitmap(await (await fetch(dataUrl)).blob());
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const g = canvas.getContext('2d', { willReadFrequently: true });
    g.drawImage(bitmap, 0, 0);
    const px = g.getImageData(0, 0, bitmap.width, bitmap.height).data;
    let n = 0;
    for (let i = 0; i < px.length; i += 4) if (px[i] > 230 && px[i + 1] > 190 && px[i + 1] < 235 && px[i + 2] < 90) n++;
    return n;
  } catch (_) { return null; }
}

async function captureTab(tabId, frameId = 0) {
  try {
    const tab = await chrome.tabs.get(tabId);
    if (!tab?.active) return null;
    // Numbers on the things the list names, for the instant of the capture:
    // the same numbers the model is given, so it can point at one it can't name
    const marks = await quickly(sendToTab(tabId, { type: 'MARK' }, frameId).catch(() => null));
    const marked = marks?.marked ?? 0;
    let url = null, seen = null;
    try {
      // Chrome sometimes hands back the screen as it was a frame ago, before the
      // tags were drawn (seen in real Chrome, not in a test). So the picture is
      // checked for them, and taken again if they're missing
      for (let tries = 0; tries < 3; tries++) {
        url = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'jpeg', quality: 70 });
        if (!marked) break;
        seen = await Promise.resolve(tagPixels(url)).catch(() => null);
        if (seen === null || seen >= marked * TAG_PIXELS) break;
        await new Promise(r => setTimeout(r, 150 * (tries + 1)));
      }
    } finally {
      // Always taken down again, whatever happened — and awaited, so nothing
      // that follows meets them
      await quickly(sendToTab(tabId, { type: 'UNMARK' }, frameId).catch(() => null));
    }
    const shot = await shrinkShot(url);
    // Tags the picture doesn't show are not claimed: the model is told there are none
    const shown = marked && (seen === null || seen >= marked * TAG_PIXELS) ? marked : 0;
    return shot && { ...shot, marked: shown };
  } catch (_) { return null; }
}

// The capture is the screen's full size, which on a high-density display is
// several times what is useful. Scaled down where the browser can; otherwise
// sent as it is.
async function shrinkShot(dataUrl) {
  const raw = { type: 'image/jpeg', data: String(dataUrl).split(',')[1] ?? '' };
  if (!raw.data) return null;
  try {
    if (typeof OffscreenCanvas === 'undefined' || typeof createImageBitmap === 'undefined') return raw;
    const bitmap = await createImageBitmap(await (await fetch(dataUrl)).blob());
    const scale = Math.min(1, SHOT_MAX_SIDE / Math.max(bitmap.width, bitmap.height));
    if (scale === 1) return raw;
    const canvas = new OffscreenCanvas(Math.round(bitmap.width * scale), Math.round(bitmap.height * scale));
    canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.7 });
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return { type: 'image/jpeg', data: btoa(bin) };
  } catch (_) { return raw; }
}

// A question in an embedded frame — Connect serves its worksheets that way —
// often has its Next button and Required tabs in the page around it. Try the
// question's frame first, then the top one.
async function inQuestionOrTop(tabId, frameId, msg) {
  const here = await sendToTab(tabId, msg, frameId).catch(e => ({ success: false, error: e.message }));
  if (here?.success || frameId === 0) return here;
  const top = await sendToTab(tabId, { ...msg, timeoutMs: 1500 }, 0).catch(() => null);
  return top?.success ? top : here;
}

// ── Connect: from a graded question to the next one ─────────────────────────
// Pressing Next isn't always enough. After a wrong answer Connect greys it out
// until a concept resource has been opened ("Select a concept resource to
// continue."), and the resource has its own way back — a To Questions / Back
// to Questions button. The page side finds those by what they say (see
// connectState in content.js); here is the order to press them in, and what to
// do when none of them is there.

const pause = ms => new Promise(r => setTimeout(r, ms));
// Whatever else is on the page, these end or hand in the assignment
const NEVER_PRESS = /submit|finish|\bexit\b|\bend\b|\bdone\b|hand in|turn in|quit|sign out|log ?out|delete|reset|start over|retake/i;

// The question's frame and the page around it can each hold these buttons
async function connectStateOf(tabId, frameId) {
  const got = [];
  for (const id of frameId === 0 ? [0] : [frameId, 0]) {
    const s = await sendToTab(tabId, { type: 'CONNECT_STATE' }, id).catch(() => null);
    if (s && !s.error) got.push(s);
  }
  const any = k => got.some(s => s[k]);
  return {
    graded: any('graded'), needsResource: any('needsResource'), resource: any('resource'),
    back: any('back'), next: any('next'), nextWaiting: any('nextWaiting'),
    buttons: [...new Set(got.flatMap(s => s.buttons ?? []))].slice(0, 14)
  };
}

// Connect's verdict on the answer just given, from whichever frame shows it
async function connectResultOf(tabId, frameId) {
  for (const id of frameId === 0 ? [0] : [frameId, 0]) {
    const r = await sendToTab(tabId, { type: 'CONNECT_RESULT' }, id).catch(() => null);
    if (r?.verdict) return r;
  }
  return null;
}

// A click on a greyed-out Next does nothing and still "succeeds", so after one
// the page is looked at: it has moved on when the graded view is gone and the
// concept-resource notice isn't there
async function movedOn(tabId, frameId, wasGraded) {
  // Long enough for a slow page: calling a late arrival "stuck" would cost a call to the model
  for (let i = 0; i < 8; i++) {
    await pause(i ? 400 : 500);
    const s = await connectStateOf(tabId, frameId);
    if (s.needsResource) return false;
    if (!wasGraded || !s.graded) return true;
  }
  return false;
}

// Gets from a graded question to the next one: Next if it's usable; the
// concept resource first when the page asks for one; the way back from it
// when that's what is on screen. When none of that works and `askModel` is
// given, the model looks at the page and names the button to press. `tried`
// is what has been pressed so far, for the model and for the error.
async function advanceToNext(tabId, frameId, click, askModel) {
  const press = (candidates, timeoutMs) => inQuestionOrTop(tabId, frameId, { type: 'CLICK_TEXT', candidates, timeoutMs });
  const stopped = () => cancelledRuns.has(tabId);
  const wasGraded = (await connectStateOf(tabId, frameId)).graded;
  const tried = [];
  let pressed = { resource: 0, back: 0 }, asked = 0, last = null;

  for (let round = 0; round < 3; round++) {
    for (let hop = 0; hop < 6; hop++) {
      if (stopped()) return { stopped: true };
      reportProgress(tabId, 1, 1);   // still working, as far as the bar's silence timer goes
      const s = last = await connectStateOf(tabId, frameId);
      const gated = s.needsResource || (s.nextWaiting && !s.next);

      if (s.back && !s.next && pressed.back < 3) {
        if ((await press([{ smart: 'back' }], 1500))?.success) { pressed.back++; tried.push('To Questions'); await pause(900); continue; }
      } else if (gated && s.resource && pressed.resource < 2) {
        if ((await press([{ smart: 'resource' }], 1500))?.success) { pressed.resource++; tried.push('Read About the Concept'); await pause(1000); continue; }
      }

      const r = await press(click.candidates, hop ? 1500 : gated ? 1200 : 2500);
      if (r?.success && await movedOn(tabId, frameId, wasGraded)) return { success: true, tried };
      // Pressed and still here, or nothing to press: what is on screen now
      // decides the next hop; with nothing new to try, the hops are over
      const after = await connectStateOf(tabId, frameId);
      const more = (after.back && pressed.back < 3) || ((after.needsResource || after.nextWaiting) && after.resource && pressed.resource < 2);
      if (!more) break;
    }
    if (!askModel || asked >= 2) break;
    asked++;
    const named = await askModel(tried).catch(() => null);
    if (!named) break;
    tried.push(named);
    await pause(1000);
  }
  return { success: false, tried, buttons: last?.buttons ?? [], waiting: !!last?.nextWaiting || !!last?.needsResource };
}

// ── Answer memory ───────────────────────────────────────────────────────────
// What Connect shows as the right answer is kept, and given the next time the
// same question comes up — with no call to the model. A question is the same
// when its words and its set of choices are, in whatever order the choices come
// (Connect shuffles them). Only questions answered by ticking choices are kept.
const BOOK_MAX = 800;
let bookQueue = Promise.resolve();

function changeBook(fn) {
  const done = bookQueue.then(async () => {
    const { answerBook } = await chrome.storage.local.get('answerBook').catch(() => ({}));
    const next = fn(answerBook && typeof answerBook === 'object' ? answerBook : {});
    if (!next) return;
    // The oldest go first when it is full
    const keys = Object.keys(next);
    if (keys.length > BOOK_MAX) {
      keys.sort((a, b) => (next[a].t ?? 0) - (next[b].t ?? 0)).slice(0, keys.length - BOOK_MAX).forEach(k => delete next[k]);
    }
    await chrome.storage.local.set({ answerBook: next });
  });
  bookQueue = done.catch(() => {});
  return done;
}

const choiceKey = t => String(t ?? '').toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 100);
const hasLabel = e => (e.type === 'radio' || e.type === 'checkbox') && !!e.text;

// A short fixed-length fingerprint, so no long keys are kept
function fingerprint(s) {
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 2654435761);
    h2 = Math.imul(h2 ^ c, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

// Who this question is, from the page as first read — or null when it is not
// one to remember: no ticking choices, or more than one question on the page
function questionId(elements) {
  const choices = elements.filter(hasLabel);
  if (choices.length < 2) return null;
  const all = [...new Set(choices.map(e => e.question).filter(Boolean))];
  const qs = all.filter((q, _, a) => !a.some(o => o !== q && o.includes(q)));
  if (qs.length !== 1) return null;
  const labels = choices.map(e => choiceKey(e.text));
  if (new Set(labels).size !== labels.length) return null;
  return { key: fingerprint(choiceKey(qs[0]).slice(0, 600) + '\u0001' + [...labels].sort().join('\u0001')), labels, question: qs[0] };
}

// The click that gives the remembered answer, or null if it doesn't fit the page
function recallAction(entry, elements) {
  const picks = [];
  for (const label of entry?.a ?? []) {
    const i = elements.findIndex((e, j) => hasLabel(e) && !picks.includes(j) && choiceKey(e.text) === label);
    if (i < 0) return null;
    picks.push(i);
  }
  if (!picks.length) return null;
  // A ticked box is left ticked: clicking it again would clear it
  const todo = picks.filter(i => !elements[i].selected);
  if (!todo.length) return null;
  return picks.length === 1 ? { action: 'click', index: todo[0] } : { action: 'clickMany', indexes: todo };
}

// Nothing the page says to press worked: the model looks at the page — with a
// screenshot, and tags on the buttons — and names the one that moves on.
// Returns what it pressed, or null.
const GET_UNSTUCK = `The question on this page has already been answered and graded. Do NOT answer it again. The run is stuck: it can't get to the next question. Choose the ONE button to press next:
- "Next Question" (or Next / Continue) if it can be pressed;
- if the page says a concept resource has to be opened first ("Select a concept resource to continue"), "Read About the Concept" or another concept resource;
- if a reading or resource is open, the button that goes back to the questions ("To Questions", "Back to Questions").
Never choose Submit, Finish, Exit, End, Done, or anything that hands in or leaves the assignment. Reply {"action":"click","index":N}, or {"action":"none"} if no such button is on the page.`;

async function askWhatToPress({ apiKey, notes, tabId, frameId, model, log }, tried) {
  let page = null, where = frameId;
  const frames = frameId === 0 ? [0] : [frameId, 0];
  for (const id of frames) {
    const p = await sendToTab(tabId, { type: 'SCRAPE' }, id).catch(() => null);
    if (!p?.elements?.length) continue;
    if (!page) { page = p; where = id; }
    if (p.elements.some(e => e.tag === 'button' || e.tag === 'a')) { page = p; where = id; break; }
  }
  if (!page) return null;

  const picture = await captureTab(tabId, where);
  const stopBeat = heartbeat(tabId, 1, 1);
  const { action, request } = await callClaude(apiKey, notes, page.text ?? '', page.elements, model, false, false,
    tried.map(t => `pressed "${t}"`), false, '', picture, GET_UNSTUCK).finally(stopBeat);
  log?.steps.push({ round: 1, step: 0, attempt: 1, model: request.model, kind: 'getting past the answer',
    prompt: request.prompt, action, answer: actionSummary(action, page.elements) });

  if (action.action !== 'click' || badIndexes(action, page.elements.length).length) return null;
  const label = page.elements[action.index]?.text ?? '';
  if (!label || NEVER_PRESS.test(label)) return null;
  const done = await sendToTab(tabId, { type: 'EXECUTE', action }, where).catch(() => null);
  return done?.success ? label : null;
}

// ── Sending less (only when the "cheapest formulas" setting is on) ───────────
// By default what the model reads and which model reads it are exactly as they were:
// nothing here can change an answer. This is for those who would rather pay less and
// have tried it on a practice exam.
// A SIMnet task that is "enter a formula in cell D2" is answered by typing it: the
// ribbon's hundred-odd controls, the Windows taskbar and the page's own copy of the
// ribbon's words are about two thirds of every prompt and nothing it needs. The
// list is cut down to the cells (numbers unchanged), and if the model turns out to
// want the rest, it gets the rest.
const FORMULA_TASK = /\b(enter|type|write)\b[^.\n]{0,80}\b(formula|function)\b|\bformula\b[^.\n]{0,40}\bin (the )?(selected )?cell\b/i;
const NEEDS_RIBBON = /\b(dialog|ribbon|button|menu|tab|Function Arguments|Evaluate Formula|click)\b/i;
// The task's first sentence only: the page's text goes on to the ribbon's words
const firstSentence = t => String(t ?? '').trim().slice(0, 400).split(/(?<=[.!?])\s+/)[0];
const isFormulaTask = text => { const t = firstSentence(text); return FORMULA_TASK.test(t) && !NEEDS_RIBBON.test(t); };
const ARRAY_FORMULA = /array formula|ctrl\s*\+\s*shift\s*\+\s*enter/i;

// SIMnet's page text begins with the ribbon's words (File Home Insert ... 100%) and a
// clock, which the element list already says better and which change every minute
const tidySimnetText = t => String(t)
  .replace(/\nFile\nHome\n[\s\S]*?\n100%\n/, '\n')
  .replace(/\n\d{1,2}:\d{2} (?:AM|PM)\n\d{1,2}\/\d{1,2}\/\d{4}\n/, '\n');

async function runGoal(apiKey, notes, tabId, postClicks = [], baseModel = DEFAULT_MODEL, autoUpgrade = true, log = null, host = '', remember = false, cheapFirst = false) {
  let usedModel = baseModel;   // reported back so the UI can show an upgrade
  const isConnect = /(^|\.)mheducation\.com$/.test(host);
  const useBook = remember && isConnect;   // the answer memory: Connect shows the right answer, so only there
  let qid = null;          // this question as first read, to find it in the memory and to put it there
  let recalled = false;    // the answer came from the memory, not the model

  // Resolve once per run: every scrape, click and fill must hit the same frame
  // (changed only if the frame chosen proves to hold nothing)
  let frameId = await findQuestionFrame(tabId);

  cancelledRuns.delete(tabId);   // a fresh run clears any earlier stop

  // For the answer log: the page as it stands once the answer is in — which
  // is where Connect shows "Correct"/"Incorrect" and SIMnet its incorrect
  // popup and hint. That verdict is what tells a good answer from a bad one.
  const snapshot = async () => {
    if (!log) return;
    await new Promise(r => setTimeout(r, 700));
    const page = await sendToTab(tabId, { type: 'SCRAPE', peek: true }, frameId).catch(() => null);
    log.after = (page?.text ?? '').slice(0, 2500);
  };

  let budget = MAX_STEPS_SIMPLE;
  let completed = 0;
  let saidDone = false;   // the model reported the task complete, vs. steps running out
  let isCanvas = false;
  let isSimnet = false;
  const history = [];   // what has been done so far on this question

  // SIMnet grades with a popup (see findVerdict in content.js). A wrong first
  // try gets one more round, following SIMnet's hint — if that leaves the
  // student's last attempt untouched.
  let verdict = null;
  let attempts = null;     // {current, total} as shown at the start
  let retryHint = '';
  let round = 0;
  let ungradedDone = 0;    // "done" claims SIMnet didn't grade, this round
  let committed = false;   // the last step handed the answer in (Enter, OK): SIMnet is about to grade it
  let compactFailed = false;   // the cut-down list wasn't enough for this task: send all of it
  let parts = null;        // a question split into tabs (Required 1, Required 2)
  const doneParts = [];    // ...and the ones answered this run
  let escalated = false;   // Auto gave the question to the stronger model after the cheap one gave up
  let shotTried = false;   // a screenshot was added after the text alone failed
  const canEscalate = () => autoUpgrade && !escalated
    && !!UPGRADE_TO[baseModel] && UPGRADE_TO[baseModel] !== usedModel;

  rounds: for (;;) {
  steps: for (let step = 0; step < budget; step++) {
    if (cancelledRuns.has(tabId)) {
      cancelledRuns.delete(tabId);
      return { success: false, error: 'Stopped.', usedModel };
    }
    reportProgress(tabId, step + 1, budget);

    // A verdict can arrive after any step, not only the last
    // (just after Enter or OK the popup can be a moment coming: not there yet is
    // not the answer being wrong, and the model going off to try another way
    // with the ribbon dialogs is how real runs wandered)
    if (isSimnet && step > 0) {
      const v = committed && attempts ? await waitForVerdict(tabId, frameId, 3000) : await readVerdict(tabId, frameId);
      if (v.verdict) { verdict = v; break steps; }
    }

    let lastError = 'Unknown error';
    let stepDone = false;
    let finished = false;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        // The first look of a run has nothing earlier to compare against
        let pageData = await sendToTab(tabId, { type: 'SCRAPE', firstLook: step === 0 && attempt === 0 }, frameId);
        if (!pageData || pageData.error) {
          throw new Error(pageData?.error ?? 'No response from content script');
        }
        // Nothing to act on in the frame chosen: look for the one that has something
        if (!pageData.elements?.length) {
          const other = await busiestFrame(tabId, frameId);
          if (other !== null) {
            const there = await sendToTab(tabId, { type: 'SCRAPE', firstLook: step === 0 && attempt === 0 }, other).catch(() => null);
            if (there?.elements?.length) { frameId = other; pageData = there; }
          }
        }

        // A simulated-Excel task is a procedure — switch tab, open dialog, set
        // arguments, confirm — so it needs room for several steps. Set from the
        // scrape rather than from the action, since the page says what it is
        // before the first move is chosen.
        if (pageData.isSimnet) { isSimnet = true; budget = MAX_STEPS_SIMNET; }
        // The popup may already be up (play pressed on a graded task), and the
        // attempt counter is read before anything can change it
        if (pageData.isSimnet && step === 0 && attempt === 0) {
          const v = await readVerdict(tabId, frameId);
          if (round === 0) attempts = v.attempts;
          if (v.verdict) { verdict = v; break steps; }
        }
        // Choices in one reply, typed blanks in a second — only when there
        // are blanks, so a plain multiple-choice page costs one call.
        if (pageData.isCanvas) {
          isCanvas = true;
          budget = Math.max(budget, pageData.hasBlanks ? 2 : 1);
        }

        // The question prose often lives in the outer page while the answer
        // grid is inside the iframe, so pull both or the amounts to work from
        // would be missing entirely.
        // A peek, so the outer page's element list (and its dropdowns) are
        // left alone — every action goes to the question's frame.
        // Tables go first, in columns, so the page text's cut-off can't lose them
        let pageText = pageData.tables
          ? `Tables on the page (cells separated by |):\n${pageData.tables}\n\n${pageData.text}`
          : pageData.text;
        let outerParts = null;
        if (frameId !== 0) {
          try {
            const outer = await sendToTab(tabId, { type: 'SCRAPE', peek: true }, 0);
            if (outer?.tables && !pageData.tables) pageText = `Tables on the page (cells separated by |):\n${outer.tables}\n\n${pageText}`;
            if (outer?.text) pageText = `${outer.text}\n\n${pageText}`;
            outerParts = outer?.parts ?? null;
          } catch (_) { /* outer frame unreachable — use what we have */ }
        }

        // (only in the cheapest mode: by default what the model reads is left as it is)
        if (pageData.isSimnet && cheapFirst) pageText = tidySimnetText(pageText);

        // The Required tabs can be in the outer page when the table is in a frame
        if (!isSimnet && !isCanvas) parts = pageData.parts ?? outerParts;
        // A screenshot where the page says it needs one (a picture, almost no
        // text), or where the text alone has just failed to give an answer —
        // and on SIMnet only once a task is going wrong (a step that failed, or
        // a "done" nothing graded), not on every step of every task. It goes to
        // whichever model the page calls for: the cheap one for an ordinary
        // question, the stronger one for a table or a worksheet, which is where
        // reading the picture matters and the extra cost is worth it.
        // A question seen before, with its right answer kept: no need to ask
        let action, request, picture = null;
        if (useBook && !qid && completed === 0) qid = questionId(pageData.elements);
        const recall = qid && !recalled && completed === 0 && !isSimnet && !isCanvas
          ? recallAction(await bookEntry(qid.key), pageData.elements) : null;
        if (recall) {
          recalled = true;
          action = recall;
          request = { model: 'memory', kind: 'memory', prompt: 'The right answer to this question, as Connect showed it the last time it came up.' };
        } else {
          const simStuck = pageData.isSimnet && (ungradedDone > 0 || attempt > 0);
          picture = (pageData.isSimnet ? simStuck : (pageData.needsPicture || shotTried)) ? await captureTab(tabId, frameId) : null;
          // A formula to type, on a graded exam where a wrong one can be tried again:
          // the cheapest model first if asked, SIMnet's own verdict being the check
          // and the stronger model (with its hint) the retry
          const formulaTask = !!pageData.isSimnet && isFormulaTask(pageText);
          const retryPossible = !!postClicks.length && !!attempts && attempts.current + 1 < attempts.total;
          usedModel = escalated ? (UPGRADE_TO[baseModel] ?? baseModel)
            : (cheapFirst && formulaTask && round === 0 && !retryHint && retryPossible) ? baseModel
            : pickModel(baseModel, pageData, autoUpgrade);
          // The cells, what just appeared and nothing else, for a formula to be typed
          const compact = cheapFirst && formulaTask && completed === 0 && !retryHint && !compactFailed;
          const only = compact
            ? new Set(pageData.elements.map((e, i) => (e.cell || e.fresh) ? i : -1).filter(i => i >= 0))
            : null;
          // A worksheet can think for longer than the bar's silence
          // timer, which would call the run dead mid-answer
          const stopBeat = heartbeat(tabId, step + 1, budget);
          ({ action, request } = await callClaude(apiKey, notes, pageText, pageData.elements, usedModel, !!pageData.isWorksheet, !!pageData.isSimnet, history, !!pageData.isCanvas, retryHint, picture, '', only)
            .finally(stopBeat));
          // Anything but typing, from a list with no ribbon in it, means it wanted the
          // ribbon: ask again with all of it
          if (only && !(['type', 'key', 'selectRange'].includes(action.action)
              && !(action.action === 'type' && typeof action.index === 'number' && !only.has(action.index)))) {
            compactFailed = true; attempt--; continue;
          }
        }

        // Stop pressed while Claude was thinking: its answer is not acted on
        if (cancelledRuns.has(tabId)) {
          cancelledRuns.delete(tabId);
          return { success: false, error: 'Stopped.', usedModel };
        }

        // An array formula is entered with Ctrl+Shift+Enter. Told so in the prompt
        // and by SIMnet's own hint, the model still sent Ctrl+Enter (twice, in a real
        // log), which fills the block with the plain formula instead
        if (isSimnet && action.action === 'key' && action.key === 'Enter' && action.ctrl && !action.shift
            && ARRAY_FORMULA.test(`${pageText} ${retryHint}`)) {
          action.shift = true;
        }

        log?.steps.push({
          round: round + 1, step: step + 1, attempt: attempt + 1,
          model: request.model, kind: request.kind, prompt: request.prompt, usage: request.usage,
          action, answer: actionSummary(action, pageData.elements)
        });

        const bad = badIndexes(action, pageData.elements.length);
        if (bad.length && !pageData.elements.length) {
          const err = new Error("Couldn't see anything to click on this page: it may be drawn in a way Page Agent can't read yet. Open the gear, tap More, press Copy next to Copy page details and send that to whoever looks after Page Agent.");
          err.final = true;
          throw err;
        }
        if (bad.length) {
          throw new Error(`Referred to item ${bad.join(', ')}, which isn't on the page.`);
        }

        // Clicking the question's own box, or a confidence button, answers
        // nothing — the real log has both. Same treatment as giving up.
        if (!isSimnet && !isCanvas && completed === 0 && missedTheChoices(action, pageData.elements)) {
          // First a look at the page itself, then the stronger model
          if (!shotTried && !pageData.isSimnet) { shotTried = true; attempt--; continue; }
          if (canEscalate()) { escalated = true; attempt--; continue; }
        }

        if (action.action === 'none') {
          // Before any action: nothing on screen is answerable.
          // After a move: the drag arrangement is complete.
          // Except on a Canvas page whose questions all have an answer already
          // — arriving back on one, say — where "none" means move on.
          // Graded SIMnet — the attempt counter shows it — puts up a popup
          // for every finished task. "Done" with no popup means nothing was
          // graded, so the task isn't done: say so and carry on, rather than
          // stop on the model's word. Twice at most, so a stuck run can't
          // spend its steps insisting.
          if (isSimnet && attempts) {
            const v = await waitForVerdict(tabId, frameId, 2000);
            if (v.verdict) { verdict = v; break steps; }
            if (++ungradedDone <= 2) {
              history.push('said the task was done, but SIMnet graded nothing, so it is NOT done yet — take the next step');
              stepDone = true;
              break;
            }
            return { success: false, usedModel,
                     error: "It thinks it's done, but SIMnet hasn't graded anything. Check it and finish this one yourself." };
          }
          // Or on a part of a question answered earlier, with another to go
          const alreadyDone = (isCanvas && everyQuestionAnswered(pageData.elements))
            || !!parts?.some(p => !p.current && !doneParts.includes(p.text));
          if (completed === 0 && !alreadyDone) {
            // On Auto, the cheap model saying "none" on a question it could
            // see is usually it giving up, not the page having no question.
            // One more look, from the stronger model, before stopping.
            // The text alone gave nothing: look at the page itself before
            // changing model, which costs far more
            if (!shotTried && !pageData.isSimnet && !picture) { shotTried = true; attempt--; continue; }
            if (canEscalate()) { escalated = true; attempt--; continue; }
            return { success: true, action, noAnswer: true, usedModel };
          }
          finished = true;
          saidDone = true;
          stepDone = true;
          break;
        }

        let result;
        if (action.action === 'dragMove') {
          budget = MAX_STEPS_DRAG;
          // Focus the card in the page, then drive real keys through the debugger
          result = await sendToTab(tabId, { type: 'FOCUS_DRAG', index: action.index }, frameId);
          if (result?.success) {
            const steps = Number.isInteger(action.steps) && action.steps > 0 ? action.steps : 1;
            await trustedKeyDrag(tabId, action.dir, steps);
          }
        } else if (action.action === 'fill' && action.fills?.some(f => pageData.elements[f.index]?.sheet)) {
          // Spreadsheet cells can't be filled like inputs — each has to be
          // opened and typed into for real, one at a time.
          result = { success: true };
          const missed = [];
          for (const f of action.fills) {
            // Typing a long worksheet cell by cell can outlast the control
            // bar's silence timer on its own, so keep telling it we're alive.
            reportProgress(tabId, step + 1, budget);
            const r = await typeIntoCell(tabId, frameId, f.index, f.value);
            if (!r.success) {
              missed.push(r.error?.startsWith('[') ? r.error : `[${f.index}]`);
              // What the list really offers goes into what the retry is told, so a wrong word can be corrected
              if (r.options?.length) history.push(`the list for cell [${f.index}] showed: ${r.options.slice(0, 12).join(' | ')} (it may show only the entries that match what was typed) — use the exact words of one of these`);
            }
          }
          if (missed.length === action.fills.length) {
            result = { success: false, error: `No cells could be filled: ${missed.join(', ')}` };
          } else if (missed.length) {
            result = { success: false, error: `Filled ${action.fills.length - missed.length}/${action.fills.length}; missed ${missed.join(', ')}` };
          }
        } else {
          const stopFillBeat = heartbeat(tabId, step + 1, budget);
          result = await sendToTab(tabId, { type: 'EXECUTE', action }, frameId).finally(stopFillBeat);
          // Grid cells take no typed-in value; they only respond to real key
          // presses, like the worksheet cells above. The page has focused the
          // cell and says so; the keys go through the debugger.
          if (result?.success && result.needsKeys) {
            await attachDebugger(tabId);
            if (isSimnet && /^=/.test(action.text ?? '')) {
              // A formula: in stages, each looked at (see typeFormula)
              const trail = [];
              try {
                await typeFormula(tabId, frameId, action.text, () => sendToTab(tabId, { type: 'EXECUTE', action }, frameId), trail);
              } finally {
                if (log) (log.typing = log.typing ?? []).push({ text: action.text, trail });
              }
            } else {
              await typeText(tabId, action.text);
            }
          }
        }

        if (result?.success) {
          stepDone = true;
          completed++;
          committed = (action.action === 'key' && action.key === 'Enter')
            || (action.action === 'click' && /^(ok|apply)$/i.test((pageData.elements[action.index]?.text ?? '').trim()));
          history.push(actionSummary(action, pageData.elements));
          // A formula typed into a cell is always followed by Enter (an array formula
          // by Ctrl+Shift+Enter), and in the logs it was a model call every time to
          // say so. Pressing it needs no call; what comes of it is read straight after.
          if (isSimnet && action.action === 'type' && result.needsKeys && /^=/.test(action.text ?? '')) {
            const enter = { action: 'key', key: 'Enter', ...(ARRAY_FORMULA.test(`${pageText} ${retryHint}`) ? { ctrl: true, shift: true } : {}) };
            const pressed = await sendToTab(tabId, { type: 'EXECUTE', action: enter }, frameId).catch(() => null);
            if (pressed?.success) { history.push(actionSummary(enter, pageData.elements)); committed = true; }
          }

          // Repeating one step means it isn't taking effect — the page looks
          // unchanged, so the same move keeps looking correct. Stop rather than
          // spend the rest of the budget and the API calls on a loop.
          const n = history.length;
          if (n >= 3 && history[n - 1] === history[n - 2] && history[n - 2] === history[n - 3]) {
            return {
              success: false,
              usedModel,
              error: `Repeated the same step 3 times with no effect: ${history[n - 1]}. That control isn't responding to the click.`
            };
          }
          await new Promise(r => setTimeout(r, action.action === 'dragMove' ? 500 : 900));
          break;
        }

        lastError = result?.error ?? 'Execution returned failure without an error message';
      } catch (e) {
        lastError = e.message;
        // Haiku 5.5 has no server-side fallback: on Auto, a question it
        // declines gets one try on Sonnet 5.5, which has
        if (e.refusal && canEscalate()) { escalated = true; attempt--; continue; }
        if (e.message.startsWith('Rate limit') || e.final) {
          return { success: false, error: lastError };
        }
      }

      if (attempt < MAX_RETRIES) {
        await new Promise(r => setTimeout(r, 400 * (attempt + 1)));
      }
    }

    if (!stepDone) {
      return { success: false, usedModel, error: `Stuck on step ${step + 1}. Last error: ${lastError}` };
    }

    // A question in parts: this one is answered, so open the next tab and
    // answer that too, in the same run, before Next is pressed.
    if (parts && (finished || step === budget - 1)) {
      const here = parts.find(p => p.current)?.text ?? (doneParts.length ? null : parts[0].text);
      if (here && !doneParts.includes(here)) doneParts.push(here);
      const next = parts.find(p => !doneParts.includes(p.text));
      if (next && cancelledRuns.has(tabId)) {
        cancelledRuns.delete(tabId);
        return { success: false, error: 'Stopped.', usedModel };
      }
      if (next) {
        const opened = await inQuestionOrTop(tabId, frameId, { type: 'OPEN_PART', text: next.text });
        if (opened?.success) {
          doneParts.push(next.text);   // so a tab that won't open can't loop
          history.length = 0;
          budget = step + 2;
          await new Promise(r => setTimeout(r, 1200));
          continue;
        }
      }
    }
    if (finished) break;
  }

  if (!isSimnet) break rounds;

  // Finished by the model's account: give SIMnet a moment to grade it. Out
  // of steps: the last one may still have drawn a verdict, so look once.
  if (!verdict?.verdict) {
    verdict = saidDone ? await waitForVerdict(tabId, frameId, 3000) : await readVerdict(tabId, frameId);
  }
  if (verdict?.verdict) log?.verdicts.push({ round: round + 1, verdict: verdict.verdict, hint: verdict.hint });

  // Wrong on the first try: one more, with the hint — only when pressing
  // Continue can't spend the student's last attempt, and never in Answer only
  // mode, where the student drives.
  const retrySafe = attempts && attempts.current + 1 < attempts.total;
  if (verdict?.verdict === 'incorrect' && round === 0 && postClicks.length && retrySafe) {
    if (cancelledRuns.has(tabId)) {
      cancelledRuns.delete(tabId);
      return { success: false, error: 'Stopped.', usedModel };
    }
    if (!(await pressContinue(tabId, verdict))) break rounds;
    retryHint = verdict.hint;
    verdict = null;
    saidDone = false;
    completed = 0;
    ungradedDone = 0;
    history.length = 0;
    round++;
    continue rounds;
  }
  break rounds;
  }

  // SIMnet has no confidence rating or Next button of the Connect kind, and
  // going round again would start fiddling with a task that's already done.
  if (isSimnet) {
    await snapshot();
    const hint = verdict?.hint ? ` SIMnet's hint: ${verdict.hint.replace(/^HINT:\s*/i, '').slice(0, 300)}` : '';

    if (verdict?.verdict === 'correct') {
      // Answer only: the student moves on. Otherwise Continue goes to the
      // next question, and Autopilot carries on from there.
      if (!postClicks.length) {
        return { success: true, usedModel, finished: 'Correct! Click Continue for the next question.' };
      }
      const moved = await pressContinue(tabId, verdict);
      // "advanced": the next question is already up, so the bar needn't wait
      // for the page to change — it has
      return { success: true, message: 'Done', usedModel, advanced: moved };
    }
    if (verdict?.verdict === 'incorrect') {
      const why = round > 0 ? 'Marked incorrect again.'
                : postClicks.length && attempts && !(attempts.current + 1 < attempts.total)
                  ? 'Marked incorrect, and another try would use your last attempt.'
                  : 'Marked incorrect.';
      return { success: false, usedModel, error: `${why}${hint} Do this one yourself.` };
    }
    // Using up every step without the model saying it's finished is not a
    // finished task, however it looks — say so rather than "done".
    if (!saidDone) {
      return { success: false, usedModel,
               error: `Used all ${budget} steps without finishing. Do this one yourself, then move on.` };
    }
    return { success: true, usedModel, finished: 'Finished. Check SIMnet agrees, then move to the next one.' };
  }

  // Canvas: no confidence rating, and a Next button only in one-question-at-
  // a-time quizzes. When there is no Next, the page is answered and the quiz
  // is waiting to be handed in — which is the student's decision, so stop
  // here rather than going round again. Also stop in answer-only mode.
  if (isCanvas) {
    const done = { success: true, usedModel, finished: 'Answered. Check it over, then submit it yourself.' };
    if (!postClicks.length) return done;
    if (cancelledRuns.has(tabId)) {
      cancelledRuns.delete(tabId);
      return { success: false, error: 'Stopped.', usedModel };
    }
    const next = await sendToTab(tabId, {
      type: 'CLICK_TEXT',
      candidates: [{ selector: 'button.next-question' }],
      timeoutMs: 1500
    }, frameId).catch(() => null);
    return next?.success ? { success: true, message: 'Done', usedModel } : done;
  }

  // Direct clicks (confidence button, next button) — no Claude needed. The
  // snapshot goes just before the last one (Next), after the confidence
  // rating, when Connect is showing its verdict and before it moves on.
  if (!postClicks.length) await snapshot();

  // The graded page says what the right answer was. Kept, so the same question
  // is answered right next time — and if what was remembered turned out wrong,
  // it is put right (or dropped, when the page doesn't say what was).
  const learn = async () => {
    if (!useBook || !qid) return;
    const r = await connectResultOf(tabId, frameId);
    if (!r?.verdict) return;
    const said = r.verdict === 'correct' ? r.yours : r.correct;
    const right = said.map(choiceKey).filter(k => qid.labels.includes(k));
    const whole = right.length > 0 && right.length === said.length;
    log?.verdicts.push({ round: 1, verdict: r.verdict, ...(r.verdict === 'incorrect' ? { right: r.correct } : {}) });
    if (whole && (r.verdict === 'incorrect' || !recalled)) await rememberAnswer(qid, right).catch(() => {});
    else if (!whole && r.verdict === 'incorrect' && recalled) await forgetAnswer(qid.key).catch(() => {});
  };
  // Nothing worked: the model looks at the page, and the stronger one the second time
  let asks = 0;
  const askModel = async tried => {
    const model = asks++ && autoUpgrade && UPGRADE_TO[baseModel] ? UPGRADE_TO[baseModel] : pickModel(baseModel, {}, autoUpgrade);
    if (model !== baseModel) usedModel = model;
    return askWhatToPress({ apiKey, notes, tabId, frameId, model, log }, tried);
  };

  for (const [i, click] of postClicks.entries()) {
    if (i === postClicks.length - 1) await snapshot();
    if (cancelledRuns.has(tabId)) {
      cancelledRuns.delete(tabId);
      return { success: false, error: 'Stopped.', usedModel };
    }
    if (click.advance) {
      await learn().catch(() => {});
      const moved = await advanceToNext(tabId, frameId, click, isConnect ? askModel : null);
      if (moved.stopped) {
        cancelledRuns.delete(tabId);
        return { success: false, error: 'Stopped.', usedModel };
      }
      if (!moved.success) return { success: false, usedModel, error: stuckMessage(moved) };
      continue;
    }
    const result = await inQuestionOrTop(tabId, frameId, {
      type: 'CLICK_TEXT',
      candidates: click.candidates,
      // An optional button that isn't there shouldn't cost the full wait
      ...(click.optional ? { timeoutMs: 2500 } : {})
    });
    if (!result?.success) {
      if (click.optional) continue;
      return { success: false, error: `Could not find "${click.label}" button: ${result?.error ?? ''}` };
    }
    await new Promise(r => setTimeout(r, 400));
  }

  return { success: true, message: 'Done', usedModel, ...(recalled ? { fromMemory: true } : {}) };
}

// ── Answer memory: reading and writing ─────────────────────────────────────
async function bookEntry(key) {
  await bookQueue;
  const { answerBook } = await chrome.storage.local.get('answerBook').catch(() => ({}));
  return answerBook?.[key] ?? null;
}
const rememberAnswer = (qid, labels) => changeBook(book => {
  book[qid.key] = { a: labels, q: qid.question.slice(0, 80), t: Date.now() };
  return book;
});
const forgetAnswer = key => changeBook(book => (key in book) ? (delete book[key], book) : null);

// What the bar says when Next can't be reached: what was tried, and what was there
function stuckMessage({ tried = [], buttons = [], waiting = false }) {
  const did = tried.length ? ` It pressed ${tried.map(t => `"${t}"`).join(', then ')}.` : '';
  const seen = buttons.length ? ` On the page: ${buttons.map(b => `"${b.slice(0, 30)}"`).join(', ')}.` : '';
  return `Could not get to the next question${waiting ? ' (Next is greyed out; a concept resource may need opening)' : ''}.${did}${seen} Click Next yourself, then press play.`;
}

// ── Answer log ─────────────────────────────────────────────────────────────
// Off unless switched on. Each run is one entry: the prompts each model saw,
// what it answered, how the run ended, a look at the page afterwards, and
// whether the user marked it wrong. Kept in this browser only; the user
// downloads it to share it. Every change goes through one queue so a flag and
// an append can't overwrite each other.
const LOG_MAX_ENTRIES = 300;
const LOG_MAX_CHARS = 6_000_000;   // well inside chrome.storage's 10MB
let logQueue = Promise.resolve();

function changeLog(fn) {
  const done = logQueue.then(async () => {
    const { answerLog } = await chrome.storage.local.get('answerLog').catch(() => ({}));
    const next = fn(Array.isArray(answerLog) ? answerLog : []);
    if (!next) return;
    const kept = next.slice(-LOG_MAX_ENTRIES);
    while (kept.length > 1 && JSON.stringify(kept).length > LOG_MAX_CHARS) kept.shift();
    await chrome.storage.local.set({ answerLog: kept });
  });
  logQueue = done.catch(() => {});
  return done;
}

const hostOf = url => { try { return new URL(url).hostname; } catch (_) { return ''; } };

// Pasting a key can pick up invisible characters (a trailing newline, a
// zero-width space from a web page) that make a valid key fail.
function cleanKey(raw) {
  return raw ? String(raw).replace(/[^\x20-\x7E]/g, '').trim() : '';
}

// ── "Check this page" ──────────────────────────────────────────────────────
// The test suite runs against copies of each site's pages; this checks the
// real one. It answers the questions that matter when something "doesn't
// work": can the extension see the question, and does the key work.

function describePage(p, frameId) {
  if (p?.error) return { ok: false, text: `Couldn't read this page: ${p.error}` };
  const els = p?.elements ?? [];
  const where = frameId ? ' (inside an embedded frame)' : '';
  const n = (k, word) => `${k} ${word}${k === 1 ? '' : 's'}`;

  if (p.isSimnet) {
    const cells = els.filter(e => e.cell).length;
    return { ok: true, text: `SIMnet · ${n(els.length - cells, 'control')}, ${n(cells, 'cell')}${where}` };
  }
  if (p.isCanvas) {
    const questions = new Set(els.map(e => e.question)).size;
    return { ok: questions > 0,
             text: `${p.quizLabel ?? 'Canvas quiz'} · ${n(questions, 'question')}, ${n(els.length, 'answer')} to pick from${where}` };
  }
  if (p.isWorksheet) {
    const fields = els.filter(e => e.sheet || /^(input|textarea|select)$/.test(e.tag)).length;
    return { ok: true, text: `Worksheet · ${n(fields, 'blank')}${where}` };
  }
  if (p.isDrag) return { ok: true, text: `Drag and drop · ${n(els.length, 'item')}${where}` };
  if (!els.length) {
    return { ok: false, text: 'Nothing to answer found. Is a question showing on screen?' };
  }
  return { ok: true, text: `Question page · ${n(els.length, 'thing')} to click or fill${where}` };
}

async function checkKey(apiKey) {
  if (!apiKey) return { ok: false, text: 'No API key saved. Paste it into API Key below and click Save.' };
  try {
    // The smallest request there is: a one-token reply from the cheapest model
    const r = await postToApi(apiKey, {
      // Thinking off, so the one token isn't spent on it
      model: 'claude-haiku-5-5', max_tokens: 1,
      thinking: { type: 'disabled' }, output_config: { effort: 'low' },
      messages: [{ role: 'user', content: 'Hi' }]
    });
    if (r.ok) return { ok: true, text: 'API key works' };
    return { ok: false, text: apiErrorMessage(r.status, await r.text().catch(() => '')) };
  } catch (e) {
    return { ok: false, text: e.message };
  }
}

// A short name for the page, shown in the control bar before anything runs.
// Only for confident signals: the bar sits on every site, and "Ready ·
// Multiple choice" on a settings page with a radio button would be worse
// than saying nothing.
function pageKind(p, host) {
  if (!p || p.error) return '';
  if (p.isSimnet)    return 'SIMnet';
  if (p.isCanvas)    return p.quizLabel ?? 'Canvas quiz';
  if (p.isWorksheet) return 'Worksheet';
  if (p.isDrag)      return 'Drag and drop';
  if (/(^|\.)mheducation\.com$/.test(host ?? '')) return 'Connect';
  return '';
}

async function detectKind(tabId, host) {
  const frameId = await findQuestionFrame(tabId);
  const page = await sendToTab(tabId, { type: 'SCRAPE', peek: true }, frameId).catch(() => null);
  return pageKind(page, host);
}

async function checkPage(tabId) {
  const lines = [];
  const { apiKey, model, autoUpgrade } =
    await chrome.storage.local.get(['apiKey', 'model', 'autoUpgrade']).catch(() => ({}));

  const frameId = await findQuestionFrame(tabId);
  try {
    lines.push(describePage(await sendToTab(tabId, { type: 'SCRAPE', peek: true }, frameId), frameId));
  } catch (e) {
    lines.push({ ok: false, text: `Couldn't read this page: ${e.message}` });
  }

  lines.push(await checkKey(cleanKey(apiKey)));
  const base = resolveModel(model);
  const auto = autoUpgrade !== false && base === DEFAULT_MODEL;
  lines.push({ info: true, text: auto
    ? `Model: Auto — ${MODELS[base].label}, a smarter one for hard questions`
    : `Model: ${MODELS[base].label}` });
  return { lines };
}

// ── Showing and hiding the bar ─────────────────────────────────────────────
// One setting for every page; the bar on each page follows it.
async function toggleBar() {
  const { barHidden } = await chrome.storage.local.get('barHidden').catch(() => ({}));
  await chrome.storage.local.set({ barHidden: barHidden !== true });
}

// The key the user actually has for it — Chrome leaves a suggested shortcut
// unassigned if another extension holds it, and it can be changed
async function shortcutText() {
  const all = await chrome.commands?.getAll?.().catch(() => []) ?? [];
  return all.find(c => c.name === 'toggle-bar')?.shortcut ?? '';
}

try {
  chrome.commands?.onCommand?.addListener(cmd => { if (cmd === 'toggle-bar') toggleBar(); });
} catch (_) { /* no commands API here */ }

// Tabs whose current run has been stopped from the widget. The loop checks
// this between steps: without it, pressing stop only silenced the UI while the
// background carried on clicking.
const cancelledRuns = new Set();

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'STOP_RUN') {
    const id = msg.tabId ?? sender.tab?.id;
    if (id) cancelledRuns.add(id);
    sendResponse({ ok: true });
    return false;
  }

  if (msg.type === 'SHORTCUT') {
    shortcutText().then(shortcut => sendResponse({ shortcut }), () => sendResponse({ shortcut: '' }));
    return true;
  }

  if (msg.type === 'DETECT_PAGE') {
    const id = sender.tab?.id;
    if (!id) { sendResponse({ kind: '' }); return false; }
    detectKind(id, msg.host).then(kind => sendResponse({ kind }), () => sendResponse({ kind: '' }));
    return true;
  }

  if (msg.type === 'PAGE_DETAILS') {
    const id = msg.tabId ?? sender.tab?.id;
    pageDetails(id).then(text => sendResponse({ text }), e => sendResponse({ text: `Couldn't read this page: ${e.message}` }));
    return true;
  }

  if (msg.type === 'CHECK_PAGE') {
    const id = msg.tabId ?? sender.tab?.id;
    checkPage(id).then(sendResponse, e => sendResponse({ lines: [{ ok: false, text: e.message }] }));
    return true;
  }

  if (msg.type === 'LOG_FLAG') {
    // Marks the latest run on this site. Reliable when one question is
    // answered per press; on Autopilot the latest run may already be the next
    // question, which is why the page snapshot matters more.
    const host = hostOf(sender.url);
    let flagged = false;
    changeLog(log => {
      for (let i = log.length - 1; i >= 0; i--) {
        if (log[i].host === host) { log[i].flagged = true; flagged = true; break; }
      }
      return log;
    }).then(() => sendResponse({ ok: flagged }), () => sendResponse({ ok: false }));
    return true;
  }

  if (msg.type === 'LOG_EXPORT' || msg.type === 'LOG_COUNT') {
    logQueue.then(() => chrome.storage.local.get('answerLog')).then(({ answerLog }) => {
      const entries = Array.isArray(answerLog) ? answerLog : [];
      sendResponse(msg.type === 'LOG_COUNT' ? { count: entries.length } : { entries });
    }, () => sendResponse(msg.type === 'LOG_COUNT' ? { count: 0 } : { entries: [] }));
    return true;
  }

  if (msg.type === 'LOG_CLEAR') {
    changeLog(() => []).then(() => sendResponse({ ok: true }), () => sendResponse({ ok: false }));
    return true;
  }

  if (msg.type === 'SPEND_GET' || msg.type === 'SPEND_RESET') {
    spendQueue.then(async () => {
      if (msg.type === 'SPEND_RESET') await chrome.storage.local.set({ spend: freshSpend() });
      const { spend } = await chrome.storage.local.get('spend');
      sendResponse({ spend: spend ?? null });
    }).catch(() => sendResponse({ spend: null }));
    return true;
  }

  if (msg.type === 'BOOK_COUNT') {
    bookQueue.then(() => chrome.storage.local.get('answerBook')).then(
      ({ answerBook }) => sendResponse({ count: Object.keys(answerBook ?? {}).length }),
      () => sendResponse({ count: 0 }));
    return true;
  }

  if (msg.type === 'BOOK_CLEAR') {
    changeBook(() => ({})).then(() => sendResponse({ ok: true }), () => sendResponse({ ok: false }));
    return true;
  }

  if (msg.type !== 'RUN_GOAL') return;

  (async () => {
    const { apiKey: rawKey, model: savedModel, autoUpgrade, keepLog, rememberAnswers, cheapFormulas } =
      await chrome.storage.local.get(['apiKey', 'model', 'autoUpgrade', 'keepLog', 'rememberAnswers', 'cheapFormulas']).catch(() => ({}));
    const baseModel = resolveModel(savedModel);
    const apiKey = cleanKey(rawKey);
    if (!apiKey) {
      sendResponse({ success: false, error: 'No API key saved. Open the gear on the control bar and add it.' });
      return;
    }

    // The control bar's messages carry their tab; msg.tabId is for a caller
    // outside the page
    const tabId = msg.tabId ?? sender.tab?.id;
    if (!tabId) {
      sendResponse({ success: false, error: 'Could not determine tab ID.' });
      return;
    }

    const log = keepLog ? { at: new Date().toISOString(), host: hostOf(sender.url), steps: [], verdicts: [], after: '' } : null;

    let result;
    try {
      result = await runGoal(apiKey, msg.notes ?? '', tabId, msg.postClicks ?? [], baseModel, autoUpgrade !== false, log,
        hostOf(sender.url ?? sender.tab?.url), rememberAnswers !== false, cheapFormulas === true);
    } catch (e) {
      // Anything unexpected still has to come back as an answer. Without this
      // the reply never arrives and the widget sits on "Answering…" forever.
      result = { success: false, error: e?.message ?? String(e) };
    } finally {
      // Always release the tab so the "being debugged" banner doesn't linger
      try { await detachDebugger(tabId); } catch (_) {}
    }
    // A run that never reached Claude has nothing worth keeping. Logging must
    // never hold up or break the run, so a failed write is dropped.
    if (log?.steps.length) {
      const outcome = result?.success
        ? (result.finished ?? (result.noAnswer ? 'no answer found' : 'done'))
        : (result?.error ?? 'failed');
      await changeLog(entries => [...entries, { ...log, outcome, flagged: false }]).catch(() => {});
    }
    sendResponse(result);
  })();

  return true; // Keep message channel open for async sendResponse
});

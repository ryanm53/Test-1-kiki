// Per-model request differences. Prefill (seeding the reply with `{"action":"`)
// is rejected with a 400 on Sonnet 5 / Opus 5, as is `temperature`, so those
// models get structured outputs instead — which constrains the response to the
// schema at the API level and is a stronger guarantee than prefill anyway.
// Opus 5 also thinks by default, so it needs room under max_tokens.
const MODELS = {
  'claude-haiku-4-5': { label: 'Haiku 4.5', note: 'Fastest, cheapest', maxTokens: 200,  prefill: true, temperature: true },
  'claude-sonnet-5':  { label: 'Sonnet 5',  note: 'Smarter, ~2x cost', maxTokens: 2048, effort: 'low' },
  'claude-opus-5':    { label: 'Opus 5',    note: 'Smartest, ~5x cost', maxTokens: 2048, effort: 'low' }
};
const DEFAULT_MODEL = 'claude-haiku-4-5';

// Worksheets and drag questions need real reasoning — multi-step arithmetic in
// one case, spatial planning over several moves in the other — where the cheap
// model tends to fumble. One tier up, only for those, so ordinary multiple
// choice keeps costing what it costs.
const UPGRADE_TO = {
  'claude-haiku-4-5': 'claude-sonnet-5',
  'claude-sonnet-5':  'claude-opus-5',
  'claude-opus-5':    'claude-opus-5'
};

function pickModel(baseModel, pageData, autoUpgrade) {
  if (!autoUpgrade) return baseModel;
  const hard = pageData?.isWorksheet || pageData?.isDrag || pageData?.isSimnet;
  return hard ? (UPGRADE_TO[baseModel] ?? baseModel) : baseModel;
}

const ACTION_SCHEMA = {
  type: 'object',
  properties: {
    action:  { type: 'string', enum: ['click', 'clickMany', 'fill', 'dragMove', 'none'] },
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
{"action":"fill","fills":[{"index":N,"value":"answer"}]} — fill in the blank(s); one entry per input box, fill every blank in the question
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
Values must be plain numbers — no $, no commas, minus sign for a reduction.
A blank that is already correct at 0 still needs 0 entered.`;

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
Reply {"action":"none"} once the task described is complete.`;

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
  if (action.action === 'click' || action.action === 'dragMove') check(action.index);
  if (action.action === 'clickMany') (action.indexes ?? []).forEach(check);
  if (action.action === 'fill') (action.fills ?? []).forEach(f => check(f?.index));
  return out;
}

function actionSummary(action, elements) {
  const name = i => {
    const e = elements[i];
    if (!e) return `[${i}]`;
    return `"${(e.text || e.cell || e.tag || '').slice(0, 40)}"`;
  };
  switch (action.action) {
    case 'click':     return `clicked ${name(action.index)}`;
    case 'clickMany': return `selected ${(action.indexes ?? []).map(name).join(', ')}`;
    case 'fill':      return (action.fills ?? []).map(f => `typed "${f.value}" into ${name(f.index)}`).join('; ');
    case 'dragMove':  return `moved ${name(action.index)} ${action.dir} x${action.steps ?? 1}`;
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
async function postToApi(apiKey, requestBody) {
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
          'anthropic-dangerous-direct-browser-access': 'true'
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

  throw new Error(
    'Could not reach Claude. Check your internet connection and try again.'
    + (lastNetworkError ? ` (${lastNetworkError.message})` : '')
  );
}

async function callClaude(apiKey, notes, pageText, elements, modelId = DEFAULT_MODEL, isWorksheet = false, isSimnet = false, history = [], isCanvas = false) {
  const model = MODELS[modelId] ? modelId : DEFAULT_MODEL;
  const cfg = MODELS[model];

  const elementList = elements
    .map((el, i) => {
      const parts = [`[${i}]`, el.tag];
      if (el.type) parts.push(`type="${el.type}"`);
      if (el.text) parts.push(`"${el.text.slice(0, 80)}"`);
      if (el.placeholder) parts.push(`placeholder="${el.placeholder}"`);
      if (el.name) parts.push(`name="${el.name}"`);
      if (el.cell) parts.push(`cell=${el.cell}`);
      if (el.selected) parts.push('(selected)');
      if (el.question) parts.push(`(question: "${el.question.slice(0, 120)}")`);
      return parts.join(' ');
    })
    .join('\n');

  // Optional user context (subject, conventions, hints) — omitted when blank
  const notesSection = notes ? `Notes from the user: ${notes}\n\n` : '';

  const historySection = history.length
    ? `Steps you have ALREADY done for this question:\n${history.map((h, i) => `${i + 1}. ${h}`).join('\n')}\nDo the NEXT step, not one of these again.\n\n`
    : '';

  const userContent = `${notesSection}${historySection}Page text:
${pageText.slice(0, isWorksheet || isCanvas ? 3000 : isSimnet ? 1500 : 800)}

Elements (click by index):
${elementList || '(none found)'}`;

  // Kept so the exact prompt can be inspected from the widget without opening
  // the service worker console.
  const mode = isSimnet ? '  (simnet mode)' : isWorksheet ? '  (worksheet mode)' : isCanvas ? '  (canvas mode)' : '';
  const debugText = `model: ${model}${mode}\n\n${userContent}`;
  console.log(`[PageAgent]\n${debugText}`);
  chrome.storage.local.set({ lastPrompt: debugText });

  const requestBody = {
    model,
    // A fills array covering a whole worksheet needs far more room than a
    // single index does
    // One index per question adds up on a long quiz
    max_tokens: isWorksheet ? Math.max(cfg.maxTokens, 1500)
              : isCanvas    ? Math.max(cfg.maxTokens, 600)
              : cfg.maxTokens,
    system: SYSTEM_PROMPT + (isSimnet ? SIMNET_HINT : isWorksheet ? WORKSHEET_HINT : isCanvas ? CANVAS_HINT : ''),
    messages: [{ role: 'user', content: userContent }]
  };

  if (cfg.temperature) requestBody.temperature = 0;

  if (cfg.prefill) {
    // Seeding the reply mid-JSON makes prose structurally impossible
    requestBody.messages.push({ role: 'assistant', content: '{"action":"' });
  } else {
    // Prefill 400s on these models; constrain the response shape instead
    requestBody.output_config = { format: { type: 'json_schema', schema: ACTION_SCHEMA } };
    if (cfg.effort) requestBody.output_config.effort = cfg.effort;
  }

  const response = await postToApi(apiKey, requestBody);

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(apiErrorMessage(response.status, body));
  }

  let data;
  try {
    data = await response.json();
  } catch (_) {
    throw new Error('Claude sent back a reply that could not be read. Try again.');
  }
  // Find the text block specifically — thinking models emit other block types first
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
    throw new Error(`Claude returned invalid JSON: ${cleaned.slice(0, 300)}`);
  }

  if (!['click', 'clickMany', 'fill', 'dragMove', 'none'].includes(parsed.action)) {
    throw new Error(`Unexpected action: ${JSON.stringify(parsed.action)}`);
  }
  if (parsed.action === 'fill') {
    const ok = Array.isArray(parsed.fills)
      && parsed.fills.length > 0
      && parsed.fills.every(f => f && typeof f.index === 'number' && f.value != null);
    if (!ok) {
      throw new Error(`fill requires a non-empty fills array of {index,value}, got: ${JSON.stringify(parsed.fills)}`);
    }
  }
  if (parsed.action === 'click' && typeof parsed.index !== 'number') {
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

  return parsed;
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
async function typeText(tabId, text) {
  for (const ch of text) {
    const vk = virtualKey(ch);
    const base = { key: ch, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk };
    await chrome.debugger.sendCommand({ tabId }, 'Input.dispatchKeyEvent', {
      type: 'keyDown', text: ch, unmodifiedText: ch, ...base
    });
    await chrome.debugger.sendCommand({ tabId }, 'Input.dispatchKeyEvent', {
      type: 'keyUp', ...base
    });
    await new Promise(r => setTimeout(r, 25));
  }
}

// Spreadsheet cells (jQuery.sheet) have no input to set — the cell is selected
// by clicking it, then typed into. The click is left to the content script,
// which addresses the element directly; a debugger mouse click cannot be used
// here because its coordinates are relative to the top-level page while the
// sheet lives in an iframe, so it would land somewhere else and move the
// selection off the cell just chosen. Keystrokes are safe to send this way:
// they follow focus rather than coordinates.
async function typeIntoCell(tabId, frameId, index, value) {
  const focused = await sendToTab(tabId, { type: 'FOCUS_CELL', index }, frameId);
  if (!focused?.success) {
    return { success: false, error: focused?.error ?? `Could not open cell [${index}]` };
  }

  await attachDebugger(tabId);
  await typeText(tabId, String(value ?? ''));
  await new Promise(r => setTimeout(r, 60));
  await pressKey(tabId, 'enter');
  await new Promise(r => setTimeout(r, 160));
  return { success: true };
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

function rawSend(tabId, msg, frameId) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error('The page stopped responding. Refresh it and try again.'));
    }, MSG_TIMEOUT_MS);

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
        return { fields, choices, gridFields: gridFields + cells };
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
    let score = (r.gridFields >= 4 ? 1000 : 0) + r.fields * 10 + r.choices * 10;
    if (p.frameId === 0) score += 1;
    if (score > best.score) best = { frameId: p.frameId, score };
  }
  return best.frameId;
}

// Click / clickMany answer a question in a single call. Drag questions need
// several sequential moves, so the budget is raised only once a drag actually
// starts — multiple choice still costs exactly one API call.
const MAX_STEPS_SIMPLE = 1;
const MAX_STEPS_DRAG   = 8;
// Most tasks are 2-5 steps (select, open dialog, set, confirm). Kept tight
// because every step is a model call, and a long run risks the service worker
// being torn down before it finishes.
const MAX_STEPS_SIMNET = 6;

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

// Tells the control bar the run is still moving. Fire and forget: the bar
// lives in the top frame, may not exist at all (popup-driven runs), and a
// failure to report progress must never stop the run itself.
function reportProgress(tabId, step, budget) {
  try {
    chrome.tabs.sendMessage(tabId, { type: 'PROGRESS', step, budget }, { frameId: 0 }, () => {
      void chrome.runtime.lastError;   // read it so Chrome doesn't log it
    });
  } catch (_) { /* no listener — nothing to report to */ }
}

async function runGoal(apiKey, notes, tabId, postClicks = [], baseModel = DEFAULT_MODEL, autoUpgrade = true) {
  let usedModel = baseModel;   // reported back so the UI can show an upgrade

  // Resolve once per run: every scrape, click and fill must hit the same frame
  const frameId = await findQuestionFrame(tabId);

  cancelledRuns.delete(tabId);   // a fresh run clears any earlier stop

  let budget = MAX_STEPS_SIMPLE;
  let completed = 0;
  let isCanvas = false;
  let isSimnet = false;
  const history = [];   // what has been done so far on this question

  for (let step = 0; step < budget; step++) {
    if (cancelledRuns.has(tabId)) {
      cancelledRuns.delete(tabId);
      return { success: false, error: 'Stopped.', usedModel };
    }
    reportProgress(tabId, step + 1, budget);

    let lastError = 'Unknown error';
    let stepDone = false;
    let finished = false;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        const pageData = await sendToTab(tabId, { type: 'SCRAPE' }, frameId);
        if (!pageData || pageData.error) {
          throw new Error(pageData?.error ?? 'No response from content script');
        }

        // A simulated-Excel task is a procedure — switch tab, open dialog, set
        // arguments, confirm — so it needs room for several steps. Set from the
        // scrape rather than from the action, since the page says what it is
        // before the first move is chosen.
        if (pageData.isSimnet) { isSimnet = true; budget = MAX_STEPS_SIMNET; }
        // Choices in one reply, typed blanks in a second — only when there
        // are blanks, so a plain multiple-choice page costs one call.
        if (pageData.isCanvas) {
          isCanvas = true;
          budget = Math.max(budget, pageData.hasBlanks ? 2 : 1);
        }

        // The question prose often lives in the outer page while the answer
        // grid is inside the iframe, so pull both or the amounts to work from
        // would be missing entirely.
        let pageText = pageData.text;
        if (frameId !== 0) {
          try {
            const outer = await sendToTab(tabId, { type: 'SCRAPE' }, 0);
            if (outer?.text) pageText = `${outer.text}\n\n${pageText}`;
          } catch (_) { /* outer frame unreachable — use what we have */ }
        }

        usedModel = pickModel(baseModel, pageData, autoUpgrade);
        const action = await callClaude(apiKey, notes, pageText, pageData.elements, usedModel, !!pageData.isWorksheet, !!pageData.isSimnet, history, !!pageData.isCanvas);

        const bad = badIndexes(action, pageData.elements.length);
        if (bad.length) {
          throw new Error(`Referred to item ${bad.join(', ')}, which isn't on the page.`);
        }

        if (action.action === 'none') {
          // Before any action: nothing on screen is answerable.
          // After a move: the drag arrangement is complete.
          // Except on a Canvas page whose questions all have an answer already
          // — arriving back on one, say — where "none" means move on.
          const alreadyDone = isCanvas && everyQuestionAnswered(pageData.elements);
          if (completed === 0 && !alreadyDone) return { success: true, action, noAnswer: true, usedModel };
          finished = true;
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
            if (!r.success) missed.push(`[${f.index}]`);
          }
          if (missed.length === action.fills.length) {
            result = { success: false, error: `No cells could be filled: ${missed.join(', ')}` };
          } else if (missed.length) {
            result = { success: false, error: `Filled ${action.fills.length - missed.length}/${action.fills.length}; missed ${missed.join(', ')}` };
          }
        } else {
          result = await sendToTab(tabId, { type: 'EXECUTE', action }, frameId);
        }

        if (result?.success) {
          stepDone = true;
          completed++;
          history.push(actionSummary(action, pageData.elements));

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
        if (e.message.startsWith('Rate limit')) {
          return { success: false, error: lastError };
        }
      }

      if (attempt < MAX_RETRIES) {
        await new Promise(r => setTimeout(r, 400 * (attempt + 1)));
      }
    }

    if (!stepDone) {
      return { success: false, error: `Stuck on step ${step + 1}. Last error: ${lastError}` };
    }
    if (finished) break;
  }

  // SIMnet has no confidence rating or Next button of the Connect kind, and
  // going round again would start fiddling with a task that's already done.
  if (isSimnet) {
    return { success: true, usedModel, finished: 'Task done. Check it, then move to the next one.' };
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

  // Direct clicks (confidence button, next button) — no Claude needed
  for (const click of postClicks) {
    if (cancelledRuns.has(tabId)) {
      cancelledRuns.delete(tabId);
      return { success: false, error: 'Stopped.', usedModel };
    }
    const result = await sendToTab(tabId, {
      type: 'CLICK_TEXT',
      candidates: click.candidates,
      // An optional button that isn't there shouldn't cost the full wait
      ...(click.optional ? { timeoutMs: 2500 } : {})
    }, frameId);
    if (!result?.success) {
      if (click.optional) continue;
      return { success: false, error: `Could not find "${click.label}" button: ${result?.error ?? ''}` };
    }
    await new Promise(r => setTimeout(r, 400));
  }

  return { success: true, message: 'Done', usedModel };
}

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
             text: `Canvas quiz · ${n(questions, 'question')}, ${n(els.length, 'answer')} to pick from${where}` };
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
      model: 'claude-haiku-4-5', max_tokens: 1,
      messages: [{ role: 'user', content: 'Hi' }]
    });
    if (r.ok) return { ok: true, text: 'API key works' };
    return { ok: false, text: apiErrorMessage(r.status, await r.text().catch(() => '')) };
  } catch (e) {
    return { ok: false, text: e.message };
  }
}

async function checkPage(tabId) {
  const lines = [];
  const { apiKey, model } = await chrome.storage.local.get(['apiKey', 'model']).catch(() => ({}));

  const frameId = await findQuestionFrame(tabId);
  try {
    lines.push(describePage(await sendToTab(tabId, { type: 'SCRAPE' }, frameId), frameId));
  } catch (e) {
    lines.push({ ok: false, text: `Couldn't read this page: ${e.message}` });
  }

  lines.push(await checkKey(cleanKey(apiKey)));
  lines.push({ info: true, text: `Model: ${MODELS[model]?.label ?? MODELS[DEFAULT_MODEL].label}` });
  return { lines };
}

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

  if (msg.type === 'CHECK_PAGE') {
    const id = msg.tabId ?? sender.tab?.id;
    checkPage(id).then(sendResponse, e => sendResponse({ lines: [{ ok: false, text: e.message }] }));
    return true;
  }

  if (msg.type !== 'RUN_GOAL') return;

  (async () => {
    const { apiKey: rawKey, model: savedModel, autoUpgrade } =
      await chrome.storage.local.get(['apiKey', 'model', 'autoUpgrade']).catch(() => ({}));
    const baseModel = MODELS[savedModel] ? savedModel : DEFAULT_MODEL;
    const apiKey = cleanKey(rawKey);
    if (!apiKey) {
      sendResponse({ success: false, error: 'No API key saved. Enter it in the extension popup and click Save.' });
      return;
    }

    // Popup sends msg.tabId; floating widget (content script) uses sender.tab.id
    const tabId = msg.tabId ?? sender.tab?.id;
    if (!tabId) {
      sendResponse({ success: false, error: 'Could not determine tab ID.' });
      return;
    }

    let result;
    try {
      result = await runGoal(apiKey, msg.notes ?? '', tabId, msg.postClicks ?? [], baseModel, autoUpgrade !== false);
    } catch (e) {
      // Anything unexpected still has to come back as an answer. Without this
      // the reply never arrives and the widget sits on "Answering…" forever.
      result = { success: false, error: e?.message ?? String(e) };
    } finally {
      // Always release the tab so the "being debugged" banner doesn't linger
      try { await detachDebugger(tabId); } catch (_) {}
    }
    sendResponse(result);
  })();

  return true; // Keep message channel open for async sendResponse
});

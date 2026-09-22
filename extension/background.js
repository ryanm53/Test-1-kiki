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
  const hard = pageData?.isWorksheet || pageData?.isDrag;
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

async function callClaude(apiKey, notes, pageText, elements, refTexts = [], modelId = DEFAULT_MODEL, isWorksheet = false) {
  const model = MODELS[modelId] ? modelId : DEFAULT_MODEL;
  const cfg = MODELS[model];

  const elementList = elements
    .map((el, i) => {
      const parts = [`[${i}]`, el.tag];
      if (el.type) parts.push(`type="${el.type}"`);
      if (el.text) parts.push(`"${el.text.slice(0, 80)}"`);
      if (el.placeholder) parts.push(`placeholder="${el.placeholder}"`);
      if (el.name) parts.push(`name="${el.name}"`);
      if (el.question) parts.push(`(question: "${el.question.slice(0, 120)}")`);
      return parts.join(' ');
    })
    .join('\n');

  const refSection = refTexts.length
    ? '\n\nReference material from your designated tabs:\n' +
      refTexts.map(r => `--- ${r.url} ---\n${r.text}`).join('\n\n')
    : '';

  // Optional user context (subject, conventions, hints) — omitted when blank
  const notesSection = notes ? `Notes from the user: ${notes}\n\n` : '';

  const userContent = `${notesSection}Page text:
${pageText.slice(0, isWorksheet ? 3000 : 800)}${refSection}

Elements (click by index):
${elementList || '(none found)'}`;

  const requestBody = {
    model,
    // A fills array covering a whole worksheet needs far more room than a
    // single index does
    max_tokens: isWorksheet ? Math.max(cfg.maxTokens, 1500) : cfg.maxTokens,
    system: isWorksheet ? SYSTEM_PROMPT + WORKSHEET_HINT : SYSTEM_PROMPT,
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

  if (!response.ok) {
    const body = await response.text();
    if (response.status === 429) {
      throw new Error('Rate limit hit — wait about a minute and try again.');
    }
    throw new Error(`Claude API ${response.status}: ${body.slice(0, 300)}`);
  }

  const data = await response.json();
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

// Find open tabs matching the saved reference URLs and scrape their text.
// Matches by checking if a tab's URL starts with the stored URL string,
// so "https://example.com/chapter1" matches that page and any sub-path.
async function getReferenceContent(refUrls) {
  if (!refUrls || refUrls.length === 0) return [];

  const allTabs = await chrome.tabs.query({});
  const results = [];

  for (const refUrl of refUrls) {
    const match = allTabs.find(t => t.url && t.url.startsWith(refUrl));
    if (!match) continue;
    try {
      const data = await sendToTab(match.id, { type: 'SCRAPE' });
      if (data?.text) {
        results.push({ url: match.url, text: data.text.slice(0, 2000) });
      }
    } catch (_) {
      // Tab might not have content script (e.g. chrome:// page) — skip silently
    }
  }

  return results;
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

// Spreadsheet cells (jQuery.sheet) have no input to set — you click the cell
// and type. Synthetic events don't reliably open the editor, so click and type
// for real, then commit with Enter.
async function typeIntoCell(tabId, frameId, index, value) {
  const focused = await sendToTab(tabId, { type: 'FOCUS_CELL', index }, frameId);
  if (!focused?.success) {
    return { success: false, error: focused?.error ?? `Could not open cell [${index}]` };
  }

  await attachDebugger(tabId);

  // A real click at the cell's coordinates, in case the synthetic one above
  // wasn't enough to put the sheet into edit mode
  if (typeof focused.x === 'number') {
    const pt = { x: focused.x, y: focused.y, button: 'left', clickCount: 1 };
    await chrome.debugger.sendCommand({ tabId }, 'Input.dispatchMouseEvent', { type: 'mousePressed', ...pt });
    await chrome.debugger.sendCommand({ tabId }, 'Input.dispatchMouseEvent', { type: 'mouseReleased', ...pt });
    await new Promise(r => setTimeout(r, 120));
  }

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

function sendToTab(tabId, msg, frameId = 0) {
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, msg, { frameId }, response => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else {
        resolve(response);
      }
    });
  });
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

async function runGoal(apiKey, notes, tabId, refUrls = [], postClicks = [], baseModel = DEFAULT_MODEL, autoUpgrade = true) {
  const refTexts = await getReferenceContent(refUrls);
  let usedModel = baseModel;   // reported back so the UI can show an upgrade

  // Resolve once per run: every scrape, click and fill must hit the same frame
  const frameId = await findQuestionFrame(tabId);

  let budget = MAX_STEPS_SIMPLE;
  let completed = 0;

  for (let step = 0; step < budget; step++) {
    let lastError = 'Unknown error';
    let stepDone = false;
    let finished = false;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        const pageData = await sendToTab(tabId, { type: 'SCRAPE' }, frameId);
        if (!pageData || pageData.error) {
          throw new Error(pageData?.error ?? 'No response from content script');
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
        const action = await callClaude(apiKey, notes, pageText, pageData.elements, refTexts, usedModel, !!pageData.isWorksheet);

        if (action.action === 'none') {
          // Before any action: nothing on screen is answerable.
          // After a move: the drag arrangement is complete.
          if (completed === 0) return { success: true, action, noAnswer: true, usedModel };
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

  // Direct clicks (confidence button, next button) — no Claude needed
  for (const click of postClicks) {
    const result = await sendToTab(tabId, { type: 'CLICK_TEXT', candidates: click.candidates }, frameId);
    if (!result?.success) {
      return { success: false, error: `Could not find "${click.label}" button: ${result?.error ?? ''}` };
    }
    await new Promise(r => setTimeout(r, 400));
  }

  return { success: true, message: 'Done', usedModel };
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type !== 'RUN_GOAL') return;

  (async () => {
    const { apiKey: rawKey, model: savedModel, autoUpgrade } =
      await chrome.storage.local.get(['apiKey', 'model', 'autoUpgrade']);
    const baseModel = MODELS[savedModel] ? savedModel : DEFAULT_MODEL;
    const apiKey = rawKey ? rawKey.replace(/[^\x20-\x7E]/g, '').trim() : '';
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

    // Popup sends refUrls; floating widget loads them from storage
    const refUrls = msg.refUrls
      ?? (await chrome.storage.local.get('refUrls')).refUrls
      ?? [];

    let result;
    try {
      result = await runGoal(apiKey, msg.notes ?? '', tabId, refUrls, msg.postClicks ?? [], baseModel, autoUpgrade !== false);
    } finally {
      // Always release the tab so the "being debugged" banner doesn't linger
      await detachDebugger(tabId);
    }
    sendResponse(result);
  })();

  return true; // Keep message channel open for async sendResponse
});

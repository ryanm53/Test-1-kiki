const CLAUDE_MODEL = 'claude-haiku-4-5-20251001';
const MAX_RETRIES = 1;

const SYSTEM_PROMPT = `You are a browser automation assistant. You will be given:
1. A user goal
2. The visible text of the current web page (truncated)
3. A numbered list of interactive elements visible on screen right now
4. (Optional) Reference material scraped from tabs the user designated as sources — use this to answer questions correctly

Decide the single best next action to take to progress toward the goal.

YOUR ENTIRE RESPONSE MUST BE A SINGLE JSON OBJECT — no words before it, no words after it, no markdown, no explanation, no analysis. Just the raw JSON.

{"action":"click"|"fill"|"drag"|"none","index":<int|null>,"sourceIndex":<int|null>,"targetIndex":<int|null>,"value":<string|null>,"reasoning":<string>}

Rules:
- "action" must be exactly "click", "fill", "drag", or "none"
- For click or fill: set "index" to the element number; sourceIndex and targetIndex must be null
- For drag: set "sourceIndex" (element to grab) and "targetIndex" (drop destination); index must be null
- "value" is the string to type for fill; null otherwise
- "reasoning" is one short sentence explaining your choice — keep it SHORT (under 12 words)
- NEVER invent an index not in the provided list
- Use "none" if the goal is already met or no valid action exists`;

async function callClaude(apiKey, goal, pageText, elements, refTexts = []) {
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

  const userContent = `Goal: ${goal}

Page text (truncated to 3000 chars):
${pageText.slice(0, 3000)}${refSection}

Interactive elements visible on screen (use the bracketed index):
${elementList || '(none found)'}`;

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true'
    },
    body: JSON.stringify({
      model: CLAUDE_MODEL,
      max_tokens: 256,
      temperature: 0,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userContent }]
    })
  });

  if (!response.ok) {
    const body = await response.text();
    if (response.status === 429) {
      throw new Error('Rate limit hit — wait about a minute and try again.');
    }
    throw new Error(`Claude API ${response.status}: ${body.slice(0, 300)}`);
  }

  const data = await response.json();
  const raw = data.content?.[0]?.text ?? '';

  const cleaned = raw
    .replace(/^```(?:json)?\s*/im, '')
    .replace(/\s*```\s*$/im, '')
    .trim();

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

  // Validate shape
  if (!['click', 'fill', 'drag', 'none'].includes(parsed.action)) {
    throw new Error(`Unexpected action value: ${JSON.stringify(parsed.action)}`);
  }
  if (parsed.action === 'drag') {
    if (typeof parsed.sourceIndex !== 'number' || typeof parsed.targetIndex !== 'number') {
      throw new Error('Drag action requires numeric sourceIndex and targetIndex');
    }
  } else if (parsed.action !== 'none') {
    if (typeof parsed.index !== 'number') {
      throw new Error(`Action "${parsed.action}" requires a numeric index, got: ${JSON.stringify(parsed.index)}`);
    }
  }
  if (parsed.action === 'fill' && parsed.value == null) {
    throw new Error('Fill action requires a non-null value');
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

function sendToTab(tabId, msg) {
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, msg, response => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else {
        resolve(response);
      }
    });
  });
}

const MAX_STEPS = 1; // Claude picks the answer; postClicks handle confidence + next directly

async function runGoal(apiKey, goal, tabId, refUrls = [], postClicks = []) {
  const refTexts = await getReferenceContent(refUrls);

  // Claude handles the answer selection
  for (let step = 0; step < MAX_STEPS; step++) {
    let lastError = 'Unknown error';
    let stepDone = false;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        const pageData = await sendToTab(tabId, { type: 'SCRAPE' });
        if (!pageData || pageData.error) {
          throw new Error(pageData?.error ?? 'No response from content script');
        }

        const action = await callClaude(apiKey, goal, pageData.text, pageData.elements, refTexts);

        if (action.action === 'none') {
          return { success: true, action, message: action.reasoning };
        }

        const result = await sendToTab(tabId, { type: 'EXECUTE', action });

        if (result?.success) {
          stepDone = true;
          await new Promise(r => setTimeout(r, 900));
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
  }

  // Direct clicks (confidence button, next button) — no Claude needed
  for (const click of postClicks) {
    const result = await sendToTab(tabId, { type: 'CLICK_TEXT', candidates: click.candidates });
    if (!result?.success) {
      return { success: false, error: `Could not find "${click.label}" button: ${result?.error ?? ''}` };
    }
    await new Promise(r => setTimeout(r, 400));
  }

  return { success: true, message: 'Done' };
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type !== 'RUN_GOAL') return;

  (async () => {
    const { apiKey: rawKey } = await chrome.storage.local.get('apiKey');
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

    const result = await runGoal(apiKey, msg.goal, tabId, refUrls, msg.postClicks ?? []);
    sendResponse(result);
  })();

  return true; // Keep message channel open for async sendResponse
});

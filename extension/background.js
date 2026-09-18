const CLAUDE_MODEL = 'claude-sonnet-4-6';
const MAX_RETRIES = 2;

const SYSTEM_PROMPT = `You are a browser automation assistant. You will be given:
1. A user goal
2. The visible text of the current web page (truncated)
3. A numbered list of interactive elements visible on screen right now

Decide the single best next action to take to progress toward the goal.

Respond with ONLY valid JSON — no markdown fences, no explanation, nothing else:
{"action":"click"|"fill"|"none","index":<integer or null>,"value":<string or null>,"reasoning":<string>}

Rules:
- "action" must be exactly "click", "fill", or "none"
- "index" must be an integer from the element list (0-based), or null when action is "none"
- "value" is the text to type for "fill" actions; null otherwise
- "reasoning" is one short sentence explaining your choice
- NEVER invent an index that is not in the provided list
- Use "none" if the goal is already met or no valid action exists`;

async function callClaude(apiKey, goal, pageText, elements) {
  const elementList = elements
    .map((el, i) => {
      const parts = [`[${i}]`, el.tag];
      if (el.type) parts.push(`type="${el.type}"`);
      if (el.text) parts.push(`"${el.text.slice(0, 80)}"`);
      if (el.placeholder) parts.push(`placeholder="${el.placeholder}"`);
      if (el.name) parts.push(`name="${el.name}"`);
      return parts.join(' ');
    })
    .join('\n');

  const userContent = `Goal: ${goal}

Page text (truncated to 3000 chars):
${pageText.slice(0, 3000)}

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
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userContent }]
    })
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Claude API ${response.status}: ${body.slice(0, 300)}`);
  }

  const data = await response.json();
  const raw = data.content?.[0]?.text ?? '';

  // Strip any markdown code fences Claude might add despite instructions
  const cleaned = raw
    .replace(/^```(?:json)?\s*/im, '')
    .replace(/\s*```\s*$/im, '')
    .trim();

  let parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch (_) {
    throw new Error(`Claude returned invalid JSON: ${cleaned.slice(0, 300)}`);
  }

  // Validate shape
  if (!['click', 'fill', 'none'].includes(parsed.action)) {
    throw new Error(`Unexpected action value: ${JSON.stringify(parsed.action)}`);
  }
  if (parsed.action !== 'none' && typeof parsed.index !== 'number') {
    throw new Error(`Action "${parsed.action}" requires a numeric index, got: ${JSON.stringify(parsed.index)}`);
  }
  if (parsed.action === 'fill' && parsed.value == null) {
    throw new Error('Fill action requires a non-null value');
  }

  return parsed;
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

async function runGoal(apiKey, goal, tabId) {
  let lastError = 'Unknown error';

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      // Re-scrape on every attempt so Claude always sees current DOM state
      const pageData = await sendToTab(tabId, { type: 'SCRAPE' });
      if (!pageData || pageData.error) {
        throw new Error(pageData?.error ?? 'No response from content script');
      }

      const action = await callClaude(apiKey, goal, pageData.text, pageData.elements);

      if (action.action === 'none') {
        return { success: true, action, message: action.reasoning };
      }

      const result = await sendToTab(tabId, { type: 'EXECUTE', action });

      if (result?.success) {
        return { success: true, action, message: action.reasoning };
      }

      lastError = result?.error ?? 'Execution returned failure without an error message';
    } catch (e) {
      lastError = e.message;
    }

    if (attempt < MAX_RETRIES) {
      // Back-off between retries
      await new Promise(r => setTimeout(r, 700 * (attempt + 1)));
    }
  }

  return {
    success: false,
    error: `Failed after ${MAX_RETRIES + 1} attempt${MAX_RETRIES > 0 ? 's' : ''}. Last error: ${lastError}`
  };
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type !== 'RUN_GOAL') return;

  (async () => {
    const { apiKey } = await chrome.storage.local.get('apiKey');
    if (!apiKey) {
      sendResponse({ success: false, error: 'No API key saved. Enter it in the popup and click Save.' });
      return;
    }
    const result = await runGoal(apiKey, msg.goal, msg.tabId);
    sendResponse(result);
  })();

  return true; // Keep message channel open for async sendResponse
});

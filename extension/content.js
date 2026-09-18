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
  '[contenteditable="true"]'
].join(', ');

// Cached element list from the last scrape — execute() uses these references
// so it operates on exactly the elements Claude was shown.
let _lastElements = [];

function isVisible(el) {
  const rect = el.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0) return false;
  if (rect.bottom < 0 || rect.top > window.innerHeight) return false;
  if (rect.right < 0 || rect.left > window.innerWidth) return false;
  const style = window.getComputedStyle(el);
  return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
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

function describeEl(el) {
  const question = nearestQuestionText(el);
  return {
    tag: el.tagName.toLowerCase(),
    type: el.getAttribute('type') || null,
    text: accessibleText(el).slice(0, 100),
    placeholder: el.getAttribute('placeholder') || null,
    name: el.getAttribute('name') || null,
    question: question || null
  };
}

function scrape() {
  // Prefer the main content area to skip nav/header/footer noise
  const root = document.querySelector('[role="main"], main, article, form')
             ?? document.body;

  const all = Array.from(document.querySelectorAll(INTERACTIVE_SEL));
  _lastElements = all.filter(isVisible).slice(0, 100);

  return {
    text: (root.innerText ?? '').slice(0, 5000),
    elements: _lastElements.map(describeEl)
  };
}

async function execute(action) {
  const { index } = action;

  if (typeof index !== 'number' || index < 0 || index >= _lastElements.length) {
    return {
      success: false,
      error: `Index ${index} is out of range (list has ${_lastElements.length} elements). Did you call scrape first?`
    };
  }

  const el = _lastElements[index];

  if (!document.contains(el)) {
    return { success: false, error: `Element [${index}] is no longer in the DOM` };
  }

  // Scroll into view and give the browser a moment to settle
  el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  await new Promise(r => setTimeout(r, 400));

  try {
    if (action.action === 'click') {
      el.focus();
      el.click();
      return { success: true };
    }

    if (action.action === 'fill') {
      if (action.value == null) {
        return { success: false, error: 'Fill action missing value' };
      }

      el.focus();

      const tag = el.tagName.toLowerCase();

      if (tag === 'select') {
        el.value = action.value;
        el.dispatchEvent(new Event('change', { bubbles: true }));
      } else {
        // Use the native prototype setter so React/Vue/Angular frameworks detect the change.
        // (Frameworks override the property; calling the prototype setter bypasses the override
        // and triggers their internal reconciliation when the synthetic event fires.)
        const proto = tag === 'textarea'
          ? window.HTMLTextAreaElement.prototype
          : window.HTMLInputElement.prototype;
        const nativeSetter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
        if (nativeSetter) {
          nativeSetter.call(el, action.value);
        } else {
          el.value = action.value;
        }
        el.dispatchEvent(new InputEvent('input', { bubbles: true, data: action.value }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      }

      return { success: true };
    }

    return { success: false, error: `Unknown action type: ${action.action}` };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

// ── Floating widget ──────────────────────────────────────────────────────────

(function injectWidget() {
  if (document.getElementById('__cap-host')) return;

  const host = document.createElement('div');
  host.id = '__cap-host';
  // Position the host; all actual UI lives inside shadow DOM
  host.style.cssText = 'position:fixed;bottom:24px;right:24px;z-index:2147483647;';

  const shadow = host.attachShadow({ mode: 'open' });

  shadow.innerHTML = `
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

  #fab {
    width: 46px; height: 46px;
    background: linear-gradient(135deg, #38BDF8, #0284C7);
    color: #fff;
    border-radius: 50%;
    display: flex; align-items: center; justify-content: center;
    cursor: pointer;
    font-size: 18px;
    font-family: sans-serif;
    box-shadow: 0 2px 14px rgba(56,189,248,0.4);
    user-select: none;
    transition: transform 0.15s, opacity 0.15s;
  }
  #fab:hover { opacity: 0.88; transform: scale(1.07); }
  #fab.running { opacity: 0.7; animation: pulse 1s infinite; }
  @keyframes pulse { 0%,100% { opacity:1; } 50% { opacity:0.6; } }

  #panel {
    position: absolute; bottom: 54px; right: 0;
    width: 270px;
    background: #0f0f10;
    border: 1px solid #2e2e32;
    border-radius: 10px;
    padding: 14px 14px 12px;
    box-shadow: 0 4px 24px rgba(0,0,0,0.55);
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
  }
  #panel.hidden { display: none; }

  #closeBtn {
    position: absolute; top: 9px; right: 11px;
    background: none; border: none; color: #555;
    cursor: pointer; font-size: 17px; line-height: 1;
  }
  #closeBtn:hover { color: #aaa; }

  h3 {
    font-size: 11px; font-weight: 600; color: #a78bfa;
    text-transform: uppercase; letter-spacing: 0.06em;
    margin-bottom: 10px;
  }

  textarea {
    width: 100%; background: #1a1a1d; border: 1px solid #2e2e32;
    border-radius: 6px; color: #e2e2e2; font-size: 12px;
    padding: 7px 9px; outline: none; resize: vertical;
    min-height: 54px; font-family: inherit;
  }
  textarea:focus { border-color: #38BDF8; }

  #runBtn {
    width: 100%; margin-top: 8px; padding: 8px;
    background: linear-gradient(135deg, #38BDF8, #0284C7); color: #fff; border: none;
    border-radius: 6px; cursor: pointer; font-size: 13px;
    font-weight: 500; font-family: inherit;
    transition: opacity 0.15s;
    box-shadow: 0 1px 8px rgba(56,189,248,0.3);
  }
  #runBtn:hover:not(:disabled) { opacity: 0.88; }
  #runBtn:disabled { background: #25252a; color: #555; cursor: default; }

  #status {
    display: none; margin-top: 8px; font-size: 11px; line-height: 1.5;
    padding: 7px 9px; border-radius: 6px; word-break: break-word;
  }
  #status.running { background: rgba(56,189,248,0.08); color: #7DD3FC; border: 1px solid rgba(56,189,248,0.2); }
  #status.success { background: #0a1f12; color: #4ade80; border: 1px solid #14532d; }

  #stuckOverlay {
    display: none; position: absolute; inset: 0;
    background: rgba(0,0,0,0.72); border-radius: 10px;
    align-items: center; justify-content: center;
  }
  #stuckOverlay.visible { display: flex; }
  #stuckBox {
    background: #1a1a1d; border: 1px solid #7f1d1d;
    border-radius: 8px; padding: 16px 14px; text-align: center; width: 220px;
  }
  #stuckTitle { font-size: 13px; color: #f87171; font-weight: 600; margin-bottom: 6px; }
  #stuckMsg { font-size: 11px; color: #888; margin-bottom: 12px; line-height: 1.4; word-break: break-word; }
  #stuckOk {
    background: linear-gradient(135deg, #38BDF8, #0284C7); color: #fff; border: none;
    border-radius: 6px; padding: 6px 22px;
    cursor: pointer; font-size: 12px; font-family: inherit;
    box-shadow: 0 1px 8px rgba(56,189,248,0.3);
  }
  #stuckOk:hover { opacity: 0.88; }
</style>

<div id="fab" title="Claude Page Agent">⚡</div>

<div id="panel" class="hidden">
  <button id="closeBtn">×</button>
  <h3>Claude Page Agent</h3>
  <textarea id="goal" rows="3" placeholder='e.g. "click the login button"'></textarea>
  <button id="runBtn">Run</button>
  <div id="status"></div>
  <div id="stuckOverlay">
    <div id="stuckBox">
      <div id="stuckTitle">Got stuck</div>
      <div id="stuckMsg"></div>
      <button id="stuckOk">OK</button>
    </div>
  </div>
</div>
  `;

  const fab          = shadow.getElementById('fab');
  const panel        = shadow.getElementById('panel');
  const closeBtn     = shadow.getElementById('closeBtn');
  const goalInput    = shadow.getElementById('goal');
  const runBtn       = shadow.getElementById('runBtn');
  const statusDiv    = shadow.getElementById('status');
  const stuckOverlay = shadow.getElementById('stuckOverlay');
  const stuckMsg     = shadow.getElementById('stuckMsg');
  const stuckOk      = shadow.getElementById('stuckOk');

  // Restore last-used goal
  chrome.storage.local.get('lastGoal', ({ lastGoal }) => {
    if (lastGoal) goalInput.value = lastGoal;
  });

  fab.addEventListener('click', () => panel.classList.toggle('hidden'));
  closeBtn.addEventListener('click', () => panel.classList.add('hidden'));
  stuckOk.addEventListener('click', () => {
    stuckOverlay.classList.remove('visible');
  });
  goalInput.addEventListener('keydown', e => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) runBtn.click();
  });

  runBtn.addEventListener('click', () => {
    const goal = goalInput.value.trim();
    if (!goal) return;

    chrome.storage.local.set({ lastGoal: goal });
    setRunning(true);
    showStatus('running', 'Consulting Claude…');

    // No tabId needed — background uses sender.tab.id for content script messages
    chrome.runtime.sendMessage({ type: 'RUN_GOAL', goal }, result => {
      setRunning(false);
      if (chrome.runtime.lastError || !result) {
        showStuck(chrome.runtime.lastError?.message ?? 'No response from background.');
        return;
      }
      if (result.success) {
        showStatus('success', result.action?.reasoning ?? 'Done.');
      } else {
        showStuck(result.error ?? 'Unknown error.');
      }
    });
  });

  function setRunning(on) {
    runBtn.disabled = on;
    runBtn.textContent = on ? 'Running…' : 'Run';
    fab.classList.toggle('running', on);
  }

  function showStatus(type, text) {
    statusDiv.style.display = 'block';
    statusDiv.className = type;
    statusDiv.textContent = text;
  }

  function showStuck(msg) {
    setRunning(false);
    statusDiv.style.display = 'none';
    stuckMsg.textContent = msg;
    stuckOverlay.classList.add('visible');
  }

  document.body.appendChild(host);
})();

// ── Message listener ─────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
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
    return true; // Keep channel open for async response
  }
});

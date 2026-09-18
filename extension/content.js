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
  try {
    // ── Drag ───────────────────────────────────────────────────────────────
    if (action.action === 'drag') {
      const { sourceIndex, targetIndex } = action;
      if (typeof sourceIndex !== 'number' || sourceIndex < 0 || sourceIndex >= _lastElements.length)
        return { success: false, error: `Source index ${sourceIndex} out of range` };
      if (typeof targetIndex !== 'number' || targetIndex < 0 || targetIndex >= _lastElements.length)
        return { success: false, error: `Target index ${targetIndex} out of range` };

      const src = _lastElements[sourceIndex];
      const tgt = _lastElements[targetIndex];
      if (!document.contains(src)) return { success: false, error: 'Source element not in DOM' };
      if (!document.contains(tgt)) return { success: false, error: 'Target element not in DOM' };

      src.scrollIntoView({ behavior: 'smooth', block: 'center' });
      await new Promise(r => setTimeout(r, 150));

      const sr = src.getBoundingClientRect(), tr = tgt.getBoundingClientRect();
      const sx = sr.left + sr.width / 2, sy = sr.top + sr.height / 2;
      const tx = tr.left + tr.width / 2, ty = tr.top + tr.height / 2;
      const dt = new DataTransfer();

      // HTML5 drag events (for native drag APIs)
      src.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: dt, clientX: sx, clientY: sy }));
      await new Promise(r => setTimeout(r, 60));
      tgt.dispatchEvent(new DragEvent('dragenter', { bubbles: true, cancelable: true, dataTransfer: dt, clientX: tx, clientY: ty }));
      tgt.dispatchEvent(new DragEvent('dragover',  { bubbles: true, cancelable: true, dataTransfer: dt, clientX: tx, clientY: ty }));
      await new Promise(r => setTimeout(r, 60));
      tgt.dispatchEvent(new DragEvent('drop',      { bubbles: true, cancelable: true, dataTransfer: dt, clientX: tx, clientY: ty }));
      src.dispatchEvent(new DragEvent('dragend',   { bubbles: true, cancelable: true, dataTransfer: dt, clientX: tx, clientY: ty }));

      // Pointer + mouse events (for React DnD, Sortable.js, etc.)
      await new Promise(r => setTimeout(r, 40));
      src.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, isPrimary: true, clientX: sx, clientY: sy }));
      src.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, buttons: 1, clientX: sx, clientY: sy }));
      await new Promise(r => setTimeout(r, 40));
      document.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, isPrimary: true, clientX: tx, clientY: ty }));
      document.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, buttons: 1, clientX: tx, clientY: ty }));
      tgt.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, cancelable: true, isPrimary: true, clientX: tx, clientY: ty }));
      tgt.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, clientX: tx, clientY: ty }));

      return { success: true };
    }

    // ── Click / Fill ───────────────────────────────────────────────────────
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

    if (action.action === 'click') {
      el.focus();
      el.click();
      return { success: true };
    }

    if (action.action === 'fill') {
      if (action.value == null) return { success: false, error: 'Fill action missing value' };
      el.focus();
      const tag = el.tagName.toLowerCase();
      if (tag === 'select') {
        const opt = Array.from(el.options).find(
          o => o.textContent.trim() === action.value || o.value === action.value
        );
        if (opt) el.value = opt.value; else el.value = action.value;
        el.dispatchEvent(new Event('change', { bubbles: true }));
      } else {
        const proto = tag === 'textarea'
          ? window.HTMLTextAreaElement.prototype
          : window.HTMLInputElement.prototype;
        const nativeSetter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
        if (nativeSetter) nativeSetter.call(el, action.value); else el.value = action.value;
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
  host.style.cssText = 'position:fixed;bottom:24px;right:24px;z-index:2147483647;';

  const shadow = host.attachShadow({ mode: 'open' });

  shadow.innerHTML = `
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

  /* Button cluster: edit pencil + FAB side by side */
  #btnRow {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: 8px;
  }

  #fab {
    width: 46px; height: 46px;
    background: linear-gradient(135deg, #38BDF8, #0284C7);
    color: #fff;
    border-radius: 50%;
    border: none;
    display: flex; align-items: center; justify-content: center;
    cursor: pointer;
    font-size: 18px;
    font-family: sans-serif;
    box-shadow: 0 2px 14px rgba(56,189,248,0.4);
    user-select: none;
    transition: transform 0.15s, opacity 0.15s;
    flex-shrink: 0;
  }
  #fab:hover { opacity: 0.88; transform: scale(1.07); }
  #fab.running { opacity: 0.7; animation: pulse 1s infinite; cursor: default; }
  @keyframes pulse { 0%,100% { opacity:1; } 50% { opacity:0.6; } }

  #editBtn {
    width: 30px; height: 30px;
    background: #1e1e22;
    border: 1px solid #2e2e32;
    border-radius: 50%;
    color: rgba(235,235,245,0.45);
    font-size: 13px;
    display: flex; align-items: center; justify-content: center;
    cursor: pointer;
    box-shadow: 0 1px 6px rgba(0,0,0,0.4);
    transition: color 0.15s, background 0.15s;
    flex-shrink: 0;
  }
  #editBtn:hover { color: #38BDF8; background: #25252a; }
  #editBtn.active { color: #38BDF8; border-color: rgba(56,189,248,0.4); }

  /* Toast above the button row */
  #toast {
    position: absolute;
    bottom: 58px; right: 0;
    max-width: 240px;
    padding: 8px 12px;
    border-radius: 9px;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    font-size: 12px; line-height: 1.45;
    word-break: break-word;
    pointer-events: none;
    opacity: 0;
    transform: translateY(4px);
    transition: opacity 0.2s, transform 0.2s;
  }
  #toast.show { opacity: 1; transform: translateY(0); pointer-events: auto; }
  #toast.running { background: rgba(56,189,248,0.12); color: #7DD3FC; border: 1px solid rgba(56,189,248,0.25); }
  #toast.success { background: #0a1f12; color: #4ade80; border: 1px solid #14532d; }

  /* Goal editor panel */
  #panel {
    position: absolute; bottom: 58px; right: 0;
    width: 255px;
    background: #0f0f10;
    border: 1px solid #2e2e32;
    border-radius: 10px;
    padding: 13px 13px 11px;
    box-shadow: 0 4px 24px rgba(0,0,0,0.55);
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
  }
  #panel.hidden { display: none; }

  #panelLabel {
    font-size: 10px; font-weight: 600; color: rgba(235,235,245,0.35);
    text-transform: uppercase; letter-spacing: 0.07em;
    margin-bottom: 7px;
  }

  textarea {
    width: 100%; background: #1a1a1d; border: 1px solid #2e2e32;
    border-radius: 6px; color: #e2e2e2; font-size: 12px;
    padding: 7px 9px; outline: none; resize: vertical;
    min-height: 54px; font-family: inherit;
  }
  textarea:focus { border-color: #38BDF8; }

  #saveGoalBtn {
    width: 100%; margin-top: 8px; padding: 7px;
    background: linear-gradient(135deg, #38BDF8, #0284C7); color: #fff; border: none;
    border-radius: 6px; cursor: pointer; font-size: 12px;
    font-weight: 500; font-family: inherit;
    transition: opacity 0.15s;
    box-shadow: 0 1px 8px rgba(56,189,248,0.3);
  }
  #saveGoalBtn:hover { opacity: 0.88; }

  /* Stuck overlay inside the toast area — full-screen overlay anchored to host */
  #stuckOverlay {
    display: none; position: fixed; inset: 0;
    background: rgba(0,0,0,0.6);
    z-index: 2147483647;
    align-items: center; justify-content: center;
  }
  #stuckOverlay.visible { display: flex; }
  #stuckBox {
    background: #1a1a1d; border: 1px solid #7f1d1d;
    border-radius: 12px; padding: 20px 18px; text-align: center; width: 250px;
    box-shadow: 0 8px 40px rgba(0,0,0,0.6);
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
  }
  #stuckIcon { font-size: 28px; margin-bottom: 8px; }
  #stuckTitle { font-size: 14px; color: #f87171; font-weight: 600; margin-bottom: 6px; }
  #stuckMsg { font-size: 11.5px; color: #888; margin-bottom: 14px; line-height: 1.45; word-break: break-word; }
  #stuckOk {
    background: linear-gradient(135deg, #38BDF8, #0284C7); color: #fff; border: none;
    border-radius: 8px; padding: 8px 26px;
    cursor: pointer; font-size: 13px; font-weight: 500; font-family: inherit;
    box-shadow: 0 1px 8px rgba(56,189,248,0.3);
    transition: opacity 0.15s;
  }
  #stuckOk:hover { opacity: 0.88; }

  /* Answer result panel */
  #result {
    position: absolute;
    bottom: 58px; right: 0;
    width: 255px;
    background: #071a0e;
    border: 1px solid rgba(74,222,128,0.22);
    border-radius: 10px;
    padding: 11px 28px 11px 13px;
    box-shadow: 0 4px 24px rgba(0,0,0,0.55);
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
  }
  #result.hidden { display: none; }
  #resultClose {
    position: absolute; top: 7px; right: 9px;
    background: none; border: none;
    color: rgba(235,235,245,0.22); font-size: 15px;
    cursor: pointer; padding: 2px 4px; line-height: 1;
    font-family: sans-serif;
  }
  #resultClose:hover { color: rgba(235,235,245,0.55); }
  #resultAnswer {
    font-size: 14px; font-weight: 600;
    color: #4ade80; line-height: 1.35;
    margin-bottom: 4px;
  }
  #resultReason {
    font-size: 11px;
    color: rgba(235,235,245,0.38);
    line-height: 1.45;
  }
</style>

<div id="toast"></div>

<div id="panel" class="hidden">
  <div id="panelLabel">Saved Goal</div>
  <textarea id="goalInput" rows="3" placeholder='e.g. "answer the question and click High confidence"'></textarea>
  <button id="saveGoalBtn">Save Goal</button>
</div>

<div id="result" class="hidden">
  <button id="resultClose">×</button>
  <div id="resultAnswer"></div>
  <div id="resultReason"></div>
</div>

<div id="btnRow">
  <button id="editBtn" title="Edit saved goal">✎</button>
  <button id="fab" title="Run saved goal">⚡</button>
</div>

<div id="stuckOverlay">
  <div id="stuckBox">
    <div id="stuckIcon">⚠️</div>
    <div id="stuckTitle">Got stuck</div>
    <div id="stuckMsg"></div>
    <button id="stuckOk">OK</button>
  </div>
</div>
  `;

  const fab          = shadow.getElementById('fab');
  const editBtn      = shadow.getElementById('editBtn');
  const panel        = shadow.getElementById('panel');
  const goalInput    = shadow.getElementById('goalInput');
  const saveGoalBtn  = shadow.getElementById('saveGoalBtn');
  const toast        = shadow.getElementById('toast');
  const stuckOverlay = shadow.getElementById('stuckOverlay');
  const stuckMsg     = shadow.getElementById('stuckMsg');
  const stuckOk      = shadow.getElementById('stuckOk');
  const resultPanel  = shadow.getElementById('result');
  const resultAnswer = shadow.getElementById('resultAnswer');
  const resultReason = shadow.getElementById('resultReason');
  const resultClose  = shadow.getElementById('resultClose');

  let toastTimer  = null;
  let resultTimer = null;
  let isRunning   = false;
  let savedGoal   = '';

  // Load saved goal on init
  chrome.storage.local.get('lastGoal', ({ lastGoal }) => {
    if (lastGoal) {
      savedGoal = lastGoal;
      goalInput.value = lastGoal;
    }
  });

  // Toggle goal editor panel
  editBtn.addEventListener('click', () => {
    const hidden = panel.classList.toggle('hidden');
    editBtn.classList.toggle('active', !hidden);
    if (!hidden) goalInput.focus();
  });

  // Save goal and close panel
  saveGoalBtn.addEventListener('click', () => {
    const val = goalInput.value.trim();
    if (!val) return;
    savedGoal = val;
    chrome.storage.local.set({ lastGoal: val });
    panel.classList.add('hidden');
    editBtn.classList.remove('active');
    showToast('running', `Goal saved`);
    setTimeout(() => hideToast(), 1800);
  });

  goalInput.addEventListener('keydown', e => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) saveGoalBtn.click();
    if (e.key === 'Escape') {
      panel.classList.add('hidden');
      editBtn.classList.remove('active');
    }
  });

  // FAB = one-tap run
  fab.addEventListener('click', () => {
    if (isRunning) return;
    if (!savedGoal) {
      panel.classList.remove('hidden');
      editBtn.classList.add('active');
      goalInput.focus();
      return;
    }
    triggerRun();
  });

  stuckOk.addEventListener('click', () => stuckOverlay.classList.remove('visible'));
  resultClose.addEventListener('click', () => {
    resultPanel.classList.add('hidden');
    clearTimeout(resultTimer);
  });

  function setRunning(on) {
    isRunning = on;
    fab.classList.toggle('running', on);
  }

  function showToast(type, text) {
    clearTimeout(toastTimer);
    toast.className = type;
    toast.textContent = text;
    toast.classList.add('show');
  }

  function hideToast() {
    toast.classList.remove('show');
  }

  function showResult(answer, reasoning) {
    clearTimeout(resultTimer);
    resultAnswer.textContent = answer;
    resultReason.textContent = reasoning || '';
    resultPanel.classList.remove('hidden');
    resultTimer = setTimeout(() => resultPanel.classList.add('hidden'), 8000);
  }

  function showStuck(msg) {
    hideToast();
    stuckMsg.textContent = msg;
    stuckOverlay.classList.add('visible');
  }

  function triggerRun() {
    if (isRunning || !savedGoal) return;
    setRunning(true);
    hideToast();
    resultPanel.classList.add('hidden');
    showToast('running', 'Running…');
    chrome.runtime.sendMessage({ type: 'RUN_GOAL', goal: savedGoal }, handleResult);
  }

  function handleResult(result) {
    setRunning(false);
    hideToast();
    if (chrome.runtime.lastError || !result) {
      showStuck(chrome.runtime.lastError?.message ?? 'No response from background.');
      return;
    }
    if (result.success) {
      const a = result.action;
      let answer = 'Done';
      if (a) {
        if (a.action === 'click' && typeof a.index === 'number') {
          const el = _lastElements[a.index];
          if (el) {
            const lbl = accessibleText(el);
            const fs = el.closest('fieldset');
            let num = null;
            if (fs) {
              const sibs = Array.from(fs.querySelectorAll('input[type="radio"],input[type="checkbox"]')).filter(isVisible);
              const pos = sibs.indexOf(el);
              if (pos >= 0) num = pos + 1;
            }
            answer = num ? `${lbl} · #${num}` : (lbl || 'Clicked');
          }
        } else if (a.action === 'fill') {
          answer = `"${a.value}"`;
        } else if (a.action === 'drag') {
          const src = _lastElements[a.sourceIndex];
          answer = src ? `Moved: ${accessibleText(src)}` : 'Items rearranged';
        } else if (a.action === 'none') {
          answer = 'Already done';
        }
      }
      showResult(answer, a?.reasoning ?? '');
    } else {
      showStuck(result.error ?? 'Unknown error.');
    }
  }

  // ── Auto-run on new question ─────────────────────────────────────────────
  let lastQuestionKey = '';
  let autoRunTimer = null;

  function getQuestionKey() {
    const root = document.querySelector('[role="main"], main, article, form') ?? document.body;
    // Use the first significant heading/question element as the key
    const nodes = root.querySelectorAll('h1,h2,h3,h4,[class*="question"],[class*="Question"],[class*="prompt"],[class*="Prompt"]');
    return Array.from(nodes).map(n => n.innerText?.trim()).filter(Boolean).join('|').slice(0, 300);
  }

  function scheduleAutoRun() {
    clearTimeout(autoRunTimer);
    autoRunTimer = setTimeout(() => {
      const key = getQuestionKey();
      if (!key || key === lastQuestionKey) return;
      lastQuestionKey = key;
      triggerRun();
    }, 700);
  }

  // Listen for SPA navigation events
  window.addEventListener('popstate', scheduleAutoRun);
  window.addEventListener('hashchange', scheduleAutoRun);

  // Watch for significant DOM changes in the content area
  const contentRoot = document.querySelector('[role="main"], main, article') ?? document.body;
  new MutationObserver(() => scheduleAutoRun()).observe(contentRoot, { childList: true, subtree: false });

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

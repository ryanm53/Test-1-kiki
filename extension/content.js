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
  host.style.cssText = 'position:fixed;bottom:24px;left:24px;z-index:2147483647;';

  const shadow = host.attachShadow({ mode: 'open' });

  shadow.innerHTML = `
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

  #btnRow {
    display: flex;
    align-items: center;
    justify-content: flex-start;
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
    box-shadow: 0 2px 16px rgba(56,189,248,0.45);
    user-select: none;
    transition: transform 0.15s, opacity 0.15s;
    flex-shrink: 0;
  }
  #fab:hover { opacity: 0.88; transform: scale(1.07); }
  #fab.running { opacity: 0.7; animation: pulse 1s infinite; cursor: default; }
  @keyframes pulse { 0%,100% { opacity:1; } 50% { opacity:0.55; } }

  #editBtn, #loopBtn, #pauseBtn {
    width: 30px; height: 30px;
    background: #1c1507;
    border: 1px solid #38BDF8;
    border-radius: 50%;
    color: #C9A96E;
    font-size: 13px;
    display: flex; align-items: center; justify-content: center;
    cursor: pointer;
    box-shadow: 0 1px 8px rgba(56,189,248,0.2);
    transition: color 0.15s, background 0.15s;
    flex-shrink: 0;
  }
  #editBtn:hover, #loopBtn:hover, #pauseBtn:hover { color: #38BDF8; background: #241e0c; }
  #editBtn.active { color: #38BDF8; }
  #loopBtn.active {
    color: #fff;
    background: #0284C7;
    border-color: #38BDF8;
    box-shadow: 0 0 10px rgba(56,189,248,0.5);
  }
  #pauseBtn { display: none; }
  #pauseBtn.visible { display: flex; }
  #pauseBtn.paused {
    color: #fff;
    background: #b45309;
    border-color: #f59e0b;
    box-shadow: 0 0 10px rgba(245,158,11,0.5);
  }

  /* Toast */
  #toast {
    position: absolute;
    bottom: 58px; left: 0;
    max-width: 240px;
    padding: 8px 14px;
    border-radius: 9px;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    font-size: 13px; font-weight: 600; line-height: 1.4;
    word-break: break-word;
    pointer-events: none;
    opacity: 0;
    transform: translateY(4px);
    transition: opacity 0.2s, transform 0.2s;
  }
  #toast.show { opacity: 1; transform: translateY(0); pointer-events: auto; }
  #toast.running {
    background: rgba(28,21,7,0.96);
    color: #7DD3FC;
    border: 1px solid rgba(56,189,248,0.45);
  }
  #toast.success {
    background: rgba(28,21,7,0.96);
    color: #C9A96E;
    border: 1px solid #38BDF8;
  }

  /* Settings panel */
  #panel {
    position: absolute; bottom: 58px; left: 0;
    width: 260px;
    max-height: 70vh;
    overflow-y: auto;
    background: #1c1507;
    border: 1px solid #38BDF8;
    border-radius: 12px;
    padding: 13px 13px 12px;
    box-shadow: 0 4px 28px rgba(56,189,248,0.15), 0 4px 24px rgba(0,0,0,0.5);
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
  }
  #panel.hidden { display: none; }
  #renameInput {
    width: 100%;
    background: #130f04;
    border: 1px solid #38BDF8;
    border-radius: 6px;
    color: #f0ddb0;
    font-size: 12px;
    padding: 6px 9px;
    outline: none;
    font-family: inherit;
    margin-bottom: 2px;
  }

  .plabel {
    font-size: 10px; font-weight: 600; color: #C9A96E;
    text-transform: uppercase; letter-spacing: 0.07em;
    margin-bottom: 6px;
  }
  .plabel span {
    font-size: 9px; color: rgba(201,169,110,0.45);
    font-weight: 400; text-transform: none; letter-spacing: 0; margin-left: 4px;
  }
  .pdivider { height: 1px; background: rgba(56,189,248,0.18); margin: 10px 0; }

  textarea, #msgInput {
    width: 100%;
    background: #130f04;
    border: 1px solid rgba(56,189,248,0.3);
    border-radius: 6px;
    color: #f0ddb0;
    font-size: 12px;
    padding: 7px 9px;
    outline: none;
    font-family: inherit;
  }
  textarea { resize: vertical; min-height: 54px; }
  textarea:focus, #msgInput:focus { border-color: #38BDF8; }
  textarea::placeholder, #msgInput::placeholder { color: rgba(201,169,110,0.3); }

  #presetSelect {
    width: 100%;
    background: #130f04;
    border: 1px solid rgba(56,189,248,0.3);
    border-radius: 6px;
    color: #C9A96E;
    font-size: 12px;
    padding: 7px 9px;
    outline: none;
    font-family: inherit;
    cursor: pointer;
    margin-bottom: 2px;
  }
  #presetSelect:focus { border-color: #38BDF8; }
  .hidden { display: none !important; }

  #saveGoalBtn {
    width: 100%; margin-top: 10px; padding: 8px;
    background: linear-gradient(135deg, #38BDF8, #0284C7);
    color: #fff; border: none;
    border-radius: 7px; cursor: pointer; font-size: 12px;
    font-weight: 600; font-family: inherit; letter-spacing: 0.01em;
    transition: opacity 0.15s;
    box-shadow: 0 1px 10px rgba(56,189,248,0.35);
  }
  #saveGoalBtn:hover { opacity: 0.88; }

  /* Stuck overlay */
  #stuckOverlay {
    display: none; position: fixed; inset: 0;
    background: rgba(0,0,0,0.65);
    z-index: 2147483647;
    align-items: center; justify-content: center;
  }
  #stuckOverlay.visible { display: flex; }
  #stuckBox {
    background: #1c1507;
    border: 1px solid #38BDF8;
    border-radius: 14px; padding: 22px 20px; text-align: center; width: 260px;
    box-shadow: 0 8px 40px rgba(0,0,0,0.6), 0 0 0 1px rgba(56,189,248,0.1);
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
  }
  #stuckIcon { font-size: 28px; margin-bottom: 8px; }
  #stuckTitle { font-size: 15px; color: #C9A96E; font-weight: 600; margin-bottom: 6px; }
  #stuckMsg { font-size: 11.5px; color: rgba(201,169,110,0.5); margin-bottom: 16px; line-height: 1.5; word-break: break-word; }
  #stuckOk {
    background: linear-gradient(135deg, #38BDF8, #0284C7); color: #fff; border: none;
    border-radius: 8px; padding: 9px 28px;
    cursor: pointer; font-size: 13px; font-weight: 600; font-family: inherit;
    box-shadow: 0 1px 10px rgba(56,189,248,0.35);
    transition: opacity 0.15s;
  }
  #stuckOk:hover { opacity: 0.88; }
</style>

<div id="toast"></div>

<div id="panel" class="hidden">
  <div class="plabel">Quick Goals</div>
  <select id="presetSelect">
    <option value="">— pick a preset —</option>
  </select>
  <div class="pdivider"></div>
  <div class="plabel">Goal</div>
  <textarea id="goalInput" rows="3" placeholder='Select a preset above or type your own goal…'></textarea>
  <div class="pdivider"></div>
  <div class="plabel">Success Message <span>5 words max · default: Done!</span></div>
  <input type="text" id="msgInput" placeholder='e.g. Got it! or Correct!' maxlength="60" />
  <button id="saveGoalBtn">Save</button>
</div>

<div id="btnRow">
  <button id="editBtn" title="Edit saved goal">✎</button>
  <button id="loopBtn" title="Loop mode: auto-run on each new question">↺</button>
  <button id="pauseBtn" title="Pause / resume loop">⏸</button>
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
  const loopBtn      = shadow.getElementById('loopBtn');
  const pauseBtn     = shadow.getElementById('pauseBtn');
  const panel        = shadow.getElementById('panel');
  const goalInput    = shadow.getElementById('goalInput');
  const msgInput     = shadow.getElementById('msgInput');
  const saveGoalBtn  = shadow.getElementById('saveGoalBtn');
  const toast        = shadow.getElementById('toast');
  const stuckOverlay = shadow.getElementById('stuckOverlay');
  const stuckMsg     = shadow.getElementById('stuckMsg');
  const stuckOk      = shadow.getElementById('stuckOk');

  let toastTimer = null;
  let isRunning  = false;
  let savedGoal  = '';
  let customMsg  = '';
  let loopMode   = false;
  let loopPaused = false;
  let loopCount  = 0;

  // Load saved settings on init
  chrome.storage.local.get(['lastGoal', 'successMsg'], ({ lastGoal, successMsg }) => {
    if (lastGoal)   { savedGoal = lastGoal; goalInput.value = lastGoal; }
    if (successMsg) { customMsg = successMsg; msgInput.value = successMsg; }
  });

  // ── Presets dropdown ─────────────────────────────────────────────────────
  const presetSelect = shadow.getElementById('presetSelect');
  const PRESETS = [
    { label: 'McGraw Hill - Answer + Confidence + Next', goal: 'Step 1: Click the correct answer for this multiple choice question. Step 2: Click the button with aria-label "High Confidence" (visible text is "High") to submit your confidence rating. Step 3: Click the button whose text is "Next Question" (class "next-button") to advance. After completing all 3 steps return action "none" — do not try to answer the next question.' },
    { label: 'McGraw Hill - Answer only', goal: 'Look at the question on the page and click the correct answer' }
  ];
  PRESETS.forEach(p => {
    const opt = document.createElement('option');
    opt.value = p.goal;
    opt.textContent = p.label;
    presetSelect.appendChild(opt);
  });
  presetSelect.addEventListener('change', () => {
    if (presetSelect.value) goalInput.value = presetSelect.value;
  });

  // Enforce 5-word limit on message input
  msgInput.addEventListener('input', () => {
    const words = msgInput.value.trim().split(/\s+/).filter(Boolean);
    if (words.length > 5) msgInput.value = words.slice(0, 5).join(' ');
  });

  // Toggle goal editor panel
  editBtn.addEventListener('click', () => {
    const hidden = panel.classList.toggle('hidden');
    editBtn.classList.toggle('active', !hidden);
    if (!hidden) goalInput.focus();
  });

  // Save goal + message and close panel
  saveGoalBtn.addEventListener('click', () => {
    const val = goalInput.value.trim();
    if (!val) return;
    savedGoal = val;
    const words = msgInput.value.trim().split(/\s+/).filter(Boolean).slice(0, 5);
    customMsg = words.join(' ');
    msgInput.value = customMsg;
    chrome.storage.local.set({ lastGoal: val, successMsg: customMsg });
    panel.classList.add('hidden');
    editBtn.classList.remove('active');
    showToast('running', 'Saved');
    setTimeout(() => hideToast(), 1500);
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

  loopBtn.addEventListener('click', () => {
    loopMode = !loopMode;
    loopCount = 0;
    loopPaused = false;
    loopBtn.classList.toggle('active', loopMode);
    pauseBtn.classList.toggle('visible', loopMode);
    pauseBtn.classList.remove('paused');
    pauseBtn.title = 'Pause loop';
    pauseBtn.textContent = '⏸';
    showToast('running', loopMode ? 'Loop ON — will auto-continue' : 'Loop OFF');
    setTimeout(() => hideToast(), 1800);
  });

  pauseBtn.addEventListener('click', () => {
    loopPaused = !loopPaused;
    pauseBtn.classList.toggle('paused', loopPaused);
    pauseBtn.textContent = loopPaused ? '▶' : '⏸';
    pauseBtn.title = loopPaused ? 'Resume loop' : 'Pause loop';
    if (loopPaused) {
      clearTimeout(toastTimer);
      showToast('running', 'Loop paused — press ▶ to resume');
    } else {
      showToast('running', 'Resuming…');
      setTimeout(() => triggerRun(), 500);
    }
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

  function showStuck(msg) {
    hideToast();
    stuckMsg.textContent = msg;
    stuckOverlay.classList.add('visible');
  }

  // Poll until page content changes (new question loaded), then fire.
  // Falls back after 5s so we never hang forever.
  function waitForPageChange(snapText) {
    const deadline = Date.now() + 5000;
    function check() {
      if (loopPaused || !loopMode) return;
      const root = document.querySelector('[role="main"], main, article, form') ?? document.body;
      const now = (root.innerText ?? '').slice(0, 400);
      if (now !== snapText || Date.now() > deadline) {
        triggerRun();
      } else {
        setTimeout(check, 150);
      }
    }
    setTimeout(check, 150);
  }

  function triggerRun() {
    if (isRunning || !savedGoal) return;
    lastRunAt = Date.now();
    setRunning(true);
    hideToast();
    showToast('running', 'Running…');
    chrome.runtime.sendMessage({ type: 'RUN_GOAL', goal: savedGoal }, handleResult);
  }

  let rateLimitTimer = null;

  function handleResult(result) {
    setRunning(false);
    hideToast();
    if (chrome.runtime.lastError || !result) {
      showStuck(chrome.runtime.lastError?.message ?? 'No response from background.');
      return;
    }
    if (result.success) {
      loopCount++;
      if (loopMode && !loopPaused) {
        showToast('success', `Done #${loopCount} — waiting for next…`);
        const root = document.querySelector('[role="main"], main, article, form') ?? document.body;
        const snapText = (root.innerText ?? '').slice(0, 400);
        waitForPageChange(snapText);
      } else if (loopMode && loopPaused) {
        showToast('running', `Done #${loopCount} — paused`);
      } else {
        showToast('success', customMsg || 'Done!');
        toastTimer = setTimeout(() => hideToast(), 2500);
      }
    } else {
      const err = result.error ?? 'Unknown error.';
      if (err.includes('Rate limit')) {
        startRateLimitCountdown();
      } else {
        showStuck(err);
      }
    }
  }

  function startRateLimitCountdown() {
    clearTimeout(rateLimitTimer);
    let secs = 65;
    function tick() {
      showToast('running', `Rate limited — retrying in ${secs}s…`);
      if (secs <= 0) {
        triggerRun();
        return;
      }
      secs--;
      rateLimitTimer = setTimeout(tick, 1000);
    }
    tick();
  }

  // ── Auto-run on new question ─────────────────────────────────────────────
  let lastAutoUrl  = '';
  let autoRunTimer = null;
  const COOLDOWN   = 5000; // minimum ms between auto-runs
  let lastRunAt    = 0;

  function scheduleAutoRun() {
    clearTimeout(autoRunTimer);
    autoRunTimer = setTimeout(() => {
      if (isRunning || !savedGoal) return;
      const url = location.href;
      if (url === lastAutoUrl) return;
      if (Date.now() - lastRunAt < COOLDOWN) return;
      lastAutoUrl = url;
      triggerRun();
    }, 700);
  }

  // Native popstate/hashchange (back/forward, hash nav)
  window.addEventListener('popstate', scheduleAutoRun);
  window.addEventListener('hashchange', scheduleAutoRun);

  // Intercept pushState/replaceState for SPA navigation
  for (const method of ['pushState', 'replaceState']) {
    const orig = history[method].bind(history);
    history[method] = (...args) => { orig(...args); scheduleAutoRun(); };
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

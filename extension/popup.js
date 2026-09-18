const apiKeyInput  = document.getElementById('apiKey');
const saveKeyBtn   = document.getElementById('saveKey');
const goalInput    = document.getElementById('goal');
const runBtn       = document.getElementById('runBtn');
const statusDiv    = document.getElementById('status');
const stuckOverlay = document.getElementById('stuckOverlay');
const stuckReason  = document.getElementById('stuckReason');
const stuckOk      = document.getElementById('stuckOk');

// Reference tabs
const refToggleBtn = document.getElementById('refToggleBtn');
const refBody      = document.getElementById('refBody');
const refArrow     = document.getElementById('refArrow');
const refUrlInput  = document.getElementById('refUrl');
const addRefBtn    = document.getElementById('addRef');
const refList      = document.getElementById('refList');
const refEmpty     = document.getElementById('refEmpty');
const refCount     = document.getElementById('refCount');

let refUrls = [];
let refOpen = true;

function renderRefList() {
  // Remove all items except the empty placeholder
  Array.from(refList.querySelectorAll('.ref-item')).forEach(el => el.remove());
  refEmpty.style.display = refUrls.length ? 'none' : '';
  refCount.textContent = refUrls.length ? `(${refUrls.length})` : '';

  refUrls.forEach((url, i) => {
    const li = document.createElement('li');
    li.className = 'ref-item';
    li.innerHTML = `<span title="${esc(url)}">${esc(url)}</span><button data-i="${i}" title="Remove">×</button>`;
    li.querySelector('button').addEventListener('click', () => {
      refUrls.splice(i, 1);
      chrome.storage.local.set({ refUrls });
      renderRefList();
    });
    refList.appendChild(li);
  });
}

function addRefUrl() {
  const url = refUrlInput.value.trim();
  if (!url) return;
  if (!url.startsWith('http://') && !url.startsWith('https://')) {
    showStatus('error', 'URL must start with http:// or https://');
    return;
  }
  if (refUrls.includes(url)) { refUrlInput.value = ''; return; }
  refUrls.push(url);
  chrome.storage.local.set({ refUrls });
  renderRefList();
  refUrlInput.value = '';
}

addRefBtn.addEventListener('click', addRefUrl);
refUrlInput.addEventListener('keydown', e => { if (e.key === 'Enter') addRefUrl(); });

refToggleBtn.addEventListener('click', () => {
  refOpen = !refOpen;
  refBody.style.display = refOpen ? '' : 'none';
  refArrow.classList.toggle('open', refOpen);
});

// Load saved reference URLs
chrome.storage.local.get('refUrls', ({ refUrls: saved }) => {
  if (Array.isArray(saved)) refUrls = saved;
  renderRefList();
});

stuckOk.addEventListener('click', () => {
  stuckOverlay.classList.remove('visible');
});

// Restore saved API key on open
chrome.storage.local.get('apiKey', ({ apiKey }) => {
  if (apiKey) apiKeyInput.value = apiKey;
});

saveKeyBtn.addEventListener('click', () => {
  const key = apiKeyInput.value.trim();
  if (!key) { showStatus('error', 'Paste your Anthropic API key first.'); return; }
  chrome.storage.local.set({ apiKey: key }, () => {
    showStatus('success', 'API key saved.');
  });
});

// Also save on Enter inside the key field
apiKeyInput.addEventListener('keydown', e => {
  if (e.key === 'Enter') saveKeyBtn.click();
});

runBtn.addEventListener('click', async () => {
  const goal = goalInput.value.trim();
  if (!goal) { showStatus('error', 'Enter a goal first.'); return; }

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) { showStatus('error', 'Could not get the current tab.'); return; }

  const url = tab.url ?? '';
  if (url.startsWith('chrome://') || url.startsWith('about:') || url.startsWith('edge://')) {
    showStatus('error', 'Cannot run on browser system pages. Navigate to a real website first.');
    return;
  }

  setRunning(true);
  showStatus('running', 'Scraping page and consulting Claude…');

  chrome.runtime.sendMessage({ type: 'RUN_GOAL', goal, tabId: tab.id, refUrls }, result => {
    setRunning(false);

    if (chrome.runtime.lastError) {
      showStuck(`Extension error: ${chrome.runtime.lastError.message}`);
      return;
    }

    if (!result) {
      showStuck('No response from background worker.');
      return;
    }

    if (result.success) {
      const a = result.action;
      let html = '';

      if (a && a.action !== 'none') {
        const label = a.action === 'fill'
          ? `fill [${a.index}] → "${esc(String(a.value ?? ''))}"`
          : `${a.action} [${a.index}]`;
        html += `<span class="action-tag">${label}</span><br>`;
      }

      if (a?.reasoning) {
        html += `<div class="reasoning">${esc(a.reasoning)}</div>`;
      } else if (result.message) {
        html += esc(result.message);
      }

      showStatus('success', html || 'Done.', true);
    } else {
      showStuck(result.error || 'Unknown error.');
    }
  });
});

// Submit goal on Ctrl/Cmd+Enter
goalInput.addEventListener('keydown', e => {
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) runBtn.click();
});

function showStuck(msg) {
  stuckReason.textContent = msg;
  stuckOverlay.classList.add('visible');
}

function setRunning(on) {
  runBtn.disabled = on;
  runBtn.textContent = on ? 'Running…' : 'Run';
}

function showStatus(type, content, isHtml = false) {
  statusDiv.style.display = 'block';
  statusDiv.className = type;
  statusDiv.innerHTML = isHtml ? content : esc(content);
}

function esc(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

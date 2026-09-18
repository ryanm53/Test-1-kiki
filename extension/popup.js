const apiKeyInput = document.getElementById('apiKey');
const saveKeyBtn  = document.getElementById('saveKey');
const goalInput   = document.getElementById('goal');
const runBtn      = document.getElementById('runBtn');
const statusDiv   = document.getElementById('status');

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

  chrome.runtime.sendMessage({ type: 'RUN_GOAL', goal, tabId: tab.id }, result => {
    setRunning(false);

    if (chrome.runtime.lastError) {
      showStatus('error', `Extension error: ${chrome.runtime.lastError.message}`);
      return;
    }

    if (!result) {
      showStatus('error', 'No response from background worker.');
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
      showStatus('error', result.error || 'Unknown error.');
    }
  });
});

// Submit goal on Ctrl/Cmd+Enter
goalInput.addEventListener('keydown', e => {
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) runBtn.click();
});

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

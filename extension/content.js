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

function describeEl(el) {
  return {
    tag: el.tagName.toLowerCase(),
    type: el.getAttribute('type') || null,
    text: (el.innerText || el.getAttribute('aria-label') || el.getAttribute('title') || '').trim().slice(0, 100),
    placeholder: el.getAttribute('placeholder') || null,
    name: el.getAttribute('name') || null
  };
}

function scrape() {
  const text = document.body?.innerText ?? '';

  const all = Array.from(document.querySelectorAll(INTERACTIVE_SEL));
  _lastElements = all.filter(isVisible).slice(0, 100);

  return {
    text: text.slice(0, 5000),
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

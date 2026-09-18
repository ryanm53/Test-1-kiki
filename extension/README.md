# Claude Page Agent

A personal Chrome extension that lets you type a goal and have Claude click buttons
or fill inputs on the current page.

---

## Loading as an unpacked extension

1. Open Chrome and navigate to `chrome://extensions/`
2. Enable **Developer mode** (toggle in the top-right corner)
3. Click **Load unpacked**
4. Select the `extension/` folder inside this repository
5. The "Claude Page Agent" icon should appear in the Chrome toolbar

---

## Setup

Click the extension icon, paste your Anthropic API key into the top field, and click
**Save**. The key is stored in `chrome.storage.local` — it never leaves your browser
except as a request header to `api.anthropic.com`.

---

## Usage

1. Navigate to any web page
2. Click the extension icon
3. Type a natural-language goal, for example:
   - `click the Sign In button`
   - `fill the search box with "climate change"`
   - `click the first result link`
4. Press **Run** (or Ctrl/Cmd+Enter inside the goal box)

The extension scrapes the page, asks Claude what to do, executes the action, and
shows Claude's reasoning below the button.

---

## Reliability design

### Numbered-element-index instead of selector generation

The biggest failure mode in browser automation agents is **selector hallucination**:
asking the model to emit a CSS selector or XPath for an element that it can't actually
see. Claude invents a plausible-sounding selector that doesn't exist, the query returns
nothing, and the action fails silently.

This extension avoids that entirely:

1. `content.js` queries every interactive element on the page (`button`, `a[href]`,
   `input`, `textarea`, `select`, ARIA roles, `contenteditable`).
2. It filters the result to only elements **visible on screen** (non-zero bounding box,
   inside the viewport, not hidden by CSS `display`/`visibility`/`opacity`).
3. Each surviving element is assigned an integer index (0, 1, 2 …) and described in
   plain text (`tag`, `type`, label text, `placeholder`, `name`).
4. The model is instructed to respond with **only that index** — nothing freeform.

Because Claude can only pick from the list it was given, it cannot hallucinate a
reference to an element that doesn't exist.

### Visibility filtering

Elements pass the visibility check only if all of these hold:

- `getBoundingClientRect()` reports non-zero width **and** height
- The bounding box overlaps the current viewport (not scrolled off-screen)
- Computed CSS `display !== none`, `visibility !== hidden`, `opacity !== 0`

This prevents the agent from targeting off-screen nav drawers, hidden modals, or
zero-size placeholders that are technically in the DOM but invisible to the user.

### React / Vue / Angular compatibility for `fill` actions

Single-page apps typically override `HTMLInputElement.prototype.value` with a setter
that triggers their internal reactivity system. Simply assigning `el.value = text`
bypasses that override, and the framework never learns the value changed.

The extension instead:

1. Reads the **native** setter from the prototype (`Object.getOwnPropertyDescriptor`)
   and calls it directly on the element
2. Dispatches `InputEvent('input', { bubbles: true })` and `Event('change', { bubbles: true })`

This causes React's synthetic event system (and Vue/Angular's equivalents) to pick up
the new value exactly as if a user had typed it.

### Retry loop

If execution fails (element removed from the DOM after the scrape, a click raises an
exception, etc.) the background worker:

1. **Re-scrapes the page** — the DOM may have changed since the previous attempt
2. **Asks Claude again** with the fresh element list
3. Attempts to execute the new action

The loop runs up to **3 times total** (initial attempt + 2 retries) with a short
back-off between tries (700 ms, then 1 400 ms). Re-scraping on each retry means Claude
always reasons about the *current* state of the page rather than a stale snapshot from
before a navigation or DOM mutation.

---

## File overview

| File | Purpose |
|------|---------|
| `manifest.json` | Manifest V3 declaration: permissions, content script, service worker |
| `background.js` | Service worker: calls Claude API, owns the retry loop |
| `content.js` | Injected into every page: scrapes elements, executes actions |
| `popup.html` | Extension popup UI |
| `popup.js` | Popup logic: API key persistence, sends goal to background |

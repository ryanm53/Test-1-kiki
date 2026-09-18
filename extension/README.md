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

### Floating button (recommended for quizzes / surveys)

Every page gets a small **⚡ button** injected in the bottom-right corner. Click it to
open a mini panel, type your goal, and hit **Run** — no need to open the extension
popup. The panel stays on screen while you work through questions, and it remembers
your last goal between page loads.

- The FAB pulses while Claude is working
- On success it shows Claude's reasoning inline
- On failure it shows the **Got stuck** modal — click **OK** to dismiss and try again

### Extension popup

Click the toolbar icon to open the full popup. Same goal box and Run button, plus the
API key field and the Reference Tabs manager.

---

## Reference Tabs

If your study material (textbook, notes, slides) is open in another browser tab, you
can tell the extension to read it:

1. Open the reference page in a tab
2. Click the extension icon → expand **Reference Tabs** → paste the URL → **Add**
3. The URL is saved permanently — you only need to do this once per source

When you hit Run, the extension finds those open tabs, scrapes their text, and includes
it in the Claude prompt as reference material. Claude can then use that content to
answer questions correctly.

**URL matching:** the stored URL is used as a prefix, so saving
`https://example.com/chapter1` will match that page and any sub-path beneath it.
Up to 2 000 characters are scraped per reference tab.

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
   plain text (`tag`, `type`, label text, `placeholder`, `name`, and the question it
   belongs to).
4. The model is instructed to respond with **only that index** — nothing freeform.

Because Claude can only pick from the list it was given, it cannot hallucinate a
reference to an element that doesn't exist.

### aria-labelledby resolution

Many quiz / learning platforms (Angular-based apps in particular) put the visible
answer text in a separate `<span>` linked to the input via `aria-labelledby` rather
than inside the input itself. The scraper follows those references so Claude sees
`"Liabilities"` rather than a blank label, and can pick the correct answer.

### Question context

For radio/checkbox groups the scraper walks up to the enclosing `<fieldset>` and
follows the legend's `aria-labelledby` attribute to find the question prompt. Each
answer choice is annotated with its question, e.g.:

```
[2] input type="radio" "Liabilities" (question: "Assets = ______ + Stockholders' Equity.")
```

### Visibility filtering

Elements pass the visibility check only if all of these hold:

- `getBoundingClientRect()` reports non-zero width **and** height
- The bounding box overlaps the current viewport (not scrolled off-screen)
- Computed CSS `display !== none`, `visibility !== hidden`, `opacity !== 0`

### React / Vue / Angular compatibility for `fill` actions

The extension uses the native `HTMLInputElement.prototype.value` setter and dispatches
`InputEvent('input')` + `Event('change')` with `bubbles: true` so framework reactivity
triggers as if a user typed the value.

### Retry loop

If execution fails the background worker re-scrapes the page (DOM may have changed),
asks Claude again with the fresh element list, and retries up to **3 times total**
with 700 ms / 1 400 ms back-off. A "Got stuck" modal appears when all retries are
exhausted — click **OK** then **Run** again.

---

## File overview

| File | Purpose |
|------|---------|
| `manifest.json` | Manifest V3: permissions, content script, service worker |
| `background.js` | Service worker: Claude API calls, retry loop, reference tab scraping |
| `content.js` | Injected on every page: scrapes elements, executes actions, floating widget |
| `popup.html` | Extension popup UI |
| `popup.js` | Popup: API key, goal input, reference URL manager |

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

Every page gets a small toolbar injected in the bottom-left corner:

- **⚡** — run the saved goal once
- **✎** — open the settings panel: pick a preset from the dropdown (or type a custom
  goal), set an optional success message, **Save**
- **↺** — loop mode. After each successful question, waits for the page content to
  actually change (polls every 150ms, 5s fallback) and automatically runs again —
  useful for working through an entire quiz unattended
- **⏸ / ▶** — appears once loop mode is on; pauses/resumes the auto-continue

The panel remembers your goal and preset between page loads.

- The FAB pulses while Claude is working
- On failure it shows the **Got stuck** modal — click **OK** to dismiss and try again
- If Claude can't find a valid answer to click (e.g. an unsupported question type like
  drag-and-drop ordering), loop mode auto-pauses and shows what happened instead of
  silently retrying the same question forever

### McGraw Hill presets

The built-in presets split the work: **Claude only picks the answer** (cheapest,
least error-prone part to leave to an LLM). Clicking **High Confidence** and
**Next Question** afterward is handled by direct DOM lookups — a fixed
`data-automation-id`/class selector — with no API call at all. This is both faster
and immune to the model hallucinating the wrong button.

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

### React / Vue / Angular compatibility

For `fill` actions, the extension uses the native `HTMLInputElement.prototype.value`
setter and dispatches `InputEvent('input')` + `Event('change')` with `bubbles: true`
so framework reactivity triggers as if a user typed the value.

For the direct-click steps (High Confidence / Next Question), a full
`pointerdown → mousedown → pointerup → mouseup → click` event chain is dispatched
(with `bubbles: true`) so Angular's event system registers it reliably.

### Retry loop

If a step fails, the background worker re-scrapes the page (DOM may have changed),
asks Claude again with the fresh element list, and retries once more (2 attempts
total per step) with a 400ms back-off. A "Got stuck" modal appears if it's still
stuck — click **OK** then **Run** again.

### Forcing valid JSON output (response prefilling)

Rather than just instructing Claude to "respond with only JSON" (which an LLM can
still ignore under load), the API call prefills the assistant's turn with
`{"action":"` before sending. Claude then can only *complete* that JSON object — it
is structurally unable to open with prose. The prefilled prefix is stitched back
onto the response before parsing. A bracket-counting fallback extracts the first
complete `{...}` block in case trailing text still sneaks in after the closing brace.

### Minimal token usage

Since Claude's only job is picking which element index to click, the request is
kept as small as possible: an ~50-token system prompt, page text truncated to 800
characters, at most 25 interactive elements, and a `{"action":"click","index":N}` /
`{"action":"none"}` response capped at 40 tokens. Confidence and Next-question
clicks cost no tokens at all since they never touch the API.

---

## File overview

| File | Purpose |
|------|---------|
| `manifest.json` | Manifest V3: permissions, content script, service worker |
| `background.js` | Service worker: Claude API calls, retry loop, reference tab scraping |
| `content.js` | Injected on every page: scrapes elements, executes actions, floating widget |
| `popup.html` | Extension popup UI |
| `popup.js` | Popup: API key, goal input, reference URL manager |

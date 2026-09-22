# Page Agent — internals

A Chrome extension that answers quiz questions on the current page using Claude.
Handles multiple choice, multi-select, fill-in-the-blank, and drag-and-drop ordering.

---

> **Setting this up?** See the [setup guide in the root README](../README.md) — this file
> covers how it works internally, not how to install it.

---

## Architecture

Two scripts do the work:

- **`content.js`** runs inside the page. It scrapes the visible interactive elements,
  executes the action Claude picks, and renders the control bar (a shadow-DOM widget so
  page CSS can't affect it).
- **`background.js`** is the service worker. It builds the prompt, calls the Claude API,
  validates the response, and drives the post-answer clicks.

The split matters: only the content script can touch the page, and only the service
worker can hold the API key and make cross-origin requests.

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
stuck, surfaced inline in the control bar.

### Forcing valid JSON output

Instructing an LLM to "respond with only JSON" is not reliable under load — it will
occasionally open with prose and break the parse. Two mechanisms prevent that, chosen
per model in the `MODELS` table:

- **Prefill** (Haiku 4.5): the request ends with an assistant turn containing
  `{"action":"`, so the reply is already mid-JSON and cannot begin with prose. The
  prefix is stitched back on before parsing.
- **Structured outputs** (Sonnet 5, Opus 5): prefill returns a 400 on these models, so
  they get `output_config.format` with a JSON schema instead, which constrains the whole
  response shape rather than just its opening.

Either way a bracket-counting fallback extracts the first complete `{...}` block in case
trailing text appears after the closing brace, and the parsed action is validated against
its required fields before execution.

Two other per-model differences are handled in the same table: `temperature` is rejected
on Sonnet 5 / Opus 5, and Opus 5 thinks by default — so it needs a larger `max_tokens`,
runs at `effort: low`, and response parsing looks for the `text` block rather than
`content[0]`, since thinking blocks come first.

### Drag-and-drop via trusted input

McGraw Hill's drag questions are built on **react-beautiful-dnd**, which ignores
synthetic events — they reach the page but never satisfy its drag state machine.
rbd does ship a keyboard sensor (Space to lift, arrows to move, Space to drop), so
drag moves are driven through that, using `chrome.debugger` +
`Input.dispatchKeyEvent` to send real `isTrusted` keystrokes. The debugger attaches
lazily — only once a drag actually starts — so ordinary questions never trigger the
"being debugged" banner, and it always detaches in a `finally`.

### Token usage

The request is kept small: a short system prompt, page text truncated to 800
characters, at most 25 interactive elements, and a compact action object back.
Multiple choice costs exactly one API call — the step budget only expands (to 8) once
a drag move starts, since those need several sequential moves with a fresh look at the
board between each. Confidence and Next-question clicks cost nothing at all, since they
are direct DOM lookups that never touch the API.

---

## File overview

| File | Purpose |
|------|---------|
| `manifest.json` | Manifest V3: permissions, content script, service worker |
| `background.js` | Service worker: Claude API calls, retry loop, reference tab scraping |
| `content.js` | Injected on every page: scrapes elements, executes actions, control bar UI |
| `popup.html` | Static card pointing at the on-page control bar |

---

## Failure handling

The worst outcome is silence: a press of play that produces no action and no
message. Everything below exists to make that impossible.

**A reloaded extension orphans open pages.** Reloading at `chrome://extensions`
leaves every already-open tab running the previous copy of `content.js` with a
dead connection — `chrome.*` calls throw `Extension context invalidated`. All
calls to the extension go through `bgSend` / `store`, which check
`chrome.runtime.id` first and turn a dead connection into "refresh this page"
in the status bar rather than an uncaught throw.

**Pages open before install have no content script.** `sendToTab` catches
"receiving end does not exist", injects `content.js` into that frame with
`chrome.scripting`, and retries once. `content.js` is wrapped in a load guard so
a second injection is a no-op instead of a redeclaration error.

**Nothing waits forever.** Every message to the page has a 20s deadline, every
async message handler answers even when it throws, and `RUN_GOAL` always sends a
response — including from its `catch` and around `detachDebugger`.

**The control bar's timer measures silence, not length.** A six-step spreadsheet
task on Opus legitimately runs for minutes, so the background sends a `PROGRESS`
heartbeat as each step begins (and between cells of a long fill). The timer is
pushed back on each one and only fires after 90s of genuine silence.

**Errors say what to do.** API failures are mapped to plain English — a 401
points at the key-versus-key-ID mix-up, a 400 mentioning credit points at
Billing, a network failure says to check the connection. 5xx is retried once
before the user sees anything.

## Tests

```
npm install
npm test
```

jsdom, no browser. Each suite pins a bug that actually shipped: worksheet
column/row labelling, spreadsheet cell detection, SIMnet's ribbon surviving the
exam-chrome filter, SIMnet behaviour *not* leaking into ordinary questions, and
the failure handling above. Run it before pushing — several of these were
originally caught by the test rather than by the user.

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
- **Structured outputs** (Sonnet 5, Opus 5.5): prefill returns a 400 on these models, so
  they get `output_config.format` with a JSON schema instead, which constrains the whole
  response shape rather than just its opening.

Either way a bracket-counting fallback extracts the first complete `{...}` block in case
trailing text appears after the closing brace, and the parsed action is validated against
its required fields before execution.

Other per-model differences are handled in the same table: `temperature` is rejected
on Sonnet 5 / Opus 5.5, and Opus 5.5 always thinks — it can't be turned off, and the
thinking counts against `max_tokens` — so it gets 8000 and `effort: low` (its default is
`medium`). Response parsing looks for the `text` block rather than `content[0]`, since
thinking blocks (and, after a fallback, a `fallback` marker block) come first.

Opus 5.5's safety classifiers can decline a request: HTTP 200, `stop_reason: "refusal"`,
no answer. It opts into server-side fallback (`fallbacks: "default"`, header
`server-side-fallback-2026-07-01`), which re-runs a declined request on the model
Anthropic recommends for that category. A refusal that survives the fallback is reported
as such and not retried. A saved `claude-opus-5` (the model Opus 5.5 replaced in the
menu) is read as `claude-opus-5-5`.

### Drag-and-drop via trusted input

McGraw Hill's drag questions are built on **react-beautiful-dnd**, which ignores
synthetic events — they reach the page but never satisfy its drag state machine.
rbd does ship a keyboard sensor (Space to lift, arrows to move, Space to drop), so
drag moves are driven through that, using `chrome.debugger` +
`Input.dispatchKeyEvent` to send real `isTrusted` keystrokes. The debugger attaches
lazily — only once a drag actually starts — so ordinary questions never trigger the
"being debugged" banner, and it always detaches in a `finally`.

### Per-platform behaviour

`scrape()` identifies the page and the background adapts, so no setting has to
change between sites.

- **Connect** — the ordinary path. After answering, the preset's post-clicks run:
  High Confidence (optional — skipped when absent, e.g. worksheets) then Next.
- **SIMnet** — detected by its grid (`td.grdbdy-cell`). Up to six steps per task,
  then the run ends with a note: no Connect post-clicks, and no second pass that
  would start editing a finished task.
- **SIMnet moves** — besides click, SIMnet steps can `doubleClick`, `rightClick`,
  `type` (into element N, or into whatever is being edited when no index is
  given), `key` (Enter, Escape, Tab, Delete, Backspace, F2, F4, arrows,
  Home, End — with `ctrl`/`shift`), and `selectRange` (`from`/`to`: click the
  first cell, shift-click the last). Clicks take `shift`/`ctrl` too, and any
  cell can be targeted by address (`cell: "B7"`, resolved via SIMnet's
  `cell-B7` ids) instead of by index, so cells needn't be in the list.
  Addresses are normalised (`$a$5` -> `A5`) and validated. Only the SIMnet
  prompt describes these. Clicks and keys are simulated, as SIMnet acts on
  simulated events; typing sets a text box's value directly, and a grid cell
  — which edits only on real key presses — gets focused and then real
  keystrokes via the debugger. Each SIMnet control carries its state — `(on)`
  from aria-pressed, `(selected)`, `(open)` from aria-expanded, `(disabled)`
  — and a `<select>` its choices and current value, everywhere. Up to 8 steps;
  a run that uses them all without the model reporting the task complete is
  an error ("Used all 8 steps…"), never "Finished".
- **SIMnet, from a real exercise log** (36 tasks, 25 right first time out; every
  miss traced): `hover` for "Point to X" submenus (Hide & Unhide, Tab Color),
  since SIMnet grades a click on a submenu's parent as wrong. The strip under
  the grid — sheet tabs, New Sheet (+) — found by position (anything short and
  labelled below the grid's last row) and listed near the top; they're plain
  elements the general selector never matched. Column and row selectors by
  `column`/`row`, found by text and position (the element reading "B" above
  column B's cells), so the Bold button's "B" can't be mistaken for it. "Just
  appeared" means new since the previous look only; being inside a menu-like
  container no longer counts (part of SIMnet's toolbar is one). Newly
  appeared plain text leaves (menu entries without roles) are candidates. A
  label that repeats in the list gets its group (`(in: Gridlines)` vs
  `(in: Headings)` for Sheet Options' two Print boxes). And on a graded page
  (the attempt counter is showing), "done" with no popup means nothing was
  graded: the model is told so and continues, twice at most.
- **SIMnet grading** — SIMnet grades with a popup: a "Correct"/"Incorrect"
  heading, a HINT with the exact steps on a wrong answer, and one Continue
  button (back to the question after a wrong try, on to the next after a
  right one). `findVerdict()` finds it by wording — the heading's text with
  a Continue button in the same box, which keeps a cell reading "Correct"
  from counting — in the question frame and the top frame. It's checked
  before each step and, when the model says it's finished, for up to 3s.
  Correct: Continue, and the run returns `advanced` so Autopilot goes on at
  once. Incorrect on the first round: one retry round with the hint in the
  prompt and effort raised to medium — only if the "N of M Attempts" counter
  (read at the start) shows the retry can't spend the last attempt, and
  never in Answer only mode. Verdicts and hints go into the answer log.
- **SIMnet menus** — the element list is capped (130), and SIMnet's ribbon alone
  nearly fills it, while dropdowns, submenus and dialogs are added at the end
  of the page. So each look compares against the previous one (a `WeakSet` of
  what it saw): anything new, and anything inside an open menu or dialog, goes
  first and is marked `(just appeared)`. Bare elements with only a title
  (colour swatches) are included once they appear. A run's first look
  (`firstLook`) has no baseline; a peek never changes it.
- **Canvas Classic Quizzes** — detected by `#questions .display_question`. Every
  question on the page is scraped regardless of scroll position, each choice
  tagged with its own `.question_text` (the fieldset legend is a generic
  screen-reader "Answers" and useless for this). One `clickMany` answers the
  page; a second step only if there are typed blanks. Afterwards it clicks
  `button.next-question` if one exists, and otherwise stops. It never offers the
  model Submit Quiz. One-at-a-time Next is a full page load, so the loop is
  carried across it by a short-lived note in the tab's `sessionStorage`,
  refreshed by each step's heartbeat and deleted by anything that ends a run.

The control bar names the page before anything runs ("Ready · Canvas quiz").
It asks the background (`DETECT_PAGE`), which picks the question frame and
reads it with `SCRAPE {peek: true}` — a read that restores `_lastElements`
afterwards, so an idle look can never shift the indexes a run is about to
click. *Check this page* peeks the same way. Detection happens once per
address (plus one retry for late-drawing pages), never calls Claude, and is
skipped until a key is saved.

Settings are stored under their original keys (`lastPresetIndex`,
`autoContinue`, `model`, `autoUpgrade`) plus `mode`; the panel's Mode and
Model menus are views over them, and older saved settings are read back into
the nearest new choice.

Nothing starts a run except the play button or that note. (An earlier hook
auto-ran on any `pushState` navigation, on any site — removed.)

### Token usage

The request is kept small: a short system prompt, a compact action object back, and
only as much of the page as the platform needs. Page text is cut to 800 characters on
ordinary questions, 1,500 on SIMnet and 3,000 on worksheets and Canvas. Elements are
capped per platform: 25 on-screen ones for ordinary questions, 60 on worksheets, 150 on
a whole-page Canvas quiz and 130 on SIMnet (newly opened menus first).
Multiple choice costs exactly one API call — the step budget only expands (to 8) once
a drag move starts or on SIMnet, since those need several sequential moves with a fresh
look between each. Confidence and Next-question clicks cost nothing at all, since they
are direct DOM lookups that never touch the API.

---

## File overview

| File | Purpose |
|------|---------|
| `manifest.json` | Manifest V3: permissions, content script, service worker |
| `background.js` | Service worker: Claude API calls, retry loop, frame targeting, trusted input |
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

## Answer log

Off unless the user switches it on (`keepLog`). Each run becomes one entry in
`chrome.storage.local.answerLog`: the host, every step's exact user prompt (as
returned by `callClaude`, with the model and page kind — enough to replay it
against another model, since the system prompt follows from the kind), the
parsed action and a readable summary, the run's outcome, and `after` — a peek
at the page text once the answer is in. For Connect that's taken before the
last post-click (after the confidence rating, before Next), where the
Correct/Incorrect verdict shows; for SIMnet at the end of the task, where the
incorrect popup and hint show. The thumbs-down (`LOG_FLAG`) marks the latest
run on the sender's host.

One promise queue serialises every write, so an append and a flag can't
overwrite each other. Capped at 300 entries and ~6M characters, oldest first
out. Runs that never reached Claude aren't logged, and a failed write is
dropped rather than holding up the reply.

## Tests

```
npm install
npm test
```

Prints one line per area and a verdict:

```
✓ Every feature: question types, models, errors, stop, settings  (40 checks)
✓ SIMnet, Connect and Canvas on the same default settings  (12 checks)
...
✓ Everything works. 11 areas, 100+ checks, 20s.
```

A broken area lists the exact checks that failed and the command to rerun it
alone. GitHub runs the same thing on every push (`.github/workflows/test.yml`),
so each commit shows a ✓ or ✗.

**How it works.** `test/harness.js` loads the real `background.js` and
`content.js` into jsdom and wires Chrome's messaging between them, faking only
Claude's replies (and the debugger, which records the keys it would send). So a
test is "this page, this reply → these clicks", through the same code a user
runs. `test-features.js` covers every user-reachable feature; `test-platforms.js`
runs SIMnet, Connect and Canvas on one default configuration; the smaller
suites pin specific bugs that shipped.

**Proving a test catches something.** `EXT_DIR` points the harness at another
copy of the extension. Run a new test against the previous commit — it should
fail there and pass now:

```
mkdir /tmp/old && git show HEAD~1:extension/content.js > /tmp/old/content.js \
               && git show HEAD~1:extension/background.js > /tmp/old/background.js
EXT_DIR=/tmp/old node test/test-features.js
```

**Limits.** These are copies of each site's markup, not the sites. They catch
the extension breaking; they can't catch McGraw Hill or Instructure changing
their pages. For that there's *Check this page* in the control bar, which
reports what the extension can see on the real page.

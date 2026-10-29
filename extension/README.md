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
occasionally open with prose and break the parse. Both models (Haiku 5.5 and
Sonnet 5.5) get **structured outputs**: `output_config.format` with a JSON schema,
which constrains the whole response shape. (Prefill, seeding the reply with
`{"action":"`, returns a 400 on both; the `prefill` option in `MODELS` remains for
a model that takes one.) Opus 5.5 was dropped: it cost twice what Sonnet 5.5 does.

Either way a bracket-counting fallback extracts the first complete `{...}` block in case
trailing text appears after the closing brace, and the parsed action is validated against
its required fields before execution.

Other per-model differences are handled in the same table. A non-default `temperature`
is a 400 on both. Both think by default (no `thinking` field is sent), and thinking
counts against `max_tokens`, so Haiku 5.5 gets 2048 and Sonnet 5.5 8000, each at
`effort: low` (the defaults are medium for Haiku 5.5, high for Sonnet 5.5); worksheets and SIMnet retries go to `medium`. Response parsing looks
for the `text` block rather than `content[0]`, since thinking blocks (and, after a
fallback, a `fallback` marker block) come first.

The safety classifiers can decline a request: HTTP 200, `stop_reason: "refusal"`, no
answer. Sonnet 5.5 opts into server-side fallback (`fallbacks: "default"`,
header `server-side-fallback-2026-07-01`), which re-runs a declined request on the
model Anthropic recommends for that category. Haiku 5.5 has no server-side fallback,
so on Auto a question it declines is re-asked once of Sonnet 5.5. A refusal that
survives is reported as such and not retried. Saved choices of models the menu has
replaced carry over: `claude-haiku-4-5` → `claude-haiku-5-5`, `claude-sonnet-5` →
`claude-sonnet-5-5`, and a saved `claude-opus-5` / `claude-opus-5-5` → `claude-sonnet-5-5`.

### Auto model choice

On **Auto** (the default: Haiku 5.5 with `autoUpgrade` on), every page starts on Haiku
5.5, and Sonnet 5.5 takes over only where Haiku has already fallen short. Before 1.0.14
`pickModel` sent a page to Sonnet at once when it needed working out rather than recall
(`isHard`: SIMnet, worksheets, drag questions, and calculation questions — three or more
distinct dollar amounts or percentages across the question and its choices, `isMath`;
Canvas excepted, since a whole quiz on one page would add up every question's), because
a real accounting log had Haiku, at low effort, wrong or giving up on every calculation.
Now those pages stay on Haiku but are given what Sonnet had: `MODELS[].hard` makes it
think at `medium` effort with `maxTokens` 8000 (a worksheet doubles that, as before),
and Sonnet comes in on any of these: (1) a first-step `none`, a click that picks no
choice, or a refusal (below); (2) on a hard page, a step that fails or a reply that
can't be used (ran out of room, not an action, an item that isn't there) — `hardPage`,
`escalated`; (3) SIMnet marking a formula wrong, retried with its hint (Autopilot, never
on the last attempt); (4) a graded SIMnet task where a wrong answer would stand — the
attempt counter is showing and no retry is possible (the last attempt, or Answer only) —
which is Sonnet from the start. An ungraded SIMnet page, with no counter, stays on
Haiku. **Sonnet for hard questions** (`hardOnSonnet`, More → Cost, off) brings back the
old plan: those pages start on Sonnet at `low` effort, and the request is word for word
what picking Sonnet 5.5 sends. An ordinary question is the same request as before in
every setting. The cost of Haiku-first on a hard page is accuracy that has not been
measured against Sonnet's (no API key was available to do it); More → Cost and the log's
per-step `usage` are how to see what it costs, and the wrong answers are the other half.

Haiku can still give up on a question it could see. On Auto, a first-step `none`, or a
click that picks no radio/checkbox on a page that has them (the question's own box, a
confidence button), is taken as that: the step is re-asked once of Sonnet 5.5 before
the run stops; so is a question Haiku 5.5 declines. With a model picked by hand, nothing
is re-routed.

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
  The page text comes from `pageRoot()`: of the page's main/article/form areas,
  the one with text that holds the most controls. Connect's first such area is an
  empty form, and taking the first one left the model no page text at all. The
  question each control sits under is stated once, in full, above the page text.
- **Connect worksheets** — every box is sent (the cap was once 60 in all, which
  dropped the last two dates of a 74-box table). Labels come from the table as
  drawn (`tableGrid`), so rowspans (a date over two entry lines, labelled
  "(line 2 of 2)") and colspans (two rows of headers) don't shift columns, and a
  "$" cell is never a row name. A row named by a dropdown is labelled by its row
  number. Worksheets think at `effort: medium` with twice the room, and
  a heartbeat keeps the bar's 90s silence timer from firing mid-think.
- **Financial statement effects** — a Balance Sheet (Assets, Liabilities,
  Stockholders' Equity: Common Stock, Retained Earnings) over an Income Statement
  (Revenues, Expenses, Net Income), a dropdown and a box on every line of the
  first four. `tableLabel` treats a row with dropdowns in several columns as
  *paired*: a dropdown names only the box right beside it (the leftmost one used
  to name every box after it, so a Liabilities box was "named by" the Assets
  dropdown), a dropdown is "Assets — row 2's name", and only lines with something
  to fill are counted as rows, not the heading rows that start with a word.
  `WORKSHEET_HINT` has a paragraph for these (effects not balances, minus signs,
  it must balance, costs to get an asset ready are its cost).
- **Dropdown cells in worksheets** — a Connect worksheet cell (`td.responseCell`) whose
  editor is a dropdown took some answers and not others, and each was reported filled:
  `typeIntoCell` typed and pressed Enter 60ms later, before the list had opened, and never
  read the cell back. Now every cell is read back (`READ_CELL`) after each try and
  compared (`cellHolds`: amounts by value within rounding, a name by its exact words) and
  tried again a different way if it doesn't hold what was meant: typed at 25ms with 350ms
  for the list to open; typed at 90ms with 700ms, the entry clicked in the list if one is
  showing (`CLICK_OPTION`, matching the exact words, only inside a listbox / menu /
  autocomplete: `listedOptions`); the cell opened a second time first. Arrow keys are not
  used: on a sheet they move the selection. A cell that still doesn't hold it is missed
  and reported with what it shows and what the list showed (`LIST_OPTIONS`), the editor
  is closed with Escape, and those entries go into the retry's history so a label that
  isn't one of them is corrected. A filled cell used to be listed by what it held, so on
  a retry no row could be told from another; a worksheet cell is now listed by its row and
  column with what it holds as `value=` (not SIMnet's, which are named by content, and
  only where the label was the content). Verified against a simulator with the four ways
  such an editor misbehaves; 8 of its 13 checks fail on 1.0.12, with the cells empty and
  the bar saying it was done. *Copy page details* now includes the focused element, the
  first cells and any open list, to read the real widget.
- **Quiz pages** — the newer Canvas quizzes (and other sites') put every question on
  one page, each as a block, and draw the choices themselves: the real radio sits
  see-through (`opacity: 0`) over a styled stand-in, which `isRendered` counted as
  not on the page, so the page had no choices at all and the ordinary path would
  have taken it for one question anyway. `quizBlocks` finds each group of radios
  (by `name`, else the `radiogroup` / `fieldset` it is in), takes the widest box
  holding that group and no other, and needs at least two blocks, each with more
  than 25 characters of text (a rating scale isn't a question). The page is then
  read like Canvas Classic: `isCanvas`, every choice tagged with its question
  (`blockQuestion`: the longest piece of text in the block that isn't a choice or
  a control), answered in one `clickMany`, never submitted; the bar says "Quiz
  page" (`quizLabel`). Not on `*.mheducation.com`, SIMnet, or Classic Canvas (which
  match first). Separately, when the ordinary path finds no choice at all but there
  are see-through ones (`seeThrough`: not hidden, not zero-size), they are listed.
  Written without sight of a real New Quizzes page: `Copy page details` is how to
  see how one is built.
- **Cost** — measured, then cut without touching what the model is sent. A real day's
  bill (240 Sonnet 5.5 calls, $4.65) was about 40% input and 60% the model thinking
  (billed as output, ~1,200 tokens a call at `effort: low`), and a SIMnet formula
  question took 2.5 calls because Enter was one of them. What is done by default
  cannot change an answer: (1) the long instructions (SIMnet's and the worksheet's,
  past the 512-token cache minimum) go as one `cache_control` block (`systemFor`);
  (2) a formula typed into a cell by key presses is followed by Enter (Ctrl+Shift+Enter
  for an array formula) without a call, as it was in 28 of 28 logged formulas, and the
  verdict wait that follows ends the question; (3) `usage` from every reply is priced
  (`costOf`, `MODELS[].price`; cache reads a tenth, writes 1.25x) and added to a running
  total (`recordSpend`, shown under More → Cost, `SPEND_GET` / `SPEND_RESET`) and kept
  on each log step. Verified: with the setting off, the first request of a SIMnet
  formula, a Connect question and a calculation is byte-identical to the previous
  version's but for the cache marker (that was before Haiku-first, 1.0.14, which does
  change the model: see Auto model choice). **Cheapest formulas** (`cheapFormulas`, off) is
  the part that changes what the model reads: on a graded exam where a retry is
  possible, a formula task (`isFormulaTask`: the first sentence says to
  enter/type/write a formula or function, and doesn't mention a dialog, ribbon, button,
  menu or tab) is sent with the list cut to the cells (`only`, numbers unchanged) and
  the page text stripped of the ribbon's words and the clock (`tidySimnetText`), and a
  reply that isn't typing gets the whole list; a wrong verdict's retry has everything.
- **Matching questions** — a Connect matching question (drop boxes beside labels, a
  pool of cards) has no inputs, and a real run stopped on `Referred to item 0, which
  isn't on the page`: the list was empty. `findQuestionFrame` now counts drag
  handles (`drags`) and buttons as well as inputs, so a stray frame with one hidden
  input can't outscore the page; and when the chosen frame's list comes back empty
  `busiestFrame` swaps in the frame with the most things in it. `DRAG_SEL` knows
  react-beautiful-dnd (`data-rbd-…`), hello-pangea (`data-rfd-…`) and dnd-kit
  (`aria-roledescription="draggable"`), and lists such handles whether or not they
  say `role="button"`. An empty list with nothing to act on now ends the run with
  a message pointing at **Copy page details** (More → Troubleshooting):
  `probeStructure` runs inside every frame and reports its size, text, iframes,
  shadow-root hosts (and how many controls sit inside them, which the page reader
  does not see into), counts of buttons/inputs/draggables, and the attributes and
  HTML of up to 14 drag-like elements, so a page built some other way can be read
  from what is actually there. Moves themselves are the keyboard ones (Space lifts,
  arrows move, Space drops), which need the library's keyboard sensor.
- **Connect after the answer** — the graded page can hold the way on behind a
  gate. `advanceToNext` (background) is what the preset's Next click runs:
  `connectState` (content) says what is on screen — `graded`, `needsResource`
  ("Select a concept resource to continue."), and which of resource / back / Next
  can be pressed — found by what they *say* (`buttonScore`: *Read About the
  Concept*, then *Clarify with AI Reader*; *To Questions* / *Back to Questions*;
  Next, never anything with back/skip/submit/finish/exit/end). Each hop: back if
  that's all there is, the resource if the page is gated, else Next; then
  `movedOn` looks again, because a click on a Next greyed out by class alone
  "succeeds" and does nothing. Up to 6 hops a round. On a Connect host, if
  that gets nowhere, `askWhatToPress` gives the model the page with a screenshot,
  tags and a prompt that forbids Submit/Finish/Exit (checked again on the label it
  names, `NEVER_PRESS`), at most twice, the second on the stronger model. The
  failure message lists what was pressed and the buttons seen.
- **Answer memory** — Connect shows the right answer after a wrong one.
  `connectResult` (content) reads "Your Answer … incorrect" and the lines under
  "Correct Answer", keeping the page's own choices whose text is there (exactly,
  else by containment, the longer when one is part of another). Before the last
  post-click, `learn` stores them in `chrome.storage.local.answerBook`, keyed by
  a fingerprint of the question's words and the *sorted* set of choice labels
  (so shuffled choices still match). On the next run, step 0 looks the key up and
  clicks the remembered choices without calling the model (`recallAction`; log
  model `memory`, the bar says "remembered"). Only questions of ticked choices on
  a `*.mheducation.com` page; a page of several questions, or two choices with
  the same label, isn't remembered. A remembered answer the page marks wrong is
  replaced by the right one shown, or dropped when the page doesn't say. 800
  entries at most, the oldest out first; `rememberAnswers` (default on) and
  `BOOK_COUNT` / `BOOK_CLEAR` are the setting and the bar's count and Clear.
  Questions that aren't ticked choices (cards to drag, worksheet dropdowns) are
  kept as words: `looseQuestionId` fingerprints the question's words and the sorted
  labels of the cards/cells/boxes (never what they hold now); on a wrong verdict
  `learn` stores the lines under "Correct Answer" (`n`, 800 characters, 12 lines),
  and the next time the key is found `rememberedNote` goes to the model as the
  `instruction` of every call of the run (log: in each step's prompt). That case
  can't be clicked from memory (`recalled` stays false). `connectResult` takes the
  box to mean a wrong answer when no "Your Answer" pill is shown (`GRADED` no
  longer takes the box's own "Correct Answer" heading for the pill).
- **Drag state** — a hello-pangea / react-beautiful-dnd / dnd-kit card used to be
  listed by its words alone, so the model couldn't tell where a card was after a move
  or what boxes there were; a real matching question got one card moved and stopped.
  `dragPlace` (content) gives each card `in "<label>", place N of M`, the label being the
  aria-label of its droppable or the text of the row it sits alone in (a list sharing
  its row with others is "the pool"; one list alone is "list 1"), and `dragSummary`
  puts a "Drop areas" line, with what each holds and what to do when a move changes
  nothing, at the head of the page text (`dragZones`). `dragLeft` counts pool cards
  while a labelled box is empty: "done" then is not accepted (`dragNudges`, twice at
  most). `MAX_STEPS_DRAG` is 14. The keys are the same Space / arrow / Space; whether a
  key crosses from one list to another depends on the page's layout and has not been
  seen on a real Connect page. If the log shows a card not moving, real mouse events
  through the debugger (`Input.dispatchMouseEvent`) are the next thing to try.
- **Parts** — tabs named Required 1 / Required 2 / Req A / Part 1 (`partTabs`).
  After a part is answered the background opens the next unanswered one
  (`OPEN_PART`) and answers it in the same run; Next is pressed once, after
  the last. A tab is marked done when it's opened, so one that won't open
  can't loop.
- **Hiding the bar** — the bar's – button, the `toggle-bar` command
  (Alt+Shift+H, rebindable at chrome://extensions/shortcuts) and the popup's
  switch all write one setting, `barHidden`; every open page follows it
  through `storage.onChanged`. Only the bar is hidden: a run carries on.
- **Finding Next** — `CLICK_TEXT` matches only usable buttons, so a greyed-out
  one earlier on the page (a question's own Next, on its last Required tab)
  no longer hides the real one. Next and the Required tabs are looked for in
  the question's frame, then in the page around it (`inQuestionOrTop`).
- **Stop** — checked again the moment Claude's answer arrives, so an answer
  that comes back after stop is never acted on.
- **Number boxes** — `type="number"` blanks anything but a plain number, so
  "$41,000", "7,200" and "(7,200)" are cleaned to 41000, 7200 and -7200, and a
  box left empty by a value it refused counts as a miss.
- **Screenshots** — `scrape()` sets `needsPicture` when a page has an image,
  canvas or svg ≥ 120×60 in view (outside header/nav/footer/buttons), or hardly any
  text. The background then adds `captureTab` — `tabs.captureVisibleTab` of the
  window, only if the tab is the active one, shrunk to 1568px on a side in the
  service worker (`OffscreenCanvas`) — as an image block ahead of the text. It's
  also tried once when the text alone gives "none" or a click that picks no choice,
  before a stronger model is. It goes to whichever model is answering: Haiku 5.5
  to begin with, Sonnet 5.5 for a question that Auto steps up on (about 0.4¢ more on Sonnet, 0.02¢ on Haiku).
  The model still answers with listed items by number — the image is to read, not
  to point at. On SIMnet only once a task is going wrong (`ungradedDone`, or a retry
  after a failed step), not on every step; a failed capture just means text
  only; the log records that there was one, not the image. Needs `<all_urls>`.
- **Numbered tags (set-of-marks)** — like Vimium's hints. For the instant of a
  capture, `MARK` (content.js, `mark()`) draws a yellow tag with the item's number
  from the list, and a red outline, on every listed item that is on screen (up to
  150; a tag sits beside a small item and is moved off any other tag, kept inside
  the window), on a layer of its own: a closed shadow root, `pointer-events: none`,
  `aria-hidden`, in the browser's top layer (a popover) so it shows above a modal
  `<dialog>`. `captureTab` sends MARK to the question's frame, captures, and always
  sends `UNMARK` after (awaited, 2.5s cap each); the layer also removes itself after
  6s. Chrome sometimes returns the screen from a frame earlier, so the capture is
  checked for the tags' yellow (`tagPixels`, ≥25 px per tag) and retaken up to 3
  times; if they never show the model is told there are none. The prompt says the
  tags match the list's numbers and an untagged item is off screen. The model still
  answers with list numbers, so nothing downstream changed.
- **Data tables in a question** — tables with no blanks (an inventory schedule, a
  list of events) are sent first, one row a line with cells divided by " | "
  (`dataTables`), so a table sitting beside the question rather than in it is
  never lost, and columns read as columns. Page text has each `<select>`'s own text
  cut out of it (`textOf`): a select's innerText is every option, and sits in the
  page's as one piece. The page itself is never touched.
- **Financial statements** — a dropdown counts as a worksheet blank wherever it
  is, table or divs, and with two or more present so does every text box beside
  them; unlabelled ones take the text just before them (`nearbyLabel`). Every
  custom dropdown is opened once to read its list (12s budget, not a small cap),
  and a list shared by many dropdowns is sent once, the rest "(same as [N])".
  Angular Material (`mat-select`, `mat-option`) and `ng-select` are recognised
  as well as ARIA comboboxes. The worksheet prompt has statement guidance:
  compute from the trial balance, pick each account once, fill dropdown and amount.
- **Dropdowns** — a `<select>` is set by option text, matched loosely (same
  words, then starts-with, then contains), or by value; never to a value it
  doesn't have. A custom dropdown (`role="combobox"`, `aria-haspopup="listbox"`)
  is opened, and the matching `role="option"` clicked. Ones whose list isn't
  in the page until opened are opened, read and closed before the scrape, so
  the model sees their options — once each, in the question area only, never
  on SIMnet or a peek.
- **SIMnet** — detected by its grid (`td.grdbdy-cell`). Up to ten steps per task,
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
- **SIMnet formulas** — from a real log of 8 formula tasks, 7 graded wrong though
  every formula was right. SIMnet's own report of the steps said why: `typed =RIG
  in cell D2, typed HT(A2,2) in cell D2`. The function-name list that opens after
  `=` and three letters, and the argument hint after `(`, reset SIMnet's editor,
  and what had been typed before was gone (the cell held `HT(A2,2)`); the one
  that came out right had been typed in one chunk. Keys went 25 ms apart.
  `typeFormula` (background) now types a formula starting `=` in stages that end
  where those open (`stagesOf`: three characters, after each `(`, every 12), and
  after each asks the page (`READ_EDIT`, content.js) what the editor holds. The
  page answers `match`, or `have` — only the *tail* of what was typed, in a text
  box or twice in the page's lines (formula bar and cell): the one symptom taken
  as damage; a cell reference like the Name Box's `D2` never is, and anything
  else is "can't tell", which carries on as before. Damage is cleared (Backspace)
  and typed again at 110 ms a key. Failing that the cell is cancelled (Escape)
  and tried another way: `=` as a key and the rest inserted whole
  (`Input.insertText`), then one key at a time at 200 ms. Enter is never pressed
  on a formula known to be damaged: the last resort is an error naming what was
  wanted. Each run's log entry has `typing`: the formula, and which way worked
  and how many repairs. Plain values still go in at 25 ms with nothing read back.
  `scripts/real-chrome-simnet.js` reproduces the fault in real Chromium (the old
  code leaves `2)` in the cell).
- **SIMnet, from a second exam** (40 formula tasks, 70% right): the log showed more
  than the typing fault. (1) The reply schema names every field, so the model fills
  the ones it has no use for with `""`: six runs stopped on `from must be a cell
  address like B7, got: ""` after a good click. Empty and `null` fields (and
  `row: 0`) are now dropped before the reply is checked. (2) A line break on the end
  of typed text is dropped: Enter is a key press of its own. (3) After Enter or OK,
  on a graded exam, the verdict is waited for (up to 3s) before the next call: a
  popup that hadn't arrived yet read as "not graded", and the model went off to the
  Formulas ribbon's Function Arguments dialog, which needs more steps than it has.
  (4) That dialog redraws its boxes after each is filled, so an element the model
  chose could be gone by the time of the fill ("[16] left the page"): `liveElement`
  finds its twin in the page as it is now (same tag, text, type and name, the same
  number along among alike ones) from a quiet re-read that leaves the model's list
  alone. (5) The window's own minimize / restore / close buttons are not offered
  (a run clicked Close). (6) `READ_EDIT` also notices characters dropped from the
  middle (a `(` gone), but only in the focused editor; and only a focused or
  contenteditable box is judged at all, not the Font Size box saying `10`. (7)
  The prompt says array formulas are Ctrl+Shift+Enter.
- **SIMnet, from a third log** (101 runs; Connect nearly all right; 32 formulas typed
  whole, 14 repaired on the way): (1) "in the selected cell" names no cell, and `type`
  with nothing named and nothing open was refused. `selectedSheetCells` (the cells
  the list shows as `(selected)`) is now where it goes (the active one, else the
  first of a block). (2) A selected block for an array formula's results (G1:G3) is
  kept: naming one of its cells no longer clicks it, which shrank the block to one
  cell. (3) Ctrl+Enter for an array formula (the task, or SIMnet's hint, says
  "array formula" or "Ctrl+Shift+Enter") is sent as Ctrl+Shift+Enter: the model sent
  it with the hint in front of it, twice. (4) The prompt gives current function names
  (RANK.EQ not RANK; SYD, not SOYD, for sum-of-the-years' digits) and says a dialog's
  boxes go in one fill: the run typed SOYD, then took one Function Arguments box a
  reply and ran out of steps. SIMnet gets ten steps (`MAX_STEPS_SIMNET`), not eight.
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
only as much of the page as the platform needs. Page text is cut to 2,000 characters on
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
| `../scripts/package.js` | `npm run package` builds `dist/page-agent-<version>.zip` for the Chrome Web Store; `test-package.js` checks it. The listing, privacy answers and images are in `../store/`, the privacy policy in `../PRIVACY.md` |
| `popup.html`, `popup.js` | The toolbar button's popup: a switch to show or hide the control bar (`barHidden`), and the shortcut that does the same |

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
task legitimately runs for minutes, so the background sends a `PROGRESS`
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

**In real Chrome.** `npm test` runs against copies of pages in jsdom. What only a
real browser can show — the package loading, the bar drawing and dragging, the
popup and shortcut, a real screenshot, the numbered tags actually being in it (it
counts their yellow pixels), tags above a modal `<dialog>`, a whole run through real
clicks — is `scripts/real-chrome.js` (43 checks):

```
npm install --no-save playwright-core
node scripts/real-chrome.js            # CHROMIUM=/path/to/chrome if it isn't found
```

`scripts/real-chrome-connect.js` does the same for the Connect flow — a wrong
answer, the concept resource, back, Next, and the right answer given from memory
the second time — on a page served as `learning.mheducation.com`.

It isn't part of `npm test` because that has to run anywhere (CI included).

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

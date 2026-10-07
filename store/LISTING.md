# Putting Page Agent on the Chrome Web Store

Once it's on the store, your friends install it with one click and Chrome keeps it up to date by itself. They never download anything again.

## What you do, once (about 20 minutes, plus waiting for Google)

1. **Make a developer account.** Go to <https://chrome.google.com/webstore/devconsole>, sign in with your Google account and pay the one-time $5 fee. Google may ask you to verify your email or identity first. When it asks whether you're a *trader*, answer **No**: you're not selling anything.
2. **Upload the extension.** Click **New item** and upload **`page-agent-1.0.1.zip`**. Download it here:
   <https://github.com/ryanm53/Test-1-kiki/raw/claude/page-agent-extension-0xpw4s/store/page-agent-1.0.1.zip>

   ⚠️ Not GitHub's green **Code → Download ZIP** button: that's the whole project (tests, notes, these instructions), and the store turns it down with *"Files outside directory with manifest … are not allowed"*. Upload the zip from the link exactly as it downloads; don't unzip it first.
3. **Fill in the four tabs** by copying from the sections below: **Store listing**, **Privacy**, **Distribution**, and **Test instructions** if it's shown.
4. **Submit for review.** Google usually takes a few days, sometimes a few weeks. You'll get an email.
5. **Send your friends the link** from the item's page once it's approved.

## What your friends do, once

1. Remove the old copy first: open `chrome://extensions`, find **Page Agent** (it may still say *Claude Page Agent*) and click **Remove**. Otherwise they'll have two bars.
2. Open your link, click **Add to Chrome**.
3. Paste their API key into the bar's settings again. The store copy can't see the old copy's settings.

From then on, updates arrive by themselves.

## Each update after that

I bump the version number in `manifest.json` (the store won't take the same number twice) and build a new zip. You upload it under **Package → Upload new package**, then **Submit for review**. Once it's approved, everyone's Chrome updates within a few hours.

---

## Store listing tab

**Name** (comes from the zip): Page Agent

**Summary** (comes from the zip):
Answers the questions on your coursework and quiz pages with Claude, using your own Anthropic API key.

**Description:**

```
Page Agent puts a small control bar on your coursework pages. Press play and it reads the question on screen, asks Claude for the answer, and fills it in.

WHAT IT HANDLES
• Homework questions — multiple choice, select all that apply, fill in the blank, dropdowns, accounting worksheets (including ones split into Required 1 / Required 2 tabs) and drag-and-drop. It rates its confidence and moves on to the next question.
• Simulated Excel tasks — ribbon menus, dialogs, cells, ranges, sheet tabs, right-click menus and typing. It reads the Correct/Incorrect result, and never spends your last attempt.
• Quizzes — every question on the page at once, or one at a time. It never submits a quiz for you.

THREE MODES
• Autopilot — answers and keeps going through the whole assignment.
• One question — answers one, then stops.
• Answer only — picks the answer and lets you click Next.

YOUR OWN KEY, YOUR OWN COST
Page Agent uses Claude through your own Anthropic API key (console.anthropic.com). On Auto, easy questions go to the cheapest model (a few cents per 100 questions) and hard ones (worksheets, calculations, spreadsheets) to a stronger one (around a cent each).

OUT OF THE WAY WHEN YOU WANT
Drag the bar anywhere, or hide it with the – button and bring it back with Alt+Shift+H or the toolbar button.

PRIVATE
Your key and settings stay in your browser. The question is sent only to Anthropic's API, only when you press play. No accounts, no tracking, no analytics.
```

**Category:** Education

**Language:** English

**Store icon:** the 128×128 icon is in the zip. Upload `extension/icons/icon128.png` if the form asks for it separately.

**Screenshots** (1280×800): `store/screenshot-1-connect.png`, `store/screenshot-2-settings.png`, `store/screenshot-3-canvas.png`

**Small promo tile** (440×280): `store/promo-small.png`

---

## Privacy tab

**Single purpose:**

```
Answers the quiz or homework question on the current page, when the user presses play, using the user's own Claude API key.
```

**Permission justifications:**

| Permission | Justification to paste |
|---|---|
| `storage` | Saves the user's settings and their Anthropic API key in their own browser, so they don't re-enter them on every page. |
| `scripting` | Adds the control bar to tabs that were already open when the extension was installed or updated, and finds which frame on the page holds the question (some coursework sites show questions inside embedded frames). |
| `debugger` | Drag-and-drop questions and spreadsheet cells on some coursework sites only respond to real key presses, which only the debugger can send. It's attached to the tab the user started, only while answering, and detached straight after. |
| Host permission `<all_urls>` | Course sites run on each school's own web address and use several domains and embedded frames, so the extension can't list them in advance. It only reads a page when the user presses play. `api.anthropic.com` is where the question is sent to be answered. |

**Are you using remote code?** No, I am not using remote code.

**Data usage:** tick these:
- **Authentication information**: the user's own API key, stored in their browser and sent only to Anthropic.
- **Website content**: the question on the page, sent to Anthropic's API when the user presses play.

Then tick all three statements: not sold to third parties; not used or transferred for purposes unrelated to the single purpose; not used to determine creditworthiness or for lending.

**Privacy policy URL:**

```
https://github.com/ryanm53/Test-1-kiki/blob/claude/page-agent-extension-0xpw4s/PRIVACY.md
```

---

## Distribution tab

**Visibility: Unlisted.** Only people with the link can find it or install it. It won't show up in store searches.

**Regions:** all regions.

---

## Test instructions tab (if shown)

```
Page Agent needs the reviewer's own Anthropic API key (console.anthropic.com) to answer questions; there is no login of ours. Without a key, the bar shows "Add your API key to start", and the gear opens its settings. With a key, open any multiple-choice page, press play, and it picks an answer. The toolbar button's popup shows or hides the bar.
```

---

## If Google says no

Google may turn it down, or take it down later: it uses powerful permissions, and it answers graded coursework. If that happens, the fallback is the one-click updater from before. Your friends' bars would say "Update available", and they'd double-click one file. Ask and it gets built.

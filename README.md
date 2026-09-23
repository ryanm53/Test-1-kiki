# Page Agent

A Chrome extension that reads the question on screen and answers it for you, then moves to the next one.

Works on **McGraw Hill Connect**, **SIMnet** (McGraw Hill's practice Excel), and **Canvas quizzes**. It handles multiple choice, true/false, "select all that apply", fill-in-the-blank, accounting worksheets, and drag-and-drop ordering questions.

It works out which site it's on by itself — you can go from a SIMnet assignment to a Canvas quiz to Connect without changing any settings.

---

## Read this first

This answers graded coursework automatically. Most schools treat that as academic dishonesty, and learning platforms can flag unusual answer patterns and timing. That's your decision to make — just make it knowingly, and make sure anyone you pass this to understands what they're taking on.

It also costs a few cents per quiz in API fees, paid by whoever's key is installed. **Never share your key with someone else** — they'd be spending your money. Each person sets up their own.

---

## What you need

- **Google Chrome** on a Mac or PC
- **About 10 minutes** for first-time setup
- **A payment method** — you'll put around $5 of credit on an account. That lasts a very long time (see [Cost](#what-it-costs) below).

You do **not** need to know how to code.

---

## Step 1 — Download the code

1. Go to the top of this GitHub page
2. Click the green **Code** button
3. Click **Download ZIP**
4. Find the ZIP in your Downloads folder and **double-click to unzip it**

You'll end up with a folder called something like `Test-1-kiki`. Inside it is a folder called **`extension`** — that's the one that matters. Leave this folder somewhere you won't delete it, like your Documents folder. Chrome reads the files from this location every time it runs, so if you move or delete it later, the extension stops working.

---

## Step 2 — Install it in Chrome

1. Open Chrome and type this into the address bar, then hit Enter:

   ```
   chrome://extensions
   ```

2. In the **top-right corner** of that page, turn on **Developer mode** (a small toggle switch)
3. Three new buttons appear in the top-left. Click **Load unpacked**
4. A file picker opens. Navigate into the folder you unzipped and select the **`extension`** folder — the one containing `manifest.json`. Click **Select**

You should now see **Page Agent** listed as a card on the extensions page.

> **If Chrome shows an error**, you probably selected the outer folder instead of the inner `extension` folder. Try again and go one level deeper.

---

## Step 3 — Get an API key

### What is an API key?

The extension doesn't think for itself — it sends the question to **Claude**, an AI made by Anthropic, and Claude sends back the answer.

To do that, it needs permission to use your Claude account. An **API key** is that permission: a long password-like string of text that says "this program is allowed to use my account, and charges go to my bill."

It lives only in your own browser and is never sent anywhere except to Anthropic.

### Getting one

1. Go to **https://console.anthropic.com** and create an account
2. Once logged in, find **Billing** in the menu and add credit. **$5 is plenty** to start
3. Now find **API Keys** in the menu
4. Click **Create Key**, give it any name you like (e.g. "page agent"), and confirm

### ⚠️ Two things that trip everyone up

**1. Copy the key immediately.** It's shown **once**, right after you create it. Close that window and you can never see it again — you'd have to delete the key and make a new one. Copy it somewhere safe before clicking away.

**2. Copy the key, not the key ID.** The page shows two different things:

| What you see | Looks like | Is this it? |
|---|---|---|
| The **key** | `sk-ant-api03-` followed by ~100 more characters | ✅ **Yes, this one** |
| The **key ID** | `apikey_01Ab2Cd...` | ❌ No — this is just a label |

If yours is short, or starts with `apikey_`, it's the wrong one. The real key is long — roughly 100+ characters.

---

## Step 4 — Set it up

1. Open your quiz in Chrome and go to a question
2. Look at the **bottom-left corner** of the page. There's a small dark bar with a **play button ▶** and a **gear ⚙**. It says *"Add your API key to start"*
3. Click the **gear** to open settings
4. Paste your API key into the box and click **Save**. The box folds away to one line: **API key ✓ Saved**
5. Leave everything else on its defaults

> **No bar in the corner?** Refresh the page. The extension only loads into pages that were opened or refreshed after you installed it.

---

## Step 5 — Use it

Press the **play button ▶**. What happens next depends on the site:

| Site | What it does |
|---|---|
| **Connect** | Answers, clicks **High Confidence** and **Next Question**, and keeps going through the whole assignment on its own |
| **Canvas** | Answers **every question on the page** in one go. If the quiz shows one question at a time, it clicks **Next** and keeps going. **It never presses Submit Quiz** — when it's done it says *"Answered. Check it over, then submit it yourself."* |
| **SIMnet** | Does the task on screen — ribbon tabs and their menus, dialogs, selecting cells and ranges, double-clicking a sheet tab to rename it, right-click menus, Ctrl-clicking to group sheets, typing and pressing keys — then stops and says *"Finished. Check SIMnet agrees."* Go to the next task yourself and press play again. If it uses all its steps without finishing, it says so rather than claiming it's done |

Press the same button again — it's now a **stop button ⏸** — to halt at any point.

**Moving the bar:** drag it by its middle — the dark area around the text, not the
buttons — and drop it anywhere on screen. It stays where you put it, on that page
and every page after, so if it ever covers a question or a button you need, just
move it out of the way once.

The bar shows you what's happening as it goes:

| What it says | Meaning |
|---|---|
| **Add your API key to start** | No key saved yet — see Step 4 |
| **Ready · Canvas quiz** | Idle, and it has recognised the page: *Connect*, *SIMnet*, *Canvas quiz*, *Worksheet* or *Drag and drop*. On other sites it just says **Ready** |
| **Answering… · 7** | Working on a question. It's done 7 so far |
| **Next question… · 7** | Waiting for the next question to load |
| **Click Next when ready** | *Answer only* mode: it's answered, and waits for you to move on |
| **Answering… · step 2/6** | Working through a task that takes several steps (SIMnet) |
| **Paused · 7** | Stopped, 7 answered |
| **Answered. Check it over, then submit it yourself.** | Canvas page done. Look it over and hand it in when you're happy |
| **Finished. Check SIMnet agrees, then move to the next one.** | SIMnet task done, as far as it can tell — SIMnet's own right/wrong popup has the final word |
| **Used all 8 steps without finishing** | SIMnet task it couldn't complete. Do that one yourself |
| **Rate limited · 45s** | Went too fast for the API. It waits and resumes automatically — just leave it |
| *Amber text* | Something went wrong. The message explains what |

---

## Settings

Click the **gear ⚙** to open these. Most people only ever need the first two.

| Setting | What it does |
|---|---|
| **Mode** | **Autopilot** *(default)*: answers, rates confidence, clicks Next, and keeps going through the whole thing. **One question**: does one question, clicks Next, then stops — press play for each. **Answer only**: picks the answer and waits for you to click Next, then answers the next one when it appears. Sites without a confidence rating (Canvas, SIMnet) just skip that part |
| **API key** | Your key from Step 3. Once saved it's one line; **Change** replaces it |

Tap **More** for the rest:

| Setting | What it does |
|---|---|
| **Model** | Which AI does the thinking. **Auto** *(default, recommended)* uses the cheapest model for most questions and **Opus 5.5**, the most capable, for SIMnet, worksheets and drag-and-drop — the bar shows **↑ Opus 5.5** when it steps up. Or pick one to use every time: **Haiku 4.5** is fastest and cheapest, **Sonnet 5** is noticeably smarter for about 2× the cost, **Opus 5.5** is the most capable at about 4× |
| **Notes** *(optional)* | Extra context to improve accuracy, e.g. *"This is financial accounting — use GAAP conventions."* Fine to leave blank |
| **Answer log** | *Off unless you turn it on.* Saves each question it answers — what it was asked, what it picked, and how the page looked straight after, which is where Connect shows "Correct"/"Incorrect" and SIMnet its hint — in your browser only. When an answer was wrong, tap the **thumbs-down** that appears on the bar (most reliable in *One question* mode, since on Autopilot it may already have moved on). **Download** saves it as a file you can share to help tune Auto; **Clear** takes two taps. It adds under a second per question while it's on |
| **Troubleshooting** | *Check this page* — see [Troubleshooting](#troubleshooting). *Copy last prompt* copies exactly what was sent to Claude last time |

---

## What it costs

You're billed by Anthropic for what you use. With the default model:

| | Roughly |
|---|---|
| One question | about $0.0005 — **half a hundredth of a cent** |
| 100 questions | **about 5 cents** |
| $5 of credit | **around 10,000 questions** |

On **Auto**, the harder questions (SIMnet, worksheets, drag-and-drop) go to Opus 5.5, which costs about four times as much — around a cent each. Picking Sonnet 5 for everything costs about twice the default, Opus 5.5 about four times. Even so, $5 lasts most people a very long time.

---

## Troubleshooting

**Start here, whatever the problem:** open the gear ⚙, tap **More**, and press **Run** next to **Check this page**. In a couple of seconds it tells you:

- what kind of page it thinks you're on, and how many questions it can see (*"Canvas quiz · 4 questions, 14 answers to pick from"*)
- whether your API key works — and if not, why
- which model and mode you're using

A ✗ on any line tells you what's wrong. If you ask someone for help, send them a screenshot of this.

**"API key is invalid" or a 401 error**
You almost certainly pasted the key **ID** instead of the key. See the warning in Step 3 — the real one starts `sk-ant-api03-` and is very long. Also check for a stray space at the start or end.

**"Rate limit hit"**
You've sent requests faster than your account allows. It counts down and retries by itself — just let it sit. New accounts have lower limits that rise over time.

**Drag-and-drop questions don't work / "Close DevTools"**
Drag questions need Chrome's debugger, and only one thing can use that at a time. **Close DevTools** (the inspector panel) on that tab and try again. You'll briefly see a yellow *"Chrome is being debugged"* banner while it drags — that's normal, and it disappears when it's done.

**"No clickable answer found"**
It hit a question type it doesn't understand. Answer that one yourself, then press play to carry on.

**Nothing happens when I press play**
Check that the gear ⚙ shows **API key ✓ Saved**, and that your account actually has credit on it. **Check this page** tests both.

**The bar disappeared**
Refresh the page. If it's still missing, go to `chrome://extensions` and check Page Agent is still enabled — and that you haven't moved or deleted the folder from Step 1.

**Canvas: nothing happens, or "Couldn't find an answer here"**
Canvas has two quiz systems. This works with **Classic Quizzes** — the address bar shows `/quizzes/` followed by `/take`. The newer *New Quizzes* (the address shows `/assignments/`, and the quiz sits in a box inside the page) isn't supported yet.

**"Claude declined to answer this one"**
Claude's safety filters occasionally turn down a question — mostly ones that look like advanced biology or computer-security research. It automatically tries a different model first; this message means that one declined too. Answer that question yourself and press play to carry on, or pick a different model under **More → Model**.

**It picked a wrong answer**
It isn't perfect, especially on harder material. Under **More**, try setting **Model** to Opus 5.5, or add course context in **Notes**.

---

## Privacy

Your API key is stored in your own browser only. The text of the page you're on is sent to Anthropic to answer the question — that's how it works at all. Nothing is sent anywhere else, and there's no server in the middle collecting anything.

If you turn on the **Answer log**, the questions and answers are also kept in your browser, and they stay there unless you press Download. Turning it off stops new entries; **Clear** deletes what's there.

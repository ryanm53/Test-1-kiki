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
2. Look at the **bottom-left corner** of the page. There's a small dark bar with a **play button ▶** and a **gear ⚙**
3. Click the **gear** to open settings
4. Paste your API key into the **API Key** box and click **Save**. It turns green and says "Saved"
5. Leave everything else on its defaults

> **No bar in the corner?** Refresh the page. The extension only loads into pages that were opened or refreshed after you installed it.

---

## Step 5 — Use it

Press the **play button ▶**. What happens next depends on the site:

| Site | What it does |
|---|---|
| **Connect** | Answers, clicks **High Confidence** and **Next Question**, and keeps going through the whole assignment on its own |
| **Canvas** | Answers **every question on the page** in one go. If the quiz shows one question at a time, it clicks **Next** and keeps going. **It never presses Submit Quiz** — when it's done it says *"Answered. Check it over, then submit it yourself."* |
| **SIMnet** | Does the task on screen (switching ribbon tabs, opening dialogs and so on), then stops and says *"Task done."* Go to the next task yourself and press play again |

Press the same button again — it's now a **stop button ⏸** — to halt at any point.

**Moving the bar:** drag it by its middle — the dark area around the text, not the
buttons — and drop it anywhere on screen. It stays where you put it, on that page
and every page after, so if it ever covers a question or a button you need, just
move it out of the way once.

The bar shows you what's happening as it goes:

| What it says | Meaning |
|---|---|
| **Ready** | Idle, waiting for you |
| **Answering… · 7** | Working on a question. It's done 7 so far |
| **Next question… · 7** | Waiting for the next question to load |
| **Answering… · step 2/6** | Working through a task that takes several steps (SIMnet) |
| **Paused · 7** | Stopped, 7 answered |
| **Answered. Check it over, then submit it yourself.** | Canvas page done. Look it over and hand it in when you're happy |
| **Task done. Check it, then move to the next one.** | SIMnet task done |
| **Rate limited · 45s** | Went too fast for the API. It waits and resumes automatically — just leave it |
| *Amber text* | Something went wrong. The message explains what |

---

## Settings

Click the **gear ⚙** to open these.

| Setting | What it does |
|---|---|
| **Mode** | *Answer, confidence, next* does the full flow — leave it on this everywhere; sites without a confidence rating (Canvas, SIMnet) just skip that part. *Answer only* stops after picking the answer, so you click through yourself |
| **Auto-continue** | On: works through the whole quiz. Off: does one question per press of play |
| **Model** | Which AI does the thinking. **Haiku 4.5** is the default — fastest and cheapest. **Sonnet 5** is noticeably smarter for about 2× the cost. **Opus 5** is the most capable, about 5× |
| **Upgrade on hard questions** | On by default. SIMnet tasks, multi-blank worksheets and drag-and-drop questions need real reasoning, so those automatically use one tier up while everything else stays on your pick. When it upgrades, the status bar shows **↑ Sonnet 5** so you can see it happen. Turn this off to always use your chosen model |
| **Notes** *(optional)* | Extra context to improve accuracy, e.g. *"This is financial accounting — use GAAP conventions."* Fine to leave blank |
| **API Key** | Your key from Step 3 |
| **Reference Tabs** | Paste the address of another open tab (your textbook, notes, a study guide) and it reads that as source material when answering |

---

## What it costs

You're billed by Anthropic for what you use. With the default model:

| | Roughly |
|---|---|
| One question | about $0.0005 — **half a hundredth of a cent** |
| 100 questions | **about 5 cents** |
| $5 of credit | **around 10,000 questions** |

Switching to Sonnet 5 costs about twice that, Opus 5 about five times. Even so, $5 lasts most people a very long time.

---

## Troubleshooting

**"API key is invalid" or a 401 error**
You almost certainly pasted the key **ID** instead of the key. See the warning in Step 3 — the real one starts `sk-ant-api03-` and is very long. Also check for a stray space at the start or end.

**"Rate limit hit"**
You've sent requests faster than your account allows. It counts down and retries by itself — just let it sit. New accounts have lower limits that rise over time.

**Drag-and-drop questions don't work / "Close DevTools"**
Drag questions need Chrome's debugger, and only one thing can use that at a time. **Close DevTools** (the inspector panel) on that tab and try again. You'll briefly see a yellow *"Chrome is being debugged"* banner while it drags — that's normal, and it disappears when it's done.

**"No clickable answer found"**
It hit a question type it doesn't understand. Answer that one yourself, then press play to carry on.

**Nothing happens when I press play**
Check that your API key is saved (gear → API Key), and that your account actually has credit on it.

**The bar disappeared**
Refresh the page. If it's still missing, go to `chrome://extensions` and check Page Agent is still enabled — and that you haven't moved or deleted the folder from Step 1.

**Canvas: nothing happens, or "Couldn't find an answer here"**
Canvas has two quiz systems. This works with **Classic Quizzes** — the address bar shows `/quizzes/` followed by `/take`. The newer *New Quizzes* (the address shows `/assignments/`, and the quiz sits in a box inside the page) isn't supported yet.

**It picked a wrong answer**
It isn't perfect, especially on harder material. Try switching the **Model** to Sonnet 5, or add course context in **Notes**.

---

## Privacy

Your API key is stored in your own browser only. The text of the page you're on is sent to Anthropic to answer the question — that's how it works at all. Nothing is sent anywhere else, and there's no server in the middle collecting anything.

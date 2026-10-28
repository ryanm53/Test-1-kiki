# Page Agent — Privacy Policy

Page Agent is a Chrome extension that answers the question on the page you're on, when you press its play button, using Claude through your own Anthropic API key. This page says exactly what it does with your information.

## What stays on your computer

These are kept in Chrome's storage for the extension, in your browser only:

- **Your Anthropic API key**, which you paste in yourself.
- **Your settings**: mode, model, notes, where you've put the control bar, and whether it's hidden.
- **The last request sent to Claude**, so you can copy it under Troubleshooting.
- **Right answers from Connect**, unless you switch it off under More → Right answers. When Connect marks an answer wrong and shows the right one, Page Agent keeps a fingerprint of the question, the first few words of it, and the text of the right choices, so it can answer the same question again without asking Claude. It stays in your browser and is never sent anywhere; Clear deletes it.
- **A running cost total**: how many calls to Claude were made and what Anthropic reported they cost, by model, shown under More → Cost. It holds numbers only, no questions or answers, and Reset clears it.
- **The answer log**, only if you switch it on. It records the questions answered and how the page looked afterwards. It never leaves your browser unless you press Download and share the file yourself, and Clear deletes it.

## What is sent, and where

When you press play (or **Check this page** under Troubleshooting), the extension sends a request to **Anthropic's API** (`api.anthropic.com`) with your API key. The request contains:

- the text of the question on the current page,
- the page's buttons, choices and blanks: their labels and what's already filled in (never the contents of password fields),
- your notes, if you've written any,
- and, only when a question can't be read from its text — it contains a picture, a chart or a table drawn as an image, or has almost no text, or the text alone gave no answer — **a screenshot of the visible part of the tab** you're on. For the instant of the screenshot, small numbered tags are drawn over the page's buttons and choices, and taken down straight after; nothing on the page is changed. On SIMnet only when a task is going wrong (a step failed, or it said it was done and nothing was graded), never of another tab, and the screenshot is not kept: it isn't saved in the answer log or anywhere else.

Anthropic handles that request under its own terms and privacy policy for the API: <https://www.anthropic.com/legal/privacy>.

Nothing is sent anywhere else. There is no server of ours, no analytics, no tracking and no advertising. The developer never receives your API key, your pages or your answers.

## What it does on the page

- It reads the page only to find the question and the controls to answer it with (and, in the case above, to take a screenshot of it), and only when you ask it to: when you press play, or briefly when a page loads, to show what kind of page it is in the control bar.
- On drag-and-drop questions and spreadsheet tasks it uses Chrome's debugger permission to press keys for real, on the tab you started it on, only while it's answering. It lets go as soon as it's done.
- It never submits a quiz or test for you.
- **Copy page details** (More → Troubleshooting), when you press it, copies a description of how the page is built (its size, buttons and drag handles, and the first few words of text) to your clipboard so you can send it to whoever looks after Page Agent. It is never sent anywhere by the extension; you choose whether to paste it anywhere.

## Sale and use of data

Your data is not sold, not shared with anyone besides Anthropic as described above, and not used for anything except answering the question you asked it to.

## Removing your data

Remove the extension from Chrome, and everything it stored is deleted with it. Or, without removing it: **Clear** in the answer log deletes the log, **Clear** under Right answers deletes what it remembered, and **Change** under API key replaces your key.

## Contact

Questions or problems: <https://github.com/ryanm53/Test-1-kiki/issues>

*Last updated: October 28, 2026*

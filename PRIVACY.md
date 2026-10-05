# Page Agent — Privacy Policy

Page Agent is a Chrome extension that answers the question on the page you're on, when you press its play button, using Claude through your own Anthropic API key. This page says exactly what it does with your information.

## What stays on your computer

These are kept in Chrome's storage for the extension, in your browser only:

- **Your Anthropic API key**, which you paste in yourself.
- **Your settings**: mode, model, notes, where you've put the control bar, and whether it's hidden.
- **The last request sent to Claude**, so you can copy it under Troubleshooting.
- **The answer log**, only if you switch it on. It records the questions answered and how the page looked afterwards. It never leaves your browser unless you press Download and share the file yourself, and Clear deletes it.

## What is sent, and where

When you press play (or **Check this page** under Troubleshooting), the extension sends a request to **Anthropic's API** (`api.anthropic.com`) with your API key. The request contains:

- the text of the question on the current page,
- the page's buttons, choices and blanks: their labels and what's already filled in (never the contents of password fields),
- your notes, if you've written any.

Anthropic handles that request under its own terms and privacy policy for the API: <https://www.anthropic.com/legal/privacy>.

Nothing is sent anywhere else. There is no server of ours, no analytics, no tracking and no advertising. The developer never receives your API key, your pages or your answers.

## What it does on the page

- It reads the page only to find the question and the controls to answer it with, and only when you ask it to: when you press play, or briefly when a page loads, to show what kind of page it is in the control bar.
- On drag-and-drop questions and spreadsheet tasks it uses Chrome's debugger permission to press keys for real, on the tab you started it on, only while it's answering. It lets go as soon as it's done.
- It never submits a quiz or test for you.

## Sale and use of data

Your data is not sold, not shared with anyone besides Anthropic as described above, and not used for anything except answering the question you asked it to.

## Removing your data

Remove the extension from Chrome, and everything it stored is deleted with it. Or, without removing it: **Clear** in the answer log deletes the log, and **Change** under API key replaces your key.

## Contact

Questions or problems: <https://github.com/ryanm53/Test-1-kiki/issues>

*Last updated: October 2026*

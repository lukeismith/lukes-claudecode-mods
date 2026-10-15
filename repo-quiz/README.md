# repo-quiz

repo-quiz keeps you sharp about the repository you work in. After each of Claude's replies, a sidebar shows an interview-style question about your code or a short "Did you know?" fact.

Questions cover architecture, how a piece of code works, system design trade-offs, debugging, language semantics, concurrency, testing, security, performance and data modeling ([`categories`](#question-categories), [`difficulty`](#difficulty)). Each answer and each fact cites your actual code and official documentation. You can follow the links to learn more.

Names in code style with a link, such as [`questionsPerHour`](#questions-per-hour), are settings that you can change. Click one to go to its row in [Settings](#settings).

## Install

In a Claude Code terminal session, run this command:

```
/plugin install repo-quiz --marketplace lukeismith/lukes-claudecode-mods
```

1. Answer `y` to add the marketplace.
2. Choose the user scope, so that repo-quiz runs in every repository.
3. Set the options on the next screen, or accept the defaults. You can change each option later in `/config`.

Requirements:

- Claude Code 2.1.295 or later, which supports mods.
- macOS or Linux with Python 3 on the `PATH`. A small Python script keeps the quiz agents read-only (see "Safety").
- A terminal at least 144 columns wide, if you want the sidebar to open by itself ([`openPaneOnStart`](#open-the-pane-at-start)). At any width, `/repo-quiz` opens it.

## How it works

repo-quiz acts after each reply that started from your own message. With the default [settings](#settings), it chooses as follows:

- **A question** comes when all three conditions are true:
  - Fewer than four questions started in this repository in the last hour ([`questionsPerHour`](#questions-per-hour)).
  - Your previous message came more than three minutes earlier ([`rapidReplyMinutes`](#rapid-reply-window)).
  - No question waits for your answer.
- **A fact** comes in all other cases. A model writes facts in batches of five to ten ([`factModel`](#fact-model)). repo-quiz saves them per repository and shows one per reply. Most replies therefore cost nothing.

To see only questions or only facts, change [`mode`](#what-to-show). To start a question at any time, press `q` in the pane or run `/repo-quiz ask`. A question that you ask for ignores the hourly limit, the rapid reply window and a pause, but it obeys the daily budget. repo-quiz drops a saved fact when the code that the fact cites changes.

A background agent writes each question. The default model is Opus ([`questionModel`](#question-model), [`questionEffort`](#question-effort)). Before the agent starts, code collects the context that the agent needs:

- The branch and the recent commits.
- The files that you changed in this session.
- An excerpt of the code that the question is about. Usually this is code that you changed recently. Some files are never the focus ([`excludePaths`](#excluded-paths)).

Every third question is a refresher about code that nobody changed for a long time ([`refresherEvery`](#refresher-question-every), [`refresherMinAgeDays`](#refresher-minimum-age)). Refreshers help you remember how the older parts of your code work.

repo-quiz checks everything that the agent writes before you see it:

- **Code citations.** Each citation must quote a real line of the file that it names.
- **Documentation links.** Each link must load and must contain the quoted passage ([`sourcePolicy`](#documentation-sources)).
- **Support.** A fast Haiku check makes sure that each passage supports its claim.

repo-quiz removes each item that fails a check.

The research can find a real problem in your code, such as a bug, a race, a security hole or a broken invariant. When that occurs, the card shows the problem as a "possible flaw" after you answer ([`flawReview`](#flaw-review)).

The models write in a plain style that comes from ASD-STE100 Simplified Technical English. Each sentence gives one idea, in the active voice, with plain words ([`steWriting`](#simplified-technical-english)).

## Using the pane

To give the pane the keyboard, press ctrl+x tab or click the pane. When you type in the answer box, your keys go into the box. Press Tab to leave the box before you use the other keys.

| Key | Action |
| --- | --- |
| Enter | Adds the typed line to your answer. Enter on an empty line shows the answer. |
| `r` / `s` / `c` | Show the answer / skip the question / clear your draft. |
| `1` / `2` / `3` | Rate yourself: missed it / partly / got it. After repo-quiz shows the answer, the focus starts on "Got it". |
| `u` / `n` / `w` / `k` | Rate the card: useful / not useful / wrong / knew it (facts only). |
| `i` / `f` | Mark a flaw as a real issue / a false alarm. |
| `g` | Grade your answer with a model ([`gradeModel`](#grading-model)). The button shows the estimated price, usually about 2¢. |
| `v` | Show or hide the sources. |
| `d` | Show or hide the full fact while a question is open. |
| `x` | Close the card. |
| `q` | Ask for a new question now. The button shows the estimated price. It appears when no question waits for your answer. |
| `p` / `t` | Pause or resume / open the Stats view. The Stats view also turns repo-quiz off for this repository. |

The top line of the pane shows the repository and the estimated cost for today. When a question is ready and the pane is hidden, a toast tells you ([`toastOnNewQuestion`](#notify-on-a-new-question)). The status line shows the state of repo-quiz and the cost for today ([`statusLine`](#status-line)).

## Commands

| Command | What it does |
| --- | --- |
| `/repo-quiz` | Opens the pane. |
| `/repo-quiz ask` | Starts a new question now. |
| `/repo-quiz pause [minutes]` | Pauses new cards in this repository. The default pause is 60 minutes. |
| `/repo-quiz resume` | Ends a pause. |
| `/repo-quiz off` / `on` | Turns repo-quiz off or on for this repository, until you change it again. |
| `/repo-quiz stats` | Opens the Stats view. It shows your self-ratings by category, the accuracy of the cards, and the cost tally. |

## Settings

Change the settings in `/config`. Each change has an effect immediately. Claude Code keeps the settings in your `settings.json` file, under `pluginConfigs["repo-quiz"].options`. The second line of each name is its key in that file.

| Setting | Default | What it does |
| --- | --- | --- |
| <a id="questions-per-hour"></a>Questions per hour<br>`questionsPerHour` | 4 | The maximum number of questions per repository in one hour, from 0 to 20. 0 gives facts only. |
| <a id="rapid-reply-window"></a>Rapid reply window (minutes)<br>`rapidReplyMinutes` | 3 | When your messages come closer together than this, repo-quiz shows a fact instead of a question. 0 turns off this rule. |
| <a id="what-to-show"></a>What to show<br>`mode` | questions and facts | You can also choose questions only, or facts only. |
| <a id="refresher-question-every"></a>Refresher question every<br>`refresherEvery` | 3 | Every Nth question is about code that has not changed for a long time. 0 means never. |
| <a id="refresher-minimum-age"></a>Refresher minimum age (days)<br>`refresherMinAgeDays` | 30 | A file must stay unchanged for this many days to become refresher material. |
| <a id="difficulty"></a>Difficulty<br>`difficulty` | senior | The interview level: collegiate, senior or staff. |
| <a id="question-categories"></a>Question categories<br>`categories` | all | A comma-separated subset, such as `architecture, concurrency, security`. Partial names also match. |
| <a id="flaw-review"></a>Flaw review<br>`flawReview` | on | When this is on, cards point out real problems that the research found. |
| <a id="documentation-sources"></a>Documentation sources<br>`sourcePolicy` | official preferred | "official only" removes each source that is not in the official documentation for your stack. |
| <a id="excluded-paths"></a>Excluded paths<br>`excludePaths` | none | Comma-separated glob patterns for files that questions never focus on, such as `generated/**, *.pb.swift`. A pattern without a slash matches file names only. For a folder, write `vendor/**`. |
| <a id="question-model"></a>Question model<br>`questionModel` | opus | Haiku, Sonnet or Opus. |
| <a id="question-effort"></a>Question effort<br>`questionEffort` | high | Low, medium or high. A lower effort is faster and costs less. |
| <a id="fact-model"></a>Fact model<br>`factModel` | sonnet | Haiku, Sonnet or Opus. |
| <a id="grading-model"></a>Grading model<br>`gradeModel` | sonnet | Haiku, Sonnet or Opus. |
| <a id="simplified-technical-english"></a>Simplified Technical English<br>`steWriting` | on | When this is on, the models write in a plain style. The style comes from ASD-STE100: one idea per sentence, the active voice, simple tenses and plain words. |
| <a id="daily-budget"></a>Daily budget (USD)<br>`dailyBudgetUsd` | 0 | When the estimated spend for the day reaches this amount, repo-quiz starts no more model runs. 0 means no limit. |
| <a id="open-the-pane-at-start"></a>Open the pane at start<br>`openPaneOnStart` | on | When this is on, the sidebar opens when a session starts. |
| <a id="notify-on-a-new-question"></a>Notify on a new question<br>`toastOnNewQuestion` | on | When this is on, a toast appears if a question is ready and the pane is hidden. |
| <a id="status-line"></a>Status line<br>`statusLine` | on | When this is on, the status line shows the state of repo-quiz and the cost for today. |
| <a id="local-telemetry"></a>Local telemetry<br>`telemetry` | counts only | The records that the Stats view keeps. See "Privacy". |

Each model setting uses the newest model of that family that your version of Claude Code knows. When you update Claude Code, repo-quiz can therefore use a newer model.

## Cost

These figures are approximate, at API list prices, with the default models. The Stats view keeps a running tally of the actual spend.

| Run | Typical cost |
| --- | --- |
| One question (Opus) | about 30¢ to 60¢ |
| One batch of five to ten facts (Sonnet) | about 10¢ to 40¢ |
| One grade (Sonnet) | about 1¢ to 2¢ |
| One source check (Haiku) | less than 1¢ |

A busy hour with four questions costs about $1 to $3. To spend less, do one or more of these:

- Choose Sonnet for questions ([`questionModel`](#question-model)).
- Choose a lower effort for questions ([`questionEffort`](#question-effort)).
- Set fewer questions per hour ([`questionsPerHour`](#questions-per-hour)).
- Set a daily limit ([`dailyBudgetUsd`](#daily-budget)).

On a subscription plan, these figures show API-equivalent usage. That usage counts against the limits of your plan. Anthropic does not bill it separately.

## Privacy

- **Local telemetry.** Telemetry stays on your machine, in `~/.claude/repo-quiz/telemetry/`, and the Stats view uses it ([`telemetry`](#local-telemetry)).
  - "counts only" is the default. It keeps ratings, times, costs and verification counts. It does not keep the text that you type or the content of the cards.
  - "full" also keeps your answers and the cards, so that you can review their quality later.
  - "off" writes nothing.
- **Your conversation.** The reports of the quiz agents never go into your conversation with Claude. They do not use your context and they do not show you an answer early. You can see one short line: "a quiz agent finished. Its card is in the sidebar.".

## Safety

The quiz agents run in the background. A hook script, `hooks/guard.py`, checks each tool call that they make:

- They can read files only in the current repository. The script follows symbolic links to their targets, and refuses `~` and `..`.
- They can run only read-only commands, such as `git log`, `git show`, `git diff`, `git blame`, `rg`, `grep`, `ls`, `find`, `cat`, `head`, `tail` and `wc`. The script refuses pipes, redirects, subshells, unquoted globs, and flags that start programs.
- They can search the web and fetch documentation.
- They cannot edit or write files, and they cannot use other tools.

The guard can only refuse a call. Each call that it accepts also goes through your normal permission settings. In the default permission mode, Claude Code can therefore ask you to approve the web searches of an agent. Auto mode needs no approvals.

To check the guard, run `python3 hooks/guard.py --self-test`.

## Developing

The mod has two parts. The TypeScript function hooks are in `hooks/register.tsx` and the files next to it. The Python guard is `hooks/guard.py`.

- To run your working copy in a session, use `claude --plugin-dir ./repo-quiz`.
- To check a change, run `claude plugin validate ./repo-quiz` and `claude plugin test ./repo-quiz`.

The mods API is in early access, and it can change between Claude Code releases.

## License

Copyright (C) 2026 lukeismith.

repo-quiz is free software. You can share it and change it under the terms of the GNU General Public License, version 3 or any later version. The license gives no warranty. The [LICENSE](../LICENSE) file has the full terms.

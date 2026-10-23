# pi-decide

A [Pi](https://pi.dev) extension that lets the agent ask you structured
questions — **and answers them itself when you are not there.**

Two halves, one tool:

- **Ask.** `ask_user_question` opens a tabbed terminal dialog: up to 8
  questions, 2–8 written-out options each with a description, an optional
  markdown preview beside the list, a free-text row, per-question notes, and a
  Submit tab that reviews everything before it goes back.
- **Decide.** When nobody answers — you are asleep, the run is headless, or the
  session policy says so — a model picks the best option for each question, says
  why, and the answer comes back to the agent **labelled as an autopilot
  decision**, never as your approval.

```bash
pi install npm:pi-decide
```

Then `/reload` if Pi is already running.

> ⚠️ `pi-decide` registers the tool name `ask_user_question`, which is also used
> by `@juicesharp/rpiv-ask-user-question`. Run one or the other: two extensions
> registering the same tool name will fight over the active tool list.

---

## Why the autopilot exists

A coding agent that asks a good question is more useful than one that guesses. A
coding agent that asks a question and then *blocks forever* because the human
went to sleep is worse than either.

Interruptions only pay off when someone is actually there to take them. So
`pi-decide` splits "should I ask?" from "who answers?":

| Mode | Behaviour | Use when |
| --- | --- | --- |
| `off` *(default)* | Ask, and wait — **but not forever**. If nobody answers within `deadlineSeconds` (15 min by default), the autopilot answers. Because asking is not a promise that a human is still there. | You are at the desk. |
| `on` | Never ask. The model answers every questionnaire itself. | Long unattended runs, cron, CI. |
| `auto` | Open the dialog, but count down. No keypress within N seconds → the model answers. | "I'll be here for a while, but not for all of it." |

**The one guarantee that holds in every mode: a run never waits forever.** That
is a system invariant rather than a policy outcome — which is why even `off` has
a safety net. `off` means *"prefer to ask me"*, not *"wait for me indefinitely"*:
a run that waits indefinitely for someone who went to sleep is exactly the bug
this extension exists to fix.

If you genuinely want a dialog that waits until you come back, say so
explicitly:

```text
/decide hold          # this session: ask and wait forever, no safety net
/decide deadline 0    # same thing, expressed as config
```

`hold` is deliberately awkward to reach and warns when you use it.

Switch per session:

```text
/decide status        # what is in effect, and why
/decide off           # ask (still capped by the 15 min safety net)
/decide auto 180      # ask, self-answer after 180s
/decide on            # never ask (this session)
/decide deadline 60   # tune the safety net only
/decide hold          # ask and wait forever (removes the safety net)
/decide reset         # back to the config file
```

The footer shows `🤖 auto` or `🤖 auto:180s` while a non-default policy is
active (`*` marks a session override).

### Precedence, and why it is asymmetric

```
no interactive UI (headless json/print)   →  autopilot, always
per-call `mode: "ask"`                    →  always ask    (except over `on`)
per-call `mode: "auto"`                   →  autopilot      (except over `off`)
session override (`/decide …`)            →  wins over the config file
config file `autopilot.mode`              →  the default
```

...and on top of all of that, **whatever asks also counts down**: `auto` uses
its own delay, `off` uses `deadlineSeconds`. Only `hold` / `deadlineSeconds: 0`
removes the net, and it says so in the footer (`🤖 hold`).

Three deliberate consequences:

1. **Headless mode can never block.** There is no terminal to answer in, so the
   only alternatives are "autopilot answers" and "the run hangs".
2. **A model cannot escalate itself into a blocking dialog.** `mode: "auto"` is
   ignored when the policy is `off` — you said you want to be asked, and only
   you can lift that.
3. **A model cannot silence a question either.** `mode: "ask"` always waits,
   even under a session override of `auto`/`on`, unless the session policy is
   `on` (which is your explicit "never ask me").

## What the model sees back

The answer envelope is written so an unattended decision cannot be mistaken for
consent:

```
These answers were chosen by the autopilot, not by the user: nobody was available.
The user did not see these questions and did not confirm these choices. Proceed on
your own judgement; if the choice turns out to be unrecoverable, say so plainly in
your final report instead of silently assuming it was approved.

Answers:
- Cache: "TTL 5m" [autopilot]
- Scope: "Session store only" plus: unless writes are hot [autopilot]
      user note: ask me later
```

A cancel is equally explicit: *"do not treat the cancellation as agreement, and
do not re-ask the same questions immediately."*

## How the autopilot decides

1. **A stated recommendation wins outright, per question.** When the model marks
   `recommended`, that is the answer — no judge call, no label matching, no
   chance of drift. The model that wrote the question just did the work with
   full context; a judge reading a truncated transcript can only add error.
   This is also the direct answer to *"if the options already contain the best
   one, just use it."*
2. **Only un-recommended questions reach a judge.** One non-streaming
   completion sees a bounded excerpt of the recent conversation plus just those
   questions, and returns each answer as JSON with a one-line reason. When every
   question was recommended, no model call happens at all.
3. **Every failure still produces an answer.** A broken judge, an unreadable
   reply, a timeout — all of them fall back to the first option. The one outcome
   this feature exists to prevent is a run that waits forever.
4. **Irreversible questions get a safety rail.** See below.

### The safety rail

"Never block" must not be read as "always act". A question that can destroy
data, force-push, spend money or publish is not a question an unattended
autopilot should answer at all. Two layers trip the rail:

- the model setting `irreversible: true` on a question, and
- a conservative scan of the question, option labels and descriptions
  (`rm -rf`, `delete`, `drop`, `force push`, `reset --hard`, `publish`,
  `deploy to prod`, `revoke`, `rotate ... key`, `overwrite`, `wipe`, …).

A tripped question is still answered — but **only** with an option that reads as
the cautious path (`abort`, `skip`, `keep`, `back up first`, `dry run`, `do
nothing`). If no such option exists, the call comes back as **refused**: the
model is told in as many words to stop, finish what is safe, and report the
decision as blocked on you. A stuck-but-safe run beats a fast destructive one.

The judge never runs on the render path, so a slow model cannot freeze the
dialog, and the countdown keeps ticking while it thinks.

## Configuration

`~/.pi/agent/pi-decide.json`. Every field is optional; a missing or invalid
value silently falls back to its default, because a typo must never be able to
wedge the tool.

```json
{
  "enabled": true,
  "autopilot": { "mode": "off", "timeoutSeconds": 180, "deadlineSeconds": 900 },
  "ui": { "bell": true },
  "judge": {
    "model": null,
    "tailMessages": 10,
    "maxTailChars": 8000,
    "timeoutMs": 90000
  },
  "limits": { "maxQuestions": 8, "maxOptions": 8 },
  "notify": true,
  "debug": false
}
```

| Field | Default | Meaning |
| --- | --- | --- |
| `enabled` | `true` | Master switch. When false the tool refuses every call. |
| `autopilot.mode` | `"off"` | `off` / `on` / `auto`. |
| `autopilot.timeoutSeconds` | `180` | Countdown for `auto`. `0` means `auto` behaves like `off` (waits until the deadline). |
| `autopilot.deadlineSeconds` | `900` | Safety net for `off`: after this long with no input the autopilot answers. **`0` disables it, which is the only way a run can hang.** |
| `ui.bell` | `true` | Terminal BEL when the dialog starts waiting (TUI only). |
| `judge.model` | `null` | `null` uses the session model. Pin `{"provider":"…","model":"…"}` to decouple the judge from whatever model the run uses. A pinned model that does not resolve now warns loudly instead of degrading silently. |
| `judge.tailMessages` | `10` | Trailing messages the judge sees. |
| `judge.maxTailChars` | `8000` | Hard cap on the excerpt. |
| `judge.timeoutMs` | `90000` | Abort the judge after this long. |
| `limits.maxQuestions` | `8` | Per-invocation ceiling. |
| `limits.maxOptions` | `8` | Per-question ceiling. |
| `notify` | `true` | Show a notification when the autopilot answers. |
| `debug` | `false` | Log validation warnings and judge failures to stderr. |

The file is re-read on every call, so edits apply without a reload.

### Pinning the judge model

By default the judge is the session's model. That is zero-config, but it couples
the judge to the run: if a key expires or the provider goes down, the
questionnaire cannot be answered either. Point `judge.model` at a cheap model on
a different provider to remove that coupling.

## Keys

| Key | Action |
| --- | --- |
| `↑` `↓` | Move the highlight |
| `Enter` | Pick the option / open the focused row |
| `Space` | Toggle a checkbox on a `multiSelect` question |
| `Tab` / `←` `→` | Move between questions (and the Submit tab) |
| `n` | Note on this answer; on the Submit tab, one global note |
| `Esc` | Back out of the editor; cancel the whole questionnaire |
| `Ctrl+]` | Collapse the dialog to one line, then restore it |

`Type something.` is always the last row of a question and replaces the selected
option — you cannot end up with "LRU" *and* an unrelated sentence. In
`multiSelect` mode, a typed answer is exclusive on purpose: a mix would be
ambiguous, and a free-text answer that silently kept checkboxes is worse than
asking twice.

## Running unattended

The intended pattern:

```bash
# Start a long run, then walk away.
/decide auto 120
```

The first questionnaire you miss waits two minutes, then the autopilot answers,
the footer notifies you, and the run keeps moving. Ask for
`"recommended": "<label>"` from your own prompts and the quality of those
decisions tracks the quality of your recommendations.

## Related

- The autopilot is the companion of [`pi-unstall`](https://github.com/zeroicey/pi-unstall):
  that one notices when a run *stopped*, this one notices when a run is *waiting*.
- `@juicesharp/rpiv-ask-user-question` is the extension this one is modelled on.
  It does the dialog well; it has no answer for "nobody is home".

## Verified behaviour

Every claim below was exercised against a real Pi process, not only in unit tests.

| Case | Result |
| --- | --- |
| Headless (`-p`), policy `on` | autopilot answers, envelope labelled `[autopilot]` |
| Six consecutive calls in one run | 6/6 answered, none hung |
| Explicit `mode: "ask"` in a headless run | overridden to autopilot — **cannot hang**, and the model is told so |
| Judge model pinned to a name that does not exist | loud warning, falls back to the stated recommendation |
| Judge overruns `judge.timeoutMs` | aborted, falls back, run continues |
| Runtime `limits.maxQuestions` below the model's request | rejected with the exact count, nothing shown |
| `recommended: "Drop it"` on a question whose description says `rm -rf` | steered to "Back up first", envelope says so |
| Irreversible question with no cautious option | **refused**; the model is told to stop and report it blocked |
| `off` policy, real TUI dialog | tabs, stars, notes, free text and the Submit review page all behave as documented |
| `off` policy, nobody answers | the 15 min safety net fires and the envelope says so |
| `auto 6`, nobody touching the keyboard | self-answered after 6s, envelope says `[timeout, after 6s]` |
| Keys arriving after the dialog settled | ignored without throwing |
| Widths 0–140 columns, CJK / emoji / ZWJ / BiDi / ANSI in a preview | no over-wide line, no throw |

## Requirements

- Node.js 22 or newer.
- Pi Agent 1.3 or newer.

## License

MIT

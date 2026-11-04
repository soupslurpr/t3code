# Triage an issue

Triage lets your own coding agent investigate a T3 Code problem. The agent
reads the logs and state of the machine, checks available source, finds known
issues, and can help you write a good GitHub issue. It asks
before it applies a fix or posts anything.

## In the app

Open the command palette and choose **Triage an issue**. A new thread with no
project opens, with the triage playbook linked in the message. Choose any
provider, describe what went wrong after the link, and send. Official upstream
builds get source for the server's version while you write. Fork builds identify
their repository and compiled revision when available, but do not automatically
download source or substitute upstream code. Diagnostics still work when exact
fork source is unavailable; the agent explains that limitation. Upstream source
can help with comparisons, but does not establish how the installed fork behaves.

Triage runs on the machine of the thread or draft that you have open. With
nothing open, it uses your primary machine if that supports triage, or else the
first connected machine that does. The new thread shows the machine name, and on
mobile the palette row shows it before you start. The agent runs inside that T3
Code server, so it gives you any restart steps and does not do them itself.

## In a terminal

If the app does not start, or triage does not work in the app, run:

```sh
npx t3 triage
```

It starts Claude Code or Codex in your terminal with the same instructions.

For a fork, use its installed CLI (`t3 triage`). `npx t3 triage` may run an
upstream CLI instead; its reported identity describes that CLI, not the fork
server you are diagnosing. A fork-specific finding is not automatically an
upstream issue. If the evidence establishes an upstream defect, the report
includes the fork repository and revision and still needs your approval.

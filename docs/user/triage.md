# Triage an issue

Let your own coding agent investigate a T3 Code problem—reading local logs/state, inspecting available source, checking known issues, and helping draft a GitHub issue. The agent always asks before applying fixes or posting anything.

## In the app

Open the command palette (`Cmd/Ctrl+K`) and run **Triage an issue**. A no-project thread opens on the active machine with the triage playbook attached—pick any provider, describe the problem, and send. Official upstream builds fetch source for the server's version automatically; fork builds identify their repository and compiled revision when available without substituting upstream code, and note that limitation if exact fork source is unavailable.

## In a terminal

If the app won't start or in-app triage fails, run the installed CLI on the affected machine (or use the command from **Copy command** in the app):

```sh
t3 triage
# Or choose a specific CLI agent and model:
t3 triage --agent codex --model <model-id>
t3 triage --agent antigravity
```

Official upstream installations can also use `npx t3 triage`. Supports Claude Code, Codex, and standalone Antigravity (`agy` on `PATH` with its own sign-in; T3's managed ACP runtime does not include the standalone terminal CLI).

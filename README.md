# auto-allow

A Claude Code mod that answers the permission prompts that still show up in bypass mode, so a long run doesn't stall waiting for a click. It also approves the Claude desktop app's computer-use "Request Access" card, which no permission hook can see.

**It removes a human check.** Everything it approves would otherwise have waited for you. Install it only where you already run with bypass permissions and are comfortable with that.

## What it does

- **Permission prompts:** answers them with allow, except `AskUserQuestion`, `ExitPlanMode` and a short list of destructive Bash commands (`rm -rf /` or `~`, `mkfs`, `dd` to a disk, force-push, a fork bomb), which still get the normal prompt.
- **Computer-use access cards (macOS, Claude desktop app):** while Claude's `request_access` call waits, a helper script finds the card showing that call's reason and presses its ⌘↩ (Allow for this session). If a draft is waiting in the prompt box, or the shortcut does nothing, it clicks the button instead and then puts the pointer and the front app back.
- **A drawer above the prompt:** lists what it approved in this session (`▸ N auto-approved`), with a clear button.
- **A log:** every prompt it sees goes to `~/.claude/auto-allow/log.jsonl` (tool, target, decision; never file contents), last 2000 entries.

## Commands

- `/auto-allow on | off | status`: switch it, or see what it approved this session.
- `/auto-allow computer on | off`: switch the computer-use card part alone. It is on by default.
- `/auto-allow log`: the last 20 entries of the log.

## Computer-use cards: what they need

- macOS, with the Claude desktop app allowed under System Settings → Privacy & Security → Accessibility. Computer use already asks for this.
- The Mac unlocked, and the session open in the Claude window. Otherwise the card waits for you as usual, and a toast says why it couldn't answer.

## Install

At the prompt of a terminal session:

```
/plugin install auto-allow --marketplace yu2001-s/auto-allow
```

Answer `y` to add the marketplace, then pick a scope. The user scope is first.

From a shell:

```
claude plugin install auto-allow --marketplace yu2001-s/auto-allow
```

In the desktop app, where `/plugin` does not run: click + next to the prompt box, then Plugins. Choose Add marketplace with `yu2001-s/auto-allow`, then Add plugin.

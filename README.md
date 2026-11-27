<a href="https://www.buymeacoffee.com/mrginger" target="_blank"><img src="https://cdn.buymeacoffee.com/buttons/v2/default-violet.png" alt="Buy Me a Coffee" width="217" height="60"></a>

# Starwright

**A command center for your AI coding agents.**

Starwright is a Windows desktop app that runs **Claude Code**, **Codex**, **Cline** and a **local model** together on your projects. You give it a request and it decides who does what. Claude leads and plans, then hands self-contained work to whichever agent fits it best, based on your settings, what each plan has left and each agent's track record. The agents share one memory of the project. You can see what every request cost and who did the work, and every change can be undone.

Around the agents, Starwright has what a project needs day to day:

- a live preview, a terminal and a file browser
- one-click Deploy
- schedules that run on their own
- plugins you or the agents write
- Remote access from a phone or another computer

It runs on the subscriptions you already have (Claude, ChatGPT, and optionally ClinePass) and LM Studio on your own PC, so there are no API keys to paste.

> **Status:** a personal project, shared as is, and used daily on Windows 11. macOS and Linux build targets are set up but have never been tried.
>
> *Formerly VibeApp, renamed in 0.11.0. An installed VibeApp updates to Starwright by itself and keeps all its data.*

---

## Contents

- [The crew](#the-crew)
- [Directing the work](#directing-the-work)
- [Seeing what it costs](#seeing-what-it-costs)
- [Shared memory](#shared-memory)
- [The workspace](#the-workspace)
- [Automation](#automation)
- [Plugins](#plugins)
- [Remote access, phones and other computers](#remote-access-phones-and-other-computers)
- [Safety and privacy](#safety-and-privacy)
- [Install](#install)
- [First run](#first-run)
- [Building from source](#building-from-source)
- [Tests](#tests)
- [Project layout](#project-layout)
- [Known limits](#known-limits)
- [License](#license)

---

## The crew

| Agent | Role | Needs |
|---|---|---|
| **Claude Code** | Leads: talks with you, plans, builds, and decides what to hand off | A Claude subscription (Pro or Max) |
| **Codex** | Takes harder hand-offs, reviews Claude's changes, and takes over when Claude's plan runs out | A ChatGPT plan with Codex |
| **Cline** *(optional)* | Takes routine hand-offs and runs the background memory jobs | A ClinePass plan |
| **Local model** *(optional)* | Takes simple jobs for free, on your own computer | [LM Studio](https://lmstudio.ai) with a model loaded |

- **Hand-offs carry the full context:** your own words, pasted images, the project brief and the key facts. The result comes back with the files changed and a short diff. Starwright then checks it: script syntax, JSON, and the project's `npm test`.
- **Every change gets a second look.** Codex reviews Claude's changes, and Claude checks what every hand-off sends back.
- **Takeover.** When Claude's plan runs out, Codex carries on with the same memory, and Claude is told what happened when it's back. Cline is the last fallback if both are out.
- **Only Claude Code is required.** The others add capacity, and whatever an agent you don't have would do falls back to Claude.
- **The Chat tab** talks to any of the four directly, without building anything. Switch agents mid-conversation, and whoever answers sees everything said so far.

---

## Directing the work

- **Three modes for each message:**
  - **Build** makes the change.
  - **Plan** looks around without changing anything, then shows a numbered plan to approve, edit or cancel. Each step says whether Claude builds it or hands it off, and how hard it is.
  - **Ask** answers from your files on a cheaper model. Plain questions typed in Build are answered this way automatically.
- **The work equalizer** has a fader for each agent, from Off to First choice. Beside each fader, a meter shows what that agent actually built this week.
  - Set the faders by hand, use Auto, or pick a preset: Balanced, Save Claude, Free first or Best quality.
  - If you turn Claude Off, Codex plans, builds and answers everything.
- **A track record** for each agent and model. An agent that keeps failing at a kind of task is offered it later, and the chat says when that happens and why.
- **Smart model switching:** Haiku for quick edits, and Sonnet when Claude's plan is running low. The model you choose is the most it will use.
- **Go Nutz** lets the agents run without asking first. Some things stay blocked even then: deleting GitHub repositories, changing who can see them, and reading your GitHub sign-in.

---

## Seeing what it costs

- **Usage meters** for the Claude, Codex and ClinePass plans in the top bar. The ClinePass meter needs a Cline API key, which is stored encrypted and sent only to Cline. With less than 15% of a ClinePass window left, Starwright gives Cline only the work no other agent can take.
- **Live token counts** on the working line while a request runs, for Claude and for each hand-off.
- **A usage report:**
  - where the tokens went, by request, agent, model and kind of task
  - hand-offs and the track record
  - the versions of the tools in use
- **Tool updates you choose, then checked.** When there's a newer Codex or Cline, Starwright says so, links to what's new, and marks a version it hasn't been tested with. It never updates them by itself, because a new version can change things Starwright relies on. Press **Update** and it waits for running work to finish, installs the new version with npm, and checks that the version is right, that it still accepts the options Starwright passes it, and that a short run through Starwright's safety hook works. If the check fails, the tool gets no work until you put the old version back (one click) or keep the new one.

---

## Shared memory

- **One local SQLite database** holds the project's facts, procedures, to-dos and brief. Claude, Codex and Cline all read and write it.
- **Found by meaning.** "Put it online" finds the fact about deploying, even with no word in common. A small language model does this on your computer, and nothing is sent anywhere for it.
- **Facts that go together come together.** Starwright learns which facts are needed at the same time, so finding one brings the others along.
- **Knows when a fact may be old.** Facts are linked to the files they're about. When those files change a lot, the agents are told the fact may be out of date, and the tidy-up checks it. Facts nobody has used in two months are retired, and can be restored.
- **Background helpers** do the upkeep:
  - save what's worth remembering
  - merge duplicates
  - keep a project brief of about 500 words
  - map the code
- **Long chats are compacted in place**, keeping the rules, decisions and work in progress. A meter shows how full the chat is.
- **Keeps a record of how it's doing:** which facts each agent was given, which of them mattered, and when you had to tell an agent something memory already held. The usage report's Memory section shows it week by week, so you can see whether memory is getting smarter or just bigger.
- **Checks its own health.** Once a day it looks over what's saved for what goes wrong: the brief repeating its own instructions, a fact saved twice in other words, a test step saved as a procedure, the same lesson learned in several projects. Each comes with a fix (rewrite the brief, merge, unmark key, forget, make it one fact for all projects) on the Memory screen, and nothing changes until you choose one. The usage report says when a problem turns up in several projects, which points at Starwright itself.
- **Hand-offs bring back what was learned.** Codex, Cline and the local model end each hand-off with what's worth knowing next time, and it's saved like anything else.

---

## The workspace

- **Live preview** of your app beside the chat. Use **Point** to click on the part you mean, and **Something broke** to send an error to be fixed.
- **Terminal:** a real command line in the project's folder, under the preview. It keeps running when folded away.
- **Files:** browse the project's files without leaving the chat.
  - A dot marks each file changed since the last checkpoint.
  - Code is highlighted, and Markdown is formatted.
  - Files that usually hold keys are listed but never shown.
- **Notes and to-dos** for each project. **▶ Build this** sends a to-do to the chat, and the agents add their own leftovers.
- **Undo and redo for every message**, plus named checkpoints and a full history to restore from. Git runs underneath, and you never have to touch it.
- **Panes you can resize or fold away.** It fits a narrow window, an iPad or a phone.

---

## Automation

- **One-click Deploy.** Claude writes the deploy recipe once, from how you've deployed before, and you check it. After that, Starwright runs it without AI, with a site check and optional rollback.
- **Schedules** run a request, a deploy or a site check on a timetable: at a time of day, every few hours, or after each deploy. Each one has a daily cap and a usage guard.
- **GitHub and Vercel.**
  - Back up to GitHub, automatically after each request if you like.
  - Pick up newer work from another computer.
  - Publish to Vercel.
- **Notifications:** Windows notifications, phone alerts through the free [ntfy](https://ntfy.sh) app, and a system tray mode.

---

## Plugins

A plugin adds something Starwright doesn't have, for one project or for all of them. It's a folder with a `plugin.json`, and you, Claude or Codex can write one. A plugin can have:

- **Panels:** pages in the 🧩 Plugins pane, such as a dashboard. They can read the project's files and Starwright's records.
- **Commands:** programs it runs on this computer. They run from a button, from a hook (when a request, hand-off or Deploy finishes) or on a schedule.

Nothing in a plugin runs until you approve it, and the approval covers the exact files you saw. If a file changes afterwards, you approve it again. Panels run in a locked-down frame with no internet access. A plugin that keeps failing is turned off, and **Pause all** or `--safe-mode` stops every plugin at once.

Starwright comes with two examples:

- **Project Pulse:** requests, tokens, hand-offs and scheduled runs, as charts.
- **TODO Finder:** finds TODO comments after each change, and drafts a request to fix one.

To write your own, see [docs/plugins.md](docs/plugins.md). The agents get the same guide, and a tool to check a plugin they've written.

---

## Remote access, phones and other computers

Remote access is off by default. Turn it on in **Settings → Remote access**. There are two modes:

- **This computer only:** listens on `127.0.0.1`, for tools like Claude Code on the same PC.
- **Local network:** HTTPS, with a certificate Starwright makes itself.

The whole app works in a browser or on a phone, including the terminal and plugin panels. Phones can install it as an app.

**How a device connects**

- Each device **pairs once** with a 6-digit code. The code works once, and wrong guesses are rate-limited.
- The device gets its own token, which Starwright stores only as a hash.
- In Settings you can see the paired devices, disconnect any of them, or make them read-only.
- A remote device can never change the remote-access settings.

> **Never expose Starwright to the internet** (no port forwarding). It can run commands on your computer. To reach it from outside your home, use [Tailscale](https://tailscale.com). With MagicDNS and HTTPS certificates turned on in Tailscale, Starwright gets a trusted certificate.

**Driving Starwright from Claude Code.** Starwright comes with an MCP server, so Claude Code can drive a Starwright on this computer or, over Tailscale, on another one:

```
claude mcp add vibeapp -- node "<Starwright data folder (%APPDATA%\vibeapp)>/vibeapp-mcp.cjs"
```

Settings shows the exact command. The server's tools can:

- list projects
- send a message and wait for the reply
- answer questions and approve plans
- read the chat, notes, to-dos and memory
- stop or compact a request
- deploy
- report usage

---

## Safety and privacy

**Where your code and chats go.** Your code, chats and memory stay on your computer, except what you send to the AI services you've signed in to:

| Service | What it receives |
|---|---|
| Anthropic | What Claude reads and writes |
| OpenAI | What Codex reads and writes |
| ClinePass *(only if Cline is switched on)* | Chat and code excerpts for background jobs and hand-offs, sent to Cline's model providers. Each use can be switched off in Settings. |
| LM Studio *(only if set up)* | Hand-offs and chat sent to the local model, on your computer or one you choose |
| ntfy *(only if phone alerts are on)* | A project name and what's waiting, never code or chat text |

**How it's protected**

- **Secrets** are encrypted with your Windows account (DPAPI) and stored outside your projects. Some are never given to the agents. Starwright warns before a key ends up in the chat, a file, a commit or a published site.
- **Destructive commands need your OK**, unless Go Nutz is on.
- **Plan mode is enforced by Starwright**, not left to the agent. Edits, commands that aren't read-only, Deploy and hand-offs are turned away while planning.
- **Cline's every action is checked** before it runs:
  - It works only inside the project.
  - Commands that delete folders, push or wipe history are blocked.
  - Its account connectors are switched off.
- **The preview** only shows `localhost`, with no access to Starwright's own controls.
- **Plugins** run only once approved, from the copy you approved, without the project's secrets.
- **Your sign-ins** stay with Claude Code, Codex, Cline and the GitHub CLI. Starwright never stores or reads them.

**Reporting a vulnerability:** please use GitHub's [private vulnerability reporting](../../security/advisories/new) rather than a public issue.

---

## Install

1. Download `Starwright-<version>-setup.exe` from the [Releases](../../releases) page.
2. Run it. **The installer isn't code-signed**, so Windows SmartScreen will say it "protected your PC". Choose **More info → Run anyway**. If you'd rather not, [build it yourself](#building-from-source).
3. Open Starwright from the Start menu or the desktop shortcut.

Requires Windows 10 or 11 (64-bit).

**Updates.** When there's a new version on this repository's Releases, a banner offers **What's new**, **Update and restart**, **Skip this version** and **Not now**. The download is checked against the release's SHA-512. You can turn automatic checks off in **Settings → Updates**.

---

## First run

The **Accounts** screen sets up everything Starwright drives, from inside the app:

- **Claude Code:** installs it, then you sign in with your Claude account in the built-in terminal.
- **Codex:** installs it, then you sign in with your ChatGPT account.
- **Node.js** and **Git:** installs them if they're missing. The shared memory uses Node's built-in SQLite, so you need Node.js 22.5 or newer.

The optional agents:

- **Cline:** run `npm i -g cline`, then `cline auth`, and choose ClinePass. Then press **Test Cline** under **Settings → Cline (ClinePass)**.
- **Local model:** start LM Studio's server with a model loaded. Starwright finds it, and you can point it at LM Studio on another computer.

Then go to **Projects**. Start a new project in an empty folder, open an existing one, or get one from GitHub.

---

## Building from source

**You'll need**

- Windows 10/11 x64.
- **Node.js 22.5+** and **Git**.
- **Visual Studio 2022 Build Tools** with the *Desktop development with C++* workload **and the "Spectre-mitigated libraries"** component, for the `node-pty` terminal. Install the Spectre libraries from an elevated (administrator) installer.
- Python 3, which node-gyp uses.

**Commands**

```powershell
git clone https://github.com/mrg1nger/starwright.git
cd starwright
npm install          # also applies patches/ and rebuilds node-pty for Electron
npm run dev          # run with hot reload
npm run build        # build into out/
npm run package      # make release/Starwright-<version>-setup.exe
npm run typecheck
```

**Making a release** (for maintainers):

1. Step the version with `npm version X.Y.Z --no-git-tag-version`.
2. Add a `## X.Y.Z` section to CHANGELOG.md.
3. Run `npm run package`, then `npm run release`. Add `-- --draft` to check it on GitHub first.

The release script uploads the installer, its `.blockmap` and `latest.yml`. The in-app updater needs `latest.yml`, so publish releases this way rather than by hand. The script uses the GitHub CLI's own sign-in (`gh auth login`).

**Gotchas**

- **`ELECTRON_RUN_AS_NODE` must not be set.** If it is, Electron starts as plain Node and `electron.app` is undefined. Clear the variable and run it again.
- **The node-pty patch** drops the old winpty build target, which doesn't build on modern Windows. node-pty uses ConPTY instead.

**Built with** Electron, electron-vite, React, TypeScript, the [Claude Agent SDK](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk), the Codex CLI, the Cline CLI, LM Studio's OpenAI-compatible server, SQLite (`node:sqlite`) with [sqlite-vec](https://github.com/asg017/sqlite-vec), the [gte-small](https://huggingface.co/Xenova/gte-small) language model on the ONNX runtime, highlight.js, xterm.js and node-pty. The language model isn't in this repository: `npm install` fetches it (34 MB, checked against a checksum) into `resources/models/`.

---

## Tests

```
npm test               # unit tests: fast, offline, no plan usage
npm run smoke          # the real Claude Code and Codex CLIs (uses a little of both plans)
npm run smoke -- cline # the real Cline CLI, including its safety checks
npm run try-tool -- codex  # a new Codex (or cline) in a throwaway install, before updating
npm run e2e            # the built app, clicked through end to end, with its own data folder
npm run e2e:remote     # Remote access: the API, a real browser, the MCP server, HTTPS
npm run e2e:mobile     # every screen at phone size
npm run eval           # real tasks, measuring who did what and what it cost
```

The tests never touch your real projects, memory or settings, because they run against a temporary data folder. See [tests/README.md](tests/README.md) for details. Run the smoke tests after updating Claude Code, Codex, Cline or the Agent SDK, because Starwright relies on some of their less-documented behaviour. For a new Codex or Cline, `npm run try-tool -- <codex|cline> [version]` does that before anyone updates. It installs the version into a throwaway npm folder, runs the smoke tests against it, and writes the release notes since the tested version, and what its `--help` gained or lost, to `test-results/try-tool/`. Add `--mark` to raise the tested-with version when everything passed, or `--quick` for the notes alone with no plan usage.

---

## Project layout

```
src/main/           Electron main process
  orchestrator/     Claude sessions, routing, takeover, plans, command safety
  delegation/       hand-offs to Codex, Cline and the local model
  cli/              running Claude Code, Codex and Cline
  cline/            Cline's safety hook
  memory/           shared SQLite memory, its MCP server, search by meaning, scribe, tidy, brief, code map
  plugins/          plugin approval, panels, commands, hooks and schedules
  remote/           Remote access server, pairing, Tailscale certificates, MCP server
  review/ deploy/ schedule/ backup/ github/ publish/ secrets/ preview/ ...
src/preload/        the bridge between the window and the main process
src/renderer/       the React UI
src/remote-bridge/  the same UI in a browser
shared/             types and logic used on both sides
resources/plugins/  the example plugins
docs/               guides (writing a plugin)
tests/              unit, smoke, e2e and eval tests
patches/            patch-package fixes for dependencies
```

[CHANGELOG.md](CHANGELOG.md) lists what changed in each version.

---

## Known limits

- **Windows only in practice.** The command handling assumes Windows (PowerShell, Git Bash, `.cmd` shims).
- **It depends on the CLIs' behaviour.** A Claude Code, Codex or Cline update can change things Starwright relies on, which is why it only updates Codex or Cline when you press Update, and checks the new version afterwards. Each release is tested against particular versions (Settings shows a newer one as not yet tested), and the smoke tests are how such changes show up.
- **Bring your own subscriptions.** Starwright drives the official CLIs with your own sign-ins. Check each provider's current terms for how you use them.
- **The ClinePass meter reads Cline's dashboard data**, which isn't a published API. If Cline changes it, the meter shows "—" and nothing else is affected.
- **Not code-signed.** Windows SmartScreen warns on first install. Updates are checked against the release's SHA-512. That protects against a damaged download, but not against someone who controls the GitHub account.

---

## License

[MIT](LICENSE) © 2026 Mr.Ginger

The installer also carries, under their own licences: the gte-small language model (trained by Alibaba DAMO Academy, whose model card gives the licence as MIT; shipped in Xenova's ONNX conversion), the ONNX runtime (MIT) and sqlite-vec (MIT or Apache-2.0).

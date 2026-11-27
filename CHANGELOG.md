# Changelog

The version goes up with each improvement that ships: the middle number for new features, the last for fixes only. Settings shows the version a computer is running. (Starwright was called VibeApp up to 0.10.0.)

## 0.28.1 (2026-11-27)

- **Codex 0.172.0 is tested with Starwright,** so it isn't marked untested. Its takeovers, Ask, the Chat tab, hand-offs (one, a second continuing the same session, two at once), an MCP server given to it and the check an update gets all pass. Cline stays at 3.0.76.
- **Starwright starts the first Codex or Cline on the PATH,** as a terminal would. It used to prefer any `codex.exe` or `cline.exe` it could find, even one further along the PATH, which could be a different copy from the one just updated.
- **`npm run try-tool -- <codex|cline> [version]`** tries a new version before anyone updates. It installs into a throwaway npm folder, so your own copy isn't touched, and puts it first on the PATH. It then runs the smoke tests against it, checking that Starwright really starts that copy. Last, it writes the release notes since the tested version, and what its `--help` gained or lost, to `test-results/try-tool/`. `--mark` raises the tested-with version when everything passed; `--quick` gives the notes alone, with no plan usage; `--suites` picks which smoke tests to run.
- The tests read the tested-with versions from the code, so raising them doesn't break the tests.

## 0.28.0 (2026-11-27)

Starwright can update Codex and Cline for you, when you press **Update**. It then checks the new version still works with Starwright, and if it doesn't, puts the old one back with one click. This is the check that would have caught Cline 3.0.75 stopping every run at its end.

- **An Update button** in the new-version notice and in **Settings → Updates**, for a Codex or Cline installed with npm. Installed some other way, Starwright says to update it the way it was installed; if it can't tell, it shows the command as before.
- **What's new** links to the version's release notes on GitHub.
- **Not yet tested with Starwright:** each release names the newest Codex and Cline it was tested with (now Codex 0.158.0 and Cline 3.0.76). A newer one is marked, so you know you're going first. You can still update.
- **What Update does:**
  - New work goes to the other agents. Hand-offs, background jobs or Codex's usage check already running on that tool finish first, for up to 15 minutes. A Cline that Starwright keeps running between requests is stopped.
  - If the tool is running outside Starwright (in a terminal, an editor, or left over), it stops before npm touches anything: on Windows a running program can't be replaced, and npm stopping part-way can leave a broken install. Close it, and press Update again.
  - It runs `npm install -g` for that exact version. Nothing can start the tool meanwhile.
  - It checks the new version:
    - `--version` says the new version (not another copy earlier on the PATH)
    - its `--help` still lists every option Starwright passes it, and Codex still has `exec resume` and `app-server`
    - a short real run through Starwright's safety hook answers. Codex runs once; Cline runs once as background jobs use it and once as hand-offs use it. A tool call the hook refused counts as a failure. This uses a little of that plan.
- **If the check fails,** the notice turns orange, lists what went wrong, and the tool gets no work until you choose:
  - **Put the old version back:** reinstalled the same way, and the bad version is skipped in the notice.
  - **Check again:** after fixing a sign-in or a plan limit, say.
  - **Keep it:** your call, when the problem isn't the update.

  This holds across restarts. An update cut off by closing Starwright counts as failed, since its new version was never checked.
- **The usage report's Tools section** says when an update failed its check, or is under way (Settings, Remote and the `usage_report` tool).
- **Over Remote,** only a device with full access can update, put back or keep. The Update button only installs the newest version Starwright found on npm.
- Unit tests for each step, smoke tests that run the check on the Codex and Cline installed here and `npm install -g` into a throwaway folder, and end-to-end steps that drive the notice through a failed check, putting the old version back and one that passes.

## 0.27.0 (2026-11-26)

Memory keeps a record of how it's doing: which facts it put in front of each agent, which of those mattered, and when you had to tell an agent something it already held. The usage report has a Memory section, so over a few weeks you can see whether memory is getting smarter or just bigger. Also a fix for Cline 3.0.75, which stopped every Cline run at its very end.

- **What each agent is given is recorded:** each fact put in front of an agent, which agent, and how it got there:
  - **pushed** with a request or hand-off
  - **brought along** by a linked fact
  - **looked up** with the recall tool

  Key facts aren't listed, because every request has them. Records are kept for 180 days.
- **After each request, the note-taker judges what was given:** which of those facts bore on the exchange. The report shows the share that mattered, for each way of being given.
- **It notices when you repeat something memory held:**
  - **missed:** you had to correct or remind the agent, and the fact hadn't been put in front of it in the last few requests. Search let it down.
  - **ignored:** you had to correct or remind it, and it had been given the fact, or the fact is key.
  - **said up front:** you mentioned it in a new request without anything having gone wrong. This isn't counted as a failure.

  A fact memory had wrong, which you correct, is updated as before and isn't counted. A correction that came from what you said is now marked so on the fact it replaced.
- **A fact search keeps missing isn't retired as unused.** Facts nobody has used in two months are retired. A fact you had to repeat was clearly needed, so it's kept.
- **The note-taker's own search no longer counts as using a fact.** It looked up 15 facts after every request, which made almost every fact look used. So "never used" and retiring unused facts meant very little.
- **The usage report's Memory section** (Settings, and the `usage_report` tool) shows:
  - facts given, by way, with how many mattered
  - look-ups by agent
  - misses by kind, and by week
  - the facts missed most often
- **Cline 3.0.75 works again.** That version ends a run with a new `submit_and_exit` tool, which Starwright's safety hook didn't know, so it refused it and stopped the run.
  - Every background job on Cline fell back to Haiku, which used your Claude plan.
  - The tool is now allowed: it only hands in an answer.
  - The answer it hands in, and what Cline said just before, become Cline's result, on both the hosted and the one-off Cline.
  - A background job's JSON is found even with Cline's "Submission recorded…" line after it.
  - When a background job's answer doesn't fit the format, the reason now quotes the start of what Cline said.
- Unit tests for each, four new cases in the note-taking evaluation (`VIBEAPP_EVAL_ONLY=memory npm run eval -- helpers`), and the real Cline smoke tests (12 of 12).

## 0.26.0 (2026-11-24)

Plugins, parts 2 and 3: a plugin can now do things as well as show them. It can run commands from a button, after each request, hand-off or Deploy, or on a schedule. Claude and Codex know how to write plugins, and their panels open over Remote. Starwright comes with a second example, **TODO Finder**, that uses all of it.

- **Commands.** A plugin can list programs it runs on this computer, from the project's folder: a list like `["node", "{plugin}/scan.js"]` (`node` is Starwright's own, so it works without Node installed), or a command line for the shell. It doesn't get the project's secrets.
  - **Shown word for word.** Each command is on the approval screen exactly as it will run, with when it runs by itself.
  - **Only the approved copy runs.** Its own scripts run from a copy of the files you approved, so a script changed afterwards never runs; the plugin waits for you to approve it again.
  - **What it prints is kept** with each run (secrets masked). Lines starting `::status`, `::note`, `::notify` and `::json` give the run a one-line summary, add a line to the chat, send you an alert (with the new `notify` permission), or hand data to the plugin's panel.
  - **Stopped when it runs too long:** after 2 minutes, unless the plugin says otherwise (up to an hour).
- **Buttons** in the Plugins pane run a command, and how it went shows in the chat. Each plugin's card shows its latest run, with a list of runs and what each printed, and a Stop link while one is running.
- **Hooks** run a command when something happens in the project: a request finishes, a request changed files, a hand-off finishes, or a Deploy finishes. The command gets the event as JSON. Open panels with `records:read` hear the same events.
- **Schedules** run a command daily at a time or every so many minutes (at least 5), while Starwright is running. A time missed by more than 3 hours is skipped, and they stop while schedules are paused. A plugin for every project runs its schedules in each project opened in the last two weeks.
- **A plugin that keeps failing is turned off.** If its runs from hooks and schedules fail 3 times in a row, Starwright turns it off and says why in the chat and on its card.
- **Pause all** in the Plugins pane stops every plugin at once: no panels, commands, hooks or schedules until you resume them. Starting Starwright with `--safe-mode` starts with them all paused.
- **More for panels:** `starwright.commands.run` and `.runs`, `starwright.onEvent`, `starwright.notify` (with `notify`), and `starwright.chat.draft`, which puts text in the message box for you to send or not (with the new `chat:draft` permission).
- **Claude, Codex and Cline can write plugins.** They have two new tools:
  - `plugin_guide` hands them `docs/plugins.md`.
  - `plugin_check` checks a plugin they wrote: plugin.json, the files it names, whether its scripts parse, and whether anything a panel loads would be blocked. It also says whether you've approved it.

  Claude is told to use them when you ask for something Starwright doesn't have. They can't approve or run a plugin. When a request changes a project's plugin, the chat says it needs approving.
- **Over Remote,** the Plugins pane lists plugins and opens their panels, served from Remote's own address under a one-time token, in the same locked-down frame. A device with full access can use their buttons. A read-only device's panels can only read. Approving, turning on and off, adding and pausing stay on the computer. On a phone, Plugins is a tab beside Chat, Preview, Notes and Files.
- **TODO Finder** (Add TODO Finder in the Plugins pane) finds the TODO, FIXME and HACK comments in the project's code: after each request that changes files, every morning, and when you press Scan now. Its panel lists them by file, and Ask Claude puts a request about one in the message box. When a scan finds more than last time, it says so in the chat.

## 0.25.0 (2026-11-24)

Plugins, part 1: add things to Starwright that it doesn't have, starting with dashboards. You, Claude or Codex can write them, and Starwright comes with one: **Project Pulse**.

- **🧩 Plugins sits beside Preview, Notes and Files.** It lists the project's own plugins (`.starwright/plugins/<name>` in the project, so they go into git with it) and the plugins for every project (Starwright's `plugins` folder).
- **What a plugin is:** a folder with a `plugin.json` (name, version, description, what it asks for, and its panels) and the pages it shows. Its `plugin.json` is checked, and a plugin with problems says what's wrong. `docs/plugins.md` explains how to write one.
- **Nothing runs until you approve it,** and only on the computer running Starwright. The approval screen lists what the plugin asks for in plain words. What you approve is a fingerprint of all its files as you saw them, so if any file changes, or it asks for something new, it won't open until you approve it again, with anything new marked. A plugin can be turned off and on again without losing its approval.
- **A panel runs in a locked-down frame.** It gets the files you approved, copied when it opens, from an address of its own (`starwright-plugin://`). It has no internet, no other sites, no pop-ups or forms, and no way into Starwright's page, your keys or settings, or the rest of the computer.
- **A panel reaches Starwright only through `window.starwright`,** and each call is checked against the plugin's permissions:
  - reading this project's files (never files that usually hold keys, and nothing outside the project)
  - its own small store of data (1 MB for each project)
  - reading Starwright's records for this project: requests and how they ended, tokens by agent, hand-offs, and scheduled runs
- **Panels follow the theme.** They get Starwright's colours and font as CSS variables, which update when the theme changes.
- **Project Pulse** (in "Add the Project Pulse example") shows, for the last 7, 30 or 90 days:
  - requests and how many were done
  - requests each day, as a chart you can hover for details
  - tokens by agent, read and written
  - hand-offs by agent, with the models used and how many were done
  - each scheduled run's last result
  - how many files changed since the last checkpoint

  It remembers the range you chose. It's drawn without any library, because a panel can't load anything from the internet.
- **Not yet:** commands, buttons, hooks and schedules for plugins (part 2), tools for Claude and Codex to create, check and reload plugins, and plugins over Remote (part 3). From a phone or browser, the pane says plugins open on the computer for now.

## 0.24.0 (2026-11-24)

Memory learns which facts go together, so finding one brings along the others it's usually needed with.

- **Facts that keep mattering in the same requests are linked.** Two facts count as mattering together when both were written during one request (by Claude, Codex, Cline or the note-taker) or when both are about files the request changed. A file that a lot of facts are about (more than 8, like a big shared file) doesn't link them, because changing it says little about which facts belong together. A request that was stopped or ended in an error doesn't count.
- **A pair needs to matter together at least twice before it counts.** A request where a handful of facts mattered counts fully for each pair. One where many did counts less for each pair, and past 24 facts it isn't counted. Links fade by half every 60 days without counting again, and the faintest are removed.
- **Being shown together doesn't link facts.** Being attached to a request or turning up in a search doesn't count, so facts aren't linked just because they were shown together, which would then get them shown together more.
- **A fact found for a request brings up to three partners along**, even when they're worded nothing like the request. For example, "how do we release?" also gets "the build fails unless ELECTRON_RUN_AS_NODE is cleared". The agent is told that each one was brought along and which fact it came with. An agent's own memory search adds up to two partners of its top three results. Key facts neither bring partners nor come along, because they're in every request already.
- **Links follow a fact through changes.** A fact that's corrected, merged in a tidy-up or replaced by a newer one keeps its links. Deleting a fact removes its links, and erasing a project removes all of its links.
- **The Memory screen shows a fact's partners** on a 🔗 "Often needed with" line.
- **Measured on the memory search evaluation.** Ten requests were each worded like only one fact of a pair. Without links, one got both facts attached. With links, four did: every request that found the first fact also got its partner. Agent searches still put the right answer in the first five 93% of the time, the other requests' attachments didn't get worse (19 → 20 of 60 right), and off-topic messages still get nothing.

## 0.23.0 (2026-11-23)

A Files pane: look through the project's files without leaving the chat.

- **📁 Files sits beside Preview and Notes.** It lists the project's files as a tree, folders first, leaving out what `.gitignore` leaves out (`node_modules`, build output and so on). Without git, the usual package and build folders are skipped. Find a file by typing part of its name or path.
- **What the agents changed is marked.** A dot shows each file changed since the last checkpoint (green when it's new), and folders show how many changed inside. The list loads again when a request ends or changes are undone, as does the open file.
- **Click a file to read it.** Code is highlighted, with line numbers, in colours that suit the theme. Markdown is shown formatted, with a switch to its text. Pictures are shown. Only the first 512 KB of a big file is shown, and a binary file shows just its size.
- **Mention in chat** puts the file's path in the message box, ready to ask about it or have it changed. **Open in editor** opens it in its own program on the computer.
- **Read-only, and only the project.** Nothing in it changes a file. Nothing outside the project folder can be opened: no `..`, no absolute paths, nothing in `.git`, and no link that leads out of the folder. Files that usually hold passwords or keys (`.env`, `.pem`, `.key`, SSH keys, `.npmrc` and the like) are listed by name but never shown; `.env.example` is.
- **On a phone it's a tab** next to Chat, Preview and Notes, and Mention in chat goes back to the chat. Through Remote access, a full-access device can open files, a read-only one sees only the list, and Open in editor isn't offered, since it would open on the computer.

## 0.22.0 (2026-11-22)

Tokens show while a request runs, and Starwright says when there's a newer Codex or Cline than the one installed.

- **The "working…" line counts as Claude works**: the time so far, what Claude has written this request (its tool calls and edits included), and the conversation's size now, e.g. "Claude is working… · 1m 24s · ↓ 2.3k written · 148k context". What's being written is counted as it arrives (about 4 characters a token) and corrected to the exact figure as each step ends, so the line ends on the same number as the request's usage line. Helper agents' writing counts too.
- **A hand-off shows its own tokens** next to its clock, "Codex is working · 0:12 · read 19k · wrote 163", counting up step by step: Codex from its session file as it writes it (its events only give them at the end), Cline from its per-step figures, the local model as it reads and writes. They stay on the card when it's done, until the chat is reopened.
- **Remote screens get the same line.** The live figures aren't kept in the chat history; the usage line at the end still is.

- **A notice under the top bar** names the new version, the one Starwright is using, and the command to update it (`npm i -g @openai/codex@latest` or `npm i -g cline@latest`). It only says so. A new version can change what Starwright relies on, so you choose when to update, while nothing is running, and try a small task afterwards. Skip this version, or Not now until the next start. A newer version still shows after a skip.
- **Settings, Updates lists the tools** with the version in use and the newest on npm, a Check tools button, and skipped versions to bring back. The Claude Agent SDK is listed too. It's built into Starwright, so a newer one comes with a Starwright update and gets no notice.
- **Checked a minute after start and twice a day**, while "Look for new versions automatically" is on. Only each tool's public npm entry is asked; nothing about the computer is sent. On a remote screen, the notice is about the computer running Starwright.
- **The usage report has a Tools section** with the same versions.

## 0.21.0 (2026-11-20)

Starwright keeps a track record of each agent and model, and uses it when it hands work out.

- **Every hand-off records the model that did the work, as the agent reports it.** For the local model, that's LM Studio's model. For Cline, it's the model Cline says it ran. For Codex, the model and reasoning effort come from Codex's own saved session, since its live events don't say. Each hand-off also records the Starwright version that ran it. Earlier hand-offs get their model filled in once, from the token log and Codex's sessions. Reviews record the models of the hand-offs whose work they checked.
- **An agent that keeps failing at a kind of task is tried later for it.** Three bad results in its last 5 hand-offs of that kind (failed, checks failed, or redone soon after), in the last 30 days, move it behind the next agent. It still gets the task when that agent can't do it. An agent you ask for by name is never moved. A hand-off you stopped, or one that failed because Starwright refused something, doesn't count.
- **A record is per agent and model, and starts again after a fix.** A new model starts with a clean record. Failures from before a fix that dealt with them don't count: Cline's from before 0.19.2, and the local model's from before 0.20.1.
- **You can see it.** The chat says when an agent was moved down and why. The result Claude gets says so too. The request's record notes it next to the faders, and the hand-off's record keeps the order the agents were offered it in. The usage report lists hand-offs by kind and model, and has a Track record section: who's moved down now, who's had some bad results lately, and how often the order changed and how those hand-offs went.

## 0.20.1 (2026-11-19)

The local model's hand-off shows what it's doing, and only slow reading hands its task over.

- **A fix to 0.20.0's slow-step check.** 0.20.0 timed whole steps, writing included. At 11 tokens a second, a step that wrote a medium-sized file took more than 90 seconds, so once the context was half full a working model was stopped, and its changes undone. Now only the time spent reading the context before it writes anything counts, and it takes two such slow steps in a row. The step after older output is trimmed doesn't count either, since it reads the whole conversation again once.
- **You can see whether it's still working.** Starwright now streams the local model's replies from LM Studio. A step that runs more than a few seconds gets a live line in the hand-off: "reading its context, about 40%", then "writing: 340 tokens, 11 tok/s". When the step ends, the line records what it took. The card's header shows the same line.
- **A model that stops part-way is noticed.** Nothing for two minutes in the middle of a reply ends the run, so the next agent gets the task. Before, it waited out the whole 15 minutes.
- LM Studio's own chat endpoint reports reading progress, but it doesn't accept the tools Starwright's local agent works through, so Starwright estimates the percentage from how fast earlier steps read. A new smoke test runs the local agent on the real LM Studio.

## 0.20.0 (2026-11-19)

Hand-offs waste less time, and quick requests after a break cost less. From a look at a week of use on another computer, where every one of the local model's failures was running out of time.

- **The local model only gets what fits.** Claude can now name the files a hand-off has to read. When they come to more than half of the local model's context, it's skipped and the next agent takes the task. This applies unless you asked for the local model by name, or there's no one else. The chat says why it was skipped. On the other computer, a 20-file task took the local model ten minutes before it gave up, and Cline then did it in 30 seconds.
- **It hands over when its steps get slow.** A step taking more than 90 seconds while its context is more than half full means it's wading through more than it can handle, so it stops and the next agent takes over. The first step doesn't count, since it may include loading the model. Slow steps with plenty of room left are just slow hardware, and carry on.
- **The next agent starts from a clean project.** When an agent fails after changing files and another one is next, its changes are undone first, scratch files included, so the next agent isn't building on a half-done change. The next agent is told what the failed one reported. If the last agent fails, its changes stay for Claude to look at, as before. On the other computer, a failed local-model run had left nine scratch scripts in a project.
- **Quick requests after a long break cost less.** After an hour or more with nothing sent, Claude's saved copy of the conversation has expired, so carrying on reads the whole conversation again at full price. That was 63k tokens to answer "how many VMs are on the server?". A quick request after a break now runs in a short fresh session, with the project's key facts and brief, and says so in the chat. The next bigger request goes back to the full conversation, and is told what the quick requests did.

## 0.19.3 (2026-11-19)

Two fixes from trying 0.19.2 on another computer.

- **The local model hands over sooner when a task doesn't fit.** Given 20 files, it read them all, had to drop the first 8 to make room, and read those 8 again until its time ran out. The read counts from 0.19.2 didn't stop it, since no file had been read more than twice. Now reading again something it had to drop counts too: it can get back up to 3 such files to make its change, and on the fourth it stops and another agent takes the task. Reading a file again after changing it still doesn't count.
- **A question passed on to Build shows once.** When a question went on as a build request, it showed twice in the chat after the chat was opened again.

## 0.19.2 (2026-11-19)

Fixes from a look at a week of use on another computer.

- **Secrets stay out of the chat.** Every agent has a project's secrets so its commands work, and a command can print one (`env`, a config dump, an error). The value is now shown as `[secret NAME]` in the chat, its saved history, the Deploy window and hand-off reports. The local model sees the label too, but only in what a command prints, so an edit never writes the label into a file.
- **The local model stops going round in circles.** With a small context it could drop files it had read, read them again, and keep doing that until its 15 minutes were up. Now it's warned on the third read of the same part of a file, and stopped on the fourth (or after 8 re-reads in all), so another agent gets the time. Reading a file again after changing it doesn't count. When older output is dropped, the note says which file it was.
- **A broken edit no longer ends a Cline run.** When the model's edit came through without a file path (a big write cut short), Starwright treated it as an edit outside the project and stopped Cline. Now the edit goes back to Cline, which can try again. An edit really outside the project still stops the run, and the log now says which file an edit was for.
- **Questions about live things get answered.** A question like "how many VMs are on the server?" went the cheap question way, which can't run commands, so it answered that it had no access. Now it goes on as a build request by itself (the chat says so), and the command gets run. In Ask mode, the answer says Build will do it.

## 0.19.1 (2026-11-18)

Starwright fits on an iPad (and in a narrow window). Before, the top bar and a project's buttons ran past the right edge, held either way round.

- **The top bar.** When everything doesn't fit on one line, the usage meters move to a row of small tiles under the tabs, as on a phone. This is measured rather than guessed from the screen size, because Safari on an iPad has none of Windows' fonts. That makes a monospace theme much wider there.
- **A project's buttons.** When they don't fit, Preview and Notes stay, and the rest (Secrets, Publish, Deploy, Schedules, Memory, History, Checkpoint, Go Nutz) go into the ⋯ list.
- **The chat.** The chat keeps at least 360px beside the preview, and its Build/Plan/Ask row wraps rather than pushing Compact into the divider.
- Full-width computer screens are unchanged.

## 0.19.0 (2026-11-18)

There's now a command line under the preview or notes.

- **Terminal** at the bottom of the preview opens a real command line in the project's folder (PowerShell on Windows). Click it again to fold it away. Drag its top bar to make it taller or shorter. Starwright remembers whether it's open and how tall it is.
- It keeps running while it's folded away or you're on another screen, and coming back shows what was there. Each project has its own. If it ends (say, after `exit`), "Start a new one" opens a fresh one. Closing Starwright ends it and anything it started.
- It works over Remote access too. A read-only connection can't open it or type into it, and doesn't get what it shows.

## 0.18.1 (2026-11-18)

In the Chat tab, each agent now answers as itself. Cline had replied "I'm Claude" right after Claude had said who it was.

- Each agent is told who it is and which model it runs (for example "You are Cline, running cline-pass/deepseek-v4-pro on the user's ClinePass plan"). It's also told that this chat is shared between four different AI agents and the user can switch between them.
- Earlier replies in the conversation now say who wrote them, either "you" or "another agent, not you". So an agent doesn't take on another's name, or repeat another's mistaken claim that the names are only labels.

## 0.18.0 (2026-11-18)

The Chat tab can talk to Cline and the local model too, alongside Claude and Codex.

- **Cline** answers on your ClinePass plan, with the Cline model chosen in Settings. **Local model** answers through LM Studio, free and on this computer.
- Each button shows only when that agent is set up: Cline when it's installed, the local model when LM Studio is running with a model.
- As before, switch whenever you like: whoever answers sees the whole conversation so far. Stop works for both, and their use is counted under Chat in Settings' usage.

## 0.17.0 (2026-11-18)

The chat and the preview (or Notes) can be resized and folded away.

- **Drag the divider** between them to make either side wider. Starwright remembers the width. Double-click the divider for the usual width again, or use the arrow keys when it's selected.
- **Fold a side away** with the small ‹ › buttons on the divider: ‹ hides the chat so the preview gets the whole width, › hides the preview so the chat does. The other button brings it back, and so does the Preview or Notes button. A folded-away preview keeps running, so it doesn't reload.
- Phones are unchanged: they still show one side at a time.

## 0.16.4 (2026-11-18)

Three fixes from a week of Lazarus's own usage records.

**The agents can't look into Starwright's own data.** A Codex hand-off looking for a password listed Starwright's secrets, deploy and memory folders. Now Codex, Cline and the local model are refused anything that reaches into Starwright's data (`%APPDATA%\vibeapp`, `~\.vibeapp`), in Go Nutz too, and told to use the project's secrets from their environment instead. For Codex this is a safety check Starwright gives each run, before every command, edit and tool call; nothing is written to your own Codex settings. A project that happens to be called VibeApp isn't affected.

**A failing Deploy isn't run over and over.** One request ran the same failing Deploy 9 times. Claude now gets one more try after fixing the cause; after two failures in a row Starwright won't run it again in that request, and Claude stops to tell you what failed and ask. Your next message starts over.

**Cline finishes big jobs instead of leaving them half done.**
- Every one of Cline's failures that week was its 10-minute limit running out on a large feature. Moderate and hard work now gets the full 15 minutes.
- When Cline or the local model runs out of time after changing files, it gets one more go to finish (Cline keeps its conversation), instead of leaving a half-built change for Claude.
- Hard work goes to Codex first when the faders are equal (it finished every hand-off it was given); moderate work is still shared by who was used least.

## 0.16.3 (2026-11-18)

**A tidier phone screen through Remote access.**
- The top bar's meters are small tiles: the name and the least left (like "Claude 73%") over its bars, so all of them fit on one line, Cline too. The equalizer shows as its bars, and the local model as its light (and "Local" when there's room); the details are in each one's tooltip, as before.
- A project's header is one line: ←, its name, and ⋯, which lists Secrets, Publish, Deploy, Schedules, Memory, History, Checkpoint and Go Nutz. Preview and Notes are in the Chat / Preview / Notes switch under it, as before, rather than twice.
- In a chat the footer links make way for the message box.
- Nothing changes on a computer screen.

## 0.16.2 (2026-11-17)

**Theme pictures work where Codex can't write files.** On some computers Codex drew the picture but wasn't allowed to save it into its folder, so the theme came out with colors only ("The read-only workspace blocked saving it"). Codex now only draws the picture, read-only, and Starwright takes it from the folder where Codex keeps every picture it makes (then removes Codex's copy).

## 0.16.1 (2026-11-17)

**A theme with a picture no longer fails with "Theme value for bg-image isn't allowed".** Claude sometimes pointed the theme's decorative background layer at the picture with url(), which a theme may never contain, so the whole theme was refused after the picture was already drawn. The picture takes that layer's place anyway, so Starwright now sets it itself; in a theme without a picture an unusable decoration is just left out. If any other value is refused, Claude is asked once more (told what was wrong) with the same picture, rather than drawing a new one.

## 0.16.0 (2026-11-17)

**Themes with a background picture.** In **Settings → Themes → Generate a theme**, tick **Draw a background picture with Codex**: Codex paints a detailed picture of what you describe (about a minute, from your Codex plan's usage), and Claude picks the theme's colors while looking at it, so the accent, panels and text match the picture.
- The picture fills the window behind everything, with the theme's own color laid lightly over it so text stays readable; panels are slightly see-through.
- The theme's card shows a small copy of its picture. Deleting the theme deletes the picture too.
- It works over Remote access as well.
- If Codex can't draw (signed out or out of usage), the theme is made with colors only and says why.
- A theme file still can't point at anything outside Starwright: the picture is kept beside it in the themes folder and shown by Starwright itself.

## 0.15.11 (2026-11-17)

**The local model is unloaded again when it isn't being used.** A model Starwright loads (0.15.10) doesn't get LM Studio's own idle timer, which only covers models LM Studio loads on demand, so it stayed in memory until ejected. Now Starwright unloads the copies it loaded itself once nothing has used them for **Settings → LM Studio → Unload it after (minutes unused)**: 60 to start with, 0 keeps it loaded. The next job loads it again.
- Never while a hand-off or background job is using it; the time counts from when the last one finished.
- Never a model you loaded yourself, including one you ejected and loaded again.
- Starwright keeps track across restarts. While Starwright is closed, nothing unloads it.

## 0.15.10 (2026-11-17)

**Starwright loads the local model itself, with enough room.** When the LM Studio model isn't loaded (after LM Studio restarts, or after it unloads an idle model), Starwright used to leave it to LM Studio to load it on the first request, with LM Studio's own default context, often only 4,096 tokens. Hand-offs then outgrew it, while Starwright thought the model had all 262,144 tokens it supports. Now:
- Before a hand-off or background job, a model that isn't loaded is loaded by Starwright with the context set in **Settings → LM Studio → Context to load the model with** (32,768 to start with; capped at what the model supports). The hand-off shows "Loading… / Loaded in N s".
- A model that's already loaded (by you, or earlier) is used as it is, and Starwright goes by the context it really has. A second copy is never loaded, and two jobs at once share one load.
- If LM Studio can't load it (not enough memory, say), the hand-off says so, and what to try, and the work goes to another agent.
- With an older LM Studio that can't be asked to load a model, Starwright plans for 8,192 tokens until the model is up, then for what it really has.

## 0.15.9 (2026-11-17)

**The local model doesn't get stuck on a command any more.** A command that started something in the background (a dev server, say) and then ended was waited on for ever, because what it started kept its output open: the hand-off sat on "run_command…" with nothing happening, past its time limit, until it was stopped by hand. Now:
- The local model carries on a moment after such a command ends, and is told the server is still running in the background.
- Whatever its commands left running is stopped when the hand-off ends.
- A command's time limit always ends it, and Stop ends it at once.
- No command can run past the end of the hand-off's own time.

## 0.15.8 (2026-11-17)

**Previews don't leave dev servers running any more.** Stopping a preview always stopped what it started, but only while Starwright was there to do it: after a crash, a forced close or an update restart, the dev servers kept running and held their ports, so the next preview failed with errors like "Port 5173 is already in use". Starwright now writes down each preview's processes while it runs, and stops whatever is still running from that list when it next opens, when a preview stops or restarts, and when a preview's server ends on its own. A process is only stopped if both its id and its start time match what was written down, so nothing else is touched, including a dev server you started yourself.
- A dev server already left running by an earlier version isn't on the list, so it has to be ended once by hand: stop the preview, find it with `Get-NetTCPConnection -LocalPort 5173 -State Listen` in PowerShell, and end that process.

## 0.15.7 (2026-11-17)

**A local model light in the top bar.** Next to the usage meters, a green or red light shows whether LM Studio's server is answering, with the model loaded under it ("Offline" when it isn't answering, "not loaded" when the chosen model isn't in memory). Hover for the address, every loaded model and its context size; click to check again. It's checked every 30 seconds, and only shows while the local model is in use (background jobs or coding hand-offs turned on in Settings → LM Studio).

## 0.15.6 (2026-11-17)

**A ClinePass usage meter.** With a Cline API key saved (Settings → Cline → ClinePass usage meter; make one at app.cline.bot → Settings → API Keys), the top bar shows ClinePass's 5-hour, weekly and monthly limits next to Claude and Codex, the same numbers as Cline's dashboard.
- The key is checked with Cline before it's kept, encrypted on this computer, and only ever sent to Cline. It can be removed in the same place, and it can't be set from a phone or browser (Remote access).
- **Starwright backs off Cline before it runs out.** With less than 15% of a ClinePass window left, Cline only gets hand-offs nobody else can take, background jobs skip it, Claude is told, and the route tag says how much is left.
- The usage report's "Plans now" line, and the `usage` tool for Claude Code, include ClinePass.
- Cline doesn't publish this as an API (it's what its own dashboard reads), so if it changes, the meter shows "—" and nothing else is affected.

**A preview on https no longer crashes Starwright.** Opening the preview of a project whose dev server runs on `https://localhost` (Vite with a certificate, say) from a phone or another computer (Remote access) brought up "A JavaScript error occurred in the main process" and left Starwright hung. The preview now passes through over https, live reload included, and Starwright's check that the preview has started works for https ones too. Anything else that goes wrong reaching a preview shows as an error on that page instead of stopping Starwright.

## 0.15.5 (2026-11-17)

**Go Nutz means no Allow/Deny prompts, for every agent.**
- Claude's own PowerShell commands could still ask in Go Nutz: while a plan was being made, or on the way into building an approved one. They don't any more. (Changing files while planning is still stopped, as before.)
- Cline and the local model don't ask in Go Nutz either, including a Cline that was already running before Go Nutz was turned on (it kept the rules it started with).
- Turning Go Nutz on answers a helper's prompt that's already waiting with Allow, so the hand-off carries on.

**Commands with a web address aren't "outside the project" any more.** The "s:/" of `https://localhost:8443/...` was read as a path on drive S:, so `curl` and `Invoke-WebRequest` calls to your own server asked every time. Web addresses are now skipped; `file://` ones still count as files.

## 0.15.4 (2026-11-17)

**Undo works again after a project's first `npm install`.** The copy Starwright saves before each message (what Undo goes back to, and what the Codex review compares against) failed in any project whose `.gitignore` lists `node_modules`, because git refused Starwright's own "leave node_modules out" rule for naming an ignored folder. From a project's first install on, messages had no Undo and no Codex review. Fixed; and if saving that copy ever fails again, the chat says Undo isn't available for that message, and why.

**Equal faders share the work.** With Codex, Cline and the local model on the same fader, every hand-off went to Codex (ties fell back to the old order). Now the agent that took fewer hand-offs this past week goes first, so 3/3/3 really splits it. A higher fader still always wins.

**The route tag names the agent that would take the work.** It said "Codex does most of the work" whatever the faders were; it now names who a hand-off would go to first ("Cline · does most of the work").

**Claude's fader at its lowest stops the step up to Opus.** With "step up to Opus for complex requests" on, big requests still moved to Opus even with Claude's fader at 1. In Manual with Claude at 1 (or Off), they stay on your chosen model.

**The usage report counts every agent's hand-offs per request.** Requests that handed work to Cline or the local model showed "0 hand-offs", since only Codex's were counted. The report now says "handed work off" rather than "used Codex".

## 0.15.3 (2026-11-16)

**A request still running shows as running when you come back to its chat.** Going to Settings, Extensions or another project and back showed the chat so far, but not that the request was still going: no "working" line and no Stop button, so it looked finished or stuck. The chat now asks whether the project is still busy when it opens, and carries on showing the request's steps as they come.

## 0.15.2 (2026-11-16)

**Cline and the local model get the same Allow/Deny prompt as Claude.** A command that might reach outside the project used to be refused outright for them, while Claude's would just ask you. Now it asks, saying which agent wants to run what, and the hand-off waits for your answer. Unanswered after 5 minutes, it's refused and the prompt goes away, so a hand-off nobody is watching doesn't hang. Destructive commands and pushing stay refused for them, as before; a one-off Cline run (when the hosted one can't be used) and a takeover still refuse, since there's no prompt to wait on.

**Commands with a sed expression aren't taken for paths any more.** `grep ... | sed 's/"//g'` was flagged as "working outside the project folder", because the `//g` looked like a path, and Cline kept retrying it. Expressions like `s/old/new/` are now read as text; files the command reads or writes outside the project still count.

## 0.15.1 (2026-11-16)

**Plans follow the equalizer.** Plan steps only knew "Claude" or "Codex", so a plan made under "Free first" still showed Codex everywhere and kept plain steps like scaffolding with Claude.
- **Steps are marked "Claude" or "Hand off" with how hard they are** (simple, moderate, hard), not with an agent: Starwright picks the agent when the step is built, from your faders. Each hand-off step shows who it would likely go to ("Hand off · simple → Local model"), and once built, who actually did it.
- **Planning is told your settings:** with the faders favouring the helpers (Free first, Save Claude), every self-contained step is marked for hand-off, scaffolding, boilerplate, tests and docs included, and simple pieces get their own steps so they can go to the free local model or Cline. Claude keeps design decisions, wiring the pieces together and the review.
- Plans written before this update, with "(Codex)" steps, are read as hand-offs.

**Backslashes in paths show as backslashes in every theme.** A theme with a Japanese font (Yu Gothic, Meiryo, MS Gothic...) drew them as ¥, so project paths read D:¥Vibe¥WebNotes. The backslash now always comes from Segoe UI, whatever the theme's font, and the theme generator is told not to pick those fonts.

## 0.15.0 (2026-11-16)

**The work equalizer** (step 3): the Claude/Codex slider in the top bar is replaced by a fader each for Claude, Codex, Cline and the local model, from Off to First choice. Click the equalizer button beside the usage meters to open it.
- **Manual:** the faders decide. A helper's fader sets where it comes in the order for each hand-off (higher first; equal faders keep the usual order: simple work to the local model, then Cline, then Codex; harder work to Codex first). Off means never, even when Claude asks for it by name. Claude's fader against the strongest helper sets how much Claude hands off. The roles still hold: the local model never gets hard work or moves ahead of the others above simple work, and a nearly used-up Codex plan still moves Codex to the back.
- **Claude can go to Off:** Codex then plans, builds and answers every request directly, as when Claude's plan is used up, without asking first, and nothing (the small background jobs included) uses your Claude plan. Codex can't be Off at the same time. When Claude comes back, it's told what Codex did meanwhile.
- **Presets:** Balanced, Save Claude, Free first and Best quality.
- **Meters beside the faders:** what each one actually built over the last 7 days. A route that isn't set up (not signed in, or hand-offs switched off in Settings) says so under its fader.
- **Auto** works as the slider's Auto did (leaning toward the plan with more left) until it learns from the quality records in a later update.
- **Your slider setting carries over:** a fixed slider position becomes the matching Manual faders; Auto stays Auto.

**Fix:** on a phone, a long plan step no longer runs off the edge of the screen.

## 0.14.1 (2026-11-15)

**Codex, Cline and the local model can use the project's secrets.** Only Claude had them: the other agents were started without them, so a hand-off (or a takeover when Claude is out) that needed an API key failed. Now each gets the same secrets Claude gets, as environment variables (Starwright's own keys still stay hidden from all of them), and its task lists their names, never their values, with how to read them. A Cline that keeps running between hand-offs starts afresh when the project's secrets change.

## 0.14.0 (2026-11-15)

**Starwright now decides who gets each hand-off** (step 2 of the work equalizer). Claude used to choose between Codex, Cline and the local model itself, and in practice almost always picked Codex: on one install, Cline and the local model got no coding work in 30 days although both were switched on.
- **One hand-off tool for Claude:** it describes the task, what kind it is (feature, bug fix, tests, refactor, boilerplate, docs) and how hard (simple, moderate, hard). Starwright picks the agent: simple work goes to the free local model first, then Cline, then Codex; moderate work to Codex first; hard work to Codex or Cline, never the local model. Tests, boilerplate and docs count as simple unless Claude says they're hard. A nearly used-up Codex plan moves Codex to the back; an agent you ask for by name goes first.
- **Passed on when one fails:** if an agent fails without changing anything, the next one gets the task (a cheaper agent with another behind it gets 10 minutes, not 15, so a stall doesn't hold things up). The chat card shows who got it, and Claude is told who did it and who passed it on.
- **Claude is asked to split bigger jobs**, handing the simple, well-specified parts off separately so they can go to the cheaper agents, even when nothing in the request suits Codex.

**Quality is now tracked as and after work is done**, for each agent and kind of task (shown on the meters and in the usage report):
- **Your reaction:** pressing Undo on a request, or saying the last result was wrong or broken ("that broke the login", "still not working"; Haiku spots it while labelling the message), counts against whoever built it.
- **Redone hand-offs:** Claude, or a later hand-off, changing the same files again in the same request.
- **Fixes that held:** after Codex's review and Claude's fixes, the automatic checks run again.
- **Why a request wasn't reviewed** (quick edit or plan, Codex built it, reviews off, Codex low, no changes...), to find out why reviews are rare. Work by Cline or the local model is now always reviewed like Claude's own.

## 0.13.0 (2026-11-15)

**Who did the work.** The first step toward a work equalizer (one fader each for Claude, Codex, Cline and the local model, in place of the Claude/Codex slider): before the faders, the meters.
- **Settings, "Where your usage goes", now opens with a meter per route:** each one's share of the building over the last week (Claude editing files itself, or a hand-off it carried out), with what else it did (requests it was in charge of, reviews, background jobs) and how its work went. Hover a row for the detail.
- **New records, for judging how good each route's work is:** whether each hand-off's automatic checks passed, and every Codex review with who built the change and how serious its findings were.
- **The usage report** (Settings, and Claude Code through the API) starts with the same breakdown, "Who did the work".

## 0.12.0 (2026-11-15)

**Secrets move to a new computer with a backup password.** Secrets and extension keys are locked to the Windows account that saved them, so until now a backup couldn't bring them to another computer.
- **Set a backup password** in Settings, Backups. Every backup (nightly, by hand or exported) then also carries the secrets and extension keys, locked with that password (AES-256 with a key made from it by scrypt). The password stays on this computer, locked with its Windows key, and never goes in a backup. Backups that carry them say "secrets included".
- **Restoring on another computer asks for it**, then locks the secrets again with the new computer's key, so they work as before. A wrong password stops the restore before anything changes. Without it (or with no password set), everything else restores and those projects simply ask for their secrets again, instead of showing "couldn't be unlocked".
- Only Starwright on the computer itself can set the backup password, not a Remote access device.
- Sign-ins to Claude, Codex and GitHub belong to those tools and are made again on the new computer; Remote access pairings stay with each computer.

**Get it from GitHub for every missing project.** Projects restored from a backup made before 0.11.1 have no saved GitHub address; "Get it from GitHub" now offers them too, with your repository list (the one with the project's name already picked), then downloads it and links it, keeping its memory and history.

Also: two backups made in the same second no longer collide.

## 0.11.1 (2026-11-14)

**Projects whose folder isn't on this computer** (after restoring a backup made on another computer, or after moving or deleting a folder):
- **Marked in the list** as "Not on this computer". Clicking one no longer opens a project that can't work; it explains, and offers:
- **Find it…:** pick where the folder is now. The project keeps its memory, chats, notes and to-dos (before, opening it from a different place started it afresh, with its memory left behind under the old one). A folder that is plainly a different GitHub project, or one already in the list, is refused.
- **Get it from GitHub:** for projects with a GitHub copy, download it and link it in one step. Starwright now notes each project's GitHub address while its folder is here, so this works after a restore.
- Requests and schedules for a project whose folder is missing stop with a clear message instead of failing partway.

## 0.11.0 (2026-11-14)

**VibeApp is now Starwright**, a better fit for what it has become: a control center where Claude, Codex, Cline and a local model work on your projects together.
- **The new name everywhere you see it:** the title, the footer, the window and taskbar, the installer and shortcuts, the tray, Windows and phone notifications, Settings, the phone and browser view, and what the agents are told.
- **Nothing moves.** Updating keeps your projects, memory, chats, settings, secrets, schedules, extensions and paired devices exactly where they were. Undo history in your projects, "Start with Windows", and Claude Code's connection to the app keep working. New backups go to Documents\Starwright Backups, unless your earlier ones are in Documents\VibeApp Backups, which stays in use.
- **New home:** https://github.com/mrg1nger/starwright. Updates come from there from now on; this version is also published in the old VibeApp repository so existing copies find it.

## 0.10.0 (2026-11-14)

**Coding hand-offs to the local model.** Claude can hand straightforward coding work to VibeApp's own coding agent running on the model in LM Studio: free, and nothing leaves the computer.
- **Turn it on** in Settings → LM Studio → "Claude can hand coding work to LM Studio" (off until you do). Claude is told it's there on requests where it might hand work off, and that it suits simple, well-specified jobs.
- **Controlled by VibeApp.** The model can only ask for six things: list, read, search, edit or write files, and run a command. VibeApp carries out each one itself, only inside the project: deleting folders, pushing and anything outside the project are refused, as for Cline.
- **Like the other hand-offs:** its steps show live in the chat ("Local model is working"); Claude gets back its report, the files changed with a diff, and the automatic checks; Codex reviews the change; and it's logged as LM Studio usage (free) in the usage report.
- **Built for a local model:** short instructions, edits that still apply when the model copies text with different line endings or spaces, older tool output trimmed when the conversation fills the model's context, and a stop when it repeats itself or runs out of steps. Thinking is off (the same score at about twice the speed).
- Tested: Qwen3.6 35B-A3B in LM Studio (RTX 4060, 8 GB) passed all five coding tasks of the hand-off eval twice (fixing a bug, adding a feature, a rename across files, a feature over three files, and a bug that isn't where the failing test points), about 24 s per task. A real Claude session handed it a task and got the change back in 21 s. Codex on LM Studio was tried first and doesn't work with this model.

## 0.9.0 (2026-11-13)

**LM Studio: VibeApp's background jobs on a model on your own computer.**
- **Settings → LM Studio.** Turn on "Background jobs on LM Studio" and saving memory, the memory tidy-up, the project brief, file summaries and chat summaries run on the model loaded in LM Studio: free, and the text never leaves the computer. Off until you turn it on.
- **First in line.** LM Studio is asked first, then Cline, then Haiku; if LM Studio is closed or can't do a job, the next one does it as before.
- **The panel finds the server** (http://localhost:1234 by default, or another address) and lists its models, loaded ones marked. Pick one or use whichever is loaded. "Test LM Studio" sends a one-word request and says how long it took. Warnings when the address is another computer or the model's context is too small.
- **Fast and checked.** The answer's format is enforced by LM Studio and checked again by VibeApp. Thinking is off except for the tidy-up (about ten times faster on Qwen3.6). Usage is logged as LM Studio, with its own section in the usage report.
- Tested: Qwen3.6 35B-A3B in LM Studio scored 8/8 on the memory-saving eval (the same as Haiku), about 21 s per job on an RTX 4060.

## 0.8.0 (2026-11-11)

VibeApp carries RedAstra Labs' branding (redastralabs.com):
- **"RedAstra Labs" with its star over the VibeApp title.** It opens redastralabs.com.
- **A footer on every screen:** the version, then links to redastralabs.com, the GitHub repository and the MIT licence, each with a small icon. On a phone it's one short line.
- **A RedAstra theme** in Settings, in the website's colours: near-black with RedAstra red. Your current theme stays as it is until you pick it.

## 0.7.0 (2026-11-11)

Third step of the memory work (Memory v3): **memory knows when it may be old.**
- **Facts are linked to the files they are about.** When the note-taker saves something after a request, it is linked to the files that request changed and the fact is about. A fact that names a file ("prices are in shop.js") is linked to it too.
- **"May be out of date."** Every request's changes are counted against the facts about those files. When a file has changed by about its own length since, or is deleted, Claude, Codex and Cline see the fact marked "may be out of date" (and why), and so does the Memory screen.
- **The tidy-up checks those first.** It reads the files as they are now and retires a fact they clearly contradict; one they don't contradict is kept and counts as up to date again. Tested on the background models: Kimi K3.1 Pro and MiniMax M3.1 Flash got all 24 cases right over three runs, Haiku all 8.
- **Facts nobody looks up are retired**: none looked up (searched, or attached to a request) for 60 days and 30 of the project's requests. Never key facts or your preferences for every project, and a project you leave alone for a while loses nothing. Retired facts stay under Show forgotten.
- **Which fact replaced which.** A corrected or merged fact says what replaced it, under Show forgotten.
- **On the Memory screen:** a "Useful lately" order (most recently looked up first); the files each fact is about; whether memory is searched by meaning on this computer; and approved plans, which open in full (from their fact, or the new Approved plans list).

## 0.6.0 (2026-11-10)

Second step of the memory work (Memory v3): **memory is searched by what you mean, not by matching words.**
- **"Put it online" finds the fact about deploying**, even though they share no word. A small language model (gte-small, 34 MB) reads every remembered fact and every file summary and compares meanings. It runs on your own computer, inside VibeApp; nothing is sent anywhere for it.
- **Claude, Codex and Cline all get it.** Their memory tools (`recall`, `where`) ask the running VibeApp, over a private channel on this computer that nothing on the network can reach. An exact name such as an error message is still found by its letters.
- **Fewer, better facts are attached to each request.** Before, any distinctive word in common was enough, so "ok do it" often came with unrelated facts. Now a fact or file is attached only when it is close in meaning.
- **Measured.** On the search test (120 questions with known answers): the right fact or file among the first five 93% of the time, against 70% before; 80% against 0% when the question shares no word with its answer. On 50 real requests from two real projects, judged without knowing which search found what: a directly useful fact among the first five for 44 requests instead of 38; three quarters of the attached facts useful instead of under half; and of 18 messages like "ok do it", 3 got a fact attached instead of 12.
- **The first start after updating** takes a moment in the background to read through everything already remembered (about a hundredth of a second per fact or file). Until that is done, and on a computer where the model can't run, memory is searched by keyword as before.
- The installer is 31 MB bigger (245 MB instead of 214 MB): the model and the program that runs it.
- For developers: the model is fetched by `npm install` (it isn't in the repository), comparing is done by the sqlite-vec add-on, and `npm run package` now checks that only the built app went into the installer.

## 0.5.5 (2026-11-10)

First step of the memory work planned in the roadmap (Memory v3):
- **Approved plans are kept whole.** A plan you approve is saved in full, and Claude, Codex and Cline can read it back (the new `plans` memory tool). Before, memory kept only the steps squeezed onto one line and cut at 950 characters. The Memory screen now shows one line per plan, such as "Approved 2026-11-10: Security review of FNotes (plan #3…)". Plans saved before are moved over once, with what was kept of them.
- **The memory test was wrong about "every project" rules, not the note-taker.** The test let a rule saved by one model count as already known to the next, so every model after the first looked as if it missed the rule. Fixed, with a harder case added. Every model ClinePass runs gets 6 of 6; Kimi K3.1 Pro and MiniMax M3.1 Flash 18 of 18 over three runs. The note-taker's instructions are unchanged, and the scores in Settings → Cline are corrected.

## 0.5.4 (2026-11-10)

- **Approved plans are remembered with all their letters.** A plan approved without numbered steps (a look over the project, a review) was saved to memory with every "s" taken out ("Thi reque t wa ju t…"), since plan mode first shipped. Those saved plans can't be repaired, so VibeApp forgets them once on start; they stay under Show forgotten.

## 0.5.3 (2026-11-10)

- **Publish remembers the last GitHub backup after a restart.** The time was only kept in memory, so after an update (which restarts VibeApp) Publish said nothing about the last backup until the next one. Backups themselves were never affected.
- **A Cline model typed into Settings can't undo a newer choice.** The text box (used only when Cline's model list can't be read) kept the value it opened with and saved it back when clicked out of, over a change made from another window, a phone or the API. Seen on 0.5.0's box, which put a background-job model back.

## 0.5.2 (2026-11-10)

- **"Default" means the same Cline model everywhere.** With no model chosen, hand-offs ran on ClinePass's default (Kimi K3.1 Pro) but background jobs and Test Cline on whatever the computer's own Cline setup defaulted to (MiniMax on one machine). They now all use ClinePass's default, so "Same as hand-offs" is true.

## 0.5.1 (2026-11-10)

- **Settings → Cline has real model menus.** They list the ClinePass models Cline offers right now (read from Cline, with their proper names), each with VibeApp's own test results, and say which model "ClinePass's default" means. A model ClinePass refuses or no longer offers is marked. The old suggestions were out of date, and one of them (Qwen3.7 Plus) is refused by ClinePass.
- **Every ClinePass model tested** on hand-off coding (three tasks checked by the project's own tests) and on saving memory. All 10 models ClinePass runs did the coding tasks; five it lists are refused (Qwen3.7 Plus and Max, MiniMax M3, MiMo V2.6 Flash and Pro). **Kimi K3.1 Pro** (ClinePass's default) is recommended for both: 3/3 at ~19 s per task, and 14/15 memory cases at under 4 s.
- Fixed: VibeApp's automatic `npm test` check after a hand-off could report a pass for failing tests when VibeApp itself ran under a test runner (found by the new coding test, which had the same flaw).

## 0.5.0 (2026-11-10)

Cline hand-offs run on a Cline that stays running, the way editors such as Zed and JetBrains host it (`cline --acp`):
- **No start-up wait.** A one-off Cline took 4–12 s just to start; the hosted one starts in about a second, once. A second hand-off in the same request starts at once (1.3 s for a short one in testing) and remembers the first.
- **Every step is checked twice.** VibeApp's safety hook still runs first (and tells Cline why something was refused), and now Cline also asks VibeApp's permission for each step, which VibeApp answers with the same rules.
- **Always on ClinePass.** Left to itself, a hosted Cline starts on Cline's pay-as-you-go billing; VibeApp pins ClinePass and checks the model before sending anything.
- Token usage still shows in the usage report (read from Cline's own session record).
- If the hosted Cline can't start, the hand-off runs the old way. Background jobs and reviews still use one-off runs.
- Hand-offs with no model chosen now use ClinePass's default for hosted sessions (Kimi K3.1 Pro); pick one under Settings → Cline.

## 0.4.3 (2026-11-10)

- **Fewer background jobs fall back to Claude.** Cline's newer default model sometimes left out an empty list in its answer, and VibeApp threw the whole answer away and asked Haiku instead (half the memory saves on one computer). A left-out list now counts as empty.
- Tested nine ClinePass models on saving memory: **MiniMax M3.1 Flash** got all 15 cases right and was the fastest, so it's the one to choose under Settings → Cline for background jobs. Three models in ClinePass's list (Qwen3.7 Plus, Qwen3.7 Max, MiMo V2.6 Flash) are currently refused.

## 0.4.2 (2026-11-10)

- **Plan mode really changes nothing now.** It used to rely on Claude following its instructions: Claude Code's own plan mode lets commands run, and VibeApp approved its own tools (Deploy, hand-offs to Codex and Cline) in every mode. Found on a real install, where a "done" sent while the switch was still on Plan deployed, migrated a production database over ssh and handed work to Codex. Now VibeApp checks every step while planning, Go Nutz or not: reading, searching, read-only commands (`git status`, `ls`…), memory, notes, to-dos and drafts are fine; edits, other commands (ssh included), Deploy, hand-offs and installs are turned away.
- **One prompt to leave Plan mode.** When your message needs something done now, Claude asks once, saying what and why: **Switch to Build and allow** (the rest of the request is a normal Build, and the switch moves to Build) or **Keep planning** (it carries on planning and doesn't ask again in that request).

## 0.4.1 (2026-11-10)

- **After an update, VibeApp says so once:** "VibeApp was updated to 0.4.2 (from 0.4.1)", with a What's new link. It starts with the update after this one, since versions before 0.4.1 didn't record which version ran last.

## 0.4.0 (2026-11-10)

VibeApp updates itself from GitHub Releases:
- **A banner when there's a new version,** across the top of every screen. It has a **What's new** link to the release page, **Update and restart**, **Skip this version** (a newer one still shows) and **Not now**.
- **Update and restart** downloads the new installer and checks it against the release's SHA-512. VibeApp then closes, installs it quietly and opens again. If a project is still working, it asks first.
- **Settings → Updates:** the running version, **Check for updates**, a link to all releases, **Look for new versions automatically** (on; at start and every 6 hours), and **Remind me again** for a skipped version.
- Remote browsers see the banner too, but installing happens on the computer.
- For whoever makes releases: `npm run release` publishes the packaged version with the files the updater needs, and the changelog section as the notes.

## 0.3.1 (2026-11-09)

Security check before the code goes public:
- **Links can only open web pages or email.** The window used to hand any kind of link (file:, ms-…: and other program launchers) to Windows, and nothing stopped it leaving VibeApp's own screens.
- **Pairing codes can't be guessed from many addresses.** After 20 wrong codes from anywhere in 10 minutes, pairing pauses for everyone and the code changes.
- **Remote access "This computer" mode only answers to localhost**, so a website can't reach it by pointing its own name at this computer (DNS rebinding).
- Updated dependencies with known security problems (zod and others); `npm audit` finds none in what the app ships.
- The node-pty patch holds only its one real change, no build files.

## 0.3.0 (2026-11-09)

Cline (on the ClinePass plan) joins Claude and Codex:
- **Background jobs on Cline.** Saving memory, the tidy-up, the project brief, file summaries and chat summaries no longer use Claude's plan. Haiku steps in if Cline can't do one.
- **Claude can hand straightforward work to Cline** (`run_cline_subtask`). Codex reviews what Cline changed.
- **Cline takes a request when Claude and Codex are both out.**
- **Safety:** every Cline tool call goes through VibeApp's check. Cline works only inside the project, destructive commands are swapped for a "blocked" message, and the account connectors (Gmail, Drive) are switched off and refused.
- **Settings → Cline (ClinePass):** on/off for each use, the models, and Test Cline.
- **The usage report counts Cline separately.** New evaluations: `npm run eval -- helpers` and `VIBEAPP_EVAL_BUILDER=cline`.

## 0.2.0 (2026-11-09)

The first numbered step. Everything built up to here, including:
- Codex-led really hands off the work: Codex builds and tests, Claude plans and judges the report.
- Claude deploys with the saved Deploy (run_deploy), and Claude Code can too through the connector.
- Usage evaluations: every request recorded, Settings → Detailed report, `npm run usage`, `npm run eval`.
- Memory lives in the open project (🧠 Memory next to History).
- GitHub backup and sync, Schedules, Remote access, Deploy.

## 0.1.0

Everything before version numbers were stepped.

# Changelog

The version goes up with each improvement that ships: the middle number for new features, the last for fixes only. Settings shows the version a computer is running. (Starwright was called VibeApp up to 0.10.0.)

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

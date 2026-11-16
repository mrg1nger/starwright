# Changelog

The version goes up with each improvement that ships: the middle number for new features, the last for fixes only. Settings shows the version a computer is running. (Starwright was called VibeApp up to 0.10.0.)

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

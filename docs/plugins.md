# Writing a Starwright plugin

A plugin adds something to Starwright that it doesn't have, for one project or for all of them.
You, Claude or Codex can write one. A plugin can have:

- **Panels**: pages shown in the 🧩 Plugins pane beside the chat, such as a dashboard.
- **Commands**: programs it runs on this computer, from the project's folder.
- **Buttons**: run a command when you press them.
- **Hooks**: run a command when something happens (a request, hand-off or Deploy finishes).
- **Schedules**: run a command at set times, while Starwright is running.

Nothing in a plugin runs until you approve it, on the computer running Starwright.

## Where plugins live

- `.starwright/plugins/<name>/` inside a project holds that project's own plugins. They go into
  git with the project.
- Starwright's `plugins` folder holds plugins for every project. It's `%APPDATA%\vibeapp\plugins`
  on Windows, and the Plugins pane has a link that opens it.

A plugin is a folder with a `plugin.json` and the files it uses. The folder's name must match the
plugin's `name`. A plugin can have up to 200 files and 5 MB, all real files (no links).

## plugin.json

```json
{
  "name": "todo-finder",
  "title": "TODO Finder",
  "version": "1.0.0",
  "description": "What it does, in a sentence.",
  "permissions": ["commands", "chat:draft"],
  "panels": [{ "id": "list", "title": "TODOs", "entry": "panel.html" }],
  "commands": [{ "id": "scan", "title": "Scan for TODOs", "run": ["node", "{plugin}/scan.js"], "timeout": 60 }],
  "buttons": [{ "title": "Scan now", "command": "scan" }],
  "hooks": [{ "on": "files-changed", "command": "scan" }],
  "schedules": [{ "id": "morning", "command": "scan", "when": { "kind": "daily", "time": "09:00" } }]
}
```

- `name`: lower-case letters, digits and dashes, up to 40 characters.
- `version`: written like `1.0.0`. Change it when you change the plugin.
- `permissions`: only what the plugin uses. See the list below.
- `panels`: up to eight. Each `entry` is an `.html` file inside the folder.
- `commands`: up to 20. A plugin needs at least one panel or one command.
- `buttons` (up to 6), `hooks` (up to 8) and `schedules` (up to 6) name a command by its `id`.

### Permissions

| Permission | What it allows |
|---|---|
| `files:read` | A panel reads the project's files (never files that usually hold keys, like `.env`) |
| `storage` | A panel keeps its own small store of data, up to 1 MB for each project |
| `records:read` | A panel reads Starwright's records for the project: requests, tokens, hand-offs and schedules, and hears events while it's open |
| `commands` | The plugin runs its commands. Needed whenever it has any |
| `notify` | It sends you alerts, on this computer and on your phone if phone alerts are on |
| `chat:draft` | A panel puts text in the chat's message box. You still choose whether to send it |

## Approval

The Plugins pane shows what a plugin asks for in plain words. It shows each command exactly as it
will run, and when it runs by itself. Approving covers the exact files you saw, by a fingerprint
of all of them. If any file changes afterwards, or the plugin asks for a new permission, nothing
of it runs or opens until it's approved again. So after an agent writes or edits a plugin, you
approve it before it runs. The chat points this out when a request changed a project's plugin.

Turning a plugin off keeps the approval, so you can turn it back on. **Pause all** in the Plugins
pane stops every plugin at once, and starting Starwright with `--safe-mode` starts with them all
paused.

## Commands

A command is a program, run as you, from the project's folder. It can do what any program you
run can do, which is why each one is shown for approval.

- `"run": ["node", "{plugin}/scan.js"]`: a list is the program and its arguments, run without a
  shell. `node` is Starwright's own Node, so a plugin's scripts work without Node installed.
  Other programs (`npm`, `git`, `python`) are found on the PATH.
- `"run": "npm test -- --reporter dot"`: text is a command line for the shell (PowerShell on
  Windows, `sh` elsewhere).
- `{plugin}` is the plugin's files as approved: a copy, so a file changed after approval never
  runs. `{project}` is the project's folder. `{data}` is a folder of the plugin's own for this
  project, for what it keeps between runs.
- `timeout` is in seconds (default 120, at most 3600). A command that runs longer is stopped.

A command also gets these environment variables: `STARWRIGHT_PROJECT`, `STARWRIGHT_PROJECT_NAME`,
`STARWRIGHT_PLUGIN_DIR`, `STARWRIGHT_DATA_DIR`, `STARWRIGHT_TRIGGER` (`button`, `panel`,
`hook:<event>` or `schedule:<id>`), `STARWRIGHT_EVENT` (the event as JSON, for a hook), and
`STARWRIGHT_INPUT` (what the panel passed, as JSON). It doesn't get the project's secrets.

What a command prints is kept with its run (the last 8000 characters, any secret values masked).
Exit code 0 means it worked. Lines that start like this mean something to Starwright:

| Line | What happens |
|---|---|
| `::status <text>` | The run's one-line summary, shown in the Plugins pane and the chat |
| `::note <text>` | A line in the project's chat (up to 5 a run) |
| `::notify <text>` | An alert for you (needs `notify`) |
| `::json <json>` | Data for the plugin's panel, kept with the run (up to 200 KB) |

### When commands run

- **A button** in the Plugins pane runs it. How it went shows in the chat.
- **A panel** runs it with `starwright.commands.run(id, input)` and gets the run back.
- **A hook** runs it when something happens: `request-end` (a request in the chat finished),
  `files-changed` (a request changed files), `handoff-end` (a hand-off to Codex, Cline or the
  local model finished) or `deploy-end` (a Deploy finished). The event comes in
  `STARWRIGHT_EVENT`, for example
  `{ "type": "request-end", "at": "…", "outcome": "done", "request": "…", "files": ["src/a.js"] }`.
- **A schedule** runs it at set times while Starwright is running:
  `{ "kind": "daily", "time": "09:00", "days": [1, 2, 3, 4, 5] }` (days are 0 for Sunday to 6;
  every day if left out) or `{ "kind": "every", "minutes": 60 }` (at least 5). A time missed by
  more than 3 hours is skipped, not made up for. Schedules don't run while schedules are paused
  in Settings. A plugin for every project runs its schedules in each project opened in the last
  two weeks.

A plugin runs one command at a time. Runs from hooks and schedules wait their turn, at most 3. If
its runs from hooks and schedules fail 3 times in a row, Starwright turns it off and says why in
the chat. Turn it on again once it's fixed.

## What a panel can do

A panel runs in a locked-down frame:

- It runs its own scripts and styles, and shows pictures from its own folder or `data:` URLs.
- It has no internet access, can't load from other sites, and has no frames, forms or pop-ups.
- It can't reach Starwright's page, your keys or settings, or the rest of the computer.

Use paths relative to the page (`style.css`, not `/style.css`), so the panel also works over
Remote. The one exception is the helper script that gives the page `window.starwright`:

```html
<script src="/_starwright/api.js"></script>
```

Draw charts yourself, with SVG or canvas. A library has to be copied into the plugin's folder,
because it can't be loaded from the internet. When a panel needs something from outside, a
command can fetch it and hand it over with `::json`.

### The API

Every call returns a promise. A call the plugin has no permission for fails with an error that
says which permission it needs.

| Call | Permission | Returns |
|---|---|---|
| `starwright.ready` | none | `{ project: { name }, plugin: { name, title, version }, permissions, commands, theme }` |
| `starwright.files.list()` | `files:read` | `{ files: string[], changed: { [path]: 'modified' \| 'added' \| 'deleted' \| 'untracked' \| 'renamed' }, truncated }`. Changes are since the last checkpoint, and the list follows `.gitignore` |
| `starwright.files.read(path)` | `files:read` | `{ kind: 'text', text, truncated, size }`, `{ kind: 'image', dataUrl }`, or `{ kind: 'binary' \| 'secret', size }` |
| `starwright.storage.get(key)` / `.set(key, value)` / `.remove(key)` / `.keys()` | `storage` | The plugin's own store for this project: any JSON value |
| `starwright.records.requests({ days })` | `records:read` | Each request: `at, mode, route, size, model, text` (up to 200 characters), `outcome` (`done` / `stopped` / `error`), `seconds, handoffs`, and `claude`, `codex` and `cline` tokens (`fresh, cached, output`) |
| `starwright.records.usage({ days })` | `records:read` | Each step's tokens: `at, kind, agent, model, fresh, cached, output, steps, costUsd` |
| `starwright.records.handoffs({ days })` | `records:read` | Each hand-off: `id, agent, status, brief, kind, model, startedAt, finishedAt, files` (a count) |
| `starwright.records.schedules()` | `records:read` | Each of the project's schedules: `name, kind, enabled, nextAt`, and its last 30 `runs` (`at, status, detail, trigger`) |
| `starwright.onEvent(fn)` | `records:read` | Calls `fn` with each event in the project while the panel is open (the same events hooks get) |
| `starwright.commands.run(id, input)` | `commands` | Runs one of its commands and resolves to the run: `{ at, ok, exitCode, seconds, output, status, result }` (`result` is its `::json`) |
| `starwright.commands.runs(id)` | `commands` | Its latest runs (of that command, or all), newest first |
| `starwright.notify(text)` | `notify` | Sends you an alert |
| `starwright.chat.draft(text)` | `chat:draft` | Puts text in the chat's message box |
| `starwright.onTheme(fn)` | none | Calls `fn` when Starwright's theme changes |

`days` is 1 to 365 (30 if left out), and a call returns at most 2000 rows. Records are always for
the project the panel is open in.

### Fitting the theme

The page gets Starwright's theme as CSS variables, and they update when the theme changes:
`--sw-bg` (the pane's background), `--sw-surface`, `--sw-sunken`, `--sw-text`, `--sw-muted`,
`--sw-border`, `--sw-accent`, `--sw-accent-text`, `--sw-good`, `--sw-warn`, `--sw-bad`,
`--sw-font` and `--sw-radius`. `<html data-theme>` is `dark` or `light`. Give the variables
fallback values in your CSS, so the page still looks right before it connects.

## Over Remote

On a phone or another computer connected through Remote, the Plugins pane lists the plugins and
opens their panels. A device with full access can also use their buttons, and its panels can run
commands. A read-only device's panels can only read. Approving, turning plugins on and off,
adding them and pausing them happen on the computer running Starwright.

## For Claude and Codex

- Read this guide with the `plugin_guide` tool before writing or changing a plugin.
- Write it in `.starwright/plugins/<name>/` in the project.
- Run `plugin_check` with its name when it's written. It checks plugin.json and that the files it
  names are there. It also checks that the scripts parse and nothing the panel loads would be
  blocked, and says whether it's approved.
- You can't approve or run it. Finish by telling the user what it does, what it asks for and when
  it runs, and that it's waiting in 🧩 Plugins.

## Examples

Starwright comes with two, which you can add from the Plugins pane:

- **Project Pulse** (`resources/plugins/project-pulse`), a panel. It shows requests per day,
  tokens by agent, hand-offs by agent, scheduled runs and the files changed since the checkpoint,
  and remembers the range you chose.
- **TODO Finder** (`resources/plugins/todo-finder`), a panel with a command, a button, a hook and
  a schedule. It finds TODO, FIXME and HACK comments after each request that changes files, every
  morning, and when you press Scan now. Its panel lists them by file, and each has an Ask Claude
  button that puts a request in the message box.

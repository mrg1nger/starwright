# Writing a Starwright plugin

A plugin adds something to Starwright that it doesn't have, such as a dashboard for a project.
You, Claude or Codex can write one. This is release 1, so a plugin is **one or more panels**:
pages shown in the 🧩 Plugins pane beside the chat.

## Where plugins live

- `.starwright/plugins/<name>/` inside a project holds that project's own plugins. They go into
  git with the project.
- Starwright's `plugins` folder holds plugins for every project. It's `%APPDATA%\vibeapp\plugins`
  on Windows, and the Plugins pane has a link that opens it.

A plugin is a folder with a `plugin.json` and the files it names. The folder's name must match
the plugin's `name`. A plugin can have up to 200 files and 5 MB, all real files (no links).

## plugin.json

```json
{
  "name": "project-pulse",
  "title": "Project Pulse",
  "version": "1.0.0",
  "description": "What it shows, in a sentence.",
  "permissions": ["records:read", "files:read", "storage"],
  "panels": [{ "id": "pulse", "title": "Pulse", "entry": "panel.html" }]
}
```

- `name`: lower-case letters, digits and dashes, up to 40 characters.
- `version`: written like `1.0.0`.
- `permissions`: only what the plugin uses. See the list below.
- `panels`: one to eight panels. Each `entry` is an `.html` file inside the folder.

## Approval

Nothing in a plugin runs until it's approved in the Plugins pane, **on the computer running
Starwright**. The pane shows what the plugin asks for in plain words.

The approval covers the exact files you saw, by a fingerprint of all of them. If any file
changes afterwards, or the plugin asks for a new permission, it won't open until it's approved
again. So after an agent edits a plugin, you need to approve it again before it opens.

Turning a plugin off keeps the approval, so you can turn it back on.

## What a panel can do

A panel runs in a locked-down frame:

- It runs its own scripts and styles, and shows pictures from its own folder or `data:` URLs.
- It has no internet access, can't load from other sites, and has no frames, forms or pop-ups.
- It can't reach Starwright's page, your keys or settings, or the rest of the computer.

Everything else goes through `window.starwright`, which comes from a script every panel gets:

```html
<script src="/_starwright/api.js"></script>
```

Draw charts yourself, with SVG or canvas. A library has to be copied into the plugin's folder,
because it can't be loaded from the internet.

### The API

Every call returns a promise. A call the plugin has no permission for fails with an error that
says which permission it needs.

| Call | Permission | Returns |
|---|---|---|
| `starwright.ready` | none | `{ project: { name }, plugin: { name, title, version }, permissions, theme }` |
| `starwright.files.list()` | `files:read` | `{ files: string[], changed: { [path]: 'modified' \| 'added' \| 'deleted' \| 'untracked' \| 'renamed' }, truncated }`. Changes are since the last checkpoint, and the list follows `.gitignore` |
| `starwright.files.read(path)` | `files:read` | `{ kind: 'text', text, truncated, size }`, `{ kind: 'image', dataUrl }`, or `{ kind: 'binary' \| 'secret', size }`. Files that usually hold keys (`.env`, `*.pem` …) are never shown |
| `starwright.storage.get(key)` / `.set(key, value)` / `.remove(key)` / `.keys()` | `storage` | The plugin's own store for this project: any JSON value, up to 1 MB in all |
| `starwright.records.requests({ days })` | `records:read` | Each request: `at, mode, route, size, model, text` (up to 200 characters), `outcome` (`done` / `stopped` / `error`), `seconds, handoffs`, and `claude`, `codex` and `cline` tokens (`fresh, cached, output`) |
| `starwright.records.usage({ days })` | `records:read` | Each step's tokens: `at, kind, agent, model, fresh, cached, output, steps, costUsd` |
| `starwright.records.handoffs({ days })` | `records:read` | Each hand-off: `id, agent, status, brief, kind, model, startedAt, finishedAt, files` (a count) |
| `starwright.records.schedules()` | `records:read` | Each schedule: `name, kind, enabled, nextAt`, and its last 30 `runs` (`at, status, detail, trigger`). What a schedule does isn't included |
| `starwright.onTheme(fn)` | none | Calls `fn` when Starwright's theme changes |

`days` is 1 to 365 (30 if left out), and a call returns at most 2000 rows. Records are always
for the project the panel is open in.

### Fitting the theme

The page gets Starwright's theme as CSS variables, and they update when the theme changes:
`--sw-bg` (the pane's background), `--sw-surface`, `--sw-sunken`, `--sw-text`, `--sw-muted`,
`--sw-border`, `--sw-accent`, `--sw-accent-text`, `--sw-good`, `--sw-warn`, `--sw-bad`,
`--sw-font` and `--sw-radius`. `<html data-theme>` is `dark` or `light`. Give the variables
fallback values in your CSS, so the page still looks right before it connects.

## An example

Starwright comes with **Project Pulse** (`resources/plugins/project-pulse`). It shows requests
per day, tokens by agent, hand-offs by agent, scheduled runs and the files changed since the
checkpoint, and remembers the range you chose. To add it, use "Add the Project Pulse example"
in the Plugins pane.

## Coming next

- Release 2: commands, buttons, hooks (when a request ends, when files change, when a hand-off
  ends) and schedules.
- Release 3: tools for Claude and Codex to create, check and reload plugins, and panels you can
  view over Remote.

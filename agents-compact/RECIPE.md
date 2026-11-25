# Agents, compact

Herdr's `agents` sidebar list with slightly smaller rows and text, so more fit.

![Agents, compact](preview.png)

## What you see

Exactly Herdr's `agents` mod, with these sizes:

| | Herdr | compact |
| --- | --- | --- |
| Row text (the list's base size) | 13px | 12px |
| Agent name | 12.5px | 11.5px |
| Rows | 30px | 26px |
| Tree rows, loading and empty rows | 28px | 25px |
| Section headers (machines, groups) | 26px | 24px |

Smaller text (10 to 11.5px), icons, avatars and the panel header are unchanged.

## How it's made

Copy `~/.config/herdr-app/mods/agents/` (`main.js`, `mod.json`) to
`mods/agents-compact/`, then in `main.js`, in one pass (so no value is changed
twice): `.h(30)` → `.h(26)`, `.h(28)` → `.h(25)`, `.h(26)` → `.h(24)`,
`text_size(13)` → `text_size(12)`, `text_size(12.5)` → `text_size(11.5)`.
Also the sort menu overlay opens `mod: "agents-compact"` instead of `"agents"`.
`mod.json`: `{ "place": "none", "title": "Agents", "cloned_from": { "name": "agents", "version": "<Herdr version>" } }`.
A header comment says what changed. Redo it after each Herdr update.

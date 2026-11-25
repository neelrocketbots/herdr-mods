# files-md

Herdr's Files panel with a few additions: markdown files render (headings, lists,
tables, code), Ctrl/Cmd-clicked file paths in a terminal open in the panel, long
lines wrap, and the shown file opens in your editor with one click.

![The Files panel showing docs/billing-export.md rendered, with Source and Open in Zed buttons](screenshot.png)

## What it adds

- `.md`, `.markdown`, `.mdx` files open **rendered**, images included (local
  ones next to the file, and remote ones); **Source** shows the highlighted
  text, **Preview** switches back. A click on an image opens its link or the
  image.
- **Task lists** (`- [ ]` / `- [x]`) show real checkboxes. Clicking one ticks
  or unticks it in the file itself (only that line's box, and only if the
  line hasn't changed since; otherwise the file is shown again as it is now).
  Files on another machine, or cut short for size, show them read-only.
- **Ctrl/Cmd-click a file path in a terminal** (`src/app.ts:42`, `README.md#L5`)
  and it opens in the Files panel, at that line, highlighted. Images,
  archives, folders, missing and remote files go to Herdr's usual opener. It's
  a terminal link handler (Herdr 0.1.17+): the layout lists it under
  `link_handlers`, which Herdr adds by itself the first time.
- **Wrap** in the header wraps long lines in the source view (on by default,
  remembered). Markdown source is colored (headings, code, links, quotes).
- **Open in &lt;editor&gt;** in the header opens the shown file (local folders only).
- Everything else is Herdr's Files panel as shipped (0.1.18): the tree of the
  focused terminal's folder, syntax-highlighted previews in your terminal font
  size, and one git scan shared with Changes that pauses while Herdr isn't
  focused.

It's a copy of Herdr's shipped `files` mod (Apache-2.0), because Herdr rewrites
its own mods on every start.

## Install

```sh
sh install.sh files-md
```

Or ask your Herdr agent to add this folder. Then point the layout's Files block at
it: `"content": { "mod": "files-md" }` on the `files` child of `panel-body`
(`custom-herdr` does).

## Settings

`editor` in `~/.config/herdr-app/herdr-mods.json`; the button shows its name.

## What it runs

Herdr's own file listing and reads, plus your editor's CLI or `open`. For
images in markdown: copies them (`cp`), or downloads remote ones (`curl`), into
`~/.config/herdr-app/data/files-md/img`, and reads their size with `sips`.

How it's built: [RECIPE.md](RECIPE.md). Part of [herdr-mods](../README.md).

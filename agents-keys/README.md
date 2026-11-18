# agents-keys

Herdr's Agents list, with the keys that reach the next and previous agent:
`⌘]` on the agent after the one you're in, `⌘[` on the one before.

![The Agents list: WEB-128 selected, ⌘[ on WEB-131 above it, ⌘] on api below it](screenshot.png)

## What it does

- Everything Herdr's Agents list does: grouped or priority views, sub-agents,
  pins, status.
- Plus small key labels on two rows: the key bound to `agent.next` on the agent
  it would go to, and `agent.prev` on the other. They follow the list's own
  order, as those keys do, and move as you switch agents. Herdr has no key for
  "agent number N", so these two are what there is.

## Install

```sh
sh install.sh agents-keys
```

Then point your layout's agents block at it: `"content": { "mod": "agents-keys" }`
(`custom-herdr` already does).

## Updating

It's a copy of Herdr's `agents` mod, so it doesn't change when Herdr updates its
own. To take a newer version, clone it again
(`herdr-app do mod.clone '{"name":"agents","as":"agents-keys"}'` after removing
this one) and re-apply the change in [RECIPE.md](RECIPE.md).

## What it runs

The same as Herdr's `agents` mod. Reads `keys.json` through Herdr.

How it's built: [RECIPE.md](RECIPE.md). Part of [herdr-mods](../README.md).

---
'openclaw-amem': patch
---

Correct what happens when a second memory plugin is installed.

Two places said the gateway "silently skips" a second `memory`-kind plugin with
no log output. On OpenClaw 2026.8.1 it does the opposite. Both plugins load, both
register a tool named `memory_search`, and the gateway keeps one of them.

Bundled plugins are found before installed ones, so `memory-core` keeps the name
and amem's `memory_search` tool is dropped. Amem still serves the memory slot, so
memory works, but the tool an agent calls is the other plugin's. Setting the slot
is not enough on its own any more — the other plugin has to be disabled too.

The drop is reported, at level ERROR, but in the structured log under
`/tmp/openclaw/`, not in the gateway log:

```
plugin tool name conflict (openclaw-amem): memory_search
```

The name in brackets is the plugin whose tool was dropped, which is the opposite
of what it reads like.

Both pages now also say that `memory-core` does unrelated work, so an operator
who disables it knows what else stops.

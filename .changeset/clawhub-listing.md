---
'openclaw-amem': patch
---

Rename the plugin listing and refresh its description.

The ClawHub listing read **"Memory (A-MEM v2)"**, which had three problems. It
used `A-MEM` — the spelling reserved for the paper — as the product identity,
while the brand everywhere else (npm packages, repo, docs site) is `amem`, so
searching the name users see elsewhere matched nothing. The "v2" was internal
history (the TypeScript rewrite that replaced a Python one) shown next to a
version number of 1.3.0, so the page contradicted itself. And "Memory (" merely
repeated the Memory category chip rendered directly above it.

It is now **"amem — agentic memory"**.

The description had also fallen behind. It led with implementation ("implementing
A-MEM") rather than what the thing does, and described the 1.1.x feature set —
missing per-agent access control and per-person memory separation, which are the
things that now distinguish it. The one genuinely good line, "memories evolve,
not just accumulate", is kept and moved to the front.

Also adds `amem` to the npm keywords: the brand was the one term missing from
them. `a-mem` stays, since that is how people look for the paper's implementation.

Applied to all four surfaces that carry it: the plugin manifest (what ClawHub
renders), package.json (npm), the registered plugin name in the source (what
OpenClaw itself shows), and the plugin README (the npm landing page).

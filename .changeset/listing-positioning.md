---
'openclaw-amem': patch
---

Reposition the ClawHub listing around contradiction detection.

Browsing the memory category shows ~25 plugins, and the previous name — "amem —
agentic memory" — used the two most generic words available in a category whose
own tag is #agent-memory. Six of the visible listings open with "long-term
memory".

Cards truncate at roughly 65-70 characters, so the opening line is the whole
pitch. It previously read "Long-term memory for OpenClaw agents. Extracts facts
instead of…" — indistinguishable from the rest of the page, with every
differentiator cut off.

Reading all 25 descriptions, nothing else in the category claims contradiction
detection, per-person separation, or memories that rewrite themselves. The
listing now leads with the first of those, which is both the most distinctive and
the easiest to recognise as a real problem:

  Catches memories that contradict each other. Notes rewrite themselves as new
  ones arrive, link into a graph, and stay separated per agent and per person.

The name is now just `amem`, matching the npm package, the repo and the docs
site, and following the pattern of the other independent entries there (Soul,
Lethe, Memex) rather than restating the category.

Nothing here is a new claim: the nightly sweep is scheduled as of the previous
release, and per-agent and per-subject scoping have shipped.

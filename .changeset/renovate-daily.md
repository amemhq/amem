---
---

No release — Renovate's schedule.

Dropped the weekly window. `minimumReleaseAge` already filters churn (3 days for
patches, 7 for minors, 30 for majors) and `prConcurrentLimit: 5` already caps how
many land at once; batching on top of both delayed information without reducing
it. Worst case was 12 days from publish to PR.

This project is unusually exposed to dependency behaviour: embedding runs entirely
on `@huggingface/transformers` and `onnxruntime-node`, and 2.0.0 shipped unusable
because that runtime cannot load fp16 weights — something no test caught, since
they all mock the embedding module. When that is fixed upstream, waiting up to
twelve days to hear about it is the wrong trade.

`lockFileMaintenance` keeps its monthly window; it carries no new information.

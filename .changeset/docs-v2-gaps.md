---
---

Docs only — no package change.

Three things 2.0.0 introduced were never written down, and one predates it:

- `MixedEmbeddingModelsError` had no mention anywhere, and it is the one that
  makes memory unusable mid-migration in mode B. Migrating one per-agent
  collection and restarting puts every unmigrated one in conflict with it, so the
  instruction is to migrate them all before restarting.
- A bare `amem-migrate` downloads 1.08 GB. It has to measure the target model's
  width to report anything, and measuring means loading it — but the docs read
  like a status check.
- BM25 no longer contributes notes the query never hit; the pipeline lists in two
  places still described the old behaviour.
- `memory_search`'s documented return shape named a `score` field that is called
  `similarity`, listed `category` and `retrieval_count` which are not returned,
  and omitted six that are, including the new `via`.

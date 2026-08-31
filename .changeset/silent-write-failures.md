---
'@amemhq/core': patch
'openclaw-amem': patch
---

Say when a write fails, and stay quiet when nothing needed writing.

The previous patch gave the engine a warning channel the host can read. It did
not help the paths that write no message at all. Every LLM helper returns a
safe-looking default — `null`, `[]`, `false`, an empty structure — and most of
those returns were silent. An LLM that answers with nothing and a turn that
holds nothing worth keeping produced the same output.

Most of them share one cause. `llmCall` reports the calls that throw, but a
provider can also answer 200 with no text, and both wrappers turned that into a
`null` that nobody logged. Every caller treats that `null` as a failure, so
`llmCall` reports it once, at the source, rather than at each of the ten places
that check it.

The rest are the responses that arrive and cannot be used, which are now named
where they happen:

- `llmConstructNote` says that the note is about to be stored with no keywords,
  tags or context. This is the one with a lasting cost: the note is saved, and
  later searches match almost nothing in it.
- `llmCrudDecision` and `llmConflictScan` say when the response holds no array,
  or holds something that is not an array.
- `llmShouldMerge` says when the verdict is missing.
- `llmEvolutionJudge` says when it defaults a pair to `NEW` without an answer.
  `NEW` is a verdict, and this path reached it without asking the model.
- The `agent_end` hook says when a turn arrives with no user or no assistant
  message.

A turn the model reads and decides to store nothing from writes no message.
That case is not a failure, and a test pins it.

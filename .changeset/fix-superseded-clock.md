---
'@heichaowo/amem-core': patch
---

Stop deciding which contradicted memory to retire by its write time.

Story 43's `auto` mode retired "the older note of the pair", using the note's
`timestamp`. That field records when a memory was **written down**, not when the
fact became true, and the two clocks come apart constantly — "back in 2019 I was
vegetarian", recorded today, is the newer row and the older fact. Retiring by
write time gets that case exactly backwards: it silences the memory that is
currently true and keeps the one that is stale.

The batch scan now asks the model which side is **superseded**, judged from the
wording ("used to", "moved last month", "switched to") — which is where the
event-time evidence actually lives, and which the model is already reading. The
prompt states explicitly that the notes are not in chronological order.

When the model cannot tell, it answers `null` and **nothing is retired**; the pair
is still flagged for review. A `superseded` value that names anything other than
the two notes in the pair is treated as unknown rather than as a target, so a
hallucinated index can never retire a memory the model was not discussing.

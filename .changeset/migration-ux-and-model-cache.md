---
'@amemhq/core': minor
'openclaw-amem': minor
---

Make a migration survivable without reading the source first.

Everything here came out of running one on a real store, in the order it went
wrong:

- **The model cache is per copy of the library.** Transformers.js caches inside
  its own install directory and reads no environment variable for it, so the
  plugin's copy and every `npx --package=@amemhq/core` run download the same
  2.27 GB separately — and each fresh `npx` temp directory downloads it again.
  `AMEM_MODEL_CACHE` points them at one path. `AMEM_MODEL_DIR` reads weights
  already on disk, for a slow link or a machine that cannot reach HuggingFace.
- **A download printed nothing for 75 minutes.** `progress_callback` now reports
  the weights at every 10%. A cached model still prints nothing.
- **Nothing said to stop the agent, or when.** The long part is the download,
  which is safe to do with the agent up; the writing is what wants it stopped.
  Usage and docs now say so in that order.
- **`amem-migrate help` started a 2.27 GB download.** Only `-h` and `--help` were
  recognised, so the bare word fell through to a normal run.
- **`--switch` deleted the source outright.** It snapshots first now and prints
  the file path. Freeing the name requires dropping the collection; losing the
  data does not, and those are two decisions. Note the path really is the only
  handle afterwards — once the name is an alias, the snapshot API resolves it to
  the new collection and reports none.

Docs gain what has actually been run, keyed by model *and* dtype rather than model
alone, since they fail independently: `bge-m3` is in use at fp32 and does not load
at fp16. Plus measured timings for each phase of a migration, because the three
have completely different bottlenecks and only one scales with the store.

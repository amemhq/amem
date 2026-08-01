# Release notes

What a release means if you use the plugin. This is what ClawHub shows on the
listing. [CHANGELOG.md](./CHANGELOG.md) is the same releases described at the
engine level, generated from changesets, and stays that way for npm.

## 2.1.1

**Search scores mean something on every row now.** A memory found by its wording
rather than by meaning had no similarity figure — nothing had measured one — and
showed as 0%, which made a direct text match look like the least relevant thing in
the list. It is measured now. 2.1.0 fixed the same gap for memories pulled in by
their links and missed this one.

## 2.1.0

**Upgrade if you are on 2.0.x. It could not load its own model.** 2.0.0 and 2.0.1
asked for a half-precision build of `bge-m3` to halve the download, and the ONNX
runtime cannot load those weights — a fresh install could not embed at all. Nothing
picks a precision now. The download is 2.27 GB rather than 1.08 GB, which is the
correct trade for a model that loads.

**The download says how far along it is.** It was silent, and a 2 GB download that
prints nothing for an hour looks like a hang.

**`AMEM_MODEL_CACHE` puts the model where you want it.** By default each copy of
the plugin keeps its own, so updating the plugin re-downloads 2.27 GB and running
the migration tool downloads it a second time. Point them all at one directory and
they share it. `AMEM_MODEL_DIR` reads weights you placed yourself, for a slow link
or a machine that cannot reach HuggingFace.

**Migrating is less of a trap.** `amem-migrate` now says to stop your agent before
the step that writes, not before the long download; takes a snapshot before it
drops the old store, so switching over and throwing the old data away are two
decisions; and answers to `amem-migrate help`, which used to start a 2.27 GB
download instead of printing anything.

## 2.0.1

The jump from 1.4.3, since 2.0.0 was published to npm but never reached ClawHub.

**Memories longer than a sentence or two are searchable now.** The embedding model
the plugin shipped with reads only the first 128 tokens of a note — around 60
Chinese characters — and silently ignores the rest, so search has been matching on
opening clauses. The new default reads 8192.

**Nothing happens to your existing memories when you upgrade.** They keep the
model that built them and keep working exactly as before. On startup the plugin
tells you the store is on the old model and prints the command that moves it:

```
npx --package=@amemhq/core amem-migrate
```

It reports first and writes nothing until you add `--apply`. Your original store is
only read until the very last step, so there is nothing to undo if a run looks
wrong.

**A fresh install downloads 2.27 GB** for the new model, once, then caches it. If
that is more than you want, `AMEM_EMBED_MODEL=Xenova/bge-small-zh-v1.5` is 25 MB —
Chinese only, and it stops at 512 tokens. Set it before you store anything;
changing it later means migrating.

**Search results say where they came from.** A result that is in the list because
it links to a match is now marked, instead of looking like a weak match. The
percentage is labelled `similarity`, because that is what it is — it is not the
number that orders the list.

**Search stopped padding its results.** When a query matched no words in your
store, the keyword half of search was still contributing notes, chosen by nothing
at all, weighted the same as real matches. It now contributes nothing, and the
results come from meaning alone.

**One manifest field removed.** It duplicated what `package.json` already
declares, and ClawHub's validator flags it. No effect on how the plugin runs.

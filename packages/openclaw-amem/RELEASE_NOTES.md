# Release notes

This document explains what each release means if you use the plugin. This is
what ClawHub shows on the listing. [CHANGELOG.md](./CHANGELOG.md) covers the
same releases at the engine level. It is generated from changesets and is the
format that npm uses.

## 2.1.2

**When memory stops working, the log now says so.** The engine wrote its
warnings to a channel the gateway throws away, so nothing reached the log file.
A broken LLM endpoint looked exactly like a quiet day.

That gap hid a real one. If the engine cannot reach the LLM, it still saves the
memory with no keywords, no tags and no summary. No message reported this. On
one store the hook ran 684 times across 11 days and saved nothing at all,
because the provider setting was wrong. The log showed nothing either way.

**A turn that fails and a turn with nothing to save no longer look the same.**
Some failures wrote no message at all, so fixing the channel alone would not
have shown them. The engine now logs a message when a model replies with no text
or with something the engine cannot read. It also logs a message when a memory
is about to be saved with none of its fields filled in. A turn from which the
model decides to save nothing stays quiet, because that is not a failure.

There is nothing to configure. Update the plugin. Restart the gateway.

## 2.1.1

**Search scores mean something on every row now.** A memory found by its wording
rather than by meaning had no similarity figure. Nothing measured one, so it
showed as 0%. This made a direct text match look like the least relevant thing
in the list. It is measured now. 2.1.0 fixed the same gap for memories pulled in
by their links but missed this one.

## 2.1.0

**Upgrade if you are on 2.0.x. It did not load its own model.** 2.0.0 and
2.0.1 asked for a half-precision build of `bge-m3` to halve the download. The
ONNX runtime cannot load those weights, so a fresh install did not embed at
all. Nothing picks a precision now. The download is 2.27 GB rather than 1.08 GB,
which is the correct trade for a model that loads.

**The download says how far along it is.** It was silent. A 2 GB download that
prints nothing for an hour looks like a hang.

**`AMEM_MODEL_CACHE` puts the model where you want it.** By default, each copy
of the plugin keeps its own model. If you update the plugin, it re-downloads
2.27 GB. If you run the migration tool, it downloads the model a second time.
Point them all at one directory. They share the model. `AMEM_MODEL_DIR` reads
weights you placed yourself, for a slow link or a machine that cannot reach
HuggingFace.

**Migrating is less of a trap.** `amem-migrate` now says to stop your agent
before the step that writes, not before the long download. It takes a snapshot
before it deletes the old store, so the switch and the deletion are two separate
decisions. It now responds to `amem-migrate help`, which used to start a 2.27 GB
download instead of showing anything.

## 2.0.1

This version is the jump from 1.4.3 because 2.0.0 was published to npm but never
reached ClawHub.

**Memories longer than a sentence or two are searchable now.** The embedding
model that the plugin shipped with reads only the first 128 tokens of a note,
around 60 Chinese characters, and silently ignores the rest. As a result, search
matched on opening clauses only. The new default reads 8192.

**Nothing happens to your existing memories when you upgrade.** They keep the
model that built them and work exactly as before. On startup the plugin tells
you the store is on the old model and shows the command that moves it:

```
npx --package=@amemhq/core amem-migrate
```

It reports first and writes nothing until you add `--apply`. The tool reads your
original store only until the very last step. If a run looks wrong, there is
nothing to undo.

**A fresh install downloads 2.27 GB** for the new model, once, then caches it.
If that is more than you want, `AMEM_EMBED_MODEL=Xenova/bge-small-zh-v1.5` is 25
MB. It supports Chinese only and stops at 512 tokens. Set it before you store
anything. If you change it later, you must migrate.

**Search results say where they came from.** A result that is in the list
because it links to a match is now marked. It no longer looks like a weak match.
The percentage is labelled `similarity` because that is what it is. It is not
the number that orders the list.

**Search stopped padding its results.** When a query matched no words in your
store, the keyword half of search still contributed notes. These were chosen by
nothing at all and weighted the same as real matches. It now contributes
nothing, and the results come from meaning alone.

**One manifest field removed.** It duplicated what `package.json` already
declares, and ClawHub's validator flags it. There is no effect on how the plugin
runs.

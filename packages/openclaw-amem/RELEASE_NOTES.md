# Release notes

This document explains what each release means if you use the plugin. This is
what ClawHub shows on the listing. [CHANGELOG.md](./CHANGELOG.md) covers the
same releases at the engine level. It is generated from changesets and is the
format that npm uses.

## 2.1.3

**The nightly cleanup runs once, not several times at once.** The plugin can
load twice in one gateway, and each copy started its own 02:30 job. Every night
the same work ran two to four times in parallel, on the same notes. It now runs
once.

**`openclaw` commands exit when they finish.** A command that loads plugins,
for example `openclaw --help`, did not exit after it printed its output. The
plugin held a timer open until 02:30. It no longer does.

**Similar memories are merged at night instead of after every turn.** The
merge was the slowest step after each turn, and the only step with no upper
limit, so it often took the memory step past its 30-second budget. It now runs
at 02:30, for every agent that saved memories since the previous run. A
near-duplicate you save during the day stays separate until then.

**A slow turn no longer runs past its time limit.** After each turn, the plugin
has 30 seconds to save what it learned. When the model was slow, the work went
on after that limit and ran into the next turn. It now stops before the limit
and keeps what it has saved. If the model is very slow, some facts from that
turn are not saved.

**The nightly cleanup waits for your tasks.** It runs at 02:30 in the same
gateway as your agent, with the same API key. If a task ran at that time, the
two competed for the model, and the cleanup could merge away a memory that the
task had just saved. The cleanup now starts only when no task is running. If a
task starts while the cleanup runs, the cleanup stops. It starts that part again
when the task is done. If the same part stops three times, or the cleanup waits
more than one hour in a night, it leaves the rest for the next night. The next
night starts where it stopped.

The cleanup cannot see a task that runs in a separate process, for example
`openclaw agent --local`.

**Saving memories after a turn is faster on some API endpoints.** Some
endpoints make the model think before it answers, even when nobody asked for
it. The memory step after each turn does not need that. On one endpoint a short
request took about 7 s instead of 5.8 s, and a long one took 13 to 15 s instead
of about 6 s. The plugin now asks the model not to think. A model that must
think, such as Opus 5.5, still works as before. To go back to the old requests,
set `llmThinking` to `auto`.

**A model that thinks has room to answer.** If you set a stronger model for
the nightly checks, for example Opus 5.5, its thinking could use up all the
space for its answer. The check then got no answer, and it treated two similar
memories as different. The plugin now leaves room for the answer. A model that
does not think still stops when its answer is done.

**A contradiction check that fails is done again.** When the model gave no
usable answer for a group of memories, the check still marked the group as
done. It never checked that group again. Now it checks the group again the next
night.

There is nothing to configure. Update the plugin. Restart the gateway.

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

**The startup line about the model no longer says `0.00 GB`.** The model comes
in two files, and one of them is small. The line always used gigabytes, so the
small file showed as zero, which looks like a broken download. Each file now
shows in a unit that fits it.

That line also appears when the model is already on disk. It reaches 100% at
once, once per file. This is what a cached model looks like, not a second
download.

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

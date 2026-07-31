# Release notes

What a release means if you use the plugin. This is what ClawHub shows on the
listing. [CHANGELOG.md](./CHANGELOG.md) is the same releases described at the
engine level, generated from changesets, and stays that way for npm.

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

**A fresh install downloads 1.08 GB** for the new model, once, then caches it. If
that is more than you want, set
`AMEM_EMBED_MODEL=onnx-community/gte-multilingual-base` before you store anything
— about a third of the size, same 8192-token limit. Changing it later means
migrating.

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

---
'@amemhq/core': patch
'openclaw-amem': patch
---

Rewrite the documentation in Simplified Technical English.

All 19 documentation files: the 14 pages under `docs/`, the four READMEs, and
the plugin release notes. ASD-STE100 in pragmatic mode, so the domain vocabulary
stays. Short sentences, active voice, simple tenses, the condition before the
command, and one word for one meaning across the whole set.

A style pass changes no facts, and this documentation was audited a month ago,
so a rewrite that quietly moved a number would undo that work. Every file was
compared against its committed version for code spans, inline code, headings,
link targets and numbers. Nothing was lost. Three tokens were added, all of them
a vague subject replaced by its real one: "Enforcement is planned for Story 33"
became "Story 33 will add enforcement", and "it refuses to do that unless"
became "amem refuses to run `--switch` unless".

Two things the rewrite found rather than made:

- `design-rationale.md` said the evidence pass "changed four things and removed
  one claim" above a list of three. The count never matched, going back to the
  commit that added the page. The lead-in now says what the list holds.
- `RELEASE_NOTES.md` is wrapped at 80 columns again. Rewriting it had joined
  the lines, and that file is the one document here that wraps.

Headings are unchanged everywhere, because other pages link to them by anchor,
and the four `## <version>` headings are what the release-note check matches on.

---
'openclaw-amem': patch
---

Run the 02:30 job once per process, and stop it holding the process open.

register() can run more than once in one process. The gateway has loaded the
plugin as two module graphs 50-75 ms apart, and each call started its own timer
chain. As a result the nightly job ran two to four times concurrently every
night, and each copy re-read the same 15 pairs and raced to merge the same
notes. The handle now lives on globalThis, because a module-level variable
cannot deduplicate across module graphs. The latest registration owns it.

The timer is unref'd. Every CLI command that loads plugins calls register() too,
and the pending timer kept those processes alive. With the plugin enabled,
`openclaw --help` was still running after 91 s. With it disabled, it exited in
5 s.

A job that rejects is now caught and reported. A rejection that escapes a timer
callback is unhandled, and Node exits the process on an unhandled rejection.

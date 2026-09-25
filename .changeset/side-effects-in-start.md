---
'openclaw-amem': patch
---

Start the nightly job, the collection check and the run subscription from the
service's start(), not from register().

OpenClaw 2026.9.6 runs register() in far more places than the gateway. The
gateway keeps a pool of model-catalog worker threads with no idle timeout, and
each loads every plugin. A worker thread has its own globalThis, so the
nightly-timer singleton did not reach it. On the first night of 2.1.3 the 02:30
job ran twice in one gateway, and the copy in the worker saw no runs, so it did
not wait for the user. Each worker also loaded the 2.27 GB embedding model
through the collection check. So did every CLI command: `openclaw --help` took
20 s, and during an update the check failed with "Cannot find package
'onnxruntime-common'". OpenClaw loads plugins from per-package copies that hold
only declared dependencies, and @huggingface/transformers 4.2.0 imports
onnxruntime-common without declaring it.

OpenClaw starts services only in the gateway and in one-shot diagnostics such
as `openclaw doctor`. The storage layer still ensures the collection before
each read and write, so nothing depends on the startup check to create it.

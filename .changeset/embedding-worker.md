---
'@amemhq/core': patch
'openclaw-amem': patch
---

Run the embedding model in a worker thread.

OpenClaw 2026.10.10 on Node 26 samples the gateway's main thread with a V8 CPU
profiler every 10 ms. On an Apple chip with SME (M4), onnxruntime 1.30 runs its
KleidiAI kernels in streaming mode, and a SIGPROF that arrives there makes the
process die with SIGILL. Model load and inference both crashed it: 26 restarts
on 2026-11-03. Turning KleidiAI off stops the crash but makes one inference
2.7 times slower (77 ms to 210 ms), and the model load still stalls the main
thread for 3.3 s.

The model now loads and runs in `node:worker_threads`, from the
`embed-worker` file next to the engine's entry file, where the profiler does
not sample. The worker is unref'd except while a request waits, so a CLI still
exits. A worker that exits is replaced. In a process that called
`loadModel()`, such as amem-api, the model is loaded again even if no request
waits. If the worker cannot start, or exits three times in one minute, the
engine embeds on the calling thread, with KleidiAI off on macOS arm64.

`closeEmbedding()` stops the worker and makes later calls fail, and
`openEmbedding()` allows them again. The plugin calls them from the service's
`stop()` and `start()`. OpenClaw stops and starts a memory plugin's service on
the same module when it reloads other plugins.

In an OpenClaw plugin capture, Transformers.js cannot find
`onnxruntime-common`. It imports it without declaring it, and the capture
links each package only to what it declares. OpenClaw's own resolver covers
this on the main thread but not in a worker. The worker registers a resolve
hook that resolves it from `onnxruntime-node` instead, which is the copy the
native binding is built against. Node before 22.15 has no
`module.registerHooks` and skips it.

import { defineConfig } from 'tsup'
import { fileURLToPath } from 'node:url'

// The engine (`@amemhq/core`, its source lives in packages/amem-core)
// is inlined into this bundle so the plugin ships self-contained: one ClawHub
// artifact, no runtime engine fetch, no version skew. It is resolved by alias
// to its source rather than declared as a dependency on purpose — a
// `workspace:*` dependency is rewritten to a version in the published manifest,
// which turns the engine back into a runtime install (and 404'd ClawHub's
// `npm install` outright while the engine was unpublished). No dependency, no
// leak.
const amemEngine = fileURLToPath(new URL('../amem-core/src/index.ts', import.meta.url))
// The engine starts its embedding worker from the file next to its own module, so the
// worker ships as dist/embed-worker.js beside dist/index.js.
const embedWorker = fileURLToPath(new URL('../amem-core/src/embed-worker.ts', import.meta.url))

export default defineConfig({
  entry: { index: 'src/index.ts', 'embed-worker': embedWorker },
  format: ['cjs'],
  clean: true,
  bundle: true,
  // import.meta.url in this CommonJS bundle: the engine finds its worker file with it.
  shims: true,
  // @huggingface/transformers uses dynamic imports for ONNX backends
  // bundling it breaks backend detection — keep as external.
  // openai is external too: bundling it inlines ~440KB into every plugin
  // download, even for the default Anthropic path. It is a published package,
  // so it installs at runtime from the plugin's dependencies like transformers.
  external: ['@huggingface/transformers', 'onnxruntime-node', 'openai', 'openclaw', /^openclaw\/.+/],
  esbuildOptions(options) {
    // Everything in `dependencies` stays external and is installed at runtime;
    // only the engine is inlined, via this alias to its source.
    options.alias = { ...options.alias, '@amemhq/core': amemEngine }
  },
})

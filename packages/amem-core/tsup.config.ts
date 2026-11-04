import { defineConfig } from 'tsup'

export default defineConfig({
  // The embedding worker is its own file: embedding.ts starts it from next to itself.
  entry: ['src/index.ts', 'src/cli-migrate.ts', 'src/embed-worker.ts'],
  format: ['esm', 'cjs'],
  dts: true,
  clean: true,
  sourcemap: true,
  // import.meta.url in the CommonJS build: embedding.ts finds its worker file with it.
  shims: true,
  // Library build: keep runtime deps external so consumers dedupe them.
  // @huggingface/transformers uses dynamic imports for ONNX backends — never bundle.
  external: [
    '@huggingface/transformers',
    'onnxruntime-node',
    '@node-rs/jieba',
    '@qdrant/js-client-rest',
    '@anthropic-ai/sdk',
    'uuid',
  ],
})

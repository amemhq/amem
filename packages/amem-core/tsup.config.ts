import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['src/index.ts', 'src/cli-migrate.ts'],
  format: ['esm', 'cjs'],
  dts: true,
  clean: true,
  sourcemap: true,
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

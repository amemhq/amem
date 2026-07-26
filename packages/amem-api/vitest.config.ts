import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: {
      // Resolve amem-core to its SOURCE, not its built dist. Two reasons, both
      // for the integration tests: CI runs them without a build step, so there
      // is no dist to import; and it puts the engine's own `embedding.js` and
      // `llm.js` in the module graph, where a test can mock them — so the
      // pipeline runs against real Qdrant while downloading no model and making
      // no LLM call. The unit tests mock the engine wholesale, so for them the
      // alias never resolves to anything and this is a no-op.
      '@amemhq/core': resolve(import.meta.dirname, '../amem-core/src/index.ts'),
    },
  },
})

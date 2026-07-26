<p align="center">
  <img src="https://raw.githubusercontent.com/heichaowo/amem/main/docs/public/logo.webp" width="120" alt="amem Logo" />
</p>

# amem

Monorepo for the **amem** agentic-memory stack — memories that **evolve**, not just accumulate. Qdrant + local Transformers.js + LLM, **no Python required**.

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-yellow?style=for-the-badge" alt="License: MIT" /></a>
  <a href="https://www.npmjs.com/package/openclaw-amem"><img src="https://img.shields.io/npm/v/openclaw-amem?style=for-the-badge&logo=npm&logoColor=white&label=openclaw-amem" alt="npm: openclaw-amem" /></a>
  <a href="https://github.com/heichaowo/amem/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/heichaowo/amem/ci.yml?branch=main&style=for-the-badge&logo=githubactions&logoColor=white&label=CI" alt="CI" /></a>
  <a href="https://arxiv.org/abs/2502.12110"><img src="https://img.shields.io/badge/arXiv-2502.12110-b31b1b?style=for-the-badge" alt="arXiv" /></a>
</p>

## Packages

| Package | What it is | npm |
| --- | --- | --- |
| [`@heichaowo/amem-core`](packages/amem-core) | Framework-agnostic **A-MEM engine** — note construction, evolution, hybrid (BM25 + dense) retrieval with graph expansion. Qdrant + Transformers.js. | `@heichaowo/amem-core` |
| [`openclaw-amem`](packages/openclaw-amem) | **OpenClaw** memory-slot plugin — a thin wrapper around `amem-core`. | `openclaw-amem` |
| `amem-api` | Thin single-writer **service** (HTTP + MCP) so multiple processes share one memory store. | *coming soon* |

📖 Documentation: **[amem.owo.lc](https://amem.owo.lc)** · 📄 Paper: [A-MEM (arXiv:2502.12110, NeurIPS 2025)](https://arxiv.org/abs/2502.12110)

## Models

Two tiers, because the calls are not equally hard. `fast` runs everything frequent:
extraction, link judgement, the per-turn CRUD decision. `strong` runs only merge
adjudication and contradiction classification.

| tier | env | plugin config |
| --- | --- | --- |
| fast | `AMEM_LLM_MODEL` | `llmModel` |
| strong | `AMEM_LLM_STRONG_MODEL` | `llmStrongModel` |

`strong` is optional and falls back to `fast` field by field, so setting only
`llmStrongModel` keeps the same provider and endpoint with a better model, and
setting all three `llmStrong*` fields runs the tiers on separate backends — a
local Ollama for `fast`, a hosted API for `strong`. Set none and it behaves as a
single-model install. There is no built-in `strong` default: an upgrade never
starts spending more on its own.

The split is worth the config because the gap is uneven. Extraction differs about
2 points between a cheap model and a strong one; contradiction detection differs
17–21, and implicit contradictions collapse from 55% to 8.7%. Sources and the
rest of the reasoning: [Design Rationale](https://amem.owo.lc/guide/design-rationale).

## Develop

This is a [pnpm](https://pnpm.io) workspace (Node 24).

```bash
pnpm install                 # first run: `pnpm approve-builds` to allow onnxruntime-node / sharp / esbuild
pnpm -r build                # build every package
pnpm -r typecheck
pnpm -r test                 # vitest — integration tests need Qdrant on :6333 + ANTHROPIC_API_KEY
pnpm docs:dev                # run the docs site locally
```

Publishing is automated via [Changesets](https://github.com/changesets/changesets) + GitHub Actions.

## License

MIT © heichaowo

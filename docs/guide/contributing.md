# Contributing

## Development setup

This is a [pnpm](https://pnpm.io) monorepo (Node 24).

```bash
git clone https://github.com/amemhq/amem
cd amem
pnpm install        # first run: `pnpm approve-builds` for onnxruntime-node / sharp / esbuild
pnpm -r build
```

## Running checks

```bash
pnpm -r lint               # ESLint (Flat Config)
pnpm format                # Prettier check
pnpm -r typecheck
pnpm -r test               # Vitest — integration tests need Qdrant :6333 + ANTHROPIC_API_KEY
```

## Test coverage

Test suite is under reconstruction. See [GitHub Issues](https://github.com/amemhq/amem/issues) for progress.

## Project structure

```
amem/
├── packages/
│   ├── amem-core/         amem-core — the framework-agnostic engine
│   │   └── src/           memory · storage · embedding · llm · prompts · quality · evo-counter · config
│   └── openclaw-amem/     the OpenClaw plugin (bundles amem-core)
│       └── src/index.ts   plugin entry & OpenClaw hooks
├── docs/                  documentation site (VitePress)
└── pnpm-workspace.yaml
```

## References

| Reference | Role |
|-----------|------|
| Xu et al., _A-MEM: Agentic Memory for LLM Agents_, NeurIPS 2025 · [arXiv:2502.12110](https://arxiv.org/abs/2502.12110) | Core architecture |
| Robertson & Zaragoza, _The Probabilistic Relevance Framework: BM25 and Beyond_, 2009 | BM25 ranking formula |
| Cormack et al., _Reciprocal Rank Fusion_, SIGIR 2009 | RRF fusion formula |
| Sun et al., _Jieba Chinese Text Segmentation_ | Chinese word segmentation |

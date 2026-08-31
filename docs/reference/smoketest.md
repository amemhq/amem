# Smoke Test Results

The `amem-smoketest` suite contains 31 QA pairs across 8 categories. It uses `gemini-3.5-flash-low` as the write-side LLM.

> The smoke test is a **regression test**, not a benchmark. The dataset is self-authored. You cannot directly compare scores across implementations. The purpose is to verify that retrieval quality does not degrade between versions.

---

## Overall results (last tested: v0.3.0)

| Metric | Value |
| :--- | :--- |
| **Average Score** | **4.56 / 5.0** |
| **Hit\@1** | **64.0%** |
| **Hit\@3** | **76.0%** |
| **MRR** | **0.693** |

## Results by category

| Category | Avg Score | Notes |
| :--- | :--- | :--- |
| fact | 5.00 / 5.0 | — |
| temporal | 5.00 / 5.0 | — |
| bfs | 5.00 / 5.0 | — |
| multihop | 4.20 / 5.0 | — |
| semantic | 3.60 / 5.0 | Active improvement area |

## BFS ablation

This ablation tests the 2-hop BFS graph expansion in isolation using bfs and multihop categories (10 questions):

| | BFS OFF | BFS ON | Delta |
|:---|:---:|:---:|:---:|
| **Average Score** | 3.00 | 5.00 | **+2.00** |
| bfs category | 2.00 | 5.00 | **+3.00** |
| multihop category | 4.00 | 5.00 | **+1.00** |

BFS provides the largest single improvement of any feature in the retrieval pipeline.

## Category descriptions

| Category | What it tests |
|----------|--------------|
| **fact** | Direct factual recall (for example, account IDs, registration numbers) |
| **temporal** | Time-ordered facts where older versions should be superseded |
| **bfs** | Multi-note graph traversal — answer requires following link edges |
| **multihop** | Two independent facts that must be joined to answer (for example, company → registrar → contact email) |
| **semantic** | Paraphrased queries that do not share keywords with stored content |

## Running the smoke test

```bash
cd amem-smoketest
node run_smoketest.mjs
```

By default, the smoke test uses `gemini-3.5-flash-low` for write-side LLM operations and `gemini-pro-agent` as judge. To override, run:

```bash
AMEM_LLM_MODEL=claude-sonnet-4-6 node run_smoketest.mjs
```

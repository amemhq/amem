# A-MEM vs Traditional RAG

| Dimension | Traditional RAG | A-MEM (Zettelkasten Graph) |
| :--- | :--- | :--- |
| **Retrieval Mode** | Single-vector similarity | BM25 + Dense Vector Hybrid (RRF) + 2-hop Graph Expansion |
| **Chinese Recall** | Character-level n-gram / single char split | Jieba word segmentation for accurate Chinese BM25 indexing |
| **Fact Evolution** | Static chunking — cannot update historical entries | Dynamic Attribute Evolution & Connection Strengthening |
| **Temporal Conflicts** | Recalls contradictory facts simultaneously | `is_active` soft-invalidation shields outdated facts |
| **Memory Bloat** | Fragmented memories stack up infinitely | Daily Consolidation merges semantic duplicates |
| **Stale Memory Suppression** | High-retrieval old memories permanently outrank fresh ones | Time-decayed heat boost — age dampens retrieval_count influence |
| **Graph Noise** | N/A | BFS Relevance Gate filters low-similarity linked nodes |

## Why not mem0?

[mem0](https://github.com/mem0ai/mem0) is a popular memory layer for AI agents. openclaw-amem's dedup and evolution mechanism was inspired by mem0's LLM-driven memory update approach, while taking a different architectural direction.

| | mem0 | openclaw-amem |
|---|---|---|
| **Architecture** | Flat vector + optional graph | Zettelkasten-inspired evolving graph |
| **Retrieval** | Dense vector only | BM25 + Dense Vector (RRF) + 2-hop BFS |
| **Memory links** | Optional graph add-on | Core to the design; automatic and bidirectional |
| **Memory evolution** | No | Yes — linked notes update when new info arrives |
| **Evolution history** | No | Yes — full audit trail of how each memory changed |
| **Runtime** | Python daemon | Pure TypeScript, in-process (no sidecar) |
| **Chinese support** | Character-level | Jieba word segmentation |
| **Platform** | Standalone library | OpenClaw plugin with deep agent integration |

## BFS ablation results

The 2-hop BFS graph expansion is the key architectural advantage. Measured on our internal smoke test:

| | BFS OFF | BFS ON | Delta |
|:---|:---:|:---:|:---:|
| **Average Score** | 3.00 | 5.00 | **+2.00** |
| bfs category | 2.00 | 5.00 | **+3.00** |
| multihop category | 4.00 | 5.00 | **+1.00** |

Without BFS, multi-hop relational queries (e.g. "find the contact email for the vendor mentioned in the Q3 contract") fail because the two facts are stored as separate notes not reachable by a single vector query.

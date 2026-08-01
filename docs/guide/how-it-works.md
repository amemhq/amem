# How It Works

## Memory lifecycle

```
memory_add(text)
      │
      ▼
 1. Hash dedup ──── duplicate? ──► skip
      │
      ▼
 2. Note Construction (LLM)
    ├── keywords (3–7 key terms)
    ├── tags (2–4 category tags)
    ├── context (one-sentence summary)
    └── category (Technical / Business / Personal / ...)
      │
      ▼
 3. Link Generation
    ├── retrieve top-6 candidates (embedding similarity ≥ 0.3)
    └── LLM verifies each: link bidirectionally if relevant
      │
      ▼
 4. Memory Evolution
    ├── up to 3 linked notes get attributes updated
    └── may trigger additional link candidates
      │
      ▼
 5. Save to Qdrant
```

## Retrieval pipeline

```
memory_search(query)
      │
      ▼
 1. Embed query (local ONNX)
      │
      ├──► BM25 ranking (Jieba for Chinese; see note on ja/ko)
      │    only notes sharing a term with the query
      └──► Dense vector cosine similarity
      │
      ▼
 2. RRF fusion (k=60)
    Final Score = BM25_rank⁻¹ + Vector_rank⁻¹
      │
      ▼
 3. Heat boost
    Score × (1 + 0.05 × ln(1 + retrieval_count) / (age_days + 1))
      │
      ▼
 4. 2-hop BFS expansion
    ├── Walk link graph up to 2 hops from top-K anchors
    ├── Admit only nodes with cos-sim ≥ 0.25 vs query
    └── Returned as via: "link" — appended after the matches, never ranked
      │
      ▼
 5. Return merged, deduplicated results
```

## Temporal invalidation

When a memory is updated or contradicted, the old note is marked `is_active: false` and excluded from all future searches via Qdrant payload filtering. No data is ever hard-deleted — the full history is preserved.

## Daily consolidation

At **02:30 AM** (in-process scheduler), the plugin:

1. Groups active episodic notes by `category` — knowledge notes are skipped
2. Within each group, finds pairs with cosine similarity ≥ 0.75
3. Merges duplicates into a single unified note
4. Cascades all link references from soft-deleted notes to the merged note

This prevents memory bloat from semantically redundant facts accumulated over days.

## Dedup layers

Every `memory_add` call passes through three dedup layers before reaching Qdrant:

| Layer | Mechanism | Threshold | Action |
|-------|-----------|-----------|--------|
| L1 | MD5 hash | Exact match | Skip (return existing ID) |
| L2 | Vector similarity | ≥ 0.85 | UPDATE existing note |
| L2.5 | Vector similarity | 0.72 ≤ s < 0.85 | Write + flag `pending_merge=true` |

`pending_merge` notes are processed by the `agent_end` hook via LLM evolution judgment. See [Evolution & Quality](/guide/evolution) for details.

## Agent isolation

openclaw-amem enforces per-agent memory namespacing. Every note carries `owner`, `readers`, and `writers` fields.

- **Private** (default): `readers = [agentId]` — only the writing agent can retrieve this note.
- **Shared**: `agent_id = "shared"`, `readers = ["*"]` — all agents see this note in search results.

Consolidation is scoped per agent. `dev`'s consolidation pass only considers `agent_id = "dev"` notes; shared notes and other agents' private notes are never modified.

See [Agent Isolation](/guide/agent-isolation) for full details.

## Hook self-check (Story 34)

If the `agent_end` hook is silently blocked by OpenClaw's security policy (missing `allowConversationAccess=true`), the plugin detects this automatically:

- The plugin reads the hook configuration at startup and warns immediately if write-back is blocked — decided from config rather than by waiting to see whether the hook ever fires.
- Every `memory_search` result will include a visible warning notice so you see it directly in the agent's replies.

This prevents the silent failure mode where automatic write-back stops working without any visible indication.

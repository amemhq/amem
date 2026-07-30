# Tools Reference

Once installed, openclaw-amem exposes four tools to OpenClaw agents.

---

## `memory_add`

Write a new memory to the store.

```js
memory_add(text="Your memory content here.")
```

**Parameters**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `text` | `string` | ✅ | The content to store as a memory. |

**What happens internally**

1. Exact hash dedup check — skips if identical content already exists
2. High-similarity dedup check (cosine ≥ 0.95) — updates existing note instead of creating duplicate
3. LLM note construction — extracts keywords, tags, context summary, category
4. Link generation — finds up to 6 candidates, LLM verifies bidirectional links
5. Memory evolution — updates attributes on up to 3 linked notes
6. Saves to Qdrant with embedding

---

## `memory_search`

Search long-term memories using hybrid retrieval.

```js
memory_search(query="your search query", limit=5)
```

**Parameters**

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `query` | `string` | — | Natural language search query. |
| `limit` | `number` | `topK` config value | Maximum results to return. |

**Returns**

An array of memory objects ranked by relevance:

```json
[
  {
    "id": "uuid",
    "content": "Original memory text",
    "keywords": ["keyword1", "keyword2"],
    "tags": ["tag1", "tag2"],
    "context": "One-sentence summary",
    "category": "Technical",
    "retrieval_count": 3,
    "score": 0.842
  }
]
```

**Retrieval pipeline**

1. Embeds query locally (ONNX)
2. BM25 ranking with Jieba tokenization for CJK
3. Dense vector cosine similarity search
4. RRF fusion (k=60)
5. Heat boost: `score × (1 + 0.05 × ln(1+count) / (age_days+1))`
6. 2-hop BFS graph expansion with cos-sim ≥ 0.25 gate

---

## `memory_list`

Return the total count of active memories for the current agent.

```js
memory_list()
```

**Returns**

```json
{ "count": 42 }
```

---

## `memory_consolidate`

Manually trigger same-day semantic deduplication and link cascading.

```js
memory_consolidate()
```

This is also run automatically at **02:30 AM** daily. Use this tool to trigger it on-demand (e.g. after a bulk import).

**What it does**

1. Groups all active notes by `category`
2. Finds pairs with cosine similarity ≥ 0.75 within each group
3. Merges duplicates into a unified note via LLM
4. Soft-deletes (`is_active: false`) merged source notes
5. Cascades all link references from deleted notes to the merged note

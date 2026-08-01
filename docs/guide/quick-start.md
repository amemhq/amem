# Quick Start

Once installed, the plugin is available as OpenClaw tools automatically. No additional setup is needed.

## Write a memory

```js
memory_add("Project uses PostgreSQL 16 on AWS RDS, connection pooling via PgBouncer.")
```

On write, the plugin:
1. Checks for exact duplicates (hash dedup)
2. Runs LLM note construction (keywords, tags, context, category)
3. Retrieves candidate notes and generates bidirectional links
4. Evaluates memory evolution on linked notes

## Search memories

```js
memory_search("database configuration", limit=5)
```

Returns up to `limit` memories ranked by hybrid RRF score (BM25 + vector cosine) with heat boost and 2-hop BFS graph expansion.

## List memory count

```js
memory_list()
```

Returns the total active note count for the current agent namespace.

## Manual consolidation

```js
memory_consolidate()
```

Merges semantic duplicates (cosine ≥ 0.75) across the whole store, grouped by category, with link cascading. Knowledge notes are skipped.

---

## Automatic consolidation

The plugin schedules **daily consolidation** automatically at **02:30 AM** (in-process `setTimeout`). It:

- Groups notes by `category`
- Merges semantic duplicates (cosine ≥ 0.75) into one note, keeping the episodic type
- Cascades all link references to preserve graph topology

No configuration required.

---

## LLM CRUD gate

At agent conversation end (`agent_end` hook), the plugin:

1. Reads the **last** user message and the **last** assistant message, each truncated to 500 characters — not the whole conversation
2. Decides `NEW` / `UPDATE` / `DELETE` / `NONE` per note
3. Executes changes automatically

This keeps the memory store clean without manual intervention.

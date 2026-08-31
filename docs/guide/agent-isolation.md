# Agent Isolation

openclaw-amem gives every OpenClaw agent its own private memory namespace. This page explains how isolation works, how shared memory is published, what the access fields mean, how to configure Mode A vs Mode B, and the rationale for security and architecture.

---

## Introduction

In a multi-agent OpenClaw setup — for example, `main` (your daily driver) and `dev` (a sandboxed coding assistant) — each agent accumulates memories about its own work context. Without isolation, memories from `main` will pollute `dev`'s retrieval results and vice versa. More critically, a compromised or misbehaving agent can read private information stored by another agent through shared memory poisoning ([arXiv:2604.16548](https://arxiv.org/abs/2604.16548)).

openclaw-amem addresses this with an **isolation-by-default** model: every memory that an agent writes is private to that agent unless the agent explicitly publishes it to the `shared` scope.

### Research background

The following papers informed the design:

- **[arXiv:2604.16548]** — *Security of Long-Term Memory in LLM Agents* (2026): Memory leakage in multi-agent systems most commonly occurs via shared memory stores. The paper argues isolation should be the **default**, with sharing as an explicit, auditable exception.
- **[arXiv:2603.10062]** — *Multi-Agent Memory from a Computer Architecture Perspective* (2026): The paper models agent memory as an analogy to the computer memory hierarchy — L1 cache (private), RAM (shared), NUMA (distributed). amem's Mode A maps to the L1/RAM split. Mode B maps to NUMA.
- **[arXiv:2504.19413]** — *Mem0: Building Production-Ready AI Agents with Scalable Long-Term Memory*, ECAI 2025: The paper defines a four-dimensional scope model (user_id, agent_id, run_id, app_id). amem's scope model is a deliberate subset — see [Comparison with mem0](#comparison-with-mem0-scope-model).

---

## Core concepts

### Private memory

Private memory is the default. When an agent writes a note, the plugin tags it with that agent's `agent_id` and a `readers` list that contains only that agent. No other agent can retrieve it.

**When to use private memory:** Always, unless you have a specific reason to share. Private memory is appropriate for:
- Personal task context (`"Currently debugging auth middleware, focus on JWT expiry"`)
- Agent-specific preferences and conventions
- Sensitive or proprietary information
- Work-in-progress notes not ready to share

### Shared memory

You write shared memory with `agent_id="shared"` and `readers=["*"]`. All agents that query memory will see shared notes mixed into their results.

**When to use shared memory:** When information is genuinely useful to all agents:
- Team-wide conventions (`"All API endpoints use snake_case JSON keys"`)
- Shared credentials or configuration facts
- Cross-agent context that needs to be consistent (`"Production deploy is frozen until 2026-06-20"`)

The key design decision: amem uses an **explicit** `agent_id="shared"` marker rather than the absence of an `agent_id` field. This makes shared notes immediately identifiable in the Qdrant database and prevents accidental leakage via missing fields. See [Design rationale](#why-explicit-shared-marker) below.

### The three access fields

Every `MemoryNote` carries three access control fields:

| Field | Type | Example | Meaning |
|-------|------|---------|---------|
| `owner` | `string` | `"main"` | The agent that originally wrote this note. Immutable after creation. |
| `readers` | `string[]` | `["main"]` or `["*"]` | Which agents can retrieve this note. `["*"]` means all agents. |
| `writers` | `string[]` | `["main"]` | Which agents can modify this note. **Not yet enforced** — Story 33. |

#### `owner`

The `owner` field records which agent created the note. The plugin sets it at write time and never modifies it, even if the note is later evolved or updated. It provides an audit trail: you can always query Qdrant to see which agent produced which memories.

Example: A note written by `dev` always has `owner: "dev"`, even if `main` later reads it via shared access.

#### `readers`

The `readers` field controls which agents' `searchMemory` calls will return this note.

```ts
// Private note — only "main" can retrieve it
readers: ["main"]

// Shared note — any agent can retrieve it
readers: ["*"]

// Future: fine-grained ACL (not yet implemented)
readers: ["main", "dev"]
```

In Mode A (shared collection), the `searchMemory` query adds a Qdrant filter:
```
agent_id IN ["<self>", "shared"]
```

This means each agent sees only its own private notes plus notes in the shared scope.

#### `writers`

The `writers` field records which agents are authorized to modify (evolve, update, soft-delete) this note. Currently **schema-only**: the plugin stores the field in Qdrant but does not check it at write time. Story 33 will add enforcement.

Example: A shared note written by `main` has `writers: ["main"]`. This signals that only `main` is the intended modifier, but `dev` can currently update it without a hard error. This will change in Story 33.

### Why explicit shared marker?

mem0 ([arXiv:2504.19413]) uses an implicit convention: omitting `agent_id` from a memory entry means it is accessible to all agents. This creates a problem: a bug that forgets to set `agent_id` accidentally creates a shared (leaky) memory.

amem uses `agent_id="shared"` as an explicit opt-in. The consequences are:

- You can `grep` or query Qdrant for `agent_id = "shared"` to audit all shared notes at any time
- A bug that fails to set `agent_id` falls back to the empty-string or missing-field case. The system does **not** treat this as shared. It treats it as a malformed write and rejects it or stores it as private.
- Shared notes are visually distinct in Qdrant's web UI

---

## Mode A vs Mode B

openclaw-amem supports two physical isolation modes:

| Dimension | Mode A (default) | Mode B (dedicated collection) |
|-----------|-----------------|-------------------------------|
| Qdrant collections | One (`amem_notes`) | One per agent (`amem_notes_dev`, etc.) |
| Isolation mechanism | `agent_id` payload filter at query time | Separate Qdrant collection |
| Shared notes | `agent_id="shared"` in same collection, visible to all agents | No cross-collection sharing — shared scope not visible in Mode B |
| Setup complexity | None (default) | Requires `collection` field in agent config |
| Index efficiency | Single index, filter overhead | Separate indexes, no filter overhead |
| Cross-agent sharing | Supported via `agent_id="shared"` | Not supported across agents |
| Physical data separation | Logical only | Complete (different Qdrant namespaces) |
| Recommended for | Most use cases | High-security sandboxing, compliance requirements |

### When to use Mode A

Mode A is the right choice for:
- Standard multi-agent setups where agents share some context
- Cases where you want shared notes visible to all agents
- Simpler configuration and operational overhead

### When to use Mode B

Mode B is appropriate when:
- You need **complete** physical separation (for example, compliance or audit requirements)
- The `dev` agent must be fully sandboxed and must never see any `main` notes, even shared ones
- You want separate Qdrant collections for independent backup or restore

**Note:** In Mode B, `dev` does not see shared notes written by `main`. If you need cross-agent sharing, use Mode A.

---

## Configuration

### Mode A — default, no extra config required

```json
{
  "plugins": {
    "allow": ["openclaw-amem"],
    "entries": {
      "openclaw-amem": {
        "enabled": true,
        "config": {
          "agentId": "main",
          "topK": 5
        }
      }
    },
    "slots": {
      "memory": "openclaw-amem"
    }
  }
}
```

All agents use the default `amem_notes` collection. The `agentId` field determines which agent's notes are private. All agents can see shared notes (`agent_id="shared"`) because the filter includes them automatically.

### Mode B — dedicated collection per agent

```json
{
  "plugins": {
    "allow": ["openclaw-amem"],
    "entries": {
      "openclaw-amem": {
        "enabled": true,
        "config": {
          "agentId": "main",
          "topK": 5,
          "agents": {
            "dev": {
              "agentId": "dev",
              "collection": "amem_notes_dev"
            }
          }
        }
      }
    },
    "slots": {
      "memory": "openclaw-amem"
    }
  }
}
```

When the `dev` agent is active, it reads from and writes to `amem_notes_dev` exclusively. The `main` agent continues to use `amem_notes`. The system makes no cross-collection queries.

### Full `openclaw.json` example with multiple agents

```json
{
  "plugins": {
    "allow": ["openclaw-amem"],
    "entries": {
      "openclaw-amem": {
        "enabled": true,
        "config": {
          "agentId": "main",
          "topK": 5,
          "agents": {
            "dev": {
              "agentId": "dev"
            },
            "sandbox": {
              "agentId": "sandbox",
              "collection": "amem_notes_sandbox"
            }
          }
        }
      }
    },
    "slots": {
      "memory": "openclaw-amem"
    }
  }
}
```

In this example:
- `main` — uses default `amem_notes` collection, Mode A
- `dev` — uses default `amem_notes` collection with `agent_id="dev"` filter, Mode A (shares the collection with `main`, can see shared notes)
- `sandbox` — uses dedicated `amem_notes_sandbox` collection, Mode B (completely isolated, no shared notes visible)

---

## How shared memory works step by step

### Writing a private note (default)

When `main` calls `memory_add("vendor account")`:

1. The plugin constructs a `MemoryNote` with:
   - `agent_id: "main"`
   - `owner: "main"`
   - `readers: ["main"]`
   - `writers: ["main"]`
2. The plugin stores the note in Qdrant under `amem_notes` (Mode A) or `amem_notes_main` (if Mode B is configured).
3. When `dev` calls `memory_search("vendor account")`, the query filter `agent_id IN ["dev", "shared"]` excludes this note — `dev` never sees it.

### Writing a shared note

Currently, you write shared notes via the internal `agent_id="shared"` scope parameter. A future user-facing API (for example, `memory_add(text, scope="shared")`) is planned.

When a shared note is written:
1. `agent_id: "shared"`, `owner: "<writing agent>"`, `readers: ["*"]`, `writers: ["<writing agent>"]`
2. The plugin stores it in Qdrant in the shared collection (`amem_notes`).
3. All agents' `searchMemory` calls include `agent_id IN [self, "shared"]`, so all agents retrieve this note.

### How `searchMemory` filters results (Mode A)

Every `searchMemory` query in Mode A appends a Qdrant payload filter:

```json
{
  "must": [
    { "should": [
      { "key": "agent_id", "match": { "value": "<self>" } },
      { "key": "agent_id", "match": { "value": "shared" } }
    ] }
  ],
  "must_not": [
    { "key": "is_active", "match": { "value": false } }
  ]
}
```

`is_active` is under `must_not` rather than `must`, which is not the same thing:
notes written before the field existed have no `is_active` at all, and requiring
`true` will hide them. Excluding `false` keeps them.

This ensures:
- The query always excludes soft-deleted notes (`is_active: false`)
- The query returns only the calling agent's private notes and globally shared notes

### Mode B search (own collection only)

In Mode B, the plugin targets the agent's dedicated collection directly. The plugin needs no `agent_id` filter — the collection itself provides isolation. The plugin does not query shared notes from other agents' collections.

---

## Consolidation behavior

### Per-agent scoping

The daily consolidation pass (02:30 AM in-process scheduler) runs per agent. When `main`'s consolidation runs, it queries only `agent_id = "main"` notes. When `dev`'s consolidation runs (if `dev` has its own consolidation schedule), it queries only `agent_id = "dev"` notes.

### Shared notes are excluded

All agents' consolidation passes explicitly exclude notes with `agent_id = "shared"`. This is intentional:

1. **Ownership ambiguity** — Shared notes can be written by `main` but consumed by `dev`. If `dev`'s consolidation merges or modifies them, it will violate the `owner` guarantee.
2. **Stability** — Shared notes serve as stable reference facts. Merging shared notes automatically can corrupt or silently alter information that other agents depend on.
3. **writers enforcement (future)** — When Story 33 implements `writers` field enforcement, only the `owner` agent will be able to modify shared notes. Until then, this exclusion provides equivalent protection.

### What consolidation does with each scope

| Note type | Included in consolidation? | Why |
|-----------|---------------------------|-----|
| Private (`agent_id = self`) | ✅ Yes | Normal dedup and merge |
| Shared (`agent_id = "shared"`) | ❌ No | Excluded to prevent cross-agent modification |
| Other agent's private notes | ❌ No | Filtered out by `agent_id` query |

---

## Access fields reference

### Full combination table

| `owner` | `readers` | `writers` | `agent_id` | Meaning |
|---------|-----------|-----------|------------|---------|
| `"main"` | `["main"]` | `["main"]` | `"main"` | Private note written by `main`, readable only by `main` |
| `"dev"` | `["dev"]` | `["dev"]` | `"dev"` | Private note written by `dev`, readable only by `dev` |
| `"main"` | `["*"]` | `["main"]` | `"shared"` | Shared note written by `main`, readable by all agents |
| `"dev"` | `["*"]` | `["dev"]` | `"shared"` | Shared note written by `dev`, readable by all agents |
| `"main"` | `["main", "dev"]` | `["main"]` | `"main"` | Fine-grained ACL (future, not yet implemented) |

### Current enforcement status

| Field | Enforced? | Since | Notes |
|-------|-----------|-------|-------|
| `owner` | ✅ Schema | Story 32 | Set at write time, not modifiable |
| `readers` | ✅ Query filter | Story 32 | `agent_id IN [self, "shared"]` filter applied to all searches |
| `writers` | ❌ Schema only | Story 32 | Stored in Qdrant but not checked at write/update/delete time |

Story 33 will add `writers` enforcement. When Story 33 is implemented, any write/evolve/delete operation against a note will first check that the calling agent appears in the note's `writers` list.

---

## Comparison with mem0 scope model

### mem0's four-dimensional scope

mem0 ([arXiv:2504.19413], ECAI 2025) defines memory scope across four orthogonal dimensions:

| Dimension | Purpose | amem equivalent |
|-----------|---------|-----------------|
| `user_id` | Separate memories by human user | Not implemented (single-user local) |
| `agent_id` | Separate memories by AI agent | ✅ `agent_id` field |
| `run_id` | Separate memories by conversation/session | Not implemented (single-session local) |
| `app_id` | Separate memories by application | Not implemented (single-app) |

### Why amem doesn't need `run_id` and `app_id`

amem is a **single-user local** system. There is no multi-tenant SaaS context where multiple users or applications share one memory store. As a result:

- `user_id` — unnecessary. amem assumes a single human operator.
- `run_id` — unnecessary. amem treats the OpenClaw session as a continuous context, not isolated conversation runs. Consolidation already handles cross-session memory management.
- `app_id` — unnecessary. amem is a dedicated plugin for OpenClaw only.

`user_id` is in the long-term roadmap. The team plans to implement it alongside an HTTP API layer for potential multi-user setups. The only required change is a `user_id` payload filter added to Qdrant queries.

### Why explicit shared marker over mem0's implicit null-scoping

mem0's convention: when `agent_id` is omitted from a memory entry, all agents can access that entry (implicit shared).

amem's convention: `agent_id="shared"` is an explicit opt-in (explicit shared).

**The problem with implicit null-scoping:**
- A bug that forgets to set `agent_id` accidentally creates a shared (and thus leaky) memory
- You cannot distinguish "shared by design" from "shared by accident" in the database
- Auditing shared notes requires querying for null/missing `agent_id`, which is awkward in Qdrant

**amem's explicit marker:**
- `grep agent_id:shared` or `filter: { key: "agent_id", match: { value: "shared" } }` gives a clean audit list
- Missing `agent_id` is a write error. The system treats it as private, never accidentally shared.
- As [arXiv:2604.16548] states: isolation-by-default, sharing is an explicit, auditable exception

### Computer architecture analogy

[arXiv:2603.10062] frames multi-agent memory as a computer memory hierarchy:

| Architecture level | amem mapping | Visibility |
|-------------------|--------------|------------|
| L1 cache (per-core private) | Private notes (`agent_id = self`) | Only the owning agent |
| RAM (shared) | Shared notes (`agent_id = "shared"`) | All agents |
| NUMA (distributed) | Mode B dedicated collections | Isolated, no cross-agent access |

Mode A implements the L1/RAM split: each agent has a private working set with a global shared region. Mode B implements NUMA-style isolation: each agent has its own address space with no shared region.

---

## Security considerations

### Memory leakage in multi-agent systems

[arXiv:2604.16548] identifies three primary memory leakage vectors in multi-agent LLM systems:

1. **Cross-agent reads** — Agent B reads Agent A's private notes via a shared memory store
2. **Shared memory poisoning** — A malicious or compromised agent writes adversarial content to the shared scope and affects other agents' retrieval
3. **Consolidation spillover** — An agent's consolidation pass accidentally modifies another agent's notes

openclaw-amem addresses all three:

1. **Cross-agent reads** — `agent_id` filter at query time prevents Agent B from reading Agent A's private notes. In Mode B, separate collections provide physical isolation.
2. **Shared memory poisoning** — The quality gate currently mitigates this (content < 10 chars rejected, ephemeral flagging). Story 33 `writers` enforcement will prevent unauthorized modification of shared notes.
3. **Consolidation spillover** — Consolidation runs per agent. The system excludes shared notes entirely.

### Isolation-by-default principle

The core security principle, per [arXiv:2604.16548]: **isolation should be the default, sharing is an explicit exception**.

This principle shapes every design decision in openclaw-amem's isolation model:
- Private is the default note scope (no extra config needed)
- Shared requires explicit `agent_id="shared"` (opt-in)
- Consolidation excludes shared notes (conservative default)
- Story 33 will add `writers` enforcement (progressive hardening)

### What is NOT yet protected

- **`writers` enforcement** — Story 32 stores the `writers` field but does not enforce it. A `dev` agent can technically evolve or soft-delete a shared note written by `main`. Story 33 will add a hard check.
- **Prompt injection via shared notes** — A compromised agent can write adversarial content into a shared note that manipulates another agent's behavior when retrieved. This is a known attack class ([arXiv:2604.16548] §4). Mitigation requires content validation at write time (future work).

---

## Limitations and future work

### Story 33: `writers` enforcement

The `writers` field is currently schema-only. When Story 33 is implemented:

- Any `updateMemory`, `evolveNote`, or `softDelete` call will first check `writers` includes the calling agent
- Unauthorized agents will receive a `PERMISSION_DENIED` error on write attempts
- The consolidation loop will double-check `writers` before merging shared notes

### No cross-collection sharing in Mode B

In Mode B, each agent operates on its own dedicated Qdrant collection. There is no cross-collection query mechanism. If `main` writes a shared note in `amem_notes` and `dev` is in Mode B (`amem_notes_dev`), `dev` does not see `main`'s shared note.

This is a deliberate trade-off: Mode B prioritizes physical isolation over sharing convenience. If you need cross-agent sharing, use Mode A.

### No fine-grained ACL beyond binary private/shared

Current `readers` options are:
- `["<agentId>"]` — private (single agent)
- `["*"]` — shared (all agents)

A future fine-grained ACL (`readers: ["main", "dev"]` for selective sharing between specific agents) is possible without schema changes — only query filter logic will need updating. Implementation is planned for post-Story 33.

### `user_id` dimension

amem is currently single-user. The team plans a `user_id` dimension alongside an HTTP API layer for potential multi-user deployments. When the team adds it, it will be an additional Qdrant payload filter with no breaking changes to the existing `agent_id` isolation model.

---

## References

| Citation | arXiv | Role in amem design |
|----------|-------|---------------------|
| Chhikara et al., *Mem0: Building Production-Ready AI Agents with Scalable Long-Term Memory*, ECAI 2025 | [arXiv:2504.19413](https://arxiv.org/abs/2504.19413) | Four-dimensional scope model; explicit vs implicit shared marker comparison |
| *Multi-Agent Memory from a Computer Architecture Perspective*, 2026 | [arXiv:2603.10062](https://arxiv.org/abs/2603.10062) | Private/shared/distributed memory hierarchy; access protocol design |
| *Security of Long-Term Memory in LLM Agents*, 2026 | [arXiv:2604.16548](https://arxiv.org/abs/2604.16548) | Isolation-by-default principle; memory leakage attack vectors |
| Kerestecioglu et al., *Human-Inspired Memory Architecture for LLM Agents*, Microsoft, 2026 | [arXiv:2605.08538](https://arxiv.org/abs/2605.08538) | Sleep-phase consolidation design (related to amem's 02:30 AM consolidation) |
| *Governing Evolving Memory in LLM Agents: SSGM Framework*, 2026 | [arXiv:2603.11768](https://arxiv.org/abs/2603.11768) | Memory evolution taxonomy (EVOLVE/CONFLICT/EXPAND/NEW) |
| *Graph-based Agent Memory: Taxonomy, Techniques, and Applications*, 2026 | [arXiv:2602.05665](https://arxiv.org/abs/2602.05665) | Conflict detection in graph memory updates |
| *Memory in the LLM Era*, 2026 | [arXiv:2604.01707](https://arxiv.org/abs/2604.01707) | Memory operations taxonomy |
| Xu et al., *A-MEM: Agentic Memory for LLM Agents*, NeurIPS 2025 | [arXiv:2502.12110](https://arxiv.org/abs/2502.12110) | Core architecture that amem implements |

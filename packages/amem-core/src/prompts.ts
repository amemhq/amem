/**
 * prompts.ts — Locale-aware prompt templates for A-MEM LLM functions
 *
 * Only the 3 content-sensitive functions need locale variants:
 *   - crudDecision: extracts facts from conversation (needs natural language output)
 *   - shouldMerge: merges duplicate memories (needs natural language output)
 *   - evolutionJudge: judges memory evolution (needs natural language output)
 *
 * The other 3 functions (constructNote, shouldLink, evolveNote) produce
 * structured/binary output and work equally well in English for any input language.
 *
 * PROMPT_VERSION: 1 — created: 2026-06-24
 * When updating any locale, review the other locale for behavioral parity.
 */

// ── Types ────────────────────────────────────────────────────────────────────

export type PromptLocale = 'en' | 'zh'

export interface LocalePrompts {
  crudDecision: (userText: string, assistantText: string, memoryList: string) => string
  shouldMerge: (contentA: string, contentB: string) => string
  evolutionJudge: (oldContent: string, newContent: string) => string
  /** Story 43: scan a BATCH of notes for mutually contradictory pairs. */
  conflictScan: (numberedNotes: string) => string
}

// ── Locale resolution ────────────────────────────────────────────────────────

const LOCALE: PromptLocale = (process.env.AMEM_PROMPT_LOCALE as PromptLocale) === 'zh' ? 'zh' : 'en'

// ── English templates ────────────────────────────────────────────────────────

const en: LocalePrompts = {
  crudDecision: (
    userText,
    assistantText,
    memoryList
  ) => `You are a memory management agent. Analyze the conversation and decide what memory operations are needed.

## Conversation

User: ${userText}
Assistant: ${assistantText}

## Existing relevant memories (identified by integer idx)

${memoryList}

## Task

Extract only genuinely important long-term facts (decisions, preferences, account info, project status, key insights). Skip small talk, confirmations, and information already captured in existing memories.

## Operation types
- NEW: Extract a brand new fact not present in existing memories
- UPDATE: New information refines or supersedes an existing memory; specify existingIdx
- DELETE: An existing memory is outdated, contradicted, or wrong; specify existingIdx, fact = original content
- NONE: Nothing worth recording, or information already fully captured

## Output format

Return a JSON array. Each item:
{"action": "NEW"|"UPDATE"|"DELETE"|"NONE", "fact": "fact content", "existingIdx": integer or omit, "reason": "optional"}

Return at most 3 operations. If nothing is worth recording, return [].
Return only the JSON array, no other text.

Examples:

1. New preference:
[{"action": "NEW", "fact": "User prefers TypeScript over JavaScript", "reason": "Explicitly stated tech preference"}]

2. Updating an existing memory (idx 0 was "User is evaluating React and Vue"):
[{"action": "UPDATE", "fact": "User decided to use React (dropped Vue)", "existingIdx": 0, "reason": "Decision finalized, update evaluation status"}]

3. Conversation is just "Sure, thanks" / "Got it" with no new info:
[]`,

  shouldMerge: (
    contentA,
    contentB
  ) => `You are a memory deduplication assistant. Determine whether two memories express essentially the same information.

Memory A: ${contentA}
Memory B: ${contentB}

Rules:
- If both memories express the same core fact (possibly different wording or granularity), return:
  {"shouldMerge": true, "merged": "Concise merged statement preserving key details from both, more complete than either alone"}
- If the memories are complementary, on different topics, or contain different specific facts, return:
  {"shouldMerge": false}

Return only JSON, no other text.

Examples:

1. Should merge (different granularity):
A: "Project uses PostgreSQL"
B: "Project's primary database is PostgreSQL 16, deployed on AWS RDS"
-> {"shouldMerge": true, "merged": "Project uses PostgreSQL 16 as primary database, deployed on AWS RDS"}

2. Should NOT merge (complementary but distinct):
A: "User prefers VS Code"
B: "User's VS Code uses One Dark Pro theme"
-> {"shouldMerge": false}`,

  evolutionJudge: (
    oldContent,
    newContent
  ) => `You are a memory evolution judge. Analyze the relationship between an old and new memory and return JSON.

Old memory: ${oldContent}
New memory: ${newContent}

Classification rules:

- EVOLVE: New content deepens or updates the old memory (e.g. "Considering Next.js" -> "Decided on Next.js 14 App Router")
  Return: {"type": "EVOLVE", "mergedContent": "Merged content preserving the evolution trajectory"}

- CONFLICT: Old and new information directly contradict each other on the same attribute (e.g. "Uses MySQL as primary DB" vs "Migrated to PostgreSQL")
  Return: {"type": "CONFLICT"}

- EXPAND: New information supplements the old memory on the same topic (e.g. "Handles backend dev" + "Backend uses Go and gRPC")
  Return: {"type": "EXPAND", "mergedContent": "Merged content integrating both pieces of information"}

- NEW: Completely unrelated information, no substantive connection to the old memory
  Return: {"type": "NEW"}

Return only JSON, no other text.`,
  conflictScan: (numberedNotes) => `You are auditing a person's memory store for CONTRADICTIONS.

Below are numbered memories. Find pairs that CANNOT both be true of the same person at the same time.

${numberedNotes}

What counts as a contradiction:
- The same attribute holding two incompatible values ("lives in Paris" vs "moved to Berlin")
- A stated preference or constraint that a later memory violates ("is vegetarian" vs "loved the steak")
- A fact that a later memory supersedes ("uses MySQL" vs "migrated to PostgreSQL")

What does NOT count — be strict, these are the common false positives:
- Additive facts. Two things can both be true ("has a dog named Buddy" + "adopted a second dog, Scout" is NOT a contradiction)
- Change over time that both memories already acknowledge
- Merely similar or related topics
- Different contexts (likes coffee at work, tea at home)

For each contradicting pair, also say which one is SUPERSEDED — the one that is
no longer true. Judge this from the WORDING, not from any assumed order: phrases
like "used to", "back in 2019", "moved last month", "switched to" tell you which
statement describes the past. The memories are NOT listed in chronological order,
and the number does not imply age.

If you cannot tell which one is superseded, set it to null. That is a normal and
useful answer — say null rather than guessing, because a wrong guess retires a
memory that is still true.

Return ONLY a JSON array. Empty array if nothing genuinely contradicts:
[{"a": 0, "b": 3, "superseded": 0, "reason": "one short sentence naming the incompatible attribute"}]

"superseded" must be either the value of "a", the value of "b", or null.
Use the numbers shown. Report a pair once. Prefer returning nothing over guessing.`,
}

// ── Chinese templates ────────────────────────────────────────────────────────

const zh: LocalePrompts = {
  crudDecision: (userText, assistantText, memoryList) => `你是一个记忆管理 agent，负责分析对话内容并决定如何操作记忆库。

## 对话内容

用户：${userText}
助手：${assistantText}

## 已有相关记忆（用整数 idx 标识）

${memoryList}

## 任务

分析上述对话，决定需要哪些记忆操作。只提取真正重要的长期事实（决策、偏好、账号信息、项目状态、关键洞察）。跳过闲聊、确认语、重复信息。

## 操作类型
- NEW：提取全新事实（已有记忆中没有的信息）
- UPDATE：新信息更新了某条已有记忆，用 existingIdx 指定要更新的条目
- DELETE：某条已有记忆已经过时、发生冲突或错误，用 existingIdx 指定，fact 填原内容
- NONE：不值得记录或已有完全相同的信息

## 输出格式

返回 JSON 数组，每条格式：
{"action": "NEW"|"UPDATE"|"DELETE"|"NONE", "fact": "事实内容", "existingIdx": 整数或省略, "reason": "原因（可选）"}

每次最多返回 3 条操作。如果没有值得操作的内容，返回 []。
只返回 JSON 数组，不要任何其他文字。

示例：

1. 提取新偏好：
[{"action": "NEW", "fact": "用户偏好 TypeScript 而非 JavaScript", "reason": "明确表达的技术偏好"}]

2. 更新已有记忆（idx 0 原为"用户正在评估 React 和 Vue"）：
[{"action": "UPDATE", "fact": "用户决定使用 React（放弃了 Vue）", "existingIdx": 0, "reason": "决策已明确，更新评估状态"}]

3. 对话仅为"好的，谢谢"/"没问题"等确认语，无新信息：
[]`,

  shouldMerge: (contentA, contentB) => `你是一个记忆去重助手，负责判断两条记忆是否表达了本质相同的信息。

记忆A：${contentA}
记忆B：${contentB}

判断规则：
- 如果两条记忆表达的是本质相同的信息（可能措辞不同、粒度不同，但核心事实一致），返回 JSON：
  {"shouldMerge": true, "merged": "合并后的简洁表述，保留两条记忆的关键信息，比任何一条都更完整"}
- 如果两条记忆是互补信息、不同主题、或包含不同的具体事实，返回 JSON：
  {"shouldMerge": false}

只返回 JSON，不要任何其他文字。

示例：

1. 应合并（粒度不同）：
A: "项目使用 PostgreSQL 数据库"
B: "项目的主数据库是 PostgreSQL 16，部署在 AWS RDS 上"
→ {"shouldMerge": true, "merged": "项目使用 PostgreSQL 16 作为主数据库，部署在 AWS RDS 上"}

2. 不应合并（互补但不同）：
A: "用户喜欢用 VS Code"
B: "用户的 VS Code 使用 One Dark Pro 主题"
→ {"shouldMerge": false}`,

  evolutionJudge: (oldContent, newContent) => `你是一个记忆演化判断助手。分析以下两条记忆的关系并返回 JSON。

旧记忆：${oldContent}
新记忆：${newContent}

判断规则：

- EVOLVE：新内容是对旧记忆的深化/更新（如「正在考虑用 Next.js」→「决定用 Next.js 14 App Router」）
  返回：{"type": "EVOLVE", "mergedContent": "融合后的完整内容，保留演化轨迹"}

- CONFLICT：新旧信息在同一属性上直接矛盾（如「使用 MySQL 作为主数据库」vs「已迁移到 PostgreSQL」）
  返回：{"type": "CONFLICT"}

- EXPAND：新信息是对旧记忆同一主题的补充扩展（如「负责后端开发」+「后端使用 Go 和 gRPC」）
  返回：{"type": "EXPAND", "mergedContent": "合并后的完整内容，整合双方信息"}

- NEW：全新信息，与旧记忆无实质关联（如「喜欢 dark mode」vs「下周要去出差」）
  返回：{"type": "NEW"}

只返回 JSON，不要任何其他文字。`,
  conflictScan: (numberedNotes) => `你在审计一个人的记忆库，找出其中**互相矛盾**的条目。

下面是编号的记忆。找出那些**不可能同时为真**的配对。

${numberedNotes}

算矛盾的情况：
- 同一属性上出现互斥的值（「住在巴黎」vs「搬到了柏林」）
- 后来的记忆违反了先前陈述的偏好或约束（「吃素」vs「那块牛排很好吃」）
- 后来的事实取代了先前的（「用 MySQL」vs「已迁移到 PostgreSQL」）

**不算**矛盾 —— 请严格，以下是最常见的误判：
- 累加的事实。两者可以同时成立（「养了一只狗叫 Buddy」+「又领养了第二只叫 Scout」**不是**矛盾）
- 两条记忆本身已经体现了随时间的变化
- 只是主题相似或相关
- 场景不同（在公司喝咖啡，在家喝茶）

对每一对矛盾，还要指出哪一条是**已失效的**（不再为真的那条）。请从**措辞**判断，不要假设顺序：
「以前」「2019 年那会儿」「上个月搬了」「改用了」这类说法能告诉你哪条描述的是过去。
这些记忆**不是按时间顺序排列的**，编号也不代表新旧。

如果无法判断哪条已失效，就填 null。这是一个**正常且有用**的回答 —— 宁可填 null 也不要猜，
因为猜错会让一条**仍然为真**的记忆被停用。

只返回 JSON 数组。没有真正矛盾就返回空数组：
[{"a": 0, "b": 3, "superseded": 0, "reason": "一句话说明是哪个属性互斥"}]

"superseded" 只能是 "a" 的值、"b" 的值，或 null。
使用上面显示的编号。同一对只报一次。**宁可不报，也不要猜。**`,
}

// ── Export ────────────────────────────────────────────────────────────────────

const templates: Record<PromptLocale, LocalePrompts> = { en, zh }

export const t = templates[LOCALE]

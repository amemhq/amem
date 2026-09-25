---
'@amemhq/core': patch
'openclaw-amem': patch
---

Turn thinking off on fast-tier calls to the Anthropic API.

Fast-tier calls are short extractions and yes/no judgments, and they run inside
agent_end's 30 s budget. Some endpoints turn thinking on without being asked. A
relay measured on 2026-09-25 did this for claude-haiku-4-5. A short request took
about 7 s instead of 5.8 s, and a long Chinese prompt took 13 to 15 s instead of
5.5 to 6 s. A fast call on the Anthropic path now sends
`thinking: {type: "disabled"}`. On the Anthropic API itself, Haiku 4.5 and
Sonnet 4.6 do not think by default, so nothing changes for them there.

Opus 5.5, Fable and Mythos always think, and they return a 400 for that field.
After any 400 to it, the engine asks again without the field. If that works, it
remembers the endpoint and model for the rest of the process. Later calls to
them go without the field and with at least 4000 output tokens. The engine does
not match the error body, because relays word it differently.

`AMEM_LLM_THINKING` (plugin config `llmThinking`) is `off` by default. `auto`
sends no thinking field. The strong tier and the OpenAI path never send one.

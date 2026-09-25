---
'@amemhq/core': patch
'openclaw-amem': patch
---

Give a call that may think enough output tokens to answer.

Thinking counts against max_tokens. The strong tier asks for 300 to 600 tokens
and sends no thinking field. On Sonnet 5, Opus 5, Opus 5.5 or Fable, thinking
could use all of them and leave no answer. A missing evolution judgment reads as
NEW, which clears pending_merge, so the pair is not judged again.

On the Anthropic path, every call that does not send thinking disabled now gets
at least 4000 output tokens. That is every strong-tier call, a fast call with
`AMEM_LLM_THINKING=auto`, and a model that refused disabled. On the OpenAI path,
OpenAI's own reasoning models (o-series, gpt-5) get the same. Before, their
budget stayed as asked. max_tokens is a cap, so a model that does not think
still stops where its answer ends. An answer that the old cap cut off can now be
complete. A server that checks prompt plus max_tokens against a small context
window, such as vLLM on the Anthropic format, can reject the larger requests.

---
'@amemhq/core': patch
'openclaw-amem': patch
---

Stop claiming CJK. It is Chinese.

`simpleTokenize` branches on Han characters, so Korean and kana-only Japanese never
reach Jieba and fall to `[\w]+`, which matches neither Hangul nor kana — **zero
tokens, so BM25 never indexes them**. Japanese *with* kanji is worse than nothing:
it does reach Jieba, gets cut as though it were Chinese, and comes back holding the
kanji with every kana dropped. Measured: a 13-word Japanese sentence yields 2
tokens, a Korean one yields 0, the same Chinese sentence yields 9.

Dense retrieval covers both — the default model is multilingual — so search works
for ja/ko on one half of the hybrid rather than two. Nothing about that is
documented, and six places advertised "CJK".

Behaviour unchanged; a real fix means a per-language segmenter, which is a
dependency decision rather than a tweak. Four tests pin what it does today so
changing it has to be deliberate.

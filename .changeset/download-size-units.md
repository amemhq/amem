---
'@amemhq/core': patch
'openclaw-amem': patch
---

Show the ONNX graph size as a size, not as `0.00 GB`.

The download reporter hardcoded GB. bge-m3 ships a 607 kB graph next to 2.27 GB
of weights, three orders of magnitude apart, so every startup printed:

```
[amem] downloading onnx/model.onnx: 100% of 0.00 GB
[amem] downloading onnx/model.onnx_data: 100% of 2.27 GB
```

A zero there reads as a failed size lookup, which sent one operator looking for
a broken download that was not broken.

The reporter's docblock was wrong too. It claimed a cached model prints nothing,
and a cached model prints one 100% line per file, because Transformers.js
reports reading the cache with the same progress events it reports a download
with. Checked on a real store: the two files were last written a month before
the gateway last started, so those lines are a cache hit and nothing was
re-downloaded. The docblock now says what the line means — an instant 100% of
2.27 GB is a cache hit, and the same line arriving slowly is a real download.

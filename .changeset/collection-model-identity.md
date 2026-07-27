---
'@amemhq/core': minor
'openclaw-amem': patch
---

Record which embedding model built a collection, in Qdrant's collection metadata.

Groundwork for changing the default embedding model without breaking existing
installs. Today the engine only knows a collection's vector width; when the
default changes, an existing 384-dimension collection would meet a 1024-dimension
model and fail at startup. Knowing which model built it means the engine can keep
using that one until the user migrates.

Qdrant gained user-writable collection metadata in 1.16 (PR #7123), so this needs
no sentinel point, no sidecar file and no collection-name convention — and no read
path changes. `ensureCollection` already fetches the collection info it reads this
from, so there is no extra round trip.

Collections that predate the field are backfilled the first time they are opened:
the width matched, so whatever is configured at that moment is provably what wrote
those vectors. That stops being true once the default changes, which is why this
lands first.

Also catches a case nothing caught before: two different models of the *same*
width. `EmbeddingModelMismatchError` is thrown rather than letting the store
accumulate vectors from two geometries, which fails no check and simply retrieves
worse.

Writing the metadata is best-effort and deliberately separate from collection
creation — an older Qdrant rejecting an unfamiliar field must never be the reason
a collection cannot be created. Against Qdrant older than 1.16 this is a no-op and
behaviour is unchanged.

---
"@byollm/server": patch
---

`secretsMatch` is removed from `@byollm/server`. It was exported and called by
nothing: device codes are looked up by their SHA-256 digest, never compared, so
the function only read as evidence of constant-time handling that does not
happen. Nothing in this repository imported it.

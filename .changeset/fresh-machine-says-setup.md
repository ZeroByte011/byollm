---
"byollm": patch
---

A machine nobody has set up says so. With no config, `byollm services` listed
the built-in default (an Ollama at 11434) as if somebody had chosen it and sent
the reader to `byollm model`, which refused because there was no config; and
`byollm status` read `state: running` about a device on which nothing had ever
run. Both now say there is no config and name `byollm setup`.

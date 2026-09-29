---
"byollm": patch
---

`byollm model <service> <name>` works for HTTP services again. It built the
backend from the id alone, so every Ollama, LM Studio and vLLM service failed
with "openai-http backend requires a baseUrl" before the probe could run. The
backend is now built from the service's own config, as the daemon builds it.

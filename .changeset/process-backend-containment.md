---
"byollm": patch
---

Tighten process-backend containment, and prove it against the real binary.
The `claude` backend's fixed argv gains a switch that confines the child's file
surface to the empty scratch directory a job runs in; `codex` needed no change.
A new adversarial row runs the shipped binaries against a canary outside that
directory and reports **inconclusive** rather than a pass when its control
cannot reach the canary either — it is default-on where a CLI is installed and
signed in, and prints a line naming itself when it skips. `docs/security.md`
§3.2–§3.3 now say which platforms each file-access claim has been proved on, and
that the containment is a checked contract with somebody else's CLI rather than
an OS-level sandbox. Reported privately as BY-01 by David Sturgeon.

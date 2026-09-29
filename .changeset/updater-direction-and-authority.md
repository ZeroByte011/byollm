---
"byollm": patch
---

The updater checks direction and authority. It refuses any version at or below
the one running, takes offers only from the update authority
(`updateAuthority`, the reference hub by default — never another paired site
or a direct-mode pairing), installs without scripts from registry.npmjs.org,
and checks the package's SLSA provenance before the new version runs, rolling
back if it fails. `docs/security.md` gains §7a, Updates.

import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

/**
 * Workspace packages resolve to their *source* under test, not their built
 * `dist`. Without this a stale build silently shadows an edit, and the
 * failure looks like a logic bug rather than a missing `pnpm build`.
 */
/**
 * Windows CI is slow in a way that is *ambient*, not local to any test.
 *
 * Found twice. The first time the flake was in `cli.test.ts`, which spawns
 * real CLI processes, and the fix was a bump inside that one file on the
 * stated reasoning that "the limit moves where the slowness actually is".
 * That reasoning was wrong, and the second sighting is what shows it:
 * `quota-block.test.ts` timed out at 5000ms in a test whose body is
 * SYNCHRONOUS -- one pure call, no I/O, no timers. Such a body cannot spend
 * five seconds of its own. It was starved by the runner, on a job whose
 * import phase alone took 28.58s for 144 files.
 *
 * So the slowness is not in any file, and a per-file bump would have to be
 * repeated in every file that ever loses the scheduling lottery -- which is
 * all of them. On this runner the 5s default has stopped distinguishing
 * "hung" from "scheduled late", and a limit that cannot tell those apart is
 * not measuring anything.
 *
 * Still Windows-only, because that part of the original reasoning holds: 5s
 * is doing real work on macOS and Linux, and a global raise would hide a
 * genuine hang on two platforms to quiet a flake on the third. And 20s is a
 * raise, not a removal -- a real hang is still red, just later.
 *
 * A red build nobody can reproduce teaches people to hit rerun, and a suite
 * whose failures are sometimes meaningless stops being read. That cost lands
 * hardest on the first outside contributor, who cannot tell our flake from
 * their mistake.
 */
const SLOW_RUNNER = process.platform === "win32";
const unitTimeout = SLOW_RUNNER ? 20_000 : 5_000;

const sourceAliases = {
  "@byollm/protocol": fileURLToPath(
    new URL("./packages/protocol/src/index.ts", import.meta.url),
  ),
  // Before the bare `@byollm/server` entry, deliberately: these are prefix
  // matches applied in order, so the shorter key would otherwise rewrite
  // `@byollm/server/supabase` into `<server/src/index.ts>/supabase`.
  "@byollm/server/supabase": fileURLToPath(
    new URL("./packages/server/src/supabase/index.ts", import.meta.url),
  ),
  "@byollm/server": fileURLToPath(
    new URL("./packages/server/src/index.ts", import.meta.url),
  ),
  "@byollm/relay": fileURLToPath(
    new URL("./packages/relay/src/index.ts", import.meta.url),
  ),
  "@byollm/control-plane": fileURLToPath(
    new URL("./packages/control-plane/src/index.ts", import.meta.url),
  ),
  // Missing until 2026-08-20, and it cost an hour: the posture suite imports
  // `auditDeployment` from here, so every relay test that runs an audit was
  // reading whatever `dist` happened to hold. An edit to a probe looked like a
  // failure in the relay — which is precisely the shadowing this list exists
  // to prevent, with the one package that *audits* the others left off it.
  "@byollm/conformance": fileURLToPath(
    new URL("./packages/conformance/src/index.ts", import.meta.url),
  ),
  byollm: fileURLToPath(
    new URL("./packages/daemon/src/index.ts", import.meta.url),
  ),
};

/**
 * Coverage gates come from docs/standards.md (as amended by byollm_001 Rev 1
 * point F): a numeric line gate on a types-and-schemas package is trivially
 * met or gamed, so `protocol` is gated by the conformance kit instead. The
 * daemon's allowance exists because process-spawning code has branches that
 * only a real backend exercises.
 */
export default defineConfig({
  test: {
    /* Refuses a run that rewrote the repository — B333's twin. A probe run
       from the wrong directory renumbered fifteen tracked files here, and a
       test that forgets `cwd` does the same and passes. */
    globalSetup: ["scripts/the-suite-leaves-the-tree-as-it-found-it.mjs"],
    projects: [
      {
        resolve: { alias: sourceAliases },
        test: {
          name: "unit",
          include: ["packages/*/src/**/*.test.ts", "scripts/**/*.test.mjs"],
          environment: "node",
          testTimeout: unitTimeout,
          hookTimeout: unitTimeout,
        },
      },
      {
        resolve: { alias: sourceAliases },
        test: {
          name: "adversarial",
          include: ["packages/daemon/test/adversarial/**/*.test.ts"],
          environment: "node",
          testTimeout: 30_000,
          /**
           * After the others, never beside them — and this is about CPU, not
           * ordering.
           *
           * BY-01's row (`file-mentions-stay-outside.test.ts`) is default-on
           * wherever a CLI is installed and signed in, and it spawns several
           * **real** `claude` and `codex` processes — each a full agentic
           * runtime. Run in parallel with the `unit` project, that starved two
           * unrelated tests in two of four full runs on this Mac, in two
           * different ways: `setup.test.ts` timed out at 5006ms on a body that
           * drives scripted IO and spawns nothing, and
           * `where-the-time-went.test.ts`'s "keeps the FIRST byte" saw a child's
           * 120ms write land past its 400ms bound.
           *
           * The second failure is why the fix is here rather than in a timeout.
           * `unitTimeout` above would have caught the first and done nothing at
           * all for the second: that case measures wall-clock time to first
           * byte, so there is no limit to raise — the number it exists to report
           * was simply wrong. And widening its tolerance would mean degrading a
           * measurement test to make room for an unrelated one, which is how a
           * suite stops measuring things one accommodation at a time.
           *
           * So the heavy project gets the machine to itself. `groupOrder` runs
           * groups lowest-first, and every other project is left at the default
           * 0 — the cost is roughly thirty seconds of wall clock on a full run,
           * paid to keep every existing timeout and tolerance honest.
           */
          sequence: { groupOrder: 1 },
        },
      },
      {
        resolve: { alias: sourceAliases },
        test: {
          name: "conformance",
          include: ["packages/conformance/test/**/*.test.ts"],
          environment: "node",
          testTimeout: 60_000,
          hookTimeout: 60_000,
        },
      },
      {
        resolve: { alias: sourceAliases },
        test: {
          name: "control-plane",
          include: ["packages/control-plane/test/**/*.test.ts"],
          environment: "node",
        },
      },
      {
        resolve: { alias: sourceAliases },
        test: {
          name: "relay",
          include: ["packages/relay/test/**/*.test.ts"],
          environment: "node",
          testTimeout: 60_000,
          hookTimeout: 60_000,
        },
      },
    ],
    coverage: {
      provider: "v8",
      reporter: ["text-summary", "lcov", "json-summary"],
      include: ["packages/*/src/**/*.ts"],
      exclude: [
        "**/*.test.ts",
        "**/index.ts",
        "**/types.ts",
        // The kit is the thing that measures other code; its own guarantee is
        // that it runs green against two independent servers in CI.
        "packages/conformance/src/**",
        // The Supabase adapter is certified by the `conformance-supabase` CI
        // job, which runs the full kit against a real Postgres with a real
        // daemon. A unit test with a mocked PostgREST would exercise the mock,
        // not the adapter, and would let a wrong SQL predicate pass.
        "packages/server/src/supabase/**",
      ],
      thresholds: {
        "packages/server/src/**": {
          lines: 90,
          branches: 90,
          functions: 90,
          statements: 90,
        },
        "packages/daemon/src/**": {
          lines: 85,
          branches: 85,
          functions: 85,
          statements: 85,
        },
        // The engine is the law over somebody else's data, and it is small
        // enough that every branch is reachable from a test. Gated at the
        // server's level rather than the daemon's for that reason: there is
        // no process-spawning here to excuse a gap.
        "packages/control-plane/src/**": {
          lines: 90,
          branches: 90,
          functions: 90,
          statements: 90,
        },
      },
    },
  },
});

/**
 * Did the version npm just installed come from our release workflow? — B360.
 *
 * The updater's exact-version rule says WHICH version is installed; it says
 * nothing about who built it. Whoever can publish `byollm` to npm can put
 * anything under a new number, and an auto-updating daemon would take it.
 * So before the new binary is ever run, this asks the registry for the SLSA
 * provenance our release job attaches to every publish, and requires three
 * things of it:
 *
 * - it was built by `oftomorrowinc/byollm`'s workflow, from the tag
 *   `v<version>` — not a fork, not a branch;
 * - it names this package at this version;
 * - its subject digest is the tarball's `dist.integrity` — the hash npm
 *   checked the download against, so the statement is about the bytes that
 *   were installed and not about some other tarball.
 *
 * ## What this does not do, said where it is done
 *
 * It does not re-verify the Sigstore signature on the bundle. npm validates
 * a provenance bundle when it is published and refuses a publish whose
 * bundle does not verify; this module trusts that, and reads the statement
 * the registry serves. What that buys is the case that matters most — a
 * stolen publish token cannot mint a provenance statement from our workflow,
 * so a package published with one arrives without it and is refused. What it
 * does not buy is protection from the registry itself lying, which is
 * `npm audit signatures`' job and is not this one. `docs/security.md`
 * §Updates says the same.
 *
 * Everything unreadable is a failure. A 404, a timeout, a body that is not
 * JSON, an attestation list with no SLSA entry — each is "not verified", and
 * not verified means the update is rolled back. An updater that installs
 * what it could not check is an updater with no check.
 */

/** Where npm serves both the version document and its attestations. */
export const NPM_REGISTRY = "https://registry.npmjs.org";

/** The repository whose release workflow is the only acceptable builder. */
const RELEASE_REPOSITORY = "https://github.com/oftomorrowinc/byollm";

const SLSA_V1 = "https://slsa.dev/provenance/v1";

export type Provenance =
  | { readonly verified: true }
  | { readonly verified: false; readonly why: string };

type Fetch = (url: string) => Promise<Response>;

/**
 * Check `byollm@<version>` against its published provenance.
 *
 * `fetch` is injected so every failure path can be run without a network;
 * the default is the global one.
 */
export async function verifyProvenance(
  version: string,
  options: { readonly fetch?: Fetch; readonly registry?: string } = {},
): Promise<Provenance> {
  const get = options.fetch ?? ((url: string) => fetch(url));
  const registry = options.registry ?? NPM_REGISTRY;
  const no = (why: string): Provenance => ({ verified: false, why });

  const integrity = await readJson(get, `${registry}/byollm/${version}`);
  if (!integrity.ok)
    return no(`could not read the registry entry: ${integrity.why}`);
  const expected = sha512Hex(
    (integrity.body as { dist?: { integrity?: unknown } } | null)?.dist
      ?.integrity,
  );
  if (expected === undefined) {
    return no("the registry entry has no sha512 integrity to check against");
  }

  const listed = await readJson(
    get,
    `${registry}/-/npm/v1/attestations/byollm@${version}`,
  );
  if (!listed.ok) return no(`could not read the attestations: ${listed.why}`);
  const attestations = (listed.body as { attestations?: unknown } | null)
    ?.attestations;
  if (!Array.isArray(attestations))
    return no("the registry lists no attestations");

  const slsa = attestations.filter(
    (entry: unknown) =>
      (entry as { predicateType?: unknown } | null)?.predicateType === SLSA_V1,
  );
  if (slsa.length === 0) return no("there is no SLSA provenance for it");

  /* Every SLSA statement has to pass, not any one of them. There is one per
     publish; if there were two and one named somebody else's workflow, the
     honest reading is that we do not know who built it. */
  for (const entry of slsa) {
    const statement = decodeStatement(entry);
    if (statement === undefined) return no("its provenance could not be read");
    const why = checkStatement(statement, version, expected);
    if (why !== undefined) return no(why);
  }
  return { verified: true };
}

interface Statement {
  readonly subject?: readonly {
    readonly name?: unknown;
    readonly digest?: { readonly sha512?: unknown };
  }[];
  readonly predicate?: {
    readonly buildDefinition?: {
      readonly externalParameters?: {
        readonly workflow?: {
          readonly repository?: unknown;
          readonly ref?: unknown;
        };
      };
    };
  };
}

function checkStatement(
  statement: Statement,
  version: string,
  expected: string,
): string | undefined {
  const workflow =
    statement.predicate?.buildDefinition?.externalParameters?.workflow;
  if (workflow?.repository !== RELEASE_REPOSITORY) {
    return `it was built by ${named(workflow?.repository)}, not ${RELEASE_REPOSITORY}`;
  }
  if (workflow.ref !== `refs/tags/v${version}`) {
    return `it was built from ${named(workflow.ref)}, not refs/tags/v${version}`;
  }
  /* `isArray` narrows to `any[]`, so the element type is restated. */
  const subjects: NonNullable<Statement["subject"]> = Array.isArray(
    statement.subject,
  )
    ? (statement.subject as NonNullable<Statement["subject"]>)
    : [];
  const ours = subjects.find((s) => s.name === `pkg:npm/byollm@${version}`);
  if (ours === undefined)
    return `its provenance does not name byollm@${version}`;
  if (ours.digest?.sha512 !== expected) {
    return "its provenance names a different tarball than the one npm installed";
  }
  return undefined;
}

async function readJson(
  get: Fetch,
  url: string,
): Promise<{ ok: true; body: unknown } | { ok: false; why: string }> {
  try {
    const response = await get(url);
    if (!response.ok)
      return { ok: false, why: `HTTP ${String(response.status)}` };
    return { ok: true, body: await response.json() };
  } catch (error) {
    return {
      ok: false,
      why: error instanceof Error ? error.message : "unknown error",
    };
  }
}

function decodeStatement(entry: unknown): Statement | undefined {
  const payload = (
    entry as { bundle?: { dsseEnvelope?: { payload?: unknown } } } | null
  )?.bundle?.dsseEnvelope?.payload;
  if (typeof payload !== "string") return undefined;
  try {
    const parsed = JSON.parse(
      Buffer.from(payload, "base64").toString("utf8"),
    ) as unknown;
    return typeof parsed === "object" && parsed !== null ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/**
 * `sha512-<base64>` as the lowercase hex an in-toto subject carries.
 *
 * The two encodings of one hash are the whole comparison, so a wrong
 * conversion here is a check that refuses every release — or, written
 * carelessly, one that accepts any. The test runs it against a real
 * registry answer for that reason.
 */
export function sha512Hex(integrity: unknown): string | undefined {
  if (typeof integrity !== "string") return undefined;
  const match = /^sha512-([A-Za-z0-9+/]+={0,2})$/.exec(integrity.trim());
  if (match?.[1] === undefined) return undefined;
  const bytes = Buffer.from(match[1], "base64");
  return bytes.length === 64 ? bytes.toString("hex") : undefined;
}

function named(value: unknown): string {
  return typeof value === "string" ? value : "an unnamed workflow";
}

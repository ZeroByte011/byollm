import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { NPM_REGISTRY, sha512Hex, verifyProvenance } from "./provenance.js";

/**
 * The provenance check behind the updater — B360.
 *
 * The fixture is the registry's real answer for byollm@0.1.1, trimmed of
 * signatures and nothing else. A statement built here with our own encoder
 * would prove only that the decoder agrees with itself; this one was encoded
 * by npm, so passing it means the check reads what the registry actually
 * serves. Every refusal below is that same answer with one thing changed.
 */
interface Fixture {
  integrity: string;
  attestations: {
    predicateType: string;
    bundle: { dsseEnvelope: { payload: string; payloadType: string } };
  }[];
}

const REAL = JSON.parse(
  readFileSync(
    new URL("../test/provenance/byollm-0.1.1.json", import.meta.url),
    "utf8",
  ),
) as Fixture;

interface Statement {
  subject: { name: string; digest: { sha512: string } }[];
  predicate?: {
    buildDefinition: {
      externalParameters: { workflow: { repository: string; ref: string } };
    };
  };
}

/** The real answer, with its SLSA statement edited by `change`. */
function registry(
  over: {
    change?: (statement: Statement) => void;
    integrity?: string;
    attestations?: unknown;
    status?: Record<string, number>;
  } = {},
) {
  const asked: string[] = [];
  const attestations =
    over.attestations ??
    REAL.attestations.map((entry) => {
      if (!entry.predicateType.includes("slsa") || over.change === undefined)
        return entry;
      const statement = JSON.parse(
        Buffer.from(entry.bundle.dsseEnvelope.payload, "base64").toString(),
      ) as Statement;
      over.change(statement);
      return {
        ...entry,
        bundle: {
          dsseEnvelope: {
            ...entry.bundle.dsseEnvelope,
            payload: Buffer.from(JSON.stringify(statement)).toString("base64"),
          },
        },
      };
    });
  const fetch = (url: string) => {
    asked.push(url);
    const status = Object.entries(over.status ?? {}).find(([part]) =>
      url.includes(part),
    )?.[1];
    if (status !== undefined) {
      return Promise.resolve(new Response("", { status }));
    }
    const body = url.includes("/-/npm/v1/attestations/")
      ? { attestations }
      : { dist: { integrity: over.integrity ?? REAL.integrity } };
    return Promise.resolve(Response.json(body));
  };
  return { fetch, asked };
}

describe("a release our workflow built", () => {
  it("verifies byollm@0.1.1 as the registry serves it", async () => {
    const r = registry();
    expect(await verifyProvenance("0.1.1", { fetch: r.fetch })).toEqual({
      verified: true,
    });
    expect(r.asked).toEqual([
      `${NPM_REGISTRY}/byollm/0.1.1`,
      `${NPM_REGISTRY}/-/npm/v1/attestations/byollm@0.1.1`,
    ]);
  });

  it("converts npm's integrity into the statement's hex, both ways round", () => {
    /* The comparison is two encodings of one hash; the real pair pins it. */
    const statement = JSON.parse(
      Buffer.from(
        REAL.attestations.find((a) => a.predicateType.includes("slsa"))?.bundle
          .dsseEnvelope.payload ?? "",
        "base64",
      ).toString(),
    ) as Statement;
    expect(sha512Hex(REAL.integrity)).toBe(statement.subject[0]?.digest.sha512);
    expect(sha512Hex("sha1-2jmj7l5rSw0yVb/vlWAYkK/YBwk=")).toBeUndefined();
    expect(sha512Hex(undefined)).toBeUndefined();
  });
});

describe("what is not verified", () => {
  const cases: [string, Parameters<typeof registry>[0], string][] = [
    [
      "built by a fork",
      {
        change: (s) => {
          if (s.predicate)
            s.predicate.buildDefinition.externalParameters.workflow.repository =
              "https://github.com/someone/byollm";
        },
      },
      "someone/byollm",
    ],
    [
      "built from a branch rather than the release tag",
      {
        change: (s) => {
          if (s.predicate)
            s.predicate.buildDefinition.externalParameters.workflow.ref =
              "refs/heads/main";
        },
      },
      "refs/heads/main",
    ],
    [
      "a statement about a different tarball",
      {
        change: (s) => {
          const first = s.subject[0];
          if (first) first.digest.sha512 = "00".repeat(64);
        },
      },
      "different tarball",
    ],
    [
      "a registry integrity that does not match the statement",
      { integrity: `sha512-${Buffer.alloc(64, 1).toString("base64")}` },
      "different tarball",
    ],
    [
      "a statement naming another package",
      {
        change: (s) => {
          const first = s.subject[0];
          if (first) first.name = "pkg:npm/byollm@0.1.0";
        },
      },
      "does not name byollm@0.1.1",
    ],
    [
      "no SLSA provenance at all — a token publish",
      {
        attestations: REAL.attestations.filter(
          (a) => !a.predicateType.includes("slsa"),
        ),
      },
      "no SLSA provenance",
    ],
    [
      "a statement with no predicate",
      {
        change: (s) => {
          delete s.predicate;
        },
      },
      "an unnamed workflow",
    ],
    [
      "an unreadable payload",
      {
        attestations: [
          {
            predicateType: "https://slsa.dev/provenance/v1",
            bundle: { dsseEnvelope: { payload: "%%%" } },
          },
        ],
      },
      "could not be read",
    ],
    [
      "no attestations endpoint",
      { status: { "/-/npm/v1/attestations/": 404 } },
      "HTTP 404",
    ],
    ["no registry entry", { status: { "/byollm/0.1.1": 404 } }, "HTTP 404"],
    [
      "a registry entry with no sha512",
      { integrity: "sha1-abc=" },
      "no sha512",
    ],
  ];

  for (const [name, over, says] of cases) {
    it(`refuses ${name}`, async () => {
      const outcome = await verifyProvenance("0.1.1", {
        fetch: registry(over).fetch,
      });
      expect(outcome.verified).toBe(false);
      expect(outcome.verified ? "" : outcome.why).toContain(says);
    });
  }

  it("refuses when the network is not there, rather than guessing", async () => {
    const outcome = await verifyProvenance("0.1.1", {
      fetch: () => Promise.reject(new Error("getaddrinfo ENOTFOUND")),
    });
    expect(outcome).toEqual({
      verified: false,
      why: "could not read the registry entry: getaddrinfo ENOTFOUND",
    });
  });
});

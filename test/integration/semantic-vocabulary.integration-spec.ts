import {
  GROUPING_MEMBERS,
  MEASURE_MEMBERS,
  READ_BY_MEMBER,
  WATERMARK_MEMBER,
} from '../../src/adapters/semantic/member-mapping';
import { SignedSecurityContext } from '../../src/adapters/semantic/security-context';
import { loadSemanticConfig } from '../../src/adapters/semantic/semantic-config';
import { tenantId } from '../../src/domain/identifiers';
import { describeVocabulary } from '../../src/domain/semantic/published-vocabulary';
import { GROUPINGS, MEASURES } from '../../src/domain/semantic/vocabulary';

const config = loadSemanticConfig(process.env);
const ANYONE = tenantId('11111111-1111-4111-8111-111111111111');

jest.setTimeout(30_000);

interface CubeMeta {
  readonly cubes: readonly {
    readonly name: string;
    readonly measures: readonly {
      readonly name: string;
      /** Set by the model for a rolling-window measure. */
      readonly cumulative?: unknown;
    }[];
    readonly dimensions: readonly { readonly name: string }[];
  }[];
}

/**
 * Members the model defines and the platform deliberately does not offer.
 *
 * Each is a decision rather than an oversight, so each is written down. Without
 * this list the reverse check could only assert something vacuous; with it,
 * adding a member to the model fails this suite until somebody says which kind
 * it is — offered, or deliberately not.
 */
const DELIBERATELY_UNOFFERED: readonly string[] = [
  // The partition, present so the rewrite has something to filter on. Offering
  // it as a grouping would let a caller ask to be shown the tenant column,
  // which is one value they already know and nothing they can use.
  'products.tenant_id',
  'locations.tenant_id',
  // Named in the exported rows for a later feature, and not yet a grouping the
  // platform publishes.
  'products.category',
  'locations.category',
];

/**
 * The platform's names and the model's, driven against each other.
 *
 * Two names for the same thing is the cost of not letting the dashboard's
 * contract *be* the model's internal naming. This is what keeps that cost from
 * becoming a bug: a cube renamed in the model fails here, in a suite whose
 * whole job is to notice, rather than in a chart months later.
 *
 * The drift is a finding in **both** directions. A name nothing answers is
 * obvious the first time somebody asks for it; a member nobody can name is
 * invisible, and is how a measure someone wrote quietly ceases to exist.
 */
describe('the platform vocabulary and the model members', () => {
  let meta: CubeMeta;

  beforeAll(async () => {
    const context = await new SignedSecurityContext(config).for(
      ANYONE,
      new Date(),
    );

    const response = await fetch(`${config.url}/cubejs-api/v1/meta`, {
      headers: { Authorization: context },
    });

    if (!response.ok) {
      throw new Error(
        `the model did not describe itself: ${response.status} ${await response.text()}`,
      );
    }

    meta = (await response.json()) as CubeMeta;
  });

  const definedMeasures = () =>
    meta.cubes.flatMap((cube) => cube.measures.map((measure) => measure.name));

  const definedDimensions = () =>
    meta.cubes.flatMap((cube) =>
      cube.dimensions.map((dimension) => dimension.name),
    );

  it('describes a model at all, so an empty answer cannot pass for agreement', () => {
    // Without this, a model that failed to compile would give empty lists and
    // every "is a subset of" assertion below would hold vacuously.
    expect(meta.cubes.length).toBeGreaterThan(0);
    expect(definedMeasures().length).toBeGreaterThan(0);
    expect(definedDimensions().length).toBeGreaterThan(0);
  });

  it('answers every measure the platform offers', () => {
    const defined = definedMeasures();

    for (const measure of MEASURES) {
      expect(defined).toContain(MEASURE_MEMBERS[measure]);
    }
  });

  it('answers every grouping the platform offers, in each of its columns', () => {
    const defined = definedDimensions();

    for (const grouping of GROUPINGS) {
      const mapped = GROUPING_MEMBERS[grouping];

      if (mapped.timeDimension !== undefined) {
        expect(defined).toContain(mapped.timeDimension);
        continue;
      }

      for (const column of mapped.columns) {
        expect(defined).toContain(column.member);
      }
    }
  });

  it('answers the members the adapter names that no caller can', () => {
    expect(definedMeasures()).toContain(WATERMARK_MEMBER);

    for (const member of Object.values(READ_BY_MEMBER)) {
      expect(definedDimensions()).toContain(member);
    }
  });

  /**
   * What the platform tells a caller about a measure is what the model does.
   *
   * The vocabulary says whether a measure counts movements from before the
   * period, and that is a claim about the model's behaviour which the platform
   * does not implement — a rolling window in a YAML file does. This is the one
   * published fact that has two declarations rather than one, so it is the one
   * that is compared against the thing it describes, measure by measure.
   *
   * Compared on `cumulative`, which the model sets for any rolling window: a
   * window of any length reaches back before the period, which is exactly the
   * published claim. `cumulativeTotal` — only the unbounded case — would be a
   * narrower property than the one the vocabulary states.
   */
  it('publishes each measure as cumulative exactly when the model makes it one', () => {
    for (const { name, cumulative } of describeVocabulary().measures) {
      const described = meta.cubes
        .flatMap((cube) => cube.measures)
        .find((measure) => measure.name === MEASURE_MEMBERS[name]);

      // Absent from the metadata is not "not cumulative": the model must say.
      expect(typeof described?.cumulative).toBe('boolean');
      expect({ name, cumulative: described?.cumulative }).toEqual({
        name,
        cumulative,
      });
    }
  });

  /**
   * The other direction, which is the one that goes unnoticed.
   *
   * A member the model defines and nothing maps is a measure nobody can ask
   * for: written, compiled, answered by nothing. It is only a finding if
   * something looks for it.
   */
  it('offers, or deliberately withholds, every member the model defines', () => {
    const mapped = new Set<string>([
      ...Object.values(MEASURE_MEMBERS),
      ...Object.values(READ_BY_MEMBER),
      WATERMARK_MEMBER,
      ...Object.values(GROUPING_MEMBERS).flatMap((grouping) => [
        ...(grouping.timeDimension === undefined
          ? []
          : [grouping.timeDimension]),
        ...grouping.columns.map((column) => column.member),
      ]),
      ...DELIBERATELY_UNOFFERED,
    ]);

    const unreachable = [...definedMeasures(), ...definedDimensions()].filter(
      (member) => !mapped.has(member),
    );

    expect(unreachable).toEqual([]);
  });
});

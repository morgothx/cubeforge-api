import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The controls this platform deliberately does not offer.
 *
 * Requirement 9.5 and 10.3 of `analytics-question-refusals` are claims about
 * **absence**: when data is exported, and when a prepared answer is rebuilt,
 * are outside a caller's control. Absence is the one property no ordinary test
 * notices losing — nothing fails the day a "rebuild now" route appears; the
 * surface simply grows one, and the boundary is gone without the argument for
 * it being revisited.
 *
 * So the source is read. The export *command* is deliberately out of this:
 * `pnpm ops:export` is an operator's tool with no route, which is exactly the
 * arrangement these requirements ask for.
 */

const HTTP = join(__dirname);

function controllerSources(): { file: string; source: string }[] {
  return readdirSync(HTTP)
    .filter((file) => file.endsWith('.controller.ts'))
    .map((file) => ({
      file,
      // Comments stripped: prose about an export reads exactly like one, and
      // this file's own documentation proves writing about it must stay legal.
      source: readFileSync(join(HTTP, file), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/(^|[^:])\/\/.*$/gm, '$1'),
    }));
}

describe('what the platform offers over HTTP', () => {
  it('serves exactly the routes it committed to', () => {
    const declared = controllerSources()
      .flatMap(({ source }) => [
        ...source.matchAll(/@Controller\('([^']*)'\)/g),
      ])
      .map((match) => match[1])
      .sort();

    // Written by hand, and the whole value is that the two have to be
    // reconciled by a person. A route added without a line here fails by name,
    // which is the only moment anybody will think about whether it belongs.
    expect(declared).toEqual([
      'auth',
      'me',
      'platform/people',
      'platform/people/:personId/setup-tokens',
      'tenants',
      'tenants/:tenantId/analytics/movements',
      'tenants/:tenantId/analytics/questions',
      'tenants/:tenantId/analytics/vocabulary',
      'tenants/:tenantId/api-keys',
      'tenants/:tenantId/inventory/locations',
      'tenants/:tenantId/inventory/movements',
      'tenants/:tenantId/inventory/products',
      'tenants/:tenantId/inventory/stock',
      'tenants/:tenantId/members',
    ]);
  });

  it('offers no way to set off an export or a rebuild', () => {
    // Named precisely. A first pass forbade `refresh` as well and flagged the
    // authentication controller, which refreshes a *session* — a false
    // positive, and the kind that gets a scan deleted rather than fixed. What
    // is forbidden is setting off an export of the data or a rebuild of what is
    // prepared, including the engine's own term for the latter.
    const offering = controllerSources()
      .filter(({ source }) =>
        /\b(export|rebuild)[A-Za-z]*\s*\(|['"][^'"]*\/(exports?|rebuilds?)\b|refreshPreAggregations/i.test(
          source.replace(
            /\bexport\s+(?:const|function|type|interface|class|default|async|\{|\*)/g,
            ' ',
          ),
        ),
      )
      .map(({ file }) => file);

    expect(offering).toEqual([]);
  });

  it('reads enough controllers for that to mean anything', () => {
    // A rule over an empty set is not a rule: a renamed suffix would otherwise
    // leave both checks above passing against nothing at all.
    expect(controllerSources().length).toBeGreaterThan(10);
  });
});

import { apiKeyId, personId, tenantId } from '../domain/identifiers';
import type { ActorContext } from './actor-context';
import { tenantActedIn, tenantOf } from './tenant-authorization';

const acme = tenantId('018f2c00-0000-7000-8000-000000000001');
const somebody = personId('018f2c00-0000-7000-8000-000000000002');

const member: ActorContext = {
  kind: 'tenant-member',
  personId: somebody,
  tenantId: acme,
};
const machine: ActorContext = {
  kind: 'machine',
  apiKeyId: apiKeyId('018f2c00-0000-7000-8000-00000000000a'),
  tenantId: acme,
  role: 'editor',
};
const loosePerson: ActorContext = { kind: 'person', personId: somebody };
const operator: ActorContext = {
  kind: 'platform-operator',
  personId: somebody,
};

/**
 * Two questions that look like one.
 *
 * `tenantOf` asks which tenant a person is a member of. `tenantActedIn` asks
 * which tenant a caller acts in, whoever they are. Inventory needed the second
 * and the platform only had the first.
 *
 * Asserted directly, because in a running system both are behind other
 * refusals — the guard, and a membership lookup a machine cannot satisfy — so
 * nothing observable changes if either is widened. A check with another
 * mechanism in front of it is untested by every ordinary test, which is the
 * same shape as a repository predicate behind a row-level security policy.
 */
describe('which tenant a caller is in', () => {
  describe('tenantOf, which knows only members', () => {
    it('answers for a tenant member', () => {
      expect(tenantOf(member)).toBe(acme);
    });

    it('refuses a machine, whose role is a credential and not a membership', () => {
      expect(() => tenantOf(machine)).toThrow();
    });

    it('refuses a person acting in no tenant, and an operator', () => {
      expect(() => tenantOf(loosePerson)).toThrow();
      expect(() => tenantOf(operator)).toThrow();
    });
  });

  describe('tenantActedIn, which admits machines too', () => {
    it('answers for a tenant member and for a machine alike', () => {
      expect(tenantActedIn(member)).toBe(acme);
      expect(tenantActedIn(machine)).toBe(acme);
    });

    it('still refuses a caller who is in no tenant at all', () => {
      expect(() => tenantActedIn(loosePerson)).toThrow();
      expect(() => tenantActedIn(operator)).toThrow();
    });
  });

  it('answers an absence rather than a refusal, for both', () => {
    // A caller must not be able to tell "you may not" from "there is nothing
    // here". Distinguishing them would confirm the tenant exists.
    for (const ask of [tenantOf, tenantActedIn]) {
      expect(() => ask(operator)).toThrow();
      try {
        ask(operator);
      } catch (refusal) {
        expect(refusal).toMatchObject({ error: { kind: 'not-found' } });
      }
    }
  });
});

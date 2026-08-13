import {
  createIdentityTestContext,
  type IdentityTestContext,
} from '../../adapters/testing/identity-test-context';
import { personId as toPersonId } from '../../domain/identifiers';
import { DeactivatePersonUseCase } from './deactivate-person.use-case';

describe('deactivating a person platform-wide', () => {
  let context: IdentityTestContext;
  let deactivate: DeactivatePersonUseCase;

  beforeEach(() => {
    context = createIdentityTestContext();
    deactivate = new DeactivatePersonUseCase(context.platform);
  });

  it('deactivates the person in every tenant at once, retaining memberships', async () => {
    const acme = await context.seedTenant('Acme');
    const globex = await context.seedTenant('Globex');
    const person = await context.seedMember({
      tenantId: acme,
      email: 'shared@example.com',
      role: 'admin',
    });
    await context.seedMember({
      tenantId: globex,
      email: 'shared@example.com',
      role: 'viewer',
    });

    await deactivate.execute({ actor: context.operator, personId: person });

    expect(context.store.people.get(person)?.status).toBe('deactivated');
    expect(context.store.memberships.size).toBe(2);
    expect(
      [...context.store.memberships.values()].every(
        (membership) => membership.status === 'active',
      ),
    ).toBe(true);
  });

  /** Requirement 3.3: not-found would answer whether the person exists. */
  it('reports success for an identifier the platform does not know', async () => {
    await expect(
      deactivate.execute({
        actor: context.operator,
        personId: toPersonId('nobody'),
      }),
    ).resolves.toBeUndefined();
  });

  it('denies the operation to a tenant administrator', async () => {
    const acme = await context.seedTenant('Acme');
    const admin = await context.seedMember({
      tenantId: acme,
      email: 'admin@example.com',
      role: 'admin',
    });
    const member = await context.seedMember({
      tenantId: acme,
      email: 'member@example.com',
      role: 'viewer',
    });

    const attempt = deactivate.execute({
      actor: context.actingAs(acme, admin),
      personId: member,
    });

    await expect(attempt).rejects.toMatchObject({
      error: { kind: 'forbidden' },
    });
    expect(context.store.people.get(member)?.status).toBe('active');
  });
});

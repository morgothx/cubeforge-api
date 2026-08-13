import { DomainViolation } from '../../../domain/errors';
import {
  emailAddress,
  membershipId,
  personId,
  tenantId,
} from '../../../domain/identifiers';
import { createMembership } from '../../../domain/membership/membership.entity';
import { createTenant } from '../../../domain/tenant/tenant.entity';
import { InMemoryCredentialStore } from './in-memory-credential-store';
import { InMemoryIdentityStore } from './in-memory-identity-store';
import { InMemoryPlatformUnitOfWork } from './in-memory-platform-unit-of-work';
import { InMemoryTenantScopedUnitOfWork } from './in-memory-tenant-scoped-unit-of-work';

const CREATED_AT = new Date('2026-01-01T00:00:00.000Z');

describe('in-memory identity adapters', () => {
  let store: InMemoryIdentityStore;
  let tenantScoped: InMemoryTenantScopedUnitOfWork;
  let platform: InMemoryPlatformUnitOfWork;

  const acme = tenantId('acme');
  const globex = tenantId('globex');

  beforeEach(async () => {
    store = new InMemoryIdentityStore();
    tenantScoped = new InMemoryTenantScopedUnitOfWork(store);
    platform = new InMemoryPlatformUnitOfWork(
      store,
      new InMemoryCredentialStore(() => null),
    );

    await platform.runAsOperator(async ({ tenants }) => {
      await tenants.insert(
        createTenant({ id: acme, name: 'Acme', createdAt: CREATED_AT }),
      );
      await tenants.insert(
        createTenant({ id: globex, name: 'Globex', createdAt: CREATED_AT }),
      );
    });
  });

  /** Attaches a person to a tenant the way a use case will, in one step. */
  async function addMember(
    tenant: ReturnType<typeof tenantId>,
    options: {
      email: string;
      role: 'admin' | 'editor' | 'viewer';
      id?: string;
    },
  ): Promise<string> {
    return tenantScoped.runInTenant(tenant, async ({ people, memberships }) => {
      const person = await people.findOrCreateByEmail({
        candidateId: personId(options.id ?? `person-${options.email}`),
        email: emailAddress(options.email),
        createdAt: CREATED_AT,
      });
      await memberships.insert(
        createMembership({
          id: membershipId(`membership-${tenant}-${person}`),
          tenantId: tenant,
          personId: person,
          role: options.role,
          createdAt: CREATED_AT,
        }),
      );
      return person;
    });
  }

  describe('tenant scoping', () => {
    it('shows a tenant only its own memberships', async () => {
      await addMember(acme, { email: 'a@example.com', role: 'admin' });
      await addMember(acme, { email: 'b@example.com', role: 'viewer' });
      await addMember(globex, { email: 'c@example.com', role: 'admin' });

      const seenByAcme = await tenantScoped.runInTenant(
        acme,
        ({ memberships }) => memberships.listMembers({ includeInactive: true }),
      );

      expect(seenByAcme).toHaveLength(2);
      expect(seenByAcme.map((member) => member.email).sort()).toEqual([
        'a@example.com',
        'b@example.com',
      ]);
    });

    it('hides a membership held in another tenant, even by identifier', async () => {
      const person = await addMember(globex, {
        email: 'c@example.com',
        role: 'admin',
      });

      const found = await tenantScoped.runInTenant(acme, ({ memberships }) =>
        memberships.findByPerson(personId(person)),
      );

      expect(found).toBeNull();
    });

    it('hides a person who holds no membership in the tenant in context', async () => {
      const person = await addMember(globex, {
        email: 'c@example.com',
        role: 'admin',
      });

      const found = await tenantScoped.runInTenant(acme, ({ people }) =>
        people.findById(personId(person)),
      );

      expect(found).toBeNull();
    });

    it('resolves the tenant in context and nothing else', async () => {
      const current = await tenantScoped.runInTenant(acme, ({ tenants }) =>
        tenants.findCurrent(),
      );

      expect(current?.name).toBe('Acme');
    });
  });

  describe('platform-wide person resolution', () => {
    it('returns the existing identifier when the address is already known', async () => {
      const existing = await addMember(globex, {
        email: 'shared@example.com',
        role: 'viewer',
        id: 'person-shared',
      });

      const resolved = await tenantScoped.runInTenant(acme, ({ people }) =>
        people.findOrCreateByEmail({
          candidateId: personId('a-different-candidate'),
          email: emailAddress('SHARED@example.com'),
          createdAt: CREATED_AT,
        }),
      );

      expect(resolved).toBe(existing);
    });

    it('lets the same person hold a different role in each tenant', async () => {
      const person = await addMember(acme, {
        email: 'shared@example.com',
        role: 'admin',
        id: 'person-shared',
      });
      await addMember(globex, {
        email: 'shared@example.com',
        role: 'viewer',
        id: 'person-shared',
      });

      const roleIn = async (tenant: ReturnType<typeof tenantId>) =>
        tenantScoped.runInTenant(tenant, async ({ memberships }) => {
          const membership = await memberships.findByPerson(personId(person));
          return membership?.role;
        });

      expect(await roleIn(acme)).toBe('admin');
      expect(await roleIn(globex)).toBe('viewer');
    });
  });

  describe('the constraints the database also enforces', () => {
    it('rejects a duplicate tenant name', async () => {
      const attempt = platform.runAsOperator(({ tenants }) =>
        tenants.insert(
          createTenant({
            id: tenantId('impostor'),
            name: 'Acme',
            createdAt: CREATED_AT,
          }),
        ),
      );

      await expect(attempt).rejects.toThrow(DomainViolation);
      await expect(attempt).rejects.toMatchObject({
        error: { kind: 'tenant-name-taken' },
      });
    });

    it('rejects a second membership for the same person in the same tenant', async () => {
      const person = await addMember(acme, {
        email: 'a@example.com',
        role: 'admin',
      });

      const attempt = tenantScoped.runInTenant(acme, ({ memberships }) =>
        memberships.insert(
          createMembership({
            id: membershipId('another-membership'),
            tenantId: acme,
            personId: personId(person),
            role: 'viewer',
            createdAt: CREATED_AT,
          }),
        ),
      );

      await expect(attempt).rejects.toMatchObject({
        error: { kind: 'already-a-member' },
      });
    });
  });

  describe('transactional behaviour', () => {
    it('discards every write when the work throws', async () => {
      const attempt = tenantScoped.runInTenant(
        acme,
        async ({ people, memberships }) => {
          const person = await people.findOrCreateByEmail({
            candidateId: personId('person-doomed'),
            email: emailAddress('doomed@example.com'),
            createdAt: CREATED_AT,
          });
          await memberships.insert(
            createMembership({
              id: membershipId('doomed-membership'),
              tenantId: acme,
              personId: person,
              role: 'admin',
              createdAt: CREATED_AT,
            }),
          );
          throw new Error('the use case changed its mind');
        },
      );

      await expect(attempt).rejects.toThrow('the use case changed its mind');

      const survivors = await tenantScoped.runInTenant(
        acme,
        ({ memberships }) => memberships.listMembers({ includeInactive: true }),
      );
      expect(survivors).toHaveLength(0);
      expect(store.people.size).toBe(0);
    });
  });

  describe('listings', () => {
    it('excludes revoked memberships unless they are asked for', async () => {
      const kept = await addMember(acme, {
        email: 'kept@example.com',
        role: 'admin',
      });
      const revoked = await addMember(acme, {
        email: 'revoked@example.com',
        role: 'viewer',
      });

      await tenantScoped.runInTenant(acme, async ({ memberships }) => {
        const membership = await memberships.findByPerson(personId(revoked));
        await memberships.updateStatus(membership!.id, 'revoked');
      });

      const active = await tenantScoped.runInTenant(acme, ({ memberships }) =>
        memberships.listMembers({ includeInactive: false }),
      );
      const all = await tenantScoped.runInTenant(acme, ({ memberships }) =>
        memberships.listMembers({ includeInactive: true }),
      );

      expect(active.map((member) => member.membership.personId)).toEqual([
        kept,
      ]);
      expect(all).toHaveLength(2);
    });

    it('counts only active administrators of the tenant in context', async () => {
      await addMember(acme, { email: 'admin-a@example.com', role: 'admin' });
      await addMember(acme, { email: 'viewer-a@example.com', role: 'viewer' });
      await addMember(globex, { email: 'admin-b@example.com', role: 'admin' });

      const count = await tenantScoped.runInTenant(acme, ({ memberships }) =>
        memberships.countActiveAdministrators(),
      );

      expect(count).toBe(1);
    });
  });

  describe('the operator boundary', () => {
    it('offers the operator no route to memberships', async () => {
      await platform.runAsOperator((repositories) => {
        // The absence is the assertion. The full list is checked too, so that
        // growing the operator's reach has to be a deliberate edit here rather
        // than something that slips in with a new feature.
        expect(Object.keys(repositories)).not.toContain('memberships');
        expect(Object.keys(repositories).sort()).toEqual([
          'people',
          'setupTokens',
          'tenants',
        ]);
        return Promise.resolve();
      });
    });

    it('deactivates a person platform-wide, in every tenant at once', async () => {
      const person = await addMember(acme, {
        email: 'shared@example.com',
        role: 'admin',
        id: 'person-shared',
      });
      await addMember(globex, {
        email: 'shared@example.com',
        role: 'viewer',
        id: 'person-shared',
      });

      await platform.runAsOperator(({ people }) =>
        people.deactivate(personId(person)),
      );

      const statusIn = async (tenant: ReturnType<typeof tenantId>) =>
        tenantScoped.runInTenant(tenant, async ({ people }) => {
          const found = await people.findById(personId(person));
          return found?.status;
        });

      expect(await statusIn(acme)).toBe('deactivated');
      expect(await statusIn(globex)).toBe('deactivated');
    });

    it('reports success when deactivating an unknown person, disclosing nothing', async () => {
      const attempt = platform.runAsOperator(({ people }) =>
        people.deactivate(personId('nobody')),
      );

      await expect(attempt).resolves.toBeUndefined();
    });
  });
});

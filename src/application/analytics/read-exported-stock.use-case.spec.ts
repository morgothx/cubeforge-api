import { InMemoryAnalytics } from '../../adapters/analytics/in-memory-analytics';
import type { StockOnHandEntry } from '../../domain/analytics/answer';
import { DomainViolation } from '../../domain/errors';
import {
  apiKeyId,
  personId,
  tenantId,
  type TenantId,
} from '../../domain/identifiers';
import { PERMITTED_ROLES } from '../../domain/membership/role';
import type { ActorContext } from '../actor-context';
import {
  READ_EXPORTED_STOCK_ROLES,
  ReadExportedStockUseCase,
} from './read-exported-stock.use-case';

const ACME = tenantId('11111111-1111-4111-8111-111111111111');
const GLOBEX = tenantId('22222222-2222-4222-8222-222222222222');

const CARRIED_THROUGH = new Date('2026-08-29T03:00:00.000Z');

const ASKER = personId('33333333-3333-4333-8333-333333333333');

const memberOf = (tenant: TenantId): ActorContext => ({
  kind: 'tenant-member',
  personId: ASKER,
  tenantId: tenant,
});

const held = (sku: string, name: string, onHand: number): StockOnHandEntry => ({
  sku,
  name,
  onHand,
});

describe('answering what is on hand from the exported data', () => {
  let analytics: InMemoryAnalytics;
  let ask: ReadExportedStockUseCase;

  beforeEach(() => {
    analytics = new InMemoryAnalytics();
    ask = new ReadExportedStockUseCase(analytics);
  });

  it('answers with every product the tenant holds, each carrying its name', async () => {
    analytics.carried(ACME, CARRIED_THROUGH, {
      stock: [held('ACME-001', 'A widget', 8), held('ACME-002', 'A gadget', 3)],
    });

    const answer = await ask.execute({ actor: memberOf(ACME) });

    expect(answer.state).toBe('answered');
    if (answer.state !== 'answered') return;
    expect(answer.entries).toEqual([
      held('ACME-001', 'A widget', 8),
      held('ACME-002', 'A gadget', 3),
    ]);
  });

  it('says how far the answer reaches rather than how current it looks', async () => {
    analytics.carried(ACME, CARRIED_THROUGH, {
      stock: [held('ACME-001', 'A widget', 8)],
    });

    const answer = await ask.execute({ actor: memberOf(ACME) });

    expect(answer.state === 'answered' && answer.completeThrough).toEqual(
      CARRIED_THROUGH,
    );
  });

  it('reports a tenant that has never been carried, rather than holding nothing', async () => {
    const answer = await ask.execute({ actor: memberOf(ACME) });

    expect(answer.state).toBe('never-exported');
  });

  it('answers each of two tenants from that tenant only', async () => {
    analytics.carried(ACME, CARRIED_THROUGH, {
      stock: [held('ACME-001', 'A widget', 8)],
    });
    analytics.carried(GLOBEX, CARRIED_THROUGH, {
      stock: [held('GBX-001', 'Another widget', 500)],
    });

    const forAcme = await ask.execute({ actor: memberOf(ACME) });
    const forGlobex = await ask.execute({ actor: memberOf(GLOBEX) });

    expect(forAcme.state === 'answered' && forAcme.entries).toEqual([
      held('ACME-001', 'A widget', 8),
    ]);
    expect(forGlobex.state === 'answered' && forGlobex.entries).toEqual([
      held('GBX-001', 'Another widget', 500),
    ]);
  });

  it('refuses a machine caller as it refuses an absent record', async () => {
    analytics.carried(ACME, CARRIED_THROUGH, {
      stock: [held('ACME-001', 'A widget', 8)],
    });

    const asMachine = ask.execute({
      actor: {
        kind: 'machine',
        apiKeyId: apiKeyId('44444444-4444-4444-8444-444444444444'),
        tenantId: ACME,
        role: 'editor',
      },
    });

    await expect(asMachine).rejects.toBeInstanceOf(DomainViolation);
    await expect(asMachine).rejects.toMatchObject({
      error: { kind: 'not-found' },
    });
  });

  it('refuses a caller acting in no tenant', async () => {
    await expect(
      ask.execute({
        actor: {
          kind: 'platform-operator',
          personId: ASKER,
        },
      }),
    ).rejects.toBeInstanceOf(DomainViolation);
  });

  it('admits every tenant role, which is what the guard will read', () => {
    expect([...READ_EXPORTED_STOCK_ROLES].sort()).toEqual(
      [...PERMITTED_ROLES].sort(),
    );
  });
});

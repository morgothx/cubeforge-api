import { day, periodFrom } from '../../domain/analytics/period';
import { tenantId } from '../../domain/identifiers';
import { InMemoryAnalytics } from './in-memory-analytics';

const ACME = tenantId('00000001-0000-4000-8000-000000000001');
const GLOBEX = tenantId('00000001-0000-4000-8000-000000000002');
const MOMENT = new Date('2026-08-28T02:00:00.000Z');
const PERIOD = periodFrom(day('2026-08-01'), day('2026-08-31'));

/**
 * The seam a use-case test runs against.
 *
 * It has to be no looser than the real one, which this feature has already been
 * bitten by four times over. Two properties in particular: a tenant is bound by
 * the seam and refused unless it is well formed, and a tenant nothing has been
 * carried for answers differently from one with nothing to say.
 */
describe('the analytics double', () => {
  let analytics: InMemoryAnalytics;

  beforeEach(() => {
    analytics = new InMemoryAnalytics();
  });

  it('answers only what was arranged for the tenant the seam bound', async () => {
    analytics.carried(ACME, MOMENT, {
      stock: [{ sku: 'ACME-001', name: 'A widget', onHand: 8 }],
    });
    analytics.carried(GLOBEX, MOMENT, {
      stock: [{ sku: 'ACME-001', name: 'Another widget', onHand: 99 }],
    });

    const acme = await analytics.askAs(ACME, (q) => q.stockOnHand());

    expect(acme).toMatchObject({
      state: 'answered',
      entries: [{ sku: 'ACME-001', name: 'A widget', onHand: 8 }],
    });
  });

  it('answers a tenant nothing has been carried for as never exported', async () => {
    const answer = await analytics.askAs(ACME, (q) => q.stockOnHand());

    expect(answer).toEqual({ state: 'never-exported' });
  });

  it('keeps a quiet period apart from a tenant never carried', async () => {
    analytics.carried(ACME, MOMENT, { movements: [] });

    const answer = await analytics.askAs(ACME, (q) => q.movementsByDay(PERIOD));

    expect(answer).toEqual({
      state: 'answered',
      completeThrough: MOMENT,
      entries: [],
    });
  });

  it('answers only within the period it was asked about', async () => {
    analytics.carried(ACME, MOMENT, {
      movements: [
        { day: day('2026-08-15'), kind: 'receipt', quantity: 5 },
        { day: day('2026-09-15'), kind: 'receipt', quantity: 7 },
      ],
    });

    const answer = await analytics.askAs(ACME, (q) => q.movementsByDay(PERIOD));

    // A double that ignored the period would let a use case pass while asking
    // the engine for a tenant's whole history.
    expect(answer.state === 'answered' && answer.entries).toEqual([
      { day: '2026-08-15', kind: 'receipt', quantity: 5 },
    ]);
  });

  it('refuses a tenant identifier the real seam would refuse', async () => {
    await expect(
      analytics.askAs(tenantId('../elsewhere'), (q) => q.stockOnHand()),
    ).rejects.toThrow('tenant identifier');
  });

  it('fails the way the real one fails, with the reason asked for', async () => {
    analytics.fails('store-unreachable');

    await expect(
      analytics.askAs(ACME, (q) => q.stockOnHand()),
    ).rejects.toMatchObject({ reason: 'store-unreachable' });
  });
});

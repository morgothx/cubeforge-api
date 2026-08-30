import { InMemoryAnalytics } from '../../adapters/analytics/in-memory-analytics';
import type { MovementsOnDayEntry } from '../../domain/analytics/answer';
import {
  day,
  LONGEST_PERIOD_DAYS,
  periodFrom,
  type Day,
} from '../../domain/analytics/period';
import { DomainViolation } from '../../domain/errors';
import {
  apiKeyId,
  personId,
  tenantId,
  type TenantId,
} from '../../domain/identifiers';
import { PERMITTED_ROLES } from '../../domain/membership/role';
import type {
  TenantAnalytics,
  TenantScopedAnalytics,
} from '../ports/tenant-scoped-analytics';
import type { ActorContext } from '../actor-context';
import {
  READ_MOVEMENT_HISTORY_ROLES,
  ReadMovementHistoryUseCase,
  type MovementHistoryQuery,
} from './read-movement-history.use-case';

const ACME = tenantId('11111111-1111-4111-8111-111111111111');
const GLOBEX = tenantId('22222222-2222-4222-8222-222222222222');
const ASKER = personId('33333333-3333-4333-8333-333333333333');

const CARRIED_THROUGH = new Date('2026-08-29T03:00:00.000Z');

const memberOf = (tenant: TenantId): ActorContext => ({
  kind: 'tenant-member',
  personId: ASKER,
  tenantId: tenant,
});

const moved = (
  on: string,
  kind: string,
  quantity: number,
): MovementsOnDayEntry => ({ day: day(on), kind, quantity });

/**
 * Counts the questions that reach the seam, delegating everything else.
 *
 * A period the platform will not answer has to be refused *before* the engine
 * is asked, and "the answer came back a rejection" cannot tell that apart from
 * a question that ran and then failed. This is what makes the difference
 * observable.
 */
class CountingAnalytics implements TenantScopedAnalytics {
  asked = 0;

  constructor(private readonly delegate: TenantScopedAnalytics) {}

  askAs<T>(
    tenant: TenantId,
    question: (analytics: TenantAnalytics) => Promise<T>,
  ): Promise<T> {
    this.asked += 1;
    return this.delegate.askAs(tenant, question);
  }
}

/** The day `count` days after `from`, inclusive of both ends. */
function daysAfter(from: Day, count: number): Day {
  const moment = new Date(`${from}T00:00:00.000Z`);
  moment.setUTCDate(moment.getUTCDate() + count);
  return day(moment.toISOString().slice(0, 10));
}

describe('answering what moved, day by day', () => {
  let analytics: InMemoryAnalytics;
  let seam: CountingAnalytics;
  let ask: ReadMovementHistoryUseCase;

  const august = periodFrom(day('2026-08-01'), day('2026-08-31'));

  beforeEach(() => {
    analytics = new InMemoryAnalytics();
    seam = new CountingAnalytics(analytics);
    ask = new ReadMovementHistoryUseCase(seam);
  });

  it('answers with each day of the period that saw activity', async () => {
    analytics.carried(ACME, CARRIED_THROUGH, {
      movements: [
        moved('2026-08-03', 'receipt', 12),
        moved('2026-08-04', 'issue', 4),
        moved('2026-08-09', 'receipt', 7),
      ],
    });

    const answer = await ask.execute({ actor: memberOf(ACME), period: august });

    expect(answer.state).toBe('answered');
    if (answer.state !== 'answered') return;
    expect(answer.entries).toEqual([
      moved('2026-08-03', 'receipt', 12),
      moved('2026-08-04', 'issue', 4),
      moved('2026-08-09', 'receipt', 7),
    ]);
    expect(answer.completeThrough).toEqual(CARRIED_THROUGH);
  });

  it('leaves out what moved outside the period the caller named', async () => {
    analytics.carried(ACME, CARRIED_THROUGH, {
      movements: [
        moved('2026-07-31', 'receipt', 99),
        moved('2026-08-03', 'receipt', 12),
        moved('2026-09-01', 'issue', 99),
      ],
    });

    const answer = await ask.execute({ actor: memberOf(ACME), period: august });

    expect(answer.state === 'answered' && answer.entries).toEqual([
      moved('2026-08-03', 'receipt', 12),
    ]);
  });

  it('answers a quiet period with no entries rather than refusing it', async () => {
    analytics.carried(ACME, CARRIED_THROUGH, {
      movements: [moved('2026-07-31', 'receipt', 99)],
    });

    const answer = await ask.execute({ actor: memberOf(ACME), period: august });

    expect(answer.state).toBe('answered');
    expect(answer.state === 'answered' && answer.entries).toEqual([]);
  });

  it('reports a tenant that has never been carried, rather than a quiet month', async () => {
    const answer = await ask.execute({ actor: memberOf(ACME), period: august });

    expect(answer.state).toBe('never-exported');
  });

  it('answers each of two tenants from that tenant only', async () => {
    analytics.carried(ACME, CARRIED_THROUGH, {
      movements: [moved('2026-08-03', 'receipt', 12)],
    });
    analytics.carried(GLOBEX, CARRIED_THROUGH, {
      movements: [moved('2026-08-03', 'receipt', 500)],
    });

    const forAcme = await ask.execute({
      actor: memberOf(ACME),
      period: august,
    });
    const forGlobex = await ask.execute({
      actor: memberOf(GLOBEX),
      period: august,
    });

    expect(forAcme.state === 'answered' && forAcme.entries).toEqual([
      moved('2026-08-03', 'receipt', 12),
    ]);
    expect(forGlobex.state === 'answered' && forGlobex.entries).toEqual([
      moved('2026-08-03', 'receipt', 500),
    ]);
  });

  it('never reaches the seam with a period longer than the platform answers', () => {
    const from = day('2026-01-01');

    expect(() =>
      periodFrom(from, daysAfter(from, LONGEST_PERIOD_DAYS)),
    ).toThrow(String(LONGEST_PERIOD_DAYS));
    expect(seam.asked).toBe(0);
  });

  it('has no way to be asked without a period at all', () => {
    // @ts-expect-error A question with no period does not type-check, which is
    // how 1.4 is prevented rather than checked for. This line fails the build
    // the day the period becomes optional, which is the assertion.
    const unbounded: MovementHistoryQuery = { actor: memberOf(ACME) };

    expect(unbounded.period).toBeUndefined();
  });

  it('refuses a machine caller as it refuses an absent record', async () => {
    const asMachine = ask.execute({
      actor: {
        kind: 'machine',
        apiKeyId: apiKeyId('44444444-4444-4444-8444-444444444444'),
        tenantId: ACME,
        role: 'editor',
      },
      period: august,
    });

    await expect(asMachine).rejects.toBeInstanceOf(DomainViolation);
    await expect(asMachine).rejects.toMatchObject({
      error: { kind: 'not-found' },
    });
    expect(seam.asked).toBe(0);
  });

  it('admits every tenant role, which is what the guard will read', () => {
    expect([...READ_MOVEMENT_HISTORY_ROLES].sort()).toEqual(
      [...PERMITTED_ROLES].sort(),
    );
  });
});

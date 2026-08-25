import { externalMovementId, locationCode, sku } from './identifiers';
import { judgeMovement, type SubmittedMovement } from './movement';

const now = new Date('2026-08-25T12:00:00.000Z');

function movement(
  overrides: Partial<SubmittedMovement> = {},
): SubmittedMovement {
  return {
    externalId: externalMovementId('ERP-88412'),
    sku: sku('ACME-001'),
    location: locationCode('WH-1'),
    kind: 'receipt',
    quantity: 5,
    occurredAt: new Date('2026-08-25T10:00:00.000Z'),
    ...overrides,
  };
}

/**
 * Everything a movement can be wrong about on its own — before any question is
 * asked of the database.
 *
 * Deciding these first is what makes an entirely malformed batch cost one round
 * trip and no writes, and it is why these rules live in a pure function rather
 * than inside the use case that calls it.
 */
describe('judging a movement', () => {
  it('admits one that breaks nothing', () => {
    expect(judgeMovement(movement(), now)).toEqual({ admissible: true });
  });

  describe('the kind', () => {
    it('admits the three that exist', () => {
      for (const kind of ['receipt', 'sale', 'adjustment'] as const) {
        const quantity = kind === 'sale' ? -3 : 3;
        expect(judgeMovement(movement({ kind, quantity }), now)).toEqual({
          admissible: true,
        });
      }
    });

    it('refuses a transfer', () => {
      // The kind somebody will reach for, and the one deliberately absent. Stock
      // moving between two places is two movements — one leaving, one arriving
      // — because a single row naming two places is a different table.
      expect(
        judgeMovement(
          movement({ kind: 'transfer' as SubmittedMovement['kind'] }),
          now,
        ),
      ).toEqual({ admissible: false, reason: 'unknown-kind' });
    });
  });

  describe('the quantity', () => {
    it('requires an arrival to add and a sale to remove', () => {
      // The rule that catches an integration which inverted its sign
      // convention. Without it that mistake is invisible until a total runs
      // backwards, months later, in a chart nobody suspects.
      expect(
        judgeMovement(movement({ kind: 'receipt', quantity: -5 }), now),
      ).toEqual({ admissible: false, reason: 'quantity-sign-mismatch' });
      expect(
        judgeMovement(movement({ kind: 'sale', quantity: 5 }), now),
      ).toEqual({
        admissible: false,
        reason: 'quantity-sign-mismatch',
      });
    });

    it('lets an adjustment go either way', () => {
      // An adjustment is a stocktake correcting a drift that could have gone in
      // either direction, so it is the one kind with no sign to impose.
      for (const quantity of [7, -7]) {
        expect(
          judgeMovement(movement({ kind: 'adjustment', quantity }), now),
        ).toEqual({ admissible: true });
      }
    });

    it('refuses a movement of nothing', () => {
      expect(judgeMovement(movement({ quantity: 0 }), now)).toEqual({
        admissible: false,
        reason: 'quantity-zero',
      });
    });

    it('refuses a fraction', () => {
      // Units of measure are out of scope: a quantity is a whole number of
      // whatever the product is counted in. Accepting 2.5 would mean the
      // platform had an opinion about what half of something is.
      expect(judgeMovement(movement({ quantity: 2.5 }), now)).toEqual({
        admissible: false,
        reason: 'quantity-not-whole',
      });
    });

    it('refuses a number that is not one', () => {
      for (const quantity of [Number.NaN, Number.POSITIVE_INFINITY]) {
        expect(judgeMovement(movement({ quantity }), now)).toEqual({
          admissible: false,
          reason: 'quantity-not-whole',
        });
      }
    });

    it('refuses a quantity beyond what the column holds', () => {
      // A signed 32-bit column. Refused here rather than left to the database,
      // because in a batch this has to be one row's rejection and not the
      // request's failure.
      expect(judgeMovement(movement({ quantity: 2_147_483_648 }), now)).toEqual(
        {
          admissible: false,
          reason: 'quantity-out-of-range',
        },
      );
      expect(judgeMovement(movement({ quantity: 2_147_483_647 }), now)).toEqual(
        {
          admissible: true,
        },
      );
    });
  });

  describe('when it happened', () => {
    it('accepts yesterday, because a nightly synchronisation reports it', () => {
      expect(
        judgeMovement(
          movement({ occurredAt: new Date('2020-01-01T00:00:00.000Z') }),
          now,
        ),
      ).toEqual({ admissible: true });
    });

    it('accepts this instant', () => {
      expect(judgeMovement(movement({ occurredAt: now }), now)).toEqual({
        admissible: true,
      });
    });

    it('refuses a movement that has not happened yet', () => {
      expect(
        judgeMovement(
          movement({ occurredAt: new Date(now.getTime() + 1) }),
          now,
        ),
      ).toEqual({ admissible: false, reason: 'occurred-in-future' });
    });

    it('refuses a moment that is not one', () => {
      expect(
        judgeMovement(movement({ occurredAt: new Date('nonsense') }), now),
      ).toEqual({ admissible: false, reason: 'occurred-not-a-moment' });
    });
  });

  it('reports the first thing wrong, and only that', () => {
    // One reason per row. A caller fixing a movement fixes one thing and
    // resubmits; a list of everything wrong with it would be a different
    // contract, and the report has five hundred of these in it.
    expect(judgeMovement(movement({ kind: 'sale', quantity: 0 }), now)).toEqual(
      { admissible: false, reason: 'quantity-zero' },
    );
  });
});

// `@Type` in the movements DTO calls `Reflect.getMetadata` while its module is
// evaluated, and this spec imports that module directly rather than through Nest.
import 'reflect-metadata';
import { LONGEST_BATCH } from './dto/inventory-movements.dto';
import { loadInventoryThrottlingConfig } from './inventory-throttling';

/**
 * The allowance as a size, not as a mechanism.
 *
 * That a refused caller is told to wait is asserted against the running
 * application. What no test held until now is requirement 8.5 — the allowance
 * has to be *large enough* — and it is the product of two constants that live
 * in different files. Halving the batch cap is a reasonable-looking edit that
 * would quietly put a nightly synchronisation outside its allowance with every
 * other test still green.
 */
describe('the inventory allowance, as a size', () => {
  const config = loadInventoryThrottlingConfig({});

  it('admits a nightly synchronisation of thirty thousand movements', () => {
    expect(config.requestsPerCredential * LONGEST_BATCH).toBeGreaterThanOrEqual(
      30_000,
    );
  });

  it('measures its allowance over a minute, which is what the requirement says', () => {
    // Without this the product above could be met by widening the window
    // instead, which would satisfy the arithmetic and not the requirement.
    expect(config.windowSeconds).toBe(60);
  });
});

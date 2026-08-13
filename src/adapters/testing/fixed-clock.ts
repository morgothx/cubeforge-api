import type { Clock } from '../../application/ports/clock';

/**
 * A clock that does not move, so a creation timestamp can be asserted rather
 * than merely observed to exist.
 */
export class FixedClock implements Clock {
  constructor(private current: Date) {}

  now(): Date {
    return this.current;
  }

  advanceTo(moment: Date): void {
    this.current = moment;
  }
}

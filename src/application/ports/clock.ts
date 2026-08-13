export const CLOCK = Symbol('CLOCK');

/**
 * The only source of the current time in the application layer. Reading the
 * clock directly would make creation timestamps untestable, and requirement 1.4
 * asks for them to be recorded, which means asserted.
 */
export interface Clock {
  now(): Date;
}

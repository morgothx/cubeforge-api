import { IsString, Matches } from 'class-validator';

/** `YYYY-MM-DD`, the same shape the export partitions by. */
const DAY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * The period a caller may name.
 *
 * Both ends are required and there is no default. A missing bound is a refusal
 * (1.4), and supplying one here — "the last thirty days", say — would answer a
 * question the caller did not ask and hide the fact that they forgot to.
 *
 * The edge checks **shape**; the domain checks the calendar and the span.
 * `2026-02-30` matches this pattern and is no date, and how long a period may
 * be is a platform rule rather than a syntax rule — both belong where the rest
 * of the period rules are, and both surface as a 400 either way.
 */
export class MovementHistoryRequest {
  @IsString()
  @Matches(DAY, { message: 'from must be written YYYY-MM-DD' })
  from!: string;

  @IsString()
  @Matches(DAY, { message: 'to must be written YYYY-MM-DD' })
  to!: string;
}

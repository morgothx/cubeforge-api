import {
  ArrayNotEmpty,
  IsArray,
  IsIn,
  IsOptional,
  IsString,
  Matches,
} from 'class-validator';
import { READ_BY, type ReadBy } from '../../../domain/semantic/vocabulary';

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

/**
 * A composed question, as a body.
 *
 * **There is no tenant field**, and there is nowhere for one to go: the global
 * pipe refuses a property nothing declares, so a body naming a tenant is a
 * refusal rather than a value quietly ignored. The tenant comes from the path
 * and from the standing the platform resolved for the caller.
 *
 * The edge checks **shape** and the domain checks meaning, the same division
 * the period already follows. Whether `revenue` is a measure this model offers
 * is not a syntax question, and answering it here would put the vocabulary in
 * two places.
 */
export class ModelledQuestionRequest {
  /**
   * At least one, refused here as well as in the domain.
   *
   * The domain's refusal is the one that matters and stays; this one exists
   * because `measures: []` is a shape a caller can send by accident when a
   * dashboard builds the body from an empty selection, and saying so at the
   * edge names the field.
   */
  @IsArray()
  @ArrayNotEmpty({ message: 'measures must name at least one measure' })
  @IsString({ each: true })
  measures!: string[];

  /** Optional: a question with no grouping is one total, which is a question. */
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  groupings?: string[];

  @IsString()
  @Matches(DAY, { message: 'from must be written YYYY-MM-DD' })
  from!: string;

  @IsString()
  @Matches(DAY, { message: 'to must be written YYYY-MM-DD' })
  to!: string;

  /**
   * Which of the two dates decides, defaulting to the day this platform stored
   * the movement. Recorded only moves forward; occurred can be backdated, so a
   * caller wanting that has to say so.
   *
   * Validated against the declared moments rather than a list of its own, so
   * the body accepts exactly what the vocabulary publishes.
   */
  @IsOptional()
  @IsIn(READ_BY, {
    message: `by must be either ${READ_BY.join(' or ')}`,
  })
  by?: ReadBy;
}

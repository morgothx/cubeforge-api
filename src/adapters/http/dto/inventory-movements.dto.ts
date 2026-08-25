import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsInt,
  IsISO8601,
  IsString,
  MaxLength,
  ValidateNested,
} from 'class-validator';

/**
 * The most movements one submission may carry.
 *
 * A nightly synchronisation sends thousands of rows, and one request per row is
 * not a real integration. Five hundred is large enough that the allowance in
 * `InventoryThrottlingConfig` covers a night's work comfortably, and small
 * enough that a single request stays a thing a caller can retry.
 */
export const LONGEST_BATCH = 500;

/**
 * The edge validates *shape*; the use case judges *meaning*.
 *
 * There is deliberately no `@IsIn` on `kind`, no sign rule on `quantity` and no
 * check that `occurredAt` is in the past. Every one of those is a per-row
 * rejection with a named reason, and enforcing them here would turn one bad row
 * into the whole request's failure — which is the one thing this feature exists
 * not to do.
 *
 * What is enforced here is what cannot be a row's problem: a field of the wrong
 * *type* means the payload was not what it claimed to be.
 */
export class MovementRow {
  @IsString()
  @MaxLength(64)
  externalId!: string;

  @IsString()
  @MaxLength(64)
  sku!: string;

  @IsString()
  @MaxLength(64)
  location!: string;

  @IsString()
  @MaxLength(32)
  kind!: string;

  @IsInt({ message: 'quantity must be a whole number' })
  quantity!: number;

  @IsISO8601({}, { message: 'occurredAt must be an ISO 8601 moment' })
  occurredAt!: string;
}

/**
 * A batch too large is refused **whole**, through ordinary payload validation,
 * rather than reported as five hundred and one rejections. A caller must not be
 * able to mistake a size refusal for a data problem: the first is fixed by
 * sending fewer rows, the second by fixing rows.
 */
export class RecordMovementsBatchRequest {
  @IsArray()
  @ArrayMinSize(1, { message: 'movements must not be empty' })
  @ArrayMaxSize(LONGEST_BATCH, {
    message: `movements must not exceed ${LONGEST_BATCH} entries`,
  })
  @ValidateNested({ each: true })
  @Type(() => MovementRow)
  movements!: MovementRow[];
}

export interface MovementOutcomeResponse {
  readonly status: 'recorded' | 'already-recorded' | 'rejected';
  readonly externalId: string | null;
  readonly reason?: string;
}

export interface RecordMovementsResponse {
  readonly recorded: number;
  readonly alreadyRecorded: number;
  readonly rejected: number;
  readonly outcomes: readonly MovementOutcomeResponse[];
}

import { Inject, Injectable } from '@nestjs/common';
import type { ExternalMovementId } from '../../domain/inventory/identifiers';
import {
  parseExternalMovementId,
  parseLocationCode,
  parseSku,
} from '../../domain/inventory/identifiers';
import type {
  MovementKind,
  SubmittedMovement,
} from '../../domain/inventory/movement';
import { judgeMovement } from '../../domain/inventory/movement';
import type { RejectionReason } from '../../domain/inventory/rejection-reason';
import type { ActorContext } from '../actor-context';
import type { LocationRepository } from '../ports/location.repository';
import type { ProductRepository } from '../ports/product.repository';
import { CLOCK, type Clock } from '../ports/clock';
import {
  TENANT_SCOPED_UNIT_OF_WORK,
  type TenantScopedUnitOfWork,
} from '../ports/tenant-scoped-unit-of-work';
import { tenantActedIn } from '../tenant-authorization';

/**
 * One movement as it arrives: strings, because it came from outside.
 *
 * The use case parses rather than receiving parsed values, and that is the
 * whole reason it can report per row. A malformed code inside a batch of five
 * hundred is one row's problem; a constructor throwing at the edge would make
 * it the request's.
 */
export interface SubmittedRow {
  readonly externalId: string;
  readonly sku: string;
  readonly location: string;
  readonly kind: string;
  readonly quantity: number;
  readonly occurredAt: string;
}

export type MovementOutcome =
  | { readonly status: 'recorded'; readonly externalId: ExternalMovementId }
  | {
      readonly status: 'already-recorded';
      readonly externalId: ExternalMovementId;
    }
  | {
      readonly status: 'rejected';
      /** Null when the identifier itself was the thing that was wrong. */
      readonly externalId: ExternalMovementId | null;
      readonly reason: RejectionReason;
    };

export interface RecordMovementsReport {
  readonly recorded: number;
  readonly alreadyRecorded: number;
  readonly rejected: number;
  /** One entry per submitted row, in submission order. */
  readonly outcomes: readonly MovementOutcome[];
}

export interface RecordMovementsCommand {
  readonly actor: ActorContext;
  readonly movements: readonly SubmittedRow[];
}

/** A row that survived local judgement, with its position remembered. */
interface Candidate {
  readonly at: number;
  readonly movement: SubmittedMovement;
}

@Injectable()
export class RecordMovementsUseCase {
  constructor(
    @Inject(TENANT_SCOPED_UNIT_OF_WORK)
    private readonly tenants: TenantScopedUnitOfWork,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async execute(
    command: RecordMovementsCommand,
  ): Promise<RecordMovementsReport> {
    const tenantId = tenantActedIn(command.actor);
    const outcomes: (MovementOutcome | undefined)[] = command.movements.map(
      () => undefined,
    );

    // Everything decidable without the database, first. A batch that is
    // entirely malformed then costs one round trip and no writes.
    const candidates = this.judgeLocally(command.movements, outcomes);

    return this.tenants.runInTenant(
      tenantId,
      async ({ products, locations, movements }) => {
        const survivors = await this.dropUnknownReferences(
          candidates,
          outcomes,
          { products, locations },
        );

        const recorded = await movements.record(
          survivors.map((candidate) => candidate.movement),
        );

        for (const { at, movement } of survivors) {
          // Absent from what came back means the identifier was already recorded.
          // That is a successful retry, not a failure, and it is reported
          // distinctly so a caller can tell one from a first submission.
          outcomes[at] = recorded.has(movement.externalId)
            ? { status: 'recorded', externalId: movement.externalId }
            : { status: 'already-recorded', externalId: movement.externalId };
        }

        return summarise(outcomes);
      },
    );
  }

  /** Parsing, the standalone invariants, and duplicates within this batch. */
  private judgeLocally(
    rows: readonly SubmittedRow[],
    outcomes: (MovementOutcome | undefined)[],
  ): Candidate[] {
    const now = this.clock.now();
    const seen = new Set<string>();
    const candidates: Candidate[] = [];

    rows.forEach((row, at) => {
      const externalId = parseExternalMovementId(row.externalId);
      const sku = parseSku(row.sku);
      const location = parseLocationCode(row.location);

      if (externalId.malformed || sku.malformed || location.malformed) {
        outcomes[at] = {
          status: 'rejected',
          externalId: externalId.malformed ? null : externalId.value,
          reason: 'malformed-identifier',
        };
        return;
      }

      if (seen.has(externalId.value)) {
        // A caller that batched one document twice has a bug in how it
        // batches. A caller retrying a request does not, and the two must not
        // look alike.
        outcomes[at] = {
          status: 'rejected',
          externalId: externalId.value,
          reason: 'duplicate-within-batch',
        };
        return;
      }
      seen.add(externalId.value);

      const movement: SubmittedMovement = {
        externalId: externalId.value,
        sku: sku.value,
        location: location.value,
        kind: row.kind as MovementKind,
        quantity: row.quantity,
        occurredAt: new Date(row.occurredAt),
      };

      const judgement = judgeMovement(movement, now);
      if (!judgement.admissible) {
        outcomes[at] = {
          status: 'rejected',
          externalId: externalId.value,
          reason: judgement.reason,
        };
        return;
      }

      candidates.push({ at, movement });
    });

    return candidates;
  }

  /** One question per reference set, never one per row. */
  private async dropUnknownReferences(
    candidates: readonly Candidate[],
    outcomes: (MovementOutcome | undefined)[],
    repositories: {
      products: ProductRepository;
      locations: LocationRepository;
    },
  ): Promise<Candidate[]> {
    const skus = [...new Set(candidates.map((c) => c.movement.sku))];
    const places = [...new Set(candidates.map((c) => c.movement.location))];

    const [knownSkus, knownPlaces] = await Promise.all([
      repositories.products.declared(skus),
      repositories.locations.declared(places),
    ]);

    return candidates.filter(({ at, movement }) => {
      const reason: RejectionReason | null = !knownSkus.has(movement.sku)
        ? 'unknown-sku'
        : !knownPlaces.has(movement.location)
          ? 'unknown-location'
          : null;

      if (reason === null) {
        return true;
      }

      outcomes[at] = {
        status: 'rejected',
        externalId: movement.externalId,
        reason,
      };
      return false;
    });
  }
}

function summarise(
  outcomes: readonly (MovementOutcome | undefined)[],
): RecordMovementsReport {
  const settled = outcomes.filter(
    (outcome): outcome is MovementOutcome => outcome !== undefined,
  );

  if (settled.length !== outcomes.length) {
    // The report is positional, so a row without an outcome would shift every
    // later row's meaning by one. Failing loudly beats handing a caller a
    // report that quietly describes the wrong movements.
    throw new Error(
      `every submitted movement must have an outcome; ${
        outcomes.length - settled.length
      } of ${outcomes.length} had none`,
    );
  }

  return {
    recorded: settled.filter((o) => o.status === 'recorded').length,
    alreadyRecorded: settled.filter((o) => o.status === 'already-recorded')
      .length,
    rejected: settled.filter((o) => o.status === 'rejected').length,
    outcomes: settled,
  };
}

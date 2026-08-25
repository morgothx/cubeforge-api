import type {
  Declaration,
  ReferenceEntity,
  ReferenceRepository,
} from '../../../application/ports/reference.repository';
import type {
  MovementRepository,
  StockLevel,
} from '../../../application/ports/movement.repository';
import type { TenantId } from '../../../domain/identifiers';
import type { ExternalMovementId } from '../../../domain/inventory/identifiers';
import type { SubmittedMovement } from '../../../domain/inventory/movement';

/**
 * Both reference entities carry a name, which is the one attribute the shared
 * listing shape needs. Constraining on it here is why the store can hold either
 * without knowing which it holds.
 */
interface Held<Attributes extends { readonly name: string }> {
  readonly attributes: Attributes;
  readonly createdAt: Date;
  updatedAt: Date;
}

/**
 * The test double's storage for the inventory tables.
 *
 * Keyed by tenant *and* code, never by code alone, so a test that forgets to
 * scope a read fails here the same way it would fail against the database. A
 * double that is more permissive than the thing it stands for is a double that
 * lets exactly the bug it exists to catch through.
 */
export class InMemoryInventoryStore {
  readonly products = new Map<
    string,
    Held<{ readonly name: string; readonly category: string | null }>
  >();
  readonly locations = new Map<string, Held<{ readonly name: string }>>();
  /** Keyed by tenant and the source system's identifier, as the table is. */
  readonly movements = new Map<
    string,
    SubmittedMovement & { tenant: TenantId }
  >();

  snapshot(): string {
    return JSON.stringify([
      [...this.products],
      [...this.locations],
      [...this.movements],
    ]);
  }

  restore(snapshot: string): void {
    const [products, locations, movements] = JSON.parse(snapshot) as [
      [string, Held<{ name: string; category: string | null }>][],
      [string, Held<{ name: string }>][],
      [string, SubmittedMovement & { tenant: TenantId }][],
    ];
    this.products.clear();
    this.locations.clear();
    this.movements.clear();
    for (const [key, movement] of movements) {
      this.movements.set(key, {
        ...movement,
        occurredAt: new Date(movement.occurredAt),
      });
    }
    for (const [key, held] of products) {
      this.products.set(key, revive(held));
    }
    for (const [key, held] of locations) {
      this.locations.set(key, revive(held));
    }
  }
}

function revive<A extends { readonly name: string }>(held: Held<A>): Held<A> {
  return {
    ...held,
    createdAt: new Date(held.createdAt),
    updatedAt: new Date(held.updatedAt),
  };
}

/**
 * One implementation for both reference entities, because in the double they
 * really are the same code — the distinction the real adapters carry is which
 * table and which column, and there is neither here.
 */
export class InMemoryReferenceRepository<
  Code extends string,
  Attributes extends { readonly name: string },
> implements ReferenceRepository<Code, Attributes> {
  constructor(
    private readonly held: Map<string, Held<Attributes>>,
    private readonly tenantId: TenantId,
    private readonly now: () => Date,
  ) {}

  private key(code: Code): string {
    return `${this.tenantId}:${code}`;
  }

  declare(code: Code, attributes: Attributes): Promise<Declaration> {
    const existing = this.held.get(this.key(code));
    const moment = this.now();

    if (existing) {
      // The moment it was first declared survives, exactly as `created_at`
      // does in the real table.
      this.held.set(this.key(code), {
        ...existing,
        attributes,
        updatedAt: moment,
      });
      return Promise.resolve('updated');
    }

    this.held.set(this.key(code), {
      attributes,
      createdAt: moment,
      updatedAt: moment,
    });
    return Promise.resolve('created');
  }

  declared(codes: readonly Code[]): Promise<ReadonlySet<Code>> {
    return Promise.resolve(
      new Set(codes.filter((code) => this.held.has(this.key(code)))),
    );
  }

  list(): Promise<readonly ReferenceEntity<Code>[]> {
    const prefix = `${this.tenantId}:`;
    return Promise.resolve(
      [...this.held.entries()]
        .filter(([key]) => key.startsWith(prefix))
        .map(([key, held]) => ({
          code: key.slice(prefix.length) as Code,
          name: held.attributes.name,
          createdAt: held.createdAt,
          updatedAt: held.updatedAt,
        }))
        .sort((left, right) => left.code.localeCompare(right.code)),
    );
  }
}

/**
 * The movement stream's double.
 *
 * It mirrors the one behaviour of the real adapter that a use case can observe:
 * recording returns only what was newly recorded, so a caller can tell a first
 * submission from a replay. A double that returned everything submitted would
 * make every replay test pass against a broken implementation.
 */
export class InMemoryMovementRepository implements MovementRepository {
  constructor(
    private readonly store: InMemoryInventoryStore,
    private readonly tenantId: TenantId,
  ) {}

  private key(externalId: ExternalMovementId): string {
    return `${this.tenantId}:${externalId}`;
  }

  private get mine(): SubmittedMovement[] {
    return [...this.store.movements.values()].filter(
      (movement) => movement.tenant === this.tenantId,
    );
  }

  record(
    movements: readonly SubmittedMovement[],
  ): Promise<ReadonlySet<ExternalMovementId>> {
    const recorded = new Set<ExternalMovementId>();

    for (const movement of movements) {
      const key = this.key(movement.externalId);
      if (this.store.movements.has(key)) {
        // Already recorded. Silently skipped, exactly as `on conflict do
        // nothing` skips it, and absent from what is returned.
        continue;
      }
      this.store.movements.set(key, { ...movement, tenant: this.tenantId });
      recorded.add(movement.externalId);
    }

    return Promise.resolve(recorded);
  }

  stockOnHand(): Promise<readonly StockLevel[]> {
    const totals = new Map<string, StockLevel>();

    for (const movement of this.mine) {
      const key = `${movement.sku}\u0000${movement.location}`;
      const running = totals.get(key);
      totals.set(key, {
        sku: movement.sku,
        location: movement.location,
        onHand: (running?.onHand ?? 0) + movement.quantity,
      });
    }

    return Promise.resolve(
      [...totals.values()].sort(
        (left, right) =>
          left.sku.localeCompare(right.sku) ||
          left.location.localeCompare(right.location),
      ),
    );
  }
}

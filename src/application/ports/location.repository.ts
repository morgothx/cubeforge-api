import type { LocationCode } from '../../domain/inventory/identifiers';
import type { ReferenceRepository } from './reference.repository';

export interface LocationAttributes {
  readonly name: string;
}

export type LocationRepository = ReferenceRepository<
  LocationCode,
  LocationAttributes
>;

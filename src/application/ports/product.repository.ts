import type { Sku } from '../../domain/inventory/identifiers';
import type { ReferenceRepository } from './reference.repository';

export interface ProductAttributes {
  readonly name: string;
  /**
   * Free text, and the one attribute a later analytical feature will want to
   * group by. It carries the same typo problem that made places a declared
   * resource; no requirement asks for it to be one, so it is named here rather
   * than solved.
   */
  readonly category: string | null;
}

export type ProductRepository = ReferenceRepository<Sku, ProductAttributes>;

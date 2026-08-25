import { IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

/**
 * The edge validates shape; the domain validates the codes.
 *
 * The SKU and the place code arrive in the path rather than the body, so they
 * are not here — they are parsed by the domain's own constructors, which is the
 * one place the permitted characters are decided.
 */
export class DeclareProductRequest {
  @IsString()
  @MinLength(1, { message: 'name must not be blank' })
  @MaxLength(200)
  name!: string;

  /**
   * Optional, and free text. It is the one attribute a later analytical feature
   * will want to group by, and it carries the same typo problem that made
   * places a declared resource rather than a field.
   */
  @IsOptional()
  @IsString()
  @MaxLength(200)
  category?: string;
}

export class DeclareLocationRequest {
  @IsString()
  @MinLength(1, { message: 'name must not be blank' })
  @MaxLength(200)
  name!: string;
}

export interface DeclaredResponse {
  readonly code: string;
  readonly outcome: 'created' | 'updated';
}

export interface CatalogueEntryResponse {
  readonly code: string;
  readonly name: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

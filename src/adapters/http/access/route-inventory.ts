import { Injectable, RequestMethod } from '@nestjs/common';
// Not re-exported from the package root, unlike almost everything else in it.
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { DiscoveryService, MetadataScanner, Reflector } from '@nestjs/core';
import { ACCESS_DECLARATION, type AccessDeclaration } from './access.decorator';

export interface DeclaredRoute {
  readonly controller: string;
  readonly handler: string;
  readonly method: string;
  readonly path: string;
  /** `null` is the finding this exists for, not a missing value. */
  readonly declaration: AccessDeclaration | null;
}

/**
 * Every route the application actually has, and what each one declares.
 *
 * The list comes from the framework's own registry rather than from anything
 * maintained by hand, which is the only version of this worth having: a route
 * nobody remembered is exactly the route that needs to appear. Nothing here
 * runs on a request path — the guard refuses an undeclared route at runtime,
 * and this is what turns that refusal into a test failure before anyone ships
 * one.
 */
@Injectable()
export class RouteInventory {
  constructor(
    private readonly discovery: DiscoveryService,
    private readonly scanner: MetadataScanner,
    private readonly reflector: Reflector,
  ) {}

  all(): readonly DeclaredRoute[] {
    return this.discovery
      .getControllers()
      .flatMap((wrapper) => this.routesOf(wrapper.metatype, wrapper.instance));
  }

  private routesOf(
    metatype: unknown,
    instance: unknown,
  ): readonly DeclaredRoute[] {
    if (typeof metatype !== 'function' || instance == null) {
      return [];
    }
    const prototype: object = Object.getPrototypeOf(instance) as object;
    const base = pathOf(this.reflector.get<unknown>(PATH_METADATA, metatype));

    return this.scanner
      .getAllMethodNames(prototype)
      .flatMap((handler): DeclaredRoute[] => {
        const method = this.reflector.get<unknown>(
          METHOD_METADATA,
          methodOf(prototype, handler),
        );
        // A method with no HTTP verb is a helper, not a route.
        if (typeof method !== 'number') {
          return [];
        }

        return [
          {
            controller: metatype.name,
            handler,
            method: RequestMethod[method],
            path: join(
              base,
              pathOf(
                this.reflector.get(PATH_METADATA, methodOf(prototype, handler)),
              ),
            ),
            // Handler before controller: a class-wide declaration is a default,
            // and reading it the other way round would let a permissive class
            // outrank a method that restricted itself.
            declaration:
              this.reflector.getAllAndOverride<AccessDeclaration>(
                ACCESS_DECLARATION,
                [methodOf(prototype, handler), metatype],
              ) ?? null,
          },
        ];
      });
  }
}

/**
 * The handler as a value, which is what carries the metadata. Annotated
 * `this: void` because nothing here ever calls it — extracting a method to read
 * its decorators is not the unbound-method mistake the rule is looking for.
 */
function methodOf(prototype: object, handler: string): (this: void) => unknown {
  return (prototype as Record<string, (this: void) => unknown>)[handler];
}

/** Nest stores `''` for a bare `@Get()` and `'/'` for a bare controller. */
function pathOf(value: unknown): string {
  if (typeof value !== 'string' || value === '/' || value.length === 0) {
    return '';
  }
  return value.startsWith('/') ? value : `/${value}`;
}

function join(base: string, suffix: string): string {
  return `${base}${suffix}` || '/';
}

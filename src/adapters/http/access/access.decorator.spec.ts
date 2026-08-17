import { Reflector } from '@nestjs/core';
import {
  ACCESS_DECLARATION,
  Access,
  type AccessDeclaration,
} from './access.decorator';

/**
 * The declaration is the whole contract between a route and the guard, so what
 * matters here is that it can be read back exactly as written, and that a
 * declaration nobody could have meant is refused where it was written rather
 * than at the first request that hits it.
 */
describe('the access declaration', () => {
  const reflector = new Reflector();

  describe('what it attaches', () => {
    it('is readable from the handler it was written on', () => {
      class Controller {
        @Access({ roles: ['admin'] })
        // `this: void` so reading the method off the prototype below is not
        // the unbound-method mistake the lint rule looks for.
        handler(this: void): void {}
      }

      expect(
        reflector.get<AccessDeclaration>(
          ACCESS_DECLARATION,
          Controller.prototype.handler,
        ),
      ).toEqual({ roles: ['admin'] });
    });

    it('is readable from a controller, so a class can state a default', () => {
      @Access({ operator: true })
      class Controller {}

      expect(
        reflector.get<AccessDeclaration>(ACCESS_DECLARATION, Controller),
      ).toEqual({ operator: true });
    });

    it('leaves an undeclared handler with nothing to read', () => {
      class Controller {
        handler(this: void): void {}
      }

      // The absence the guard tests for. One key means one question, which is
      // why a route that declares nothing cannot be mistaken for one that
      // declared something empty.
      expect(
        reflector.get<AccessDeclaration>(
          ACCESS_DECLARATION,
          Controller.prototype.handler,
        ),
      ).toBeUndefined();
    });

    it('carries every shape a route may need', () => {
      const shapes: AccessDeclaration[] = [
        { public: true },
        { operator: true },
        { person: true },
        { roles: ['admin'] },
        { roles: ['admin', 'editor', 'viewer'] },
        { roles: ['editor'], machines: true },
      ];

      for (const shape of shapes) {
        class Controller {
          @Access(shape)
          handler(this: void): void {}
        }

        expect(
          reflector.get<AccessDeclaration>(
            ACCESS_DECLARATION,
            Controller.prototype.handler,
          ),
        ).toEqual(shape);
      }
    });
  });

  describe('what it refuses to attach', () => {
    /**
     * The union type already rejects these at compile time. The runtime check
     * exists because metadata is read back as data, and because a cast — the
     * kind these tests have to perform to reach the check at all — is exactly
     * how the type gets bypassed in real code.
     */
    function attaching(declaration: unknown): () => void {
      return () => Access(declaration as AccessDeclaration);
    }

    /**
     * The reason alone, with the echoed declaration cut off the end.
     *
     * Asserting against the whole message would let the echo answer for the
     * reason: every message ends with the JSON that was written, so a pattern
     * naming two properties — `/person.*machines/` — matches
     * `{"person":true,"machines":true}` no matter what the check concluded, or
     * whether it concluded anything. One of these tests passed that way before
     * the branch it was written for existed.
     */
    function reasonFor(declaration: unknown): string {
      try {
        Access(declaration as AccessDeclaration);
      } catch (error) {
        return (error as Error).message.replace(/: \{.*\}$/, '');
      }
      throw new Error(
        `this declaration was accepted: ${JSON.stringify(declaration)}`,
      );
    }

    it('refuses a declaration that permits nobody', () => {
      expect(reasonFor({ roles: [] })).toMatch(/permits nobody/);
    });

    it('refuses a declaration that states nothing at all', () => {
      expect(reasonFor({})).toMatch(/states nothing/);
    });

    it('refuses a public route that also names roles', () => {
      expect(reasonFor({ public: true, roles: ['admin'] })).toMatch(
        /public.*roles/i,
      );
    });

    it('refuses an operator route that also admits machines', () => {
      expect(reasonFor({ operator: true, machines: true })).toMatch(
        /operator.*machines/i,
      );
    });

    it('refuses machines without the roles they would have to carry', () => {
      expect(reasonFor({ machines: true })).toMatch(/machines.*roles/i);
    });

    /**
     * `person` says "any caller who names a person", which is the widest thing
     * a route can say short of `public`. Every combination below narrows or
     * contradicts it, and each failure has to name which one it was: these are
     * read at import time, with no request and no route to point at.
     */
    it.each([
      [
        'a public route that also asks for a person',
        { public: true, person: true },
        /public.*person/i,
      ],
      [
        'an operator route that also admits any person',
        { operator: true, person: true },
        /operator.*person/i,
      ],
      [
        'a person route that also names roles',
        { person: true, roles: ['admin'] },
        /person.*roles/i,
      ],
      [
        'a person route that also admits machines',
        { person: true, machines: true },
        /person.*machines/i,
      ],
    ])('refuses %s', (_case, declaration, named) => {
      expect(reasonFor(declaration)).toMatch(named);
    });

    it('refuses a role outside the permitted set', () => {
      expect(reasonFor({ roles: ['superuser'] })).toMatch(
        /admin, editor, viewer/,
      );
    });

    it('names the offending declaration, so the failure is actionable', () => {
      // Thrown while the module is being loaded, with no request and no route
      // in the message unless it is in the declaration itself. Reporting what
      // was written is the only clue available.
      expect(attaching({ roles: [] })).toThrow(/\{"roles":\[\]\}/);
    });
  });
});

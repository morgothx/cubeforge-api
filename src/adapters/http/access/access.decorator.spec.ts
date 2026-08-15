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

    it('refuses a declaration that permits nobody', () => {
      expect(attaching({ roles: [] })).toThrow(/permits nobody/);
    });

    it('refuses a declaration that states nothing at all', () => {
      expect(attaching({})).toThrow(/states nothing/);
    });

    it('refuses a public route that also names roles', () => {
      expect(attaching({ public: true, roles: ['admin'] })).toThrow(
        /public.*roles/i,
      );
    });

    it('refuses an operator route that also admits machines', () => {
      expect(attaching({ operator: true, machines: true })).toThrow(
        /operator.*machines/i,
      );
    });

    it('refuses machines without the roles they would have to carry', () => {
      expect(attaching({ machines: true })).toThrow(/machines.*roles/i);
    });

    it('refuses a role outside the permitted set', () => {
      expect(attaching({ roles: ['superuser'] })).toThrow(
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

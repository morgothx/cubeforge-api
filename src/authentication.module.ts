import { Global, Module } from '@nestjs/common';
import {
  JwtAccessTokenIssuer,
  loadTokenConfig,
} from './adapters/crypto/access-token-issuer';
import {
  Argon2PasswordHasher,
  loadHashingConfig,
} from './adapters/crypto/argon2-password-hasher';
import { RandomSecretGenerator } from './adapters/crypto/random-secret-generator';
import { PrincipalMiddleware } from './adapters/http/principal.middleware';
import { DrizzleModule } from './adapters/persistence/postgres/drizzle.module';
import { PostgresAuthenticatorUnitOfWork } from './adapters/persistence/postgres/postgres-authenticator-unit-of-work';
import { PrincipalResolver } from './application/principal-resolver';
import { ACCESS_TOKEN_ISSUER } from './application/ports/access-token-issuer';
import { AUTHENTICATOR_UNIT_OF_WORK } from './application/ports/authenticator-unit-of-work';
import { PASSWORD_HASHER } from './application/ports/password-hasher';
import { SECRET_GENERATOR } from './application/ports/secret-generator';

/**
 * Where authentication's ports meet their adapters.
 *
 * Global, because the principal middleware runs in front of every route and the
 * identity feature's controllers depend on the actor it attaches. The
 * alternative — importing this into each feature module — would say the same
 * thing more often and less clearly.
 */
@Global()
@Module({
  imports: [DrizzleModule],
  providers: [
    {
      provide: ACCESS_TOKEN_ISSUER,
      useFactory: () => new JwtAccessTokenIssuer(loadTokenConfig(process.env)),
    },
    {
      provide: PASSWORD_HASHER,
      useFactory: () =>
        new Argon2PasswordHasher(loadHashingConfig(process.env)),
    },
    { provide: SECRET_GENERATOR, useClass: RandomSecretGenerator },
    {
      provide: AUTHENTICATOR_UNIT_OF_WORK,
      useClass: PostgresAuthenticatorUnitOfWork,
    },
    PrincipalResolver,
    PrincipalMiddleware,
  ],
  exports: [
    ACCESS_TOKEN_ISSUER,
    PASSWORD_HASHER,
    SECRET_GENERATOR,
    AUTHENTICATOR_UNIT_OF_WORK,
    PrincipalResolver,
    PrincipalMiddleware,
  ],
})
export class AuthenticationModule {}

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
import { ApiKeysController } from './adapters/http/api-keys.controller';
import { AuthenticationController } from './adapters/http/authentication.controller';
import { CredentialSetupController } from './adapters/http/credential-setup.controller';
import { PrincipalMiddleware } from './adapters/http/principal.middleware';
import { DrizzleModule } from './adapters/persistence/postgres/drizzle.module';
import { PostgresAuthenticatorUnitOfWork } from './adapters/persistence/postgres/postgres-authenticator-unit-of-work';
import { IssueApiKeyUseCase } from './application/api-key/issue-api-key.use-case';
import { ListApiKeysUseCase } from './application/api-key/list-api-keys.use-case';
import { RevokeApiKeyUseCase } from './application/api-key/revoke-api-key.use-case';
import { RefreshSessionUseCase } from './application/authentication/refresh-session.use-case';
import { SignInUseCase } from './application/authentication/sign-in.use-case';
import { SignOutUseCase } from './application/authentication/sign-out.use-case';
import { IssueSetupTokenUseCase } from './application/credential/issue-setup-token.use-case';
import { RedeemSetupTokenUseCase } from './application/credential/redeem-setup-token.use-case';
import { PrincipalResolver } from './application/principal-resolver';
import { ACCESS_TOKEN_ISSUER } from './application/ports/access-token-issuer';
import { AUTHENTICATOR_UNIT_OF_WORK } from './application/ports/authenticator-unit-of-work';
import { PASSWORD_HASHER } from './application/ports/password-hasher';
import { SECRET_GENERATOR } from './application/ports/secret-generator';
import { PersistenceModule } from './persistence.module';

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
  imports: [DrizzleModule, PersistenceModule],
  controllers: [
    AuthenticationController,
    CredentialSetupController,
    ApiKeysController,
  ],
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

    SignInUseCase,
    RefreshSessionUseCase,
    SignOutUseCase,
    IssueSetupTokenUseCase,
    RedeemSetupTokenUseCase,
    IssueApiKeyUseCase,
    ListApiKeysUseCase,
    RevokeApiKeyUseCase,
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

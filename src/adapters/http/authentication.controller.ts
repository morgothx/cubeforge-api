import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  UseGuards,
} from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import { INVENTORY_BY_CREDENTIAL } from './inventory-throttling';
import { RefreshSessionUseCase } from '../../application/authentication/refresh-session.use-case';
import { SignInUseCase } from '../../application/authentication/sign-in.use-case';
import { SignOutUseCase } from '../../application/authentication/sign-out.use-case';
import { RedeemSetupTokenUseCase } from '../../application/credential/redeem-setup-token.use-case';
import { opaqueSecret } from '../../domain/credential/secrets';
import {
  CredentialThrottlerGuard,
  REDEMPTION_BY_ORIGIN,
  SIGN_IN_BY_ADDRESS,
  SIGN_IN_BY_ORIGIN,
} from './credential-throttling';
import {
  RedeemSetupTokenRequest,
  RefreshSessionRequest,
  SignInRequest,
  SignOutRequest,
} from './dto/requests';
import { toSessionResponse, type SessionResponse } from './dto/responses';
import { Access } from './access/access.decorator';

/**
 * The only routes that take no actor: presenting the credential *is* the
 * request. The principal middleware still runs in front of them and will
 * happily resolve a token if one is sent, but nothing here reads it — signing
 * in while already signed in is an ordinary thing to do.
 *
 * Every response is 200 rather than 201. Nothing addressable is created: a
 * session is a pair of secrets the caller keeps, with no URL to point at.
 */
@Controller('auth')
export class AuthenticationController {
  constructor(
    private readonly signIn: SignInUseCase,
    private readonly refresh: RefreshSessionUseCase,
    private readonly signOut: SignOutUseCase,
    private readonly redeem: RedeemSetupTokenUseCase,
  ) {}

  /**
   * Counted twice — per address and per origin — and refused with 429 once
   * either count is exhausted. That is the only authentication outcome a caller
   * can tell apart from another, and deliberately so: someone who has to wait
   * needs to know it. What they still cannot learn is whether the address they
   * were guessing exists, because the refusal happens before any use case runs
   * and therefore before anything is looked up (9.4).
   *
   * No count ever disables an account (9.2). Doing so would turn a known
   * address into a weapon against its owner, and the disabling itself would
   * confirm the address exists.
   */
  @Post('sign-in')
  @Access({ public: true })
  @UseGuards(CredentialThrottlerGuard)
  @SkipThrottle({
    [REDEMPTION_BY_ORIGIN]: true,
    [INVENTORY_BY_CREDENTIAL]: true,
  })
  @HttpCode(HttpStatus.OK)
  async store(@Body() body: SignInRequest): Promise<SessionResponse> {
    return toSessionResponse(
      await this.signIn.execute({ email: body.email, password: body.password }),
    );
  }

  @Post('refresh')
  @Access({ public: true })
  @HttpCode(HttpStatus.OK)
  async update(@Body() body: RefreshSessionRequest): Promise<SessionResponse> {
    return toSessionResponse(
      await this.refresh.execute({
        refreshToken: opaqueSecret(body.refreshToken),
      }),
    );
  }

  @Post('sign-out')
  @Access({ public: true })
  @HttpCode(HttpStatus.NO_CONTENT)
  async destroy(@Body() body: SignOutRequest): Promise<void> {
    await this.signOut.execute({
      refreshToken: opaqueSecret(body.refreshToken),
      everywhere: body.everywhere ?? false,
    });
  }

  /**
   * Redeeming establishes a password and ends every session that person had,
   * so it answers with nothing: whoever just set the password has no session
   * yet and must sign in with what they chose.
   */
  @Post('credentials')
  @Access({ public: true })
  @UseGuards(CredentialThrottlerGuard)
  // Counted by origin only: a setup token names nobody until it is looked up,
  // so there is no address to count by.
  @SkipThrottle({
    [SIGN_IN_BY_ORIGIN]: true,
    [SIGN_IN_BY_ADDRESS]: true,
    [INVENTORY_BY_CREDENTIAL]: true,
  })
  @HttpCode(HttpStatus.NO_CONTENT)
  async establish(@Body() body: RedeemSetupTokenRequest): Promise<void> {
    await this.redeem.execute({
      token: opaqueSecret(body.token),
      password: body.password,
    });
  }
}

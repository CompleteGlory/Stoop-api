import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ApiError } from '../common/api-error.js';
import { ALLOW_WITHOUT_USERNAME_KEY, IS_PUBLIC_KEY } from '../common/decorators.js';
import { OnboardingService } from './onboarding.service.js';
import { TokensService } from './tokens.service.js';

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly tokens: TokensService,
    private readonly onboarding: OnboardingService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== 'http') return true;
    const targets = [context.getHandler(), context.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, targets)) return true;

    const req = context.switchToHttp().getRequest();
    const header: string | undefined = req.headers?.authorization;
    const match = header?.match(/^Bearer\s+(.+)$/i);
    if (!match) throw ApiError.unauthorized();

    const userId = await this.tokens.verifyAccessToken(match[1]);
    req.user = { id: userId };

    const allowed = this.reflector.getAllAndOverride<boolean>(ALLOW_WITHOUT_USERNAME_KEY, targets);
    if (!allowed && !(await this.onboarding.hasUsername(userId))) {
      throw ApiError.forbidden('username_required', 'Choose a username first');
    }
    return true;
  }
}

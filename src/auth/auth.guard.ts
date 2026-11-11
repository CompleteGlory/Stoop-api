import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ApiError } from '../common/api-error.js';
import { IS_PUBLIC_KEY } from '../common/decorators.js';
import { TokensService } from './tokens.service.js';

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly tokens: TokensService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== 'http') return true;
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const req = context.switchToHttp().getRequest();
    const header: string | undefined = req.headers?.authorization;
    const match = header?.match(/^Bearer\s+(.+)$/i);
    if (!match) throw ApiError.unauthorized();

    req.user = { id: await this.tokens.verifyAccessToken(match[1]) };
    return true;
  }
}

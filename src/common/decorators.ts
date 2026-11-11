import { createParamDecorator, ExecutionContext, SetMetadata } from '@nestjs/common';

export const IS_PUBLIC_KEY = 'isPublic';
/** Skips the global auth guard for a route or controller. */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);

export const ALLOW_WITHOUT_USERNAME_KEY = 'allowWithoutUsername';
/** Lets a signed-in account that has not picked a username yet reach a route or controller. */
export const AllowWithoutUsername = () => SetMetadata(ALLOW_WITHOUT_USERNAME_KEY, true);

export interface AuthUser {
  id: string;
}

/** The signed-in user, as set by the auth guard. */
export const CurrentUser = createParamDecorator((_: unknown, ctx: ExecutionContext): AuthUser => {
  return ctx.switchToHttp().getRequest().user;
});

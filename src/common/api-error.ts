import { HttpException } from '@nestjs/common';

/** Every error the API returns has the shape `{ "error": { "code", "message" } }`. */
export class ApiError extends HttpException {
  constructor(
    status: number,
    readonly code: string,
    message: string,
  ) {
    super({ error: { code, message } }, status);
    // HttpException would otherwise label every one of these "Api Error" in logs and test output
    this.message = message;
  }

  static badRequest(code: string, message: string) {
    return new ApiError(400, code, message);
  }
  static unauthorized(message = 'Authentication required') {
    return new ApiError(401, 'unauthorized', message);
  }
  static forbidden(code: string, message: string) {
    return new ApiError(403, code, message);
  }
  static notFound(what = 'Resource') {
    return new ApiError(404, 'not_found', `${what} not found`);
  }
  static conflict(code: string, message: string) {
    return new ApiError(409, code, message);
  }
  static unprocessable(code: string, message: string) {
    return new ApiError(422, code, message);
  }
  static rateLimited(message = 'Too many requests, try again later') {
    return new ApiError(429, 'rate_limited', message);
  }
}

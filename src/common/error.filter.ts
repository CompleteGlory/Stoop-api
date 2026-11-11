import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { Response } from 'express';
import { ApiError } from './api-error.js';

const CODE_BY_STATUS: Record<number, string> = {
  400: 'bad_request',
  401: 'unauthorized',
  403: 'forbidden',
  404: 'not_found',
  405: 'method_not_allowed',
  409: 'conflict',
  413: 'payload_too_large',
  415: 'unsupported_media_type',
  422: 'unprocessable',
  429: 'rate_limited',
};

/** Turns every exception into the `{ error: { code, message } }` envelope. */
@Catch()
export class ApiErrorFilter implements ExceptionFilter {
  private readonly logger = new Logger(ApiErrorFilter.name);

  catch(exception: unknown, host: ArgumentsHost) {
    if (host.getType() !== 'http') throw exception;
    const res = host.switchToHttp().getResponse<Response>();

    if (exception instanceof ApiError) {
      res.status(exception.getStatus()).json(exception.getResponse());
      return;
    }

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const body = exception.getResponse();
      const message =
        typeof body === 'string'
          ? body
          : Array.isArray((body as any)?.message)
            ? (body as any).message.join('; ')
            : ((body as any)?.message ?? exception.message);
      res.status(status).json({
        error: { code: CODE_BY_STATUS[status] ?? 'error', message },
      });
      return;
    }

    // body-parser and friends throw plain errors that carry a status
    const status = (exception as any)?.status ?? (exception as any)?.statusCode;
    if (typeof status === 'number' && status >= 400 && status < 500) {
      res.status(status).json({
        error: {
          code: CODE_BY_STATUS[status] ?? 'bad_request',
          message: (exception as Error).message,
        },
      });
      return;
    }

    this.logger.error(
      exception instanceof Error ? (exception.stack ?? exception.message) : String(exception),
    );
    res.status(HttpStatus.INTERNAL_SERVER_ERROR).json({
      error: { code: 'internal_error', message: 'Something went wrong' },
    });
  }
}

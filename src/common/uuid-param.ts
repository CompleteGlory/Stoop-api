import { ParseUUIDPipe } from '@nestjs/common';
import { ApiError } from './api-error.js';

/** `@Param('id', uuidPipe)` answers a malformed id with the standard error envelope. */
export const uuidPipe = new ParseUUIDPipe({
  exceptionFactory: () => ApiError.badRequest('invalid_id', 'The id is not a valid UUID'),
});

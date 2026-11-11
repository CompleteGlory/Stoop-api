import { Global, Module } from '@nestjs/common';
import { SocialGraph } from '../social/social-graph.service.js';
import { DomainEvents } from './domain-events.js';
import { UserMapper } from './mappers.js';
import { RateLimiter } from './rate-limiter.service.js';

/** Small shared services that most feature modules use. */
@Global()
@Module({
  providers: [RateLimiter, DomainEvents, UserMapper, SocialGraph],
  exports: [RateLimiter, DomainEvents, UserMapper, SocialGraph],
})
export class CoreModule {}

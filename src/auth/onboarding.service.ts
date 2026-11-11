import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Not, Repository } from 'typeorm';
import { User } from '../db/entities/user.entity.js';

/** Answers whether an account has finished onboarding, which means it has picked a username. */
@Injectable()
export class OnboardingService {
  constructor(@InjectRepository(User) private readonly users: Repository<User>) {}

  hasUsername(userId: string): Promise<boolean> {
    return this.users.existsBy({ id: userId, username: Not(IsNull()) });
  }
}

import { Module } from '@nestjs/common';
import { LegalController } from './legal.controller.js';

@Module({ controllers: [LegalController] })
export class LegalModule {}

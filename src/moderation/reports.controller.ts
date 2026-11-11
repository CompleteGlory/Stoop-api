import { Body, Controller, Post } from '@nestjs/common';
import { CurrentUser, type AuthUser } from '../common/decorators.js';
import { CreateReportDto } from './reports.dto.js';
import { ReportsService } from './reports.service.js';

@Controller('reports')
export class ReportsController {
  constructor(private readonly reports: ReportsService) {}

  @Post()
  create(@CurrentUser() user: AuthUser, @Body() dto: CreateReportDto) {
    return this.reports.create(user.id, dto);
  }
}

import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { ApiError } from '../common/api-error.js';
import { RateLimiter } from '../common/rate-limiter.service.js';
import { Report } from '../db/entities/report.entity.js';
import type { CreateReportDto } from './reports.dto.js';

@Injectable()
export class ReportsService {
  constructor(
    @InjectRepository(Report) private readonly reports: Repository<Report>,
    private readonly db: DataSource,
    private readonly limiter: RateLimiter,
  ) {}

  async create(reporterId: string, dto: CreateReportDto) {
    await this.limiter.consume(`report:${reporterId}`, 20, 24 * 3600, 'reports');

    if (dto.targetType === 'rating') {
      const rating = await this.db.query(`SELECT user_id FROM ratings WHERE id = $1`, [dto.targetId]);
      if (rating.length === 0) throw ApiError.notFound('Rating');
      if (rating[0].user_id === reporterId) {
        throw ApiError.badRequest('invalid_target', 'You cannot report your own rating');
      }
    } else if (dto.targetType === 'photo') {
      const photo = await this.db.query(`SELECT user_id FROM place_photos WHERE id = $1`, [dto.targetId]);
      if (photo.length === 0) throw ApiError.notFound('Photo');
      if (photo[0].user_id === reporterId) {
        throw ApiError.badRequest('invalid_target', 'You cannot report your own photo');
      }
    } else {
      if (dto.targetId === reporterId) {
        throw ApiError.badRequest('invalid_target', 'You cannot report yourself');
      }
      const user = await this.db.query(`SELECT 1 FROM users WHERE id = $1 AND deleted_at IS NULL`, [dto.targetId]);
      if (user.length === 0) throw ApiError.notFound('User');
    }

    const saved = await this.reports.save(
      this.reports.create({
        reporterId,
        targetType: dto.targetType,
        targetId: dto.targetId,
        reason: dto.reason,
        details: dto.details ?? null,
      }),
    );
    return { id: saved.id, status: saved.status };
  }
}

import { Transform } from 'class-transformer';
import { IsIn, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';

export const REPORT_TARGETS = ['user', 'rating', 'photo'] as const;
export const REPORT_REASONS = ['spam', 'abuse', 'inappropriate', 'impersonation', 'other'] as const;

export class CreateReportDto {
  @IsIn(REPORT_TARGETS)
  targetType: (typeof REPORT_TARGETS)[number];

  /** A user id for `user`, a rating id for `rating`, a photo id for `photo`. */
  @IsUUID()
  targetId: string;

  @IsIn(REPORT_REASONS)
  reason: (typeof REPORT_REASONS)[number];

  @IsOptional()
  @IsString()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @MaxLength(500)
  details?: string;
}

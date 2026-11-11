import { Transform } from 'class-transformer';
import { IsInt, IsOptional, IsString, Max, MaxLength, Min, ValidateIf } from 'class-validator';

export class PutRatingDto {
  @IsInt()
  @Min(1)
  @Max(5)
  stars: number;

  /** Null or missing clears the comment. */
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsString()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @MaxLength(280)
  comment?: string | null;
}

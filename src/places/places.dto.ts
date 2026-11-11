import { Transform } from 'class-transformer';
import { IsLatitude, IsLongitude, IsOptional, IsString, Length, MaxLength } from 'class-validator';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

export class ResolvePlaceDto {
  /** `MKMapItem.identifier` on iOS 18+. Places from Apple Maps are matched on it. */
  @IsOptional()
  @IsString()
  @MaxLength(200)
  appleId?: string;

  @IsString()
  @Transform(trim)
  @Length(1, 120)
  name: string;

  @IsOptional()
  @IsString()
  @Transform(trim)
  @MaxLength(60)
  category?: string;

  @IsLatitude()
  latitude: number;

  @IsLongitude()
  longitude: number;
}

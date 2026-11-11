import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, Length, Max, Min } from 'class-validator';

export const PHOTO_KINDS = ['place', 'menu'] as const;
export type PhotoKind = (typeof PHOTO_KINDS)[number];

export const MAX_PHOTO_BYTES = 10 * 1024 * 1024;
export const ALLOWED_PHOTO_TYPES = ['image/jpeg', 'image/png'] as const;

export class PhotoUploadUrlDto {
  @IsIn(ALLOWED_PHOTO_TYPES)
  contentType: (typeof ALLOWED_PHOTO_TYPES)[number];

  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_PHOTO_BYTES)
  contentLength: number;
}

export class CreatePhotoDto {
  @IsIn(PHOTO_KINDS)
  kind: PhotoKind;

  /** The `key` returned by the upload-url call, after the file was PUT there. */
  @IsString()
  @Length(10, 200)
  key: string;
}

export class ListPhotosDto {
  @IsOptional()
  @IsIn(PHOTO_KINDS)
  kind?: PhotoKind;

  @IsOptional()
  @IsString()
  limit?: string;

  @IsOptional()
  @IsString()
  cursor?: string;
}

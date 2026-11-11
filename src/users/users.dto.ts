import { Transform, Type } from 'class-transformer';
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Length,
  Matches,
  Max,
  Min,
} from 'class-validator';
import { ALLOWED_AVATAR_TYPES, MAX_AVATAR_BYTES } from './avatar.service.js';
import { AVATAR_PRESETS } from './avatar-presets.js';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);
const lower = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim().toLowerCase() : value;

export class UpdateMeDto {
  @IsOptional()
  @IsString()
  @Transform(lower)
  @Matches(/^[a-z0-9_.]{3,20}$/, {
    message: 'username must be 3-20 characters: letters, digits, "_" or "."',
  })
  username?: string;

  @IsOptional()
  @IsString()
  @Transform(trim)
  @Length(1, 40)
  displayName?: string;

  @IsOptional()
  @IsBoolean()
  ghostMode?: boolean;

  /** Switches to one of the preset avatars. Photos go through the upload endpoints. */
  @IsOptional()
  @IsIn(AVATAR_PRESETS)
  avatarPreset?: string;
}

export class AvatarUploadUrlDto {
  @IsIn(ALLOWED_AVATAR_TYPES)
  contentType: (typeof ALLOWED_AVATAR_TYPES)[number];

  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_AVATAR_BYTES)
  contentLength: number;
}

export class AvatarConfirmDto {
  @IsString()
  @Length(10, 200)
  key: string;
}

export class SearchUsersDto {
  @IsString()
  @Transform(lower)
  @Length(3, 20)
  q: string;
}

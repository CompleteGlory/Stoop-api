import { Transform } from 'class-transformer';
import { IsOptional, IsString, Length, Matches, MaxLength, MinLength } from 'class-validator';

export class AppleSignInDto {
  @IsString()
  @MinLength(20)
  @MaxLength(8192)
  identityToken: string;

  /** The raw nonce the app generated; its SHA-256 went to Apple. */
  @IsOptional()
  @IsString()
  @MaxLength(200)
  nonce?: string;

  /** Apple only gives the name on the very first sign-in, so the app sends it along. */
  @IsOptional()
  @IsString()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @MaxLength(60)
  fullName?: string;
}

export class RefreshDto {
  @IsString()
  @Length(20, 200)
  refreshToken: string;
}

export class DevLoginDto {
  @IsString()
  @Transform(({ value }) => (typeof value === 'string' ? value.toLowerCase() : value))
  @Matches(/^[a-z0-9_.]{3,20}$/)
  username: string;
}

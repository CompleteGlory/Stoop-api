import { Transform } from 'class-transformer';
import { IsEmail, IsOptional, IsString, Length, Matches, MaxLength, MinLength } from 'class-validator';
import { USERNAME_PATTERN } from '../users/users.dto.js';

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

const email = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim().toLowerCase() : value);

export class GoogleSignInDto {
  @IsString()
  @MinLength(20)
  @MaxLength(8192)
  idToken: string;
}

export class EmailDto {
  @Transform(email)
  @IsEmail({}, { message: 'email must be an email address' })
  @MaxLength(254)
  email: string;
}

export class EmailPasswordDto extends EmailDto {
  @IsString()
  @Length(8, 128, { message: 'password must be 8 to 128 characters' })
  password: string;
}

const lowerTrim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim().toLowerCase() : value);

export class EmailSignUpDto extends EmailPasswordDto {
  /** Optional: the username picked on the sign-up screen, given to the account once the code is entered. */
  @IsOptional()
  @IsString()
  @Transform(lowerTrim)
  @Matches(USERNAME_PATTERN, { message: 'username must be 3-20 characters: letters, digits, "_" or "."' })
  username?: string;
}

export class EmailCodeDto extends EmailDto {
  @IsString()
  @Matches(/^\d{6}$/, { message: 'code must be 6 digits' })
  code: string;
}

export class PasswordResetDto extends EmailCodeDto {
  @IsString()
  @Length(8, 128, { message: 'newPassword must be 8 to 128 characters' })
  newPassword: string;
}

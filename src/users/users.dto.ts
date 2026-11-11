import { Transform } from 'class-transformer';
import { IsBoolean, IsObject, IsOptional, IsString, Length, Matches, ValidateIf } from 'class-validator';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);
const lower = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim().toLowerCase() : value;

export const USERNAME_PATTERN = /^[a-z0-9_.]{3,20}$/;

export class UpdateMeDto {
  // not @IsOptional: that also accepts null, which would erase the username
  @ValidateIf((_, value) => value !== undefined)
  @IsString()
  @Transform(lower)
  @Matches(USERNAME_PATTERN, {
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

  /** The person's DiceBear character, `{ style, options }`; checked in full by `validateCharacter`. */
  @ValidateIf((_, value) => value !== undefined)
  @IsObject()
  avatar?: Record<string, unknown>;
}

/** Deliberately loose: a badly formed name is an answer (`invalid`), not a request error. */
export class UsernameAvailabilityDto {
  @IsString()
  @Transform(lower)
  @Length(1, 64)
  username: string;
}

export class SearchUsersDto {
  @IsString()
  @Transform(lower)
  @Length(3, 20)
  q: string;
}

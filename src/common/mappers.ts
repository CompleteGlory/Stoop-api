import { Inject, Injectable } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../config/app-config.js';

export interface AvatarDto {
  kind: 'preset' | 'upload';
  /** Preset id (the app ships the artwork) or object key. */
  value: string;
  /** Absolute URL for uploaded avatars, null for presets. */
  url: string | null;
}

export interface PublicUserDto {
  id: string;
  username: string | null;
  displayName: string;
  avatar: AvatarDto;
}

/** Row shape produced by SQL that selects `USER_COLUMNS`. */
export interface UserColumns {
  user_id: string;
  username: string | null;
  display_name: string;
  avatar_kind: 'preset' | 'upload';
  avatar_value: string;
}

/** Add this to a SELECT over `users u` to get what `UserMapper.fromColumns` reads. */
export const USER_COLUMNS = `u.id AS user_id, u.username, u.display_name, u.avatar_kind, u.avatar_value`;

@Injectable()
export class UserMapper {
  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  avatar(kind: 'preset' | 'upload', value: string): AvatarDto {
    return {
      kind,
      value,
      url: kind === 'upload' ? `${this.config.s3.publicBaseUrl}/${value}` : null,
    };
  }

  fromColumns(row: UserColumns): PublicUserDto {
    return {
      id: row.user_id,
      username: row.username,
      displayName: row.display_name,
      avatar: this.avatar(row.avatar_kind, row.avatar_value),
    };
  }
}

import { Injectable } from '@nestjs/common';

/** A DiceBear character. The app draws it; the server only stores and checks the choice. */
export interface AvatarDto {
  style: string;
  options: Record<string, string>;
}

export interface PublicUserDto {
  id: string;
  username: string | null;
  displayName: string;
  /** Null until the person has picked a character. */
  avatar: AvatarDto | null;
}

/** Row shape produced by SQL that selects `USER_COLUMNS`. */
export interface UserColumns {
  user_id: string;
  username: string | null;
  display_name: string;
  avatar_style: string | null;
  avatar_options: Record<string, string> | null;
}

/** Add this to a SELECT over `users u` to get what `UserMapper.fromColumns` reads. */
export const USER_COLUMNS = `u.id AS user_id, u.username, u.display_name, u.avatar_style, u.avatar_options`;

@Injectable()
export class UserMapper {
  avatar(style: string | null, options: Record<string, string> | null): AvatarDto | null {
    return style ? { style, options: options ?? {} } : null;
  }

  fromColumns(row: UserColumns): PublicUserDto {
    return {
      id: row.user_id,
      username: row.username,
      displayName: row.display_name,
      avatar: this.avatar(row.avatar_style, row.avatar_options),
    };
  }
}

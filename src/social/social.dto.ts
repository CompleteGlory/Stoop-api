import { IsUUID } from 'class-validator';

export class UserIdDto {
  @IsUUID()
  userId: string;
}

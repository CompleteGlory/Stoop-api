import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn } from 'typeorm';

export type AvatarKind = 'preset' | 'upload';

@Entity('users')
export class User {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /** Apple's stable `sub` for this person. Null once the account is deleted. */
  @Column({ name: 'apple_sub', type: 'text', nullable: true, unique: true })
  appleSub: string | null;

  /** Lowercase, 3-20 chars of a-z 0-9 _ . Null until onboarding is finished. */
  @Column({ type: 'text', nullable: true })
  username: string | null;

  @Column({ name: 'display_name', type: 'text', default: '' })
  displayName: string;

  @Column({ name: 'avatar_kind', type: 'text', default: 'preset' })
  avatarKind: AvatarKind;

  /** A preset id for `preset`, an object key in the bucket for `upload`. */
  @Column({ name: 'avatar_value', type: 'text', default: 'fox' })
  avatarValue: string;

  @Column({ name: 'ghost_mode', type: 'boolean', default: false })
  ghostMode: boolean;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @Column({ name: 'deleted_at', type: 'timestamptz', nullable: true })
  deletedAt: Date | null;
}

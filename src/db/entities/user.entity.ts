import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn } from 'typeorm';

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

  /** DiceBear style of the person's character. Null until they pick one. */
  @Column({ name: 'avatar_style', type: 'text', nullable: true })
  avatarStyle: string | null;

  /** The chosen DiceBear options, checked by `validateCharacter`. */
  @Column({ name: 'avatar_options', type: 'jsonb', nullable: true })
  avatarOptions: Record<string, string> | null;

  @Column({ name: 'ghost_mode', type: 'boolean', default: false })
  ghostMode: boolean;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @Column({ name: 'deleted_at', type: 'timestamptz', nullable: true })
  deletedAt: Date | null;
}

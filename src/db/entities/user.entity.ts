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

  /** Lowercase. Set by email sign-up or by Apple/Google when they report a verified address. */
  @Column({ type: 'text', nullable: true })
  email: string | null;

  @Column({ name: 'email_verified_at', type: 'timestamptz', nullable: true })
  emailVerifiedAt: Date | null;

  /** scrypt hash (see auth/passwords.ts); null for accounts without a password. Never returned. */
  @Column({ name: 'password_hash', type: 'text', nullable: true })
  passwordHash: string | null;

  /** Sign in with Apple refresh token, kept only to revoke it on deletion. Never selected by default, never returned. */
  @Column({ name: 'apple_refresh_token', type: 'text', nullable: true, select: false })
  appleRefreshToken?: string | null;

  /** Google's stable user id, when the account signs in with Google. */
  @Column({ name: 'google_sub', type: 'text', nullable: true, unique: true })
  googleSub: string | null;

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

  /** Whether this person wants a push when a friend is nearby (and lets the app report position in the background). */
  @Column({ name: 'nearby_alerts', type: 'boolean', default: false })
  nearbyAlerts: boolean;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @Column({ name: 'deleted_at', type: 'timestamptz', nullable: true })
  deletedAt: Date | null;
}

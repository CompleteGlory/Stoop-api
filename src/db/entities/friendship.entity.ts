import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn } from 'typeorm';

export type FriendshipStatus = 'pending' | 'accepted';

/** One row per pair of users; the database enforces that with a unique index on the unordered pair. */
@Entity('friendships')
export class Friendship {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'requester_id', type: 'uuid' })
  requesterId: string;

  @Column({ name: 'addressee_id', type: 'uuid' })
  addresseeId: string;

  @Column({ type: 'text', default: 'pending' })
  status: FriendshipStatus;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @Column({ name: 'accepted_at', type: 'timestamptz', nullable: true })
  acceptedAt: Date | null;
}

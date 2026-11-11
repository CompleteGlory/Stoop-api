import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn } from 'typeorm';

export type ReportTargetType = 'user' | 'rating' | 'photo';
export type ReportReason = 'spam' | 'abuse' | 'inappropriate' | 'impersonation' | 'other';

@Entity('reports')
export class Report {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /** Null after the reporter deletes their account; the report itself stays. */
  @Column({ name: 'reporter_id', type: 'uuid', nullable: true })
  reporterId: string | null;

  @Column({ name: 'target_type', type: 'text' })
  targetType: ReportTargetType;

  /** A user id for `user`, a rating id for `rating`, a photo id for `photo`. */
  @Column({ name: 'target_id', type: 'uuid' })
  targetId: string;

  @Column({ type: 'text' })
  reason: ReportReason;

  @Column({ type: 'text', nullable: true })
  details: string | null;

  @Column({ type: 'text', default: 'open' })
  status: 'open' | 'actioned' | 'dismissed';

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;
}

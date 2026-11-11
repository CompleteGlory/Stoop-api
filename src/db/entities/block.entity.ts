import { CreateDateColumn, Entity, PrimaryColumn } from 'typeorm';

@Entity('blocks')
export class Block {
  @PrimaryColumn({ name: 'blocker_id', type: 'uuid' })
  blockerId: string;

  @PrimaryColumn({ name: 'blocked_id', type: 'uuid' })
  blockedId: string;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;
}

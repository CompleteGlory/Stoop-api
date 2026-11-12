import { Column, CreateDateColumn, Entity, PrimaryColumn, UpdateDateColumn } from 'typeorm';

export type PushEnvironment = 'sandbox' | 'production';

/**
 * A phone that receives push notifications. The APNs device token is the key, so a phone that
 * signs in to another account moves to that account. Never returned or logged.
 */
@Entity('push_devices')
export class PushDevice {
  @PrimaryColumn({ type: 'text' })
  token: string;

  @Column({ name: 'user_id', type: 'uuid' })
  userId: string;

  /** Debug builds talk to Apple's sandbox push service, TestFlight and App Store builds to production. */
  @Column({ type: 'text' })
  environment: PushEnvironment;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}

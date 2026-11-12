import { IsIn, IsNumber, Max, Min } from 'class-validator';
import type { PushEnvironment } from '../db/entities/push-device.entity.js';

/** An APNs device token as the app prints it: hex, 32 bytes today but Apple allows longer. */
export const DEVICE_TOKEN_PATTERN = /^[0-9a-f]{64,200}$/;

export class RegisterDeviceDto {
  /** `sandbox` for builds run from Xcode, `production` for TestFlight and the App Store. */
  @IsIn(['sandbox', 'production'])
  environment: PushEnvironment;
}

/** Background positions are coarse (cell towers, Wi-Fi), so a looser accuracy than the live socket's 100 m. */
export const MAX_POSITION_ACCURACY_M = 1000;

export class ReportPositionDto {
  @IsNumber({ allowNaN: false, allowInfinity: false })
  @Min(-90)
  @Max(90)
  lat: number;

  @IsNumber({ allowNaN: false, allowInfinity: false })
  @Min(-180)
  @Max(180)
  lng: number;

  /** Horizontal accuracy in metres. */
  @IsNumber({ allowNaN: false, allowInfinity: false })
  @Min(0)
  accuracy: number;
}

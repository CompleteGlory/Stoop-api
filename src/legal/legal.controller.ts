import { Controller, Get, Header, Inject } from '@nestjs/common';
import { Public } from '../common/decorators.js';
import { APP_CONFIG, type AppConfig } from '../config/app-config.js';
import { privacyPage, termsPage } from './legal.pages.js';

/** The pages App Review asks for: a Terms of Use link and a Privacy Policy URL. Public, no token. */
@Public()
@Controller()
export class LegalController {
  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  @Get('terms')
  @Header('Content-Type', 'text/html; charset=utf-8')
  @Header('Cache-Control', 'public, max-age=3600')
  terms(): string {
    return termsPage(this.config.supportEmail);
  }

  @Get('privacy')
  @Header('Content-Type', 'text/html; charset=utf-8')
  @Header('Cache-Control', 'public, max-age=3600')
  privacy(): string {
    return privacyPage(this.config.supportEmail);
  }
}

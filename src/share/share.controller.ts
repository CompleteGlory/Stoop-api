import { Controller, Get, Headers, Inject, Param, Res } from '@nestjs/common';
import type { Response } from 'express';
import { ApiError } from '../common/api-error.js';
import { Public } from '../common/decorators.js';
import { APP_CONFIG, type AppConfig } from '../config/app-config.js';
import { PlacesService } from '../places/places.service.js';
import { missingPage, placePage, shareLanguage } from './share.page.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PAGE_SECURITY = "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'";

/**
 * Shared place links. `https://<api>/p/<placeId>` opens the place sheet in Stoop through a universal
 * link, and is a small web page (with Google and Apple Maps links) for anyone without the app.
 */
@Public()
@Controller()
export class ShareController {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly places: PlacesService,
  ) {}

  /** Apple fetches this to learn which paths open the app. Off until APPLE_TEAM_ID is set. */
  @Get('.well-known/apple-app-site-association')
  association(@Res({ passthrough: true }) res: Response) {
    const { teamId, bundleId } = this.config.apple;
    if (!teamId || !bundleId) throw ApiError.notFound('Universal links');
    res.setHeader('Cache-Control', 'public, max-age=3600');
    return {
      applinks: {
        details: [{ appIDs: [`${teamId}.${bundleId}`], components: [{ '/': '/p/*', comment: 'A shared place' }] }],
      },
    };
  }

  @Get('p/:id')
  async place(
    @Param('id') id: string,
    @Headers('accept-language') acceptLanguage: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ): Promise<string> {
    const lang = shareLanguage(acceptLanguage);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Content-Security-Policy', PAGE_SECURITY);
    res.setHeader('Vary', 'Accept-Language');
    const place = UUID.test(id) ? await this.places.find(id.toLowerCase()) : null;
    if (!place) {
      res.status(404);
      res.setHeader('Cache-Control', 'no-store');
      return missingPage(lang);
    }
    res.setHeader('Cache-Control', 'public, max-age=300');
    return placePage(place, `${this.config.s3.publicBaseUrl}/p/${place.id}`, lang);
  }
}

import { existsSync } from 'node:fs';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';
import { setupApp } from './app.setup.js';
import { loadConfig } from './config/app-config.js';

// `.env` is for local development; in production the host provides real environment variables
if (existsSync('.env')) process.loadEnvFile('.env');

const config = loadConfig();
const app = setupApp(await NestFactory.create(AppModule));
await app.listen(config.port, '0.0.0.0');
new Logger('Bootstrap').log(`Listening on port ${config.port} (${config.nodeEnv})`);

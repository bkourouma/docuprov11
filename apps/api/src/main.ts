import 'reflect-metadata';
import { mkdir } from 'node:fs/promises';
import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module';
import { AllExceptionsFilter } from './common/all-exceptions.filter';

// JSON.stringify cannot serialize BigInt natively. Several Prisma columns are BigInt
// (e.g. DocumentFile.byteLength), so without this any response carrying one would crash
// with "Do not know how to serialize a BigInt". Emit BigInt as a string in JSON.
(BigInt.prototype as unknown as { toJSON: () => string }).toJSON = function () {
  return this.toString();
};

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  const logger = app.get(Logger);
  app.useLogger(logger);

  // Ensure the disk vault exists at startup (don't wait for the first acquisition).
  const config = app.get(ConfigService);
  const archivesPath = config.getOrThrow<string>('ARCHIVES_PATH');
  await mkdir(archivesPath, { recursive: true });
  logger.log(`Disk vault ready at ${archivesPath}`);

  // La clé de l'agent de numérisation est lue au démarrage : la changer dans .env n'a aucun effet
  // tant que l'API n'a pas redémarré. Le dire ici évite de chercher côté agent une panne qui est
  // ici — c'est le piège classique de cette configuration à deux fichiers.
  logger.log(
    config.get<string>('SCAN_AGENT_API_KEY')
      ? 'Scan agent key configured — X-Api-Key accepted on the scanned-documents queue'
      : 'No SCAN_AGENT_API_KEY — the scan agent must use an application account',
  );

  // CORS: allow the web app (cross-origin). Defaults to reflecting any origin in dev;
  // set CORS_ORIGIN (comma-separated) to restrict in production.
  app.enableCors({
    origin: process.env.CORS_ORIGIN ? process.env.CORS_ORIGIN.split(',') : true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  });

  app.setGlobalPrefix('api');
  app.useGlobalFilters(new AllExceptionsFilter());
  app.enableShutdownHooks();

  const port = process.env.PORT ?? 3001;
  await app.listen(port);
  logger.log(`API ready on http://localhost:${port}/api`);
}

void bootstrap();

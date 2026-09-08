// Charge le .env du monorepo AVANT tout accès à process.env (miroir de l'API NestJS
// ConfigModule.forRoot({ envFilePath: ['.env', '../../.env'] })). Doit être le tout
// premier import de l'entrée du worker. dotenv n'écrase pas les variables déjà
// définies : un lanceur qui exporte les variables (start-docupro.bat) reste prioritaire.
import { resolve } from 'node:path';
import { config as loadDotenv } from 'dotenv';

loadDotenv({ path: [resolve(process.cwd(), '.env'), resolve(process.cwd(), '../../.env')] });

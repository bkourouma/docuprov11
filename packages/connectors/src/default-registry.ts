import { filesystemConnector } from './connectors/filesystem';
import { googleDriveConnector } from './connectors/google-drive';
import { imapConnector } from './connectors/imap';
import { onedriveConnector } from './connectors/microsoft-onedrive';
import { outlookConnector } from './connectors/microsoft-outlook';
import { sharepointConnector } from './connectors/microsoft-sharepoint';
import { whatsappConnector } from './connectors/whatsapp';
import { ConnectorRegistry } from './registry';

/** Registre des connecteurs fournis d'origine. Ajouter un connecteur = un `register` de plus ici. */
export function createDefaultRegistry(): ConnectorRegistry {
  const registry = new ConnectorRegistry();
  registry.register(filesystemConnector);
  registry.register(imapConnector);
  // Lot 2b — sources autorisées par OAuth 2.0 (lecture seule).
  registry.register(googleDriveConnector);
  registry.register(onedriveConnector);
  registry.register(sharepointConnector);
  registry.register(outlookConnector);
  registry.register(whatsappConnector);
  return registry;
}

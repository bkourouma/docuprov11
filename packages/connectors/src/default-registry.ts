import { filesystemConnector } from './connectors/filesystem';
import { imapConnector } from './connectors/imap';
import { whatsappConnector } from './connectors/whatsapp';
import { ConnectorRegistry } from './registry';

/** Registre des connecteurs fournis d'origine. Ajouter un connecteur = un `register` de plus ici. */
export function createDefaultRegistry(): ConnectorRegistry {
  const registry = new ConnectorRegistry();
  registry.register(filesystemConnector);
  registry.register(imapConnector);
  registry.register(whatsappConnector);
  return registry;
}

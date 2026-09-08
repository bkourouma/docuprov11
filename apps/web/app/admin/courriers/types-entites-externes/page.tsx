'use client';

import { MailRefPage } from '../../../components/mail/MailRefPage';
import { externalEntityTypesApi, type ExternalEntityTypeRow } from '../../../lib/courriers';

/**
 * Types d'entité externe — écran dédié. Le type reste aussi créable à la volée depuis le
 * bouton « + » du champ Type de l'écran des entités externes : les deux points d'entrée écrivent
 * dans le même référentiel.
 */
export default function ExternalEntityTypesPage() {
  return (
    <MailRefPage<ExternalEntityTypeRow>
      icon="documentType"
      title="Types d'entité externe"
      formTitle="Nouveau type"
      placeholder="Ex. Ministère"
      confirmLabel="ce type d'entité externe"
      api={externalEntityTypesApi}
      idOf={(r) => r.externalEntityTypeId}
    />
  );
}

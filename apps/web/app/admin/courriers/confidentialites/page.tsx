'use client';

import { Breadcrumb } from 'antd';
import { MailRefPage } from '../../../components/mail/MailRefPage';
import { fontSize } from '../../../theme/tokens';
import { confidentialitesApi, type MailConfidentialiteRow } from '../../../lib/courriers';

export default function MailConfidentialitesPage() {
  return (
    <>
      {/* Écran hors menu ET homonyme exact de « Confidentialités » du menu Sécurité
          Documentaire (même titre, même picto) : le fil d'Ariane est ce qui distingue les deux
          écrans, la description dit lequel on tient. Posé ici, au gabarit de celui de
          PageHeader, parce que le patron MailRefPage n'expose pas la prop `breadcrumb`. */}
      <Breadcrumb
        style={{ marginBottom: 10, fontSize: fontSize.sm }}
        items={[{ title: 'Paramétrage Courrier' }, { title: 'Confidentialités' }]}
      />
      <MailRefPage<MailConfidentialiteRow>
        icon="lock"
        title="Confidentialités"
        formTitle="Nouveau niveau"
        placeholder="Ex. Confidentiel"
        confirmLabel="ce niveau de confidentialité"
        api={confidentialitesApi}
        idOf={(r) => r.mailConfidentialiteId}
      />
    </>
  );
}

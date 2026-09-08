'use client';

import { Breadcrumb } from 'antd';
import { MailRefPage } from '../../../components/mail/MailRefPage';
import { fontSize } from '../../../theme/tokens';
import { mailNaturesApi, type MailNatureRow } from '../../../lib/courriers';

export default function MailNaturesPage() {
  return (
    <>
      {/* Écran hors menu : la barre latérale n'a aucun item sélectionné et la TopBar retombe
          sur la section par défaut. Le fil d'Ariane est donc le seul repère de localisation
          pour qui arrive par URL directe. Il est posé ici — au gabarit de celui de PageHeader —
          parce que le patron MailRefPage n'expose pas la prop `breadcrumb`. */}
      <Breadcrumb
        style={{ marginBottom: 10, fontSize: fontSize.sm }}
        items={[{ title: 'Paramétrage Courrier' }, { title: 'Natures de courrier' }]}
      />
      <MailRefPage<MailNatureRow>
        icon="mail"
        title="Natures de courrier"
        formTitle="Nouvelle nature"
        placeholder="Ex. Officiel"
        confirmLabel="cette nature"
        api={mailNaturesApi}
        idOf={(r) => r.mailNatureId}
      />
    </>
  );
}

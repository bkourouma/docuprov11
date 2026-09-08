'use client';

import { MailRefPage } from '../../../components/mail/MailRefPage';
import { departTypesApi, type MailDepartTypeRow } from '../../../lib/courriers';

export default function MailDepartTypesPage() {
  return (
    <MailRefPage<MailDepartTypeRow>
      icon="send"
      title="Types de courrier départ"
      formTitle="Nouveau type de départ"
      placeholder="Ex. Note de service"
      confirmLabel="ce type de départ"
      api={departTypesApi}
      idOf={(r) => r.mailDepartTypeId}
    />
  );
}

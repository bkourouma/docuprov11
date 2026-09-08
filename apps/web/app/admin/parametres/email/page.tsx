'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { App, Button, Card, Col, Form, Input, Row, Space, Typography, Upload } from 'antd';
import type { UploadProps } from 'antd';
// Le VRAI gabarit, pas une réplique : une copie dans l'écran dériverait au premier
// changement du modèle d'e-mail. Import direct du module compilé (le paquet n'a pas
// de carte `exports`), qui est pur — il n'entraîne pas `nodemailer` dans le bundle.
import { renderNotificationEmail } from '@archivage/mailer/dist/template';
import { PageHeader } from '../../../components/PageHeader';
import { useFeedback } from '../../../components/feedback';
import { colors, fontSize, radii } from '../../../theme/tokens';
import {
  deleteEmailLogo,
  emailLogoPreviewUrl,
  getEmailTemplate,
  saveEmailTemplate,
  uploadEmailLogo,
  type EmailTemplatePayload,
  type EmailTemplateSetting,
} from '../../../lib/parametres';

/**
 * Les champs du formulaire correspondent un pour un à la charge utile. AntD rend un champ vidé sous
 * la forme `''` : l'API le normalise en `null` (« non renseigné »), donc rien à convertir ici.
 */
type FormValues = Record<keyof EmailTemplatePayload, string | undefined>;

const ACCEPTED = '.png,.jpg,.jpeg,.gif,.webp';

/** Vide ⟹ `null`, pour dire explicitement « efface ce champ » plutôt que « ne le touche pas ». */
const norm = (v: string | undefined): string | null => {
  const t = v?.trim();
  return t ? t : null;
};

/**
 * L'API peut être adressée en relatif (`/api`, via le proxy Next) : l'iframe d'aperçu
 * est rendue depuis `srcDoc`, sans origine, et ne saurait pas résoudre un tel chemin.
 */
const absolutise = (url: string): string =>
  url.startsWith('http') || typeof window === 'undefined'
    ? url
    : `${window.location.origin}${url.startsWith('/') ? '' : '/'}${url}`;

/**
 * Notification d'exemple de l'aperçu — fictive et reconnaissable comme telle. Elle
 * exerce toutes les zones du gabarit (civilité, tableau de détails, valeur mise en
 * évidence, bouton d'action, note de pied) pour que le réglage se juge sur un cas
 * complet, pas sur un e-mail vide.
 */
const EXEMPLE_NOTIFICATION = {
  title: 'Courrier imputé',
  body: 'Un courrier vous a été imputé pour traitement.',
  recipientName: 'Awa Koné',
  severity: 'info' as const,
  details: [
    { label: 'N° d’enregistrement', value: 'ARR-2026-000814', strong: true },
    { label: 'Objet', value: 'Demande de subvention' },
    { label: 'Correspondant', value: 'Ministère de la Culture' },
    { label: 'Échéance', value: '31/08/2026', strong: true },
  ],
  actionUrl: 'https://exemple.invalid/courriers/parapheur',
  actionLabel: 'Ouvrir le courrier',
  footerNote: 'Imputé par le bureau d’ordre.',
};

export default function ParametrageEmailPage() {
  const { message } = App.useApp();
  const { confirm } = useFeedback();
  const [form] = Form.useForm<FormValues>();
  const [setting, setSetting] = useState<EmailTemplateSetting | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  // Change à chaque remplacement du logo : la route publique est mise en cache une heure, sans quoi
  // l'aperçu continuerait d'afficher l'ancienne image.
  const [logoVersion, setLogoVersion] = useState(0);
  // Le bouton « Enregistrer » vit dans l'en-tête de page, loin des champs : sans repère, on quitte
  // l'écran en croyant avoir enregistré. Suivi de la saisie via `isFieldsTouched`.
  const [dirty, setDirty] = useState(false);

  const apply = useCallback(
    (row: EmailTemplateSetting) => {
      setSetting(row);
      form.setFieldsValue({
        orgName: row.orgName ?? '',
        contactEmail: row.contactEmail ?? '',
        websiteUrl: row.websiteUrl ?? '',
      });
      // Les valeurs affichées redeviennent celles du serveur : plus rien n'est en attente.
      setDirty(false);
    },
    [form],
  );

  const load = useCallback(async () => {
    setLoading(true);
    try {
      apply(await getEmailTemplate());
    } catch (e) {
      message.error(e instanceof Error ? e.message : 'Erreur de chargement');
    } finally {
      setLoading(false);
    }
  }, [apply, message]);

  useEffect(() => {
    void load();
  }, [load]);

  // Garde de sortie : fermeture d'onglet ou rechargement avec une saisie en attente.
  useEffect(() => {
    if (!dirty) return;
    const guard = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', guard);
    return () => window.removeEventListener('beforeunload', guard);
  }, [dirty]);

  const submit = async (values: FormValues) => {
    setSaving(true);
    try {
      const payload: EmailTemplatePayload = {
        orgName: norm(values.orgName),
        contactEmail: norm(values.contactEmail),
        websiteUrl: norm(values.websiteUrl),
      };
      apply(await saveEmailTemplate(payload));
      message.success('Paramétrage enregistré');
    } catch (e) {
      message.error(e instanceof Error ? e.message : "Erreur à l'enregistrement");
    } finally {
      setSaving(false);
    }
  };

  // `beforeUpload` renvoie false : on gère l'envoi nous-mêmes, pour passer par `apiUpload` et son
  // en-tête d'authentification plutôt que par la requête interne d'AntD.
  const uploadProps: UploadProps = {
    accept: ACCEPTED,
    showUploadList: false,
    maxCount: 1,
    beforeUpload: (file) => {
      void (async () => {
        try {
          apply(await uploadEmailLogo(file as File));
          setLogoVersion((v) => v + 1);
          message.success('Logo mis à jour');
        } catch (e) {
          message.error(e instanceof Error ? e.message : 'Envoi du logo impossible');
        }
      })();
      return false;
    },
  };

  const removeLogo = () =>
    confirm({
      title: 'Retirer le logo ?',
      content: 'Les e-mails partiront sans logo tant qu’aucun autre ne sera déposé.',
      danger: true,
      okText: 'Retirer',
      onOk: async () => {
        try {
          apply(await deleteEmailLogo());
          setLogoVersion((v) => v + 1);
          message.success('Logo retiré');
        } catch (e) {
          message.error(e instanceof Error ? e.message : 'Suppression impossible');
        }
      },
    });

  const hasLocalLogo = !!setting?.logoFileName;

  // Aperçu tenu à jour à la frappe : c'est tout l'intérêt, on réglait jusqu'ici à l'aveugle.
  const orgName = Form.useWatch('orgName', form);
  const contactEmail = Form.useWatch('contactEmail', form);
  const websiteUrl = Form.useWatch('websiteUrl', form);

  const previewHtml = useMemo(
    () =>
      renderNotificationEmail(EXEMPLE_NOTIFICATION, {
        orgName: norm(orgName),
        // Le vrai envoi embarque le logo en pièce jointe (CID) ; ici il faut une URL
        // ABSOLUE : le document de l'iframe n'a pas d'origine pour résoudre un chemin.
        logoUrl: hasLocalLogo ? absolutise(emailLogoPreviewUrl(logoVersion)) : null,
        contactEmail: norm(contactEmail),
        websiteUrl: norm(websiteUrl),
      }),
    [orgName, contactEmail, websiteUrl, hasLocalLogo, logoVersion],
  );

  return (
    <>
      <PageHeader
        icon="mail"
        title="Paramétrage e-mail"
        breadcrumb={[{ label: 'Administration' }, { label: 'Paramétrage e-mail' }]}
        actions={
          <Space size={8}>
            {dirty && (
              // Badge plein AA (blanc à 4,77:1) : la mention doit se voir depuis les champs,
              // à l'autre bout de l'écran.
              <span
                className="da-pill"
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  padding: '0 10px',
                  height: 24,
                  fontSize: 11,
                  fontWeight: 600,
                  background: colors.warning,
                  color: 'var(--ant-color-white)',
                }}
              >
                Modifications non enregistrées
              </span>
            )}
            <Button type="primary" loading={saving} onClick={() => void form.submit()}>
              Enregistrer
            </Button>
          </Space>
        }
      />

      <Form<FormValues>
        form={form}
        layout="vertical"
        disabled={loading}
        onFieldsChange={() => setDirty(form.isFieldsTouched())}
        onFinish={(v) => void submit(v)}
      >
        <Row gutter={[16, 16]}>
          <Col xs={24} lg={14}>
            <Card title="Identité" style={{ marginBottom: 16 }}>
              <Form.Item name="orgName" label="Nom de l’organisation">
                <Input placeholder="Ex. Direction générale" maxLength={200} />
              </Form.Item>
            </Card>

            <Card title="Coordonnées">
              <Row gutter={16}>
                <Col xs={24} md={12}>
                  <Form.Item
                    name="contactEmail"
                    label="E-mail de contact"
                    rules={[{ type: 'email', message: 'Adresse e-mail invalide' }]}
                  >
                    <Input placeholder="contact@exemple.ci" maxLength={200} />
                  </Form.Item>
                </Col>
                <Col xs={24} md={12}>
                  <Form.Item
                    name="websiteUrl"
                    label="Site web"
                    rules={[{ type: 'url', message: 'URL absolue attendue (https://…)' }]}
                  >
                    <Input placeholder="https://exemple.ci" maxLength={300} />
                  </Form.Item>
                </Col>
              </Row>
            </Card>
          </Col>

          <Col xs={24} lg={10}>
            <Card title="Logo">
              <Space direction="vertical" size={12} style={{ width: '100%' }}>
                <div
                  style={{
                    display: 'grid',
                    placeItems: 'center',
                    minHeight: 110,
                    padding: 16,
                    // Surface de dépôt = carte, teintes prises au thème.
                    borderRadius: radii.card,
                    border: `1px dashed var(--ant-color-border, ${colors.border})`,
                    background: `var(--ant-color-fill-quaternary, ${colors.bgLayout})`,
                  }}
                >
                  {hasLocalLogo ? (
                    // `<img>` et non `next/image` : la source est un endpoint de l'API, servi
                    // sous un jeton de version pour casser le cache après un dépôt. L'optimiseur
                    // exigerait de déclarer cet hôte en `remotePatterns` et remettrait sa propre
                    // couche de cache entre le dépôt et l'aperçu — l'inverse du but recherché.
                    <img
                      src={emailLogoPreviewUrl(logoVersion)}
                      alt="Logo des e-mails"
                      style={{ maxHeight: 72, maxWidth: '100%' }}
                    />
                  ) : (
                    <Typography.Text type="secondary">Aucun logo déposé</Typography.Text>
                  )}
                </div>

                <Space wrap>
                  <Upload {...uploadProps}>
                    <Button>{hasLocalLogo ? 'Remplacer' : 'Déposer un logo'}</Button>
                  </Upload>
                  {hasLocalLogo && (
                    <Button danger onClick={removeLogo}>
                      Retirer
                    </Button>
                  )}
                </Space>
              </Space>
            </Card>
          </Col>
        </Row>
      </Form>

      <Card
        title="Aperçu de l’e-mail"
        style={{ marginTop: 16 }}
        extra={
          <Typography.Text type="secondary" style={{ fontSize: fontSize.xs }}>
            Notification d’exemple — rendu réel du gabarit
          </Typography.Text>
        }
      >
        <Typography.Paragraph type="secondary">
          Les valeurs saisies ci-dessus apparaissent immédiatement. Le rendu final dépend du client
          de messagerie du destinataire (Outlook, Gmail…), qui applique ses propres règles
          d’affichage.
        </Typography.Paragraph>
        {/* iframe et non `dangerouslySetInnerHTML` : le gabarit porte ses propres styles,
            calibrés pour les clients mail. Injecté dans la page, il en hériterait la
            typographie et contaminerait l'application avec ses règles — l'aperçu ne
            montrerait plus ce qui part réellement. */}
        <iframe
          title="Aperçu de l’e-mail de notification"
          srcDoc={previewHtml}
          sandbox=""
          style={{
            width: '100%',
            height: 620,
            border: `1px solid var(--ant-color-border, ${colors.border})`,
            borderRadius: radii.card,
            background: '#ffffff',
          }}
        />
      </Card>
    </>
  );
}

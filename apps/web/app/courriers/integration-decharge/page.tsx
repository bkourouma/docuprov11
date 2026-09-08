'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  App,
  Button,
  Card,
  Col,
  Divider,
  Form,
  Popconfirm,
  Row,
  Select,
  Space,
  Upload,
} from 'antd';
import { PageHeader } from '../../components/PageHeader';
import { FormSection } from '../../components/FormSection';
import { icons } from '../../theme/icons';
import {
  integrateDecharge,
  listDechargesEnAttente,
  uploadScannedDocument,
  type DechargeEnAttente,
} from '../../lib/courriers';
import { fmt } from '../../components/mail/mailFormat';

/**
 * Largeur maximale de la colonne de saisie : au-delà, la ligne devient trop longue à parcourir
 * entre son libellé et sa fin. L'écran n'a qu'une colonne, il s'y tient donc en entier.
 */
const CONTENT_MAX_WIDTH = 640;

interface DechargeForm {
  mailId: number;
  /**
   * Champ MIROIR de la zone de dépôt : le File lui-même reste dans l'état React (rc-field-form
   * clone ses valeurs en profondeur), seul son nom entre dans le store — assez pour porter la
   * règle « obligatoire » et afficher son erreur sous le champ.
   */
  fileName?: string;
}

/** Option de la liste des départs en attente : le n° est isolé pour être rendu en chasse fixe. */
interface DechargeOption {
  value: number;
  /** Libellé recherché, et affiché une fois le courrier choisi. */
  label: string;
  nReference: string | null;
  rest: string;
}

/**
 * Intégration décharge (§13) : on rattache à un courrier de DÉPART déjà envoyé la preuve scannée de
 * sa remise (accusé de réception signé). Le back marque la pièce `decharge = true`, passe le
 * courrier en Déchargé puis l'archive — c'est ce qui clôt le courrier.
 *
 * La liste ne propose que les départs SANS pièce de décharge : un courrier en sort dès qu'il en a
 * une, et n'y revient jamais.
 */
export default function IntegrationDechargePage() {
  const { message } = App.useApp();
  const [form] = Form.useForm<DechargeForm>();
  const [saving, setSaving] = useState(false);

  const [mails, setMails] = useState<DechargeEnAttente[]>([]);
  const [loading, setLoading] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  // Valeurs validées en attente de confirmation : l'archivage étant définitif, la confirmation
  // n'a de sens qu'une fois le formulaire valide — sinon l'agent confirmerait avant de découvrir
  // qu'il manque une pièce.
  const [pending, setPending] = useState<DechargeForm | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setMails(await listDechargesEnAttente());
    } catch (e) {
      message.error(e instanceof Error ? e.message : 'Chargement impossible');
    } finally {
      setLoading(false);
    }
  }, [message]);

  useEffect(() => {
    void load();
  }, [load]);

  // N° en tête — c'est par lui que le bureau d'ordre désigne un courrier —, puis objet,
  // correspondant et date, comme le libellé de la source.
  const options = useMemo<DechargeOption[]>(
    () =>
      mails.map((m) => {
        const nReference = m.nReference ? `n° ${m.nReference}` : null;
        const rest = [m.title, m.externalEntity?.label, fmt(m.date)].filter(Boolean).join(' — ');
        return {
          value: m.mailId,
          label: [nReference, rest].filter(Boolean).join(' — '),
          nReference,
          rest,
        };
      }),
    [mails],
  );

  const submit = async (v: DechargeForm) => {
    // Le fichier vit hors du store : la règle du champ miroir a déjà tranché, cette garde ne
    // couvre qu'une désynchronisation.
    if (!file) return;
    setSaving(true);
    try {
      // Le PDF entre par la file §07, seule porte d'entrée d'un binaire dans le flux courrier :
      // le back le promeut ensuite en document GED et le marque traité.
      const { mailScannedDocumentId } = await uploadScannedDocument(file);
      await integrateDecharge(v.mailId, { scannedDocumentId: mailScannedDocumentId });
      message.success('Décharge intégrée : courrier déchargé et archivé.');
      form.resetFields();
      setFile(null);
      await load(); // le courrier vient de quitter la liste
    } catch (e) {
      message.error(e instanceof Error ? e.message : 'Intégration impossible');
    } finally {
      setSaving(false);
      setPending(null);
    }
  };

  return (
    <div style={{ maxWidth: CONTENT_MAX_WIDTH }}>
      <PageHeader icon="archive" title="Intégration décharge" />

      <Card>
        <Form<DechargeForm> form={form} layout="vertical" onFinish={(v) => setPending(v)}>
          <FormSection first icon="mail" title="Courrier concerné">
            <Row gutter={16}>
              <Col xs={24}>
                <Form.Item
                  name="mailId"
                  label="Courrier"
                  rules={[{ required: true, message: 'Le courrier est obligatoire' }]}
                  extra="Courriers de départ dont la décharge signée n'a pas encore été intégrée."
                >
                  <Select
                    showSearch
                    optionFilterProp="label"
                    loading={loading}
                    placeholder="Sélectionnez le courrier de départ…"
                    notFoundContent={
                      loading ? 'Chargement…' : 'Aucun courrier de départ en attente de décharge'
                    }
                    options={options}
                    optionRender={(o) => {
                      const d = o.data as DechargeOption;
                      return (
                        <span>
                          {d.nReference && (
                            <>
                              <span className="da-mono">{d.nReference}</span>
                              {' — '}
                            </>
                          )}
                          {d.rest}
                        </span>
                      );
                    }}
                  />
                </Form.Item>
              </Col>
            </Row>
          </FormSection>

          <FormSection icon="document" title="Décharge signée">
            <Row gutter={16}>
              <Col xs={24}>
                <Form.Item
                  name="fileName"
                  label="Décharge signée (PDF)"
                  rules={[
                    { required: true, message: 'Le scan de la décharge signée est obligatoire' },
                  ]}
                  // La zone de dépôt n'est pas un contrôle piloté par le Form : rien ne doit lui
                  // être injecté depuis la valeur du champ miroir.
                  getValueProps={() => ({})}
                  // Le fichier retenu passe par `extra` : un champ nommé ne peut cloner qu'UN
                  // enfant, et le rappel se lit de toute façon sous la zone de dépôt.
                  extra={
                    file ? (
                      <Space>
                        <icons.document size={14} />
                        <span>{file.name}</span>
                        <Button
                          type="link"
                          size="small"
                          danger
                          onClick={() => {
                            setFile(null);
                            form.setFields([{ name: 'fileName', value: undefined }]);
                          }}
                        >
                          Retirer
                        </Button>
                      </Space>
                    ) : undefined
                  }
                >
                  {/* AntD ne gère aucune liste (`LIST_IGNORE` systématique) : le fichier retenu est
                      notre seul état, et un nouveau dépôt remplace simplement le précédent. */}
                  <Upload.Dragger
                    accept=".pdf"
                    showUploadList={false}
                    beforeUpload={(f) => {
                      if (f.name.toLowerCase().endsWith('.pdf')) {
                        setFile(f);
                        // `setFields` et non `setFieldValue` : ce dernier réassigne au champ des
                        // tableaux d'erreurs frais et déclenche le faux positif antd
                        // « There may be circular references » (rc-util).
                        form.setFields([{ name: 'fileName', value: f.name, errors: [] }]);
                      } else message.error('Seuls les fichiers PDF sont acceptés.');
                      return Upload.LIST_IGNORE;
                    }}
                  >
                    <Space>
                      <Button icon={<icons.upload size={16} />}>Parcourir</Button>
                      <span>ou déposez le fichier ici</span>
                    </Space>
                  </Upload.Dragger>
                </Form.Item>
              </Col>
            </Row>
          </FormSection>

          <Divider style={{ marginTop: 8 }} />
          <Space>
            <Popconfirm
              // Ouverture pilotée par `onFinish` : la confirmation n'apparaît qu'après validation.
              open={pending != null}
              onOpenChange={(open) => {
                if (!open) setPending(null);
              }}
              title="Intégrer cette décharge ?"
              description="Le courrier passera en « Déchargé » et sera archivé définitivement."
              okText="Intégrer"
              cancelText="Annuler"
              okButtonProps={{ loading: saving }}
              onConfirm={() => {
                if (pending) void submit(pending);
              }}
              onCancel={() => setPending(null)}
            >
              <Button
                type="primary"
                htmlType="submit"
                loading={saving}
                icon={<icons.archive size={16} />}
              >
                Intégrer la décharge
              </Button>
            </Popconfirm>
            <Button
              onClick={() => {
                form.resetFields();
                setFile(null);
              }}
            >
              Réinitialiser
            </Button>
          </Space>
        </Form>
      </Card>
    </div>
  );
}

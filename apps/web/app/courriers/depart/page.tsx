'use client';

import { useEffect, useMemo, useState } from 'react';
import {
  App,
  Card,
  Col,
  DatePicker,
  Divider,
  Form,
  Input,
  Row,
  Select,
  Space,
  Button,
  Upload,
} from 'antd';
import type { Dayjs } from 'dayjs';
import { PageHeader } from '../../components/PageHeader';
import { FormSection } from '../../components/FormSection';
import { icons } from '../../theme/icons';
import {
  createDepart,
  listExternalEntities,
  listMailDepartTypes,
  listMailsByExternalEntity,
  nextDepartReference,
  uploadScannedDocument,
  type MailLinkOption,
} from '../../lib/courriers';
import { fmt } from '../../components/mail/mailFormat';

/**
 * Largeur maximale de la colonne de saisie : au-delà, la ligne devient trop longue à parcourir
 * entre son libellé et sa fin. La grille étant à deux colonnes, le bloc vaut deux fois cette
 * largeur plus la gouttière.
 */
const FIELD_COL_MAX = 640;
const CONTENT_MAX_WIDTH = FIELD_COL_MAX * 2 + 16;

/**
 * L'émetteur n'est plus saisi : le back retient le rédacteur du Départ (acteur courant). Référence,
 * confidentialité et description ne sont plus proposées à la création — champs facultatifs côté API.
 */
interface DepartForm {
  title: string;
  date: Dayjs;
  mailDepartTypeId?: number;
  nReference?: string;
  externalEntityId?: number;
  parentMailId?: number;
}

export default function DepartPage() {
  const { message } = App.useApp();
  const [saving, setSaving] = useState(false);
  const [form] = Form.useForm<DepartForm>();

  const [entities, setEntities] = useState<Array<{ externalEntityId: number; label: string }>>([]);
  const [departTypes, setDepartTypes] = useState<
    Array<{ mailDepartTypeId: number; label: string }>
  >([]);
  const [linkables, setLinkables] = useState<MailLinkOption[]>([]);
  const [linkablesLoading, setLinkablesLoading] = useState(false);
  const [file, setFile] = useState<File | null>(null);

  // « Lié au courrier » n'a de sens qu'une fois le correspondant connu : la liste est celle de SES
  // courriers, rechargée à chaque changement de destinataire externe.
  const externalEntityId = Form.useWatch('externalEntityId', form);

  useEffect(() => {
    void (async () => {
      const [e, t] = await Promise.all([
        listExternalEntities().catch(() => []),
        listMailDepartTypes().catch(() => []),
      ]);
      setEntities(e);
      setDepartTypes(t);
    })();
  }, []);

  useEffect(() => {
    if (externalEntityId == null) {
      setLinkables([]);
      return;
    }
    // Course entre deux changements rapides de correspondant : seule la dernière réponse compte,
    // sinon une requête lente écraserait la liste du correspondant réellement sélectionné.
    let cancelled = false;
    setLinkablesLoading(true);
    void (async () => {
      const rows = await listMailsByExternalEntity(externalEntityId).catch(
        () => [] as MailLinkOption[],
      );
      if (cancelled) return;
      setLinkables(rows);
      setLinkablesLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [externalEntityId]);

  const linkableOptions = useMemo(
    () =>
      linkables.map((m) => ({
        value: m.mailId,
        label: `${m.nReference ?? `#${m.mailId}`} — ${m.title} (${fmt(m.date)})`,
      })),
    [linkables],
  );

  /**
   * Le type de départ pilote la numérotation PAR TYPE (§19) : on propose le prochain n°.
   *
   * `setFields` sans clés errors/warnings, et non `setFieldValue` : ce dernier réassigne au champ
   * deux tableaux d'erreurs FRAIS, ce qui déclenche le faux positif « There may be circular
   * references » d'antd (le détecteur de cycles de rc-util confond la constante partagée
   * EMPTY_ERRORS, visée deux fois par la meta précédente, avec une vraie référence circulaire).
   */
  const onTypeChange = async (typeId: number | undefined) => {
    if (typeId == null) return;
    const ref = await nextDepartReference(typeId).catch(() => null);
    if (ref) form.setFields([{ name: 'nReference', value: ref.nReference }]);
  };

  const submit = async (v: DepartForm) => {
    setSaving(true);
    try {
      // Le PDF entre par la file §07, seule porte d'entrée d'un binaire dans le flux courrier :
      // on dépose d'abord, puis la création promeut le scan en document GED et le marque traité.
      const scannedDocumentId = file
        ? (await uploadScannedDocument(file)).mailScannedDocumentId
        : undefined;

      await createDepart({
        title: v.title.trim(),
        date: v.date.format('YYYY-MM-DD'),
        mailDepartTypeId: v.mailDepartTypeId,
        nReference: v.nReference?.trim() || undefined,
        externalEntityId: v.externalEntityId,
        parentMailId: v.parentMailId,
        scannedDocumentId,
      });
      message.success('Courrier de départ créé.');
      form.resetFields();
      setFile(null);
    } catch (e) {
      message.error(e instanceof Error ? e.message : 'Création impossible');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div style={{ maxWidth: CONTENT_MAX_WIDTH }}>
      <PageHeader icon="send" title="Courrier de départ" />

      <Card>
        <Form<DepartForm> form={form} layout="vertical" onFinish={(v) => void submit(v)}>
          <FormSection first icon="mail" title="Identification">
            <Row gutter={16}>
              <Col xs={24} md={12}>
                <Form.Item
                  name="title"
                  label="Objet du courrier"
                  rules={[{ required: true, message: "L'objet est obligatoire" }]}
                >
                  <Input placeholder="Ex. Réponse à la demande de subvention" />
                </Form.Item>
              </Col>
              <Col xs={24} md={12}>
                <Form.Item
                  name="date"
                  label="Date du courrier"
                  rules={[{ required: true, message: 'La date est obligatoire' }]}
                >
                  <DatePicker
                    style={{ width: '100%' }}
                    format="DD/MM/YYYY"
                    placeholder="JJ/MM/AAAA"
                  />
                </Form.Item>
              </Col>

              <Col xs={24} md={12}>
                <Form.Item name="mailDepartTypeId" label="Type de courrier départ">
                  <Select
                    allowClear
                    showSearch
                    optionFilterProp="label"
                    placeholder="Sélectionnez un type…"
                    notFoundContent="Aucun type de courrier départ paramétré"
                    onChange={(v) => void onTypeChange(v as number | undefined)}
                    options={departTypes.map((t) => ({
                      value: t.mailDepartTypeId,
                      label: t.label,
                    }))}
                  />
                </Form.Item>
              </Col>
              <Col xs={24} md={12}>
                <Form.Item
                  name="nReference"
                  label="N° de référence"
                  extra="Proposé automatiquement selon le type (numérotation par type)."
                >
                  <Input className="da-mono" placeholder="Généré si vide" />
                </Form.Item>
              </Col>
            </Row>
          </FormSection>

          <FormSection icon="users" title="Destinataire et courrier lié">
            <Row gutter={16}>
              <Col xs={24} md={12}>
                <Form.Item name="externalEntityId" label="Destinataire externe">
                  <Select
                    allowClear
                    showSearch
                    optionFilterProp="label"
                    placeholder="Sélectionnez un correspondant…"
                    notFoundContent="Aucune entité externe enregistrée"
                    // Le courrier lié appartient au correspondant : changer de correspondant
                    // invalide la sélection précédente, qui pointerait sur le courrier d'un tiers.
                    // `setFields` et non `setFieldValue` — cf. onTypeChange (faux positif antd).
                    onChange={() => form.setFields([{ name: 'parentMailId', value: undefined }])}
                    options={entities.map((e) => ({ value: e.externalEntityId, label: e.label }))}
                  />
                </Form.Item>
              </Col>

              <Col xs={24} md={12}>
                <Form.Item
                  name="parentMailId"
                  label="Lié au courrier"
                  extra="Courriers du destinataire externe sélectionné. Le courrier lié est archivé à la création du départ."
                >
                  <Select
                    allowClear
                    showSearch
                    optionFilterProp="label"
                    loading={linkablesLoading}
                    disabled={externalEntityId == null}
                    placeholder={
                      externalEntityId == null ? 'Choisissez d’abord un destinataire externe…' : '—'
                    }
                    notFoundContent={
                      linkablesLoading
                        ? 'Chargement…'
                        : 'Aucun courrier enregistré pour ce correspondant'
                    }
                    options={linkableOptions}
                  />
                </Form.Item>
              </Col>
            </Row>
          </FormSection>

          <FormSection icon="document" title="Pièce jointe">
            <Row gutter={16}>
              <Col xs={24} md={12}>
                <Form.Item label="Courrier à envoyer (PDF, facultatif)">
                  {/* AntD ne gère aucune liste (`LIST_IGNORE` systématique) : le fichier retenu est
                      notre seul état, et un nouveau dépôt remplace simplement le précédent. Le File
                      reste hors du store du Form, que rc-field-form clone en profondeur. */}
                  <Upload.Dragger
                    accept=".pdf"
                    showUploadList={false}
                    beforeUpload={(f) => {
                      if (f.name.toLowerCase().endsWith('.pdf')) setFile(f);
                      else message.error('Seuls les fichiers PDF sont acceptés.');
                      return Upload.LIST_IGNORE;
                    }}
                  >
                    <Space>
                      <Button icon={<icons.upload size={16} />}>Parcourir</Button>
                      <span>ou déposez les fichiers ici</span>
                    </Space>
                  </Upload.Dragger>
                  {file && (
                    <Space style={{ marginTop: 8 }}>
                      <icons.document size={14} />
                      <span>{file.name}</span>
                      <Button type="link" size="small" danger onClick={() => setFile(null)}>
                        Retirer
                      </Button>
                    </Space>
                  )}
                </Form.Item>
              </Col>
            </Row>
          </FormSection>

          <Divider style={{ marginTop: 8 }} />
          <Space>
            <Button
              type="primary"
              htmlType="submit"
              loading={saving}
              icon={<icons.add size={16} />}
            >
              Créer le courrier de départ
            </Button>
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

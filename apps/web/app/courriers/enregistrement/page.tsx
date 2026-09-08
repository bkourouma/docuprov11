'use client';

import { Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import {
  Alert,
  App,
  Button,
  Card,
  Checkbox,
  Col,
  DatePicker,
  Divider,
  Form,
  Input,
  Row,
  Select,
  Space,
  Spin,
  Tooltip,
  Upload,
  type UploadFile,
} from 'antd';
import dayjs, { type Dayjs } from 'dayjs';
import { PageHeader } from '../../components/PageHeader';
import { AiFilledTag, FormSection } from '../../components/FormSection';
import { icons } from '../../theme/icons';
import { NewExternalEntityModal } from '../../components/mail/NewExternalEntityModal';
import { personName } from '../../components/mail/mailFormat';
import {
  aiExtractionAvailability,
  createArrivee,
  extractMailWithAi,
  externalEntityTypesApi,
  getScannedDocument,
  listActors,
  listDestinataireRoles,
  listExternalEntities,
  nextArriveeReference,
  uploadScannedDocument,
  type Actor,
  type DestinataireRole,
  type ExternalEntityRow,
  type ExternalEntityTypeRow,
  type MailAiExtraction,
} from '../../lib/courriers';

/** Extensions lisibles par l'analyse IA — doit rester aligné sur `MEDIA_TYPES` côté API. */
const AI_ACCEPT = '.pdf,.jpg,.jpeg,.png,.gif,.webp';

/**
 * Largeur maximale de la colonne de saisie : au-delà, la ligne devient trop longue à parcourir
 * entre son libellé et sa fin. La grille étant à deux colonnes, le bloc vaut deux fois cette
 * largeur plus la gouttière.
 */
const FIELD_COL_MAX = 640;
const CONTENT_MAX_WIDTH = FIELD_COL_MAX * 2 + 16;

interface FormValues {
  title: string;
  date: Dayjs;
  nReference?: string;
  reference?: string;
  dateEnregistrementCourrier?: Dayjs;
  externalEntityId?: number;
  destinataireRoleId: number;
  enCopieUserGroupIds?: number[];
  description?: string;
  file?: UploadFile[];
}

function EnregistrementForm() {
  const { message } = App.useApp();
  const router = useRouter();
  const params = useSearchParams();
  const scanIdParam = params.get('scanId');
  const scanId = scanIdParam ? Number(scanIdParam) : null;

  const [form] = Form.useForm<FormValues>();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const [actors, setActors] = useState<Actor[]>([]);
  const [roles, setRoles] = useState<DestinataireRole[]>([]);
  const [entities, setEntities] = useState<Array<{ externalEntityId: number; label: string }>>([]);
  const [entityTypes, setEntityTypes] = useState<ExternalEntityTypeRow[]>([]);
  const [scanFile, setScanFile] = useState<string | null>(null);
  const [newEntityOpen, setNewEntityOpen] = useState(false);

  // Saisie automatique par IA : proposée seulement si l'API a une clé configurée.
  const [aiAvailable, setAiAvailable] = useState(false);
  const [aiEnabled, setAiEnabled] = useState(false);
  const [analysing, setAnalysing] = useState(false);
  const [unmatchedSender, setUnmatchedSender] = useState<string | null>(null);
  // Champs pré-remplis par l'IA (§8.I : "clearly show AI-filled fields") — retiré du lot dès que
  // l'agent modifie le champ à la main, car ce n'est plus une valeur proposée par le modèle.
  const [aiFilled, setAiFilled] = useState<Set<string>>(new Set());
  // Garde contre le faux positif : `form.setFieldsValue()` déclenche aussi `onValuesChange`, qui
  // sinon effacerait les tags « IA » à l'instant même où on vient de les poser.
  const justAiSetRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    void (async () => {
      const [a, r, e, t, ref, ai] = await Promise.all([
        listActors().catch(() => [] as Actor[]),
        listDestinataireRoles().catch(() => [] as DestinataireRole[]),
        listExternalEntities().catch(() => []),
        // Types : uniquement pour le formulaire de création d'expéditeur (le champ y est facultatif).
        externalEntityTypesApi.list().catch(() => [] as ExternalEntityTypeRow[]),
        nextArriveeReference().catch(() => ({ nReference: '' })),
        aiExtractionAvailability().catch(() => ({ enabled: false })),
      ]);
      setActors(a);
      setRoles(r);
      setEntities(e);
      setEntityTypes(t);
      setAiAvailable(ai.enabled);
      form.setFieldsValue({
        nReference: ref.nReference || undefined,
        // Jour seul : l'heure d'enregistrement est posée à la soumission (cf. `submit`), pas au
        // chargement de l'écran.
        dateEnregistrementCourrier: dayjs().startOf('day'),
      });
      if (scanId != null) {
        const scan = await getScannedDocument(scanId).catch(() => null);
        if (scan) setScanFile(scan.fileName ?? `Scan #${scanId}`);
      }
      setLoading(false);
    })();
  }, [form, scanId]);

  const actorOptions = useMemo(
    () => actors.map((a) => ({ value: a.userGroupId, label: personName(a.label) })),
    [actors],
  );

  /**
   * Expéditeur fraîchement créé depuis le « + » : on l'ajoute à la liste et on le sélectionne dans
   * le formulaire — c'est bien celui du courrier en cours de saisie.
   */
  const onEntityCreated = (created: ExternalEntityRow) => {
    setEntities((prev) => [...prev, created]);
    // `setFields` et non `setFieldValue` — ce dernier réassigne des tableaux d'erreurs frais au
    // champ et déclenche le faux positif antd « There may be circular references » (rc-util).
    form.setFields([{ name: 'externalEntityId', value: created.externalEntityId }]);
  };

  // Un rôle sans porteur n'enverrait le courrier à personne : on le laisse sélectionnable (le
  // paramétrage des rôles peut être en cours) mais l'écran le dit, plutôt qu'un envoi muet.
  const roleOptions = useMemo(
    () =>
      roles.map((r) => ({
        value: r.roleId,
        label: r.userCount > 0 ? r.label : `${r.label} (aucun utilisateur)`,
      })),
    [roles],
  );

  /**
   * Analyse le document déposé et pose les valeurs lues dans le formulaire. Le modèle propose,
   * l'agent dispose : rien n'est enregistré ici, et les champs restent modifiables. On ne touche
   * ni au n° d'enregistrement (attribué par le serveur) ni à la date d'enregistrement (aujourd'hui).
   */
  const analyse = async (file: File) => {
    setAnalysing(true);
    setUnmatchedSender(null);
    try {
      const r: MailAiExtraction = await extractMailWithAi(file);

      // Une date illisible par dayjs (format inattendu, jour inexistant) est ignorée plutôt que
      // posée en « Invalid Date », qui casserait le DatePicker sans rien dire.
      const date = r.date ? dayjs(r.date, 'YYYY-MM-DD', true) : null;
      const filled: Partial<FormValues> = {};
      if (r.title) filled.title = r.title;
      if (date?.isValid()) filled.date = date;
      if (r.reference) filled.reference = r.reference;
      if (r.externalEntityId != null) filled.externalEntityId = r.externalEntityId;
      if (r.destinataireRoleId != null) filled.destinataireRoleId = r.destinataireRoleId;
      if (r.description) filled.description = r.description;

      // Un PDF analysé EST le courrier numérisé : on le pose aussi dans le champ de dépôt pour
      // éviter à l'agent de sélectionner deux fois le même fichier. Une image, elle, ne convient
      // pas au champ (réservé au PDF) et n'y est pas reportée.
      if (file.name.toLowerCase().endsWith('.pdf')) {
        filled.file = [
          {
            uid: '-1',
            name: file.name,
            status: 'done',
            originFileObj: file as UploadFile['originFileObj'],
          },
        ];
      }

      const filledFieldNames = Object.keys(filled).filter((k) => k !== 'file');
      justAiSetRef.current = new Set(filledFieldNames);
      form.setFieldsValue(filled);
      setAiFilled(new Set(filledFieldNames));
      const count = filledFieldNames.length;
      if (count === 0) {
        message.warning("Aucune donnée exploitable n'a pu être lue sur ce document.");
      } else {
        message.success(
          `${count} champ${count > 1 ? 's' : ''} pré-rempli${count > 1 ? 's' : ''}. Relisez avant d'enregistrer.`,
        );
      }

      // Expéditeur lu mais absent du référentiel : on le signale avec le nom, plutôt que de laisser
      // le champ vide sans explication — l'agent crée la fiche via le « + ».
      if (r.externalEntityId == null && r.externalEntityLabel) {
        setUnmatchedSender(r.externalEntityLabel);
      }
    } catch (e) {
      message.error(e instanceof Error ? e.message : "Échec de l'analyse du document");
    } finally {
      setAnalysing(false);
    }
  };

  const submit = async (v: FormValues) => {
    setSaving(true);
    try {
      // §05 : l'heure d'enregistrement est celle du clic « Enregistrer le courrier ». Le champ ne
      // porte que le jour ; l'heure est posée ici, sinon un écran resté ouvert horodaterait le
      // courrier à l'heure de son ouverture.
      const now = dayjs();
      const dateEnregistrementCourrier = v.dateEnregistrementCourrier
        ?.hour(now.hour())
        .minute(now.minute())
        .second(now.second())
        .millisecond(now.millisecond());

      // Le PDF entre par la file §07, seule porte d'entrée d'un binaire dans le flux courrier :
      // on dépose d'abord, puis l'enregistrement promeut le scan en document GED et le marque traité.
      let scannedDocumentId = scanId ?? undefined;
      const picked = v.file?.[0]?.originFileObj;
      if (picked) {
        scannedDocumentId = (await uploadScannedDocument(picked)).mailScannedDocumentId;
      }

      await createArrivee({
        title: v.title.trim(),
        date: v.date.format('YYYY-MM-DD'),
        destinataireRoleId: v.destinataireRoleId,
        nReference: v.nReference?.trim() || undefined,
        reference: v.reference?.trim() || undefined,
        description: v.description?.trim() || undefined,
        dateEnregistrementCourrier: dateEnregistrementCourrier?.toISOString(),
        externalEntityId: v.externalEntityId,
        enCopieUserGroupIds: v.enCopieUserGroupIds?.length ? v.enCopieUserGroupIds : undefined,
        scannedDocumentId,
      });
      message.success('Courrier enregistré.');
      // On reste sur l'écran de saisie pour enchaîner l'enregistrement du courrier suivant,
      // au lieu de rediriger vers le Contrôle.
      form.resetFields();
      setScanFile(null);
      setAiFilled(new Set());
      setUnmatchedSender(null);
      const ref = await nextArriveeReference().catch(() => ({ nReference: '' }));
      form.setFieldsValue({
        nReference: ref.nReference || undefined,
        dateEnregistrementCourrier: dayjs().startOf('day'),
      });
      if (scanId != null) router.replace('/courriers/enregistrement');
    } catch (e) {
      message.error(e instanceof Error ? e.message : "Échec de l'enregistrement");
    } finally {
      setSaving(false);
    }
  };

  // Retire un champ du lot « IA » dès que l'agent le modifie lui-même — sauf si ce changement est
  // celui que l'analyse IA vient tout juste de poser (voir `justAiSetRef`).
  const onValuesChange = (changed: Partial<FormValues>) => {
    const keys = Object.keys(changed);
    if (keys.length === 0) return;
    setAiFilled((prev) => {
      if (prev.size === 0) return prev;
      let next = prev;
      for (const k of keys) {
        if (justAiSetRef.current.has(k)) {
          justAiSetRef.current.delete(k);
          continue;
        }
        if (next.has(k)) {
          if (next === prev) next = new Set(prev);
          next.delete(k);
        }
      }
      return next;
    });
  };

  /** Libellé de champ + étiquette « IA » si l'analyse automatique vient de le pré-remplir. */
  const labelWithAi = (text: string, key: keyof FormValues) => (
    <Space size={6}>
      <span>{text}</span>
      {aiFilled.has(key) && <AiFilledTag />}
    </Space>
  );

  return (
    <div style={{ maxWidth: CONTENT_MAX_WIDTH }}>
      <PageHeader icon="add" title="Enregistrement d'un courrier" />

      <NewExternalEntityModal
        open={newEntityOpen}
        onClose={() => setNewEntityOpen(false)}
        onCreated={onEntityCreated}
        types={entityTypes}
      />

      {scanFile && (
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 16 }}
          message="Document scanné rattaché"
          description={
            <>
              Ce courrier sera rattaché au scan <span className="da-mono">{scanFile}</span>, qui
              sera marqué comme traité à l&apos;enregistrement.
            </>
          }
        />
      )}

      {aiAvailable && (
        <Card size="small" style={{ marginBottom: 16 }}>
          <Checkbox
            checked={aiEnabled}
            onChange={(e) => {
              setAiEnabled(e.target.checked);
              if (!e.target.checked) {
                setUnmatchedSender(null);
                setAiFilled(new Set());
              }
            }}
          >
            Saisie automatique par IA
          </Checkbox>

          {aiEnabled && (
            <div style={{ marginTop: 12 }}>
              <Spin spinning={analysing} tip="Analyse du document en cours…">
                <Upload.Dragger
                  accept={AI_ACCEPT}
                  maxCount={1}
                  showUploadList={false}
                  disabled={analysing}
                  // Dépôt local : le fichier part vers l'analyse, pas vers le coffre — d'où le
                  // `false`, qui coupe l'envoi XHR interne d'AntD.
                  beforeUpload={(f) => {
                    void analyse(f as unknown as File);
                    return false;
                  }}
                >
                  <p style={{ margin: 0 }}>
                    <icons.upload size={22} />
                  </p>
                  <p className="ant-upload-text">Déposer le courrier à analyser</p>
                  <p className="ant-upload-hint">PDF, JPG, PNG, GIF ou WebP — 10 Mo maximum.</p>
                </Upload.Dragger>
              </Spin>

              {unmatchedSender && (
                <Alert
                  type="warning"
                  showIcon
                  style={{ marginTop: 12 }}
                  message="Expéditeur non reconnu"
                  description={
                    <>
                      Le document mentionne <strong>{unmatchedSender}</strong>, absent des
                      correspondants enregistrés. Sélectionnez-en un, ou créez-le avec le bouton « +
                      » du champ Expéditeur.
                    </>
                  }
                />
              )}
            </div>
          )}
        </Card>
      )}

      <Card>
        <Spin spinning={loading}>
          <Form<FormValues>
            form={form}
            layout="vertical"
            onFinish={(v) => void submit(v)}
            onValuesChange={onValuesChange}
            requiredMark
          >
            <FormSection first icon="mail" title="Identification du courrier">
              <Row gutter={16}>
                <Col xs={24} md={12}>
                  <Form.Item
                    name="title"
                    label={labelWithAi('Objet du courrier', 'title')}
                    rules={[{ required: true, message: "L'objet est obligatoire" }]}
                  >
                    <Input placeholder="Ex. Demande de subvention" />
                  </Form.Item>
                </Col>
                <Col xs={24} md={12}>
                  <Form.Item
                    name="date"
                    label={labelWithAi('Date du courrier', 'date')}
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
                  <Form.Item
                    name="dateEnregistrementCourrier"
                    label="Date d'enregistrement"
                    rules={[
                      { required: true, message: "La date d'enregistrement est obligatoire" },
                    ]}
                  >
                    <DatePicker
                      style={{ width: '100%' }}
                      format="DD/MM/YYYY"
                      placeholder="JJ/MM/AAAA"
                    />
                  </Form.Item>
                </Col>
                <Col xs={24} md={12}>
                  <Form.Item
                    name="nReference"
                    label="N° d'enregistrement"
                    rules={[{ required: true, message: "Le n° d'enregistrement est obligatoire" }]}
                  >
                    <Input className="da-mono" placeholder="Ex. 2026-0001" />
                  </Form.Item>
                </Col>
              </Row>
            </FormSection>

            <FormSection icon="users" title="Expéditeur et destinataire">
              <Row gutter={16}>
                <Col xs={24} md={12}>
                  <Form.Item
                    name="reference"
                    label={labelWithAi('Référence expéditeur', 'reference')}
                    rules={[{ required: true, message: 'La référence expéditeur est obligatoire' }]}
                  >
                    <Input placeholder="Référence du correspondant" />
                  </Form.Item>
                </Col>
                <Col xs={24} md={12}>
                  <Form.Item
                    label={labelWithAi('Expéditeur (entité externe)', 'externalEntityId')}
                    required
                  >
                    <Space.Compact style={{ width: '100%' }}>
                      {/* Le Form.Item porteur du champ est `noStyle` : sans cela AntD imbriquerait
                          deux libellés, et la règle « obligatoire » se dupliquerait à l'écran. */}
                      <Form.Item
                        name="externalEntityId"
                        noStyle
                        rules={[{ required: true, message: "L'expéditeur est obligatoire" }]}
                      >
                        <Select
                          allowClear
                          showSearch
                          optionFilterProp="label"
                          placeholder="Sélectionner un correspondant"
                          options={entities.map((e) => ({
                            value: e.externalEntityId,
                            label: e.label,
                          }))}
                        />
                      </Form.Item>
                      <Tooltip title="Créer un expéditeur">
                        <Button
                          // Aucune taille ni hauteur forcee : le bouton fait la meme hauteur que
                          // le champ auquel il est colle, les deux tiennent de `controlHeight`.
                          icon={<icons.add size={16} />}
                          aria-label="Créer un expéditeur"
                          onClick={() => setNewEntityOpen(true)}
                        />
                      </Tooltip>
                    </Space.Compact>
                  </Form.Item>
                </Col>

                <Col xs={24} md={12}>
                  <Form.Item
                    name="destinataireRoleId"
                    label={labelWithAi('Destinataire', 'destinataireRoleId')}
                    rules={[{ required: true, message: 'Le destinataire est obligatoire' }]}
                  >
                    <Select
                      showSearch
                      optionFilterProp="label"
                      placeholder="Sélectionner un rôle destinataire"
                      options={roleOptions}
                    />
                  </Form.Item>
                </Col>
                <Col xs={24} md={12}>
                  <Form.Item name="enCopieUserGroupIds" label="En copie (facultatif)">
                    <Select
                      mode="multiple"
                      allowClear
                      showSearch
                      optionFilterProp="label"
                      placeholder="Aucun"
                      options={actorOptions}
                    />
                  </Form.Item>
                </Col>
              </Row>
            </FormSection>

            <FormSection icon="document" title="Pièce jointe et description">
              <Row gutter={16}>
                <Col xs={24} md={12}>
                  <Form.Item
                    name="file"
                    label="Courrier numérisé (PDF)"
                    valuePropName="fileList"
                    getValueFromEvent={(e: { fileList?: UploadFile[] }) => e?.fileList ?? []}
                    // Arrivé depuis la file §07, le binaire est déjà là : n'exiger un dépôt que
                    // lorsqu'aucun scan n'est rattaché, sinon le parcours scan devient insoumettable.
                    rules={
                      scanId == null
                        ? [{ required: true, message: 'Le courrier numérisé est obligatoire' }]
                        : undefined
                    }
                  >
                    <Upload
                      accept=".pdf"
                      maxCount={1}
                      listType="text"
                      beforeUpload={(f) => {
                        if (!f.name.toLowerCase().endsWith('.pdf')) {
                          message.error('Seuls les fichiers PDF sont acceptés.');
                          return Upload.LIST_IGNORE;
                        }
                        return false; // dépôt différé : le binaire ne part qu'à la soumission
                      }}
                    >
                      <Button icon={<icons.upload size={16} />}>Sélectionner un PDF</Button>
                    </Upload>
                  </Form.Item>
                </Col>

                <Col xs={24} md={12}>
                  <Form.Item
                    name="description"
                    label={labelWithAi('Résumé / description (facultatif)', 'description')}
                  >
                    <Input.TextArea rows={3} placeholder="Résumé du courrier" />
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
                icon={<icons.check size={16} />}
              >
                Enregistrer le courrier
              </Button>
              <Button onClick={() => router.back()}>Annuler</Button>
            </Space>
          </Form>
        </Spin>
      </Card>
    </div>
  );
}

export default function EnregistrementPage() {
  return (
    <Suspense fallback={null}>
      <EnregistrementForm />
    </Suspense>
  );
}

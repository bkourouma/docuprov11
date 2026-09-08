'use client';

import { useEffect, useMemo, useState } from 'react';
import {
  App,
  Button,
  Col,
  DatePicker,
  Input,
  Row,
  Select,
  Skeleton,
  Space,
  TreeSelect,
  Typography,
} from 'antd';
import dayjs, { type Dayjs } from 'dayjs';
import {
  documentsApi,
  lookups,
  metaDataDocumentTypesApi,
  type ConfidentialiteOption,
  type DocumentDetail,
  type DocumentTypeOption,
  type DossierOption,
  type MetaDataField,
  type PlanOption,
} from '../../lib/archives';
import { filterByLabel, filterByTitle } from '../../lib/filters';
import { MetaDataFields, type MetaValues } from '../MetaDataFields';
import { InfoCard } from '../InfoCard';
import { TabSkeleton } from './shared';
import { icons } from '../../theme/icons';
import { fontSize, space } from '../../theme/tokens';

const { Text } = Typography;

interface TreeOpt {
  value: number;
  title: string;
  children?: TreeOpt[];
}

/** Arborescence antd depuis une liste plate reliée par `parentId`. */
function buildTree<T extends { parentId: number | null }>(
  rows: T[],
  idOf: (r: T) => number,
  titleOf: (r: T) => string,
): TreeOpt[] {
  const byId = new Map<number, TreeOpt>();
  rows.forEach((r) => byId.set(idOf(r), { value: idOf(r), title: titleOf(r) }));
  const roots: TreeOpt[] = [];
  rows.forEach((r) => {
    const node = byId.get(idOf(r))!;
    const parent = r.parentId != null ? byId.get(r.parentId) : undefined;
    if (parent) (parent.children ??= []).push(node);
    else roots.push(node);
  });
  return roots;
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <Text
        type="secondary"
        style={{
          display: 'block',
          marginBottom: space.xs,
          fontSize: fontSize.sm,
          whiteSpace: 'nowrap',
        }}
      >
        {label}
      </Text>
      {children}
    </div>
  );
}

/**
 * Onglet « Indexation » : réindexation COMPLÈTE d'un document déjà archivé — classement et
 * métadonnées en une seule opération, comme le formulaire `UpdateDocument` du module source.
 *
 * Les champs de métadonnées suivent le type SÉLECTIONNÉ dans le formulaire, pas celui enregistré :
 * changer le type doit montrer immédiatement les champs qu'il attend, avant même d'enregistrer.
 * Les valeurs d'une métadonnée partagée par les deux types sont conservées (le serveur applique
 * la même règle et purge celles qui deviennent hors-type).
 */
export function IndexationTab({
  detail,
  onSaved,
}: {
  detail: DocumentDetail;
  onSaved: () => void;
}) {
  const { message } = App.useApp();

  const [types, setTypes] = useState<DocumentTypeOption[]>([]);
  const [dossiers, setDossiers] = useState<DossierOption[]>([]);
  const [plans, setPlans] = useState<PlanOption[]>([]);
  const [confidentialites, setConfidentialites] = useState<ConfidentialiteOption[]>([]);
  const [refsLoading, setRefsLoading] = useState(true);

  const [label, setLabel] = useState(detail.label);
  const [typeId, setTypeId] = useState<number | null>(detail.documentTypeId);
  const [dossierId, setDossierId] = useState<number | null>(detail.dossierId);
  const [planId, setPlanId] = useState<number | null>(detail.planId);
  // Confidentialité : affichée ici avec le reste du classement, mais enregistrée par sa propre
  // route (cf. `documentsApi.setConfidentialite`).
  const [confidentialiteId, setConfidentialiteId] = useState<number | null>(detail.confidentialiteId);
  // `documentDate` reste `null` tant que personne n'a indexé le document (le worker ne la pose
  // jamais à la création) : à défaut, on affiche la date d'enregistrement (`createdAt`, toujours
  // renseignée) plutôt qu'un champ vide qui laisserait croire qu'aucune date n'existe.
  const [date, setDate] = useState<Dayjs | null>(dayjs(detail.documentDate ?? detail.createdAt));

  const [fields, setFields] = useState<MetaDataField[]>([]);
  const [fieldsLoading, setFieldsLoading] = useState(false);
  const [values, setValues] = useState<MetaValues>(() =>
    Object.fromEntries(detail.metadataValues.map((v) => [v.metaDataId, v])),
  );
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    void (async () => {
      const [t, d, p, c] = await Promise.all([
        lookups.documentTypes().catch(() => [] as DocumentTypeOption[]),
        lookups.dossiers().catch(() => [] as DossierOption[]),
        lookups.plans().catch(() => [] as PlanOption[]),
        lookups.confidentialites().catch(() => [] as ConfidentialiteOption[]),
      ]);
      setTypes(t);
      setDossiers(d);
      setPlans(p);
      setConfidentialites(c);
      setRefsLoading(false);
    })();
  }, []);

  // Champs du type SÉLECTIONNÉ — rechargés à chaque changement pour que le formulaire reflète
  // immédiatement ce que le nouveau type attend.
  useEffect(() => {
    if (typeId == null) {
      setFields([]);
      return;
    }
    let cancelled = false;
    setFieldsLoading(true);
    void metaDataDocumentTypesApi
      .fields(typeId)
      .then((f) => {
        if (!cancelled) setFields(f);
      })
      .catch(() => {
        if (!cancelled) setFields([]);
      })
      .finally(() => {
        if (!cancelled) setFieldsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [typeId]);

  const typeOptions = useMemo(
    () => types.map((t) => ({ value: t.documentTypeId, label: t.label })),
    [types],
  );
  // Référentiel ORDONNÉ par `rank` (du plus ouvert au plus restreint) : l'ordre du serveur est
  // conservé tel quel, il porte la règle d'accès.
  const confidentialiteOptions = useMemo(
    () => confidentialites.map((c) => ({ value: c.confidentialiteId, label: c.label })),
    [confidentialites],
  );
  const dossierTree = useMemo(
    () =>
      buildTree(
        dossiers,
        (d) => d.dossierId,
        (d) => d.label,
      ),
    [dossiers],
  );
  // Libellé seul, sans la cote : cohérent avec l'affichage du plan ailleurs dans l'écran.
  const planTree = useMemo(
    () =>
      buildTree(
        plans,
        (p) => p.planId,
        (p) => p.label,
      ),
    [plans],
  );

  const save = async () => {
    if (!label.trim()) {
      message.warning('Le libellé est obligatoire.');
      return;
    }
    setSaving(true);
    try {
      await documentsApi.index(detail.documentId, {
        label: label.trim(),
        documentTypeId: typeId,
        dossierId,
        planId,
        documentDate: date ? date.format('YYYY-MM-DD') : null,
        // Envoi EXHAUSTIF des champs du type : un champ vidé à l'écran doit effacer sa valeur.
        metadataValues: fields.map((f) => ({
          metaDataId: f.metaDataId,
          value: values[f.metaDataId]?.value ?? null,
          metaDataListItemId: values[f.metaDataId]?.metaDataListItemId ?? null,
        })),
      });
      // Seconde route, et seulement si la valeur a bougé : le PATCH d'indexation refuse ce champ.
      if (confidentialiteId !== detail.confidentialiteId) {
        await documentsApi.setConfidentialite(detail.documentId, confidentialiteId);
      }
      message.success('Indexation enregistrée.');
      onSaved();
    } catch (e) {
      message.error(e instanceof Error ? e.message : 'Échec de l’enregistrement');
    } finally {
      setSaving(false);
    }
  };

  if (refsLoading) {
    return <TabSkeleton rows={6} />;
  }

  return (
    <Space direction="vertical" size="large" style={{ width: '100%' }}>
      <Row gutter={[16, 16]}>
        <Col xs={24} lg={12}>
          <InfoCard icon="document" title="Document">
            <Space direction="vertical" size={14} style={{ width: '100%' }}>
              <Field label="Libellé">
                <Input
                  value={label}
                  onChange={(e) => setLabel(e.target.value)}
                  placeholder="Libellé du document"
                />
              </Field>
              <Field label="Type de document">
                <Select
                  style={{ width: '100%' }}
                  value={typeId ?? undefined}
                  onChange={(v) => setTypeId((v as number) ?? null)}
                  options={typeOptions}
                  allowClear
                  showSearch
                  filterOption={filterByLabel}
                  placeholder="Sélectionner un type"
                />
              </Field>
              <Field label="Enregistré le">
                <DatePicker
                  style={{ width: '100%' }}
                  value={date}
                  onChange={(d) => setDate(d)}
                  format="DD/MM/YYYY"
                  placeholder="JJ/MM/AAAA"
                />
              </Field>
              <Field label="Dossier">
                <TreeSelect
                  style={{ width: '100%' }}
                  value={dossierId ?? undefined}
                  onChange={(v) => setDossierId((v as number) ?? null)}
                  treeData={dossierTree}
                  treeDefaultExpandAll
                  allowClear
                  showSearch
                  filterTreeNode={filterByTitle}
                  placeholder="Sélectionner un dossier"
                />
              </Field>
              <Field label="Plan de classement">
                <TreeSelect
                  style={{ width: '100%' }}
                  value={planId ?? undefined}
                  onChange={(v) => setPlanId((v as number) ?? null)}
                  treeData={planTree}
                  treeDefaultExpandAll
                  allowClear
                  showSearch
                  filterTreeNode={filterByTitle}
                  placeholder="Sélectionner un plan"
                />
              </Field>
              <Field label="Confidentialité">
                <Select
                  style={{ width: '100%' }}
                  value={confidentialiteId ?? undefined}
                  onChange={(v) => setConfidentialiteId((v as number) ?? null)}
                  options={confidentialiteOptions}
                  allowClear
                  showSearch
                  filterOption={filterByLabel}
                  placeholder="Sélectionner un niveau"
                />
              </Field>
            </Space>
          </InfoCard>
        </Col>
        <Col xs={24} lg={12}>
          <InfoCard
            icon="documentType"
            title="Métadonnée(s)"
            extra={
              typeId != null && (
                <Text type="secondary" style={{ fontSize: fontSize.xs, fontWeight: 400 }}>
                  {types.find((t) => t.documentTypeId === typeId)?.label ?? ''}
                </Text>
              )
            }
          >
            {fieldsLoading ? (
              // Squelette et non spinner : changer de type recharge les champs, et une carte qui
              // se vide puis se remplit ferait sauter la colonne de gauche à chaque essai.
              <Skeleton active title={false} paragraph={{ rows: 3 }} />
            ) : typeId == null ? (
              <Text type="secondary" style={{ fontSize: fontSize.xs }}>
                Choisissez un type de document pour voir ses champs.
              </Text>
            ) : fields.length === 0 ? (
              <Text type="secondary" style={{ fontSize: fontSize.xs }}>
                Ce type de document n’attend aucun champ supplémentaire.
              </Text>
            ) : (
              <MetaDataFields
                fields={fields}
                values={values}
                onChange={(metaDataId, value) =>
                  setValues((prev) => ({ ...prev, [metaDataId]: value }))
                }
              />
            )}
          </InfoCard>
        </Col>
      </Row>

      <div style={{ textAlign: 'right' }}>
        <Button
          type="primary"
          loading={saving}
          icon={<icons.check size={16} />}
          onClick={() => void save()}
        >
          Enregistrer l’indexation
        </Button>
      </div>
    </Space>
  );
}

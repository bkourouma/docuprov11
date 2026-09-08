'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import {
  Alert,
  App,
  Button,
  Card,
  Grid,
  Modal,
  Row,
  Col,
  Select,
  Space,
  Steps,
  Table,
  Tooltip,
  TreeSelect,
  Typography,
  Upload,
} from 'antd';
import type { TableColumnsType, UploadFile } from 'antd';
import { API_BASE, apiJson, apiUploadChunked } from '../lib/api';
import {
  documentTypeSettingsApi,
  metaDataDocumentTypesApi,
  type MetaDataField,
  type MetaDataValue,
} from '../lib/archives';
import { filterByLabel, filterByTitle } from '../lib/filters';
import { MetaDataFields, type MetaValues } from '../components/MetaDataFields';
import { PageHeader } from '../components/PageHeader';
import { EmptyState } from '../components/EmptyState';
import { PdfViewer } from '../components/viewer/PdfViewer';
import { StatusBadge } from '../components/StatusBadge';
import { StatusTile } from '../components/StatusTile';
import { BatchPipeline, type PipelinePhase } from '../components/BatchPipeline';
import { useFeedback } from '../components/feedback';
import { icons, type IconName } from '../theme/icons';
import { radii } from '../theme/tokens';

const { Text } = Typography;

/** Panneau de choix de mode (étape « Destination ») : cible cliquable compacte, façon carte radio. */
function ModeOptionCard({
  selected,
  title,
  icon,
  onSelect,
}: {
  selected: boolean;
  title: string;
  icon: IconName;
  onSelect: () => void;
}) {
  const Glyph = icons[icon];
  return (
    <Card
      hoverable
      onClick={onSelect}
      role="radio"
      aria-checked={selected}
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onSelect();
        }
      }}
      style={{
        height: '100%',
        // État choisi : bordure primaire de 2 px (l'ombre d'1 px d'avant se lisait
        // mal sur les cartes désormais plates), sans décaler la mise en page.
        borderColor: selected ? 'var(--ant-color-primary)' : undefined,
        outline: selected ? '1px solid var(--ant-color-primary)' : undefined,
        outlineOffset: -1,
        cursor: 'pointer',
      }}
      styles={{ body: { display: 'flex', gap: 8, alignItems: 'center', padding: '8px 12px' } }}
    >
      <span
        style={{
          width: 26,
          height: 26,
          borderRadius: radii.base,
          display: 'grid',
          placeItems: 'center',
          flex: 'none',
          background: selected
            ? 'var(--ant-color-primary-bg, #e8eefc)'
            : 'var(--ant-color-fill-quaternary)',
          color: selected ? 'var(--ant-color-primary, #0033c4)' : 'var(--ant-color-text-tertiary)',
        }}
      >
        <Glyph size={15} strokeWidth={1.75} />
      </span>
      <div style={{ minWidth: 0 }}>
        <Space align="center" size={6}>
          <Text strong style={{ fontSize: 13 }}>
            {title}
          </Text>
          {selected && (
            <icons.check
              size={14}
              strokeWidth={2.5}
              style={{ color: 'var(--ant-color-primary)' }}
            />
          )}
        </Space>
      </div>
    </Card>
  );
}

/** Les 4 étapes du wizard : 2 de préparation (pilotées par `wizardStep`) + 2 automatiques
 * (Traitement/Indexation, pilotées par le statut du lot une fois créé). */
const STEP_ITEMS = [
  { title: 'Destination' },
  { title: 'Fichiers' },
  { title: 'Traitement' },
  { title: 'Indexation' },
];

interface Batch {
  batchId: number;
  dossierId: number | null;
  status: number;
}
interface BatchStatus {
  status: number;
  fileCount: number;
  documentCount: number;
  processedFiles: number;
  useIntercalaires?: boolean;
}
interface DocFile {
  fileId: number;
  fileExtension: string;
  pageCount: number | null;
}
interface BatchDoc {
  documentId: number;
  label: string;
  cote: string | null;
  documentTypeId: number | null;
  planId: number | null;
  dossierId: number | null;
  confidentialiteId: number | null;
  documentDate: string | null;
  isArchived: boolean;
  /** Valeurs déjà enregistrées des métadonnées du type (renvoyées par le serveur). */
  metadataValues?: MetaDataValue[];
  file: DocFile | null;
}

/** Copie de travail d'un document : le tableau du serveur devient une map éditable par métadonnée. */
type DraftDoc = BatchDoc & { metaValues: MetaValues };
interface DocTypeRow {
  documentTypeId: number;
  label: string;
}
/**
 * Rappel du classement du lot pendant l'indexation, en lecture seule.
 *
 * Un `Descriptions` horizontal ne convient pas : dans le panneau étroit de la visionneuse, il
 * répartit la largeur entre ses colonnes et finit par casser les valeurs lettre à lettre
 * (« A rr êt é »). Ici le libellé occupe une colonne fixe et la valeur prend tout le reste, donc
 * le texte se coupe normalement, quelle que soit la largeur disponible.
 */
function ClassementLu({ items }: { items: Array<{ label: string; value: React.ReactNode }> }) {
  return (
    <div
      style={{
        display: 'grid',
        gap: 6,
        padding: '10px 12px',
        borderRadius: radii.card,
        background: 'var(--ant-color-bg-layout)',
      }}
    >
      {items.map((it) => (
        <div key={it.label} style={{ display: 'flex', gap: 10, alignItems: 'baseline' }}>
          <Text type="secondary" style={{ fontSize: 12, width: 118, flex: 'none' }}>
            {it.label}
          </Text>
          <span style={{ minWidth: 0, fontSize: 13, fontWeight: 500 }}>{it.value}</span>
        </div>
      ))}
    </div>
  );
}

/** Ligne de référentiel hiérarchique (plans, dossiers) : sert à reconstituer un chemin lisible. */
interface TreeRow {
  parentId: number | null;
  label: string;
  code?: string | null;
}

interface TreeOpt {
  value: number;
  title: string;
  children?: TreeOpt[];
}

/** Arborescence antd (TreeSelect) depuis une liste plate reliée par `parentId`. */
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

/** Value shared by every document for a field, or null when they differ (or the list is empty). */
function commonValue<T>(docs: BatchDoc[], get: (d: BatchDoc) => T): T | null {
  if (docs.length === 0) return null;
  const first = get(docs[0]!);
  return docs.every((d) => get(d) === first) ? first : null;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} o`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} Ko`;
  return `${(n / 1024 / 1024).toFixed(1)} Mo`;
}

export default function AcquisitionPage() {
  const { message } = App.useApp();
  const { confirm } = useFeedback();
  const screens = Grid.useBreakpoint();
  const isWide = screens.lg;

  // --- referentials (loaded once) ---
  const [docTypes, setDocTypes] = useState<DocTypeRow[]>([]);
  const [plans, setPlans] = useState<(TreeRow & { planId: number })[]>([]);
  const [dossiers, setDossiers] = useState<(TreeRow & { dossierId: number })[]>([]);
  const [confidentialites, setConfidentialites] = useState<
    { confidentialiteId: number; label: string }[]
  >([]);

  // --- setup phase ---
  // Type de document du lot, choisi EN AMONT : il commande la destination (dossier + plan lus dans
  // le paramétrage du type) et les champs de métadonnées proposés à l'indexation.
  const [batchTypeId, setBatchTypeId] = useState<number | null>(null);
  // Dossier et plan du lot : déduits du type, plus jamais saisis à la main sur cet écran.
  const [defaultPlanId, setDefaultPlanId] = useState<number | null>(null);
  const [dossierId, setDossierId] = useState<number | null>(null);
  // Confidentialité du lot : préremplie depuis le paramétrage du type, corrigeable ici — même
  // logique que `dossierId`/`defaultPlanId` (écrase le défaut du type au worker, cf. acquisition.processor.ts).
  const [confidentialiteId, setConfidentialiteId] = useState<number | null>(null);
  const [files, setFiles] = useState<UploadFile[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Mode d'acquisition : false = normal (tous les fichiers → 1 document) ; true = ancien système QR + OCR.
  const [useIntercalaires, setUseIntercalaires] = useState(false);
  // Étape courante du wizard de préparation (0 Destination — mode inclus, 1 Fichiers).
  const [wizardStep, setWizardStep] = useState(0);

  // --- batch ---
  const [batch, setBatch] = useState<Batch | null>(null);
  const [status, setStatus] = useState<BatchStatus | null>(null);
  const [documents, setDocuments] = useState<BatchDoc[]>([]);
  // Progression du téléversement (envoi par paquets) : la barre avance pendant l'upload, avant
  // que le polling du traitement ne prenne le relais.
  const [uploading, setUploading] = useState(false);
  const [uploadedFiles, setUploadedFiles] = useState(0);
  // Open the indexation viewer only once per batch (so closing it doesn't immediately reopen it).
  const autoOpenedBatchRef = useRef<number | null>(null);

  // --- indexation modal ---
  const [modalOpen, setModalOpen] = useState(false);
  const [idx, setIdx] = useState(0); // document shown in the viewer
  const [viewerUrl, setViewerUrl] = useState<string | null>(null);
  const [viewerLoading, setViewerLoading] = useState(false);
  const [savingAll, setSavingAll] = useState(false);
  const [dirty, setDirty] = useState(false);
  // Per-document working copy: editable rows of the indexation table.
  const [draftDocs, setDraftDocs] = useState<DraftDoc[]>([]);
  // L'enregistrement peut partir du raccourci clavier « Entrée », dont l'écouteur n'est réenregistré
  // qu'au changement de NOMBRE de documents : il capturerait sinon la copie de travail du rendu où
  // il a été posé, et perdrait toutes les saisies faites depuis. La ref est la source à jour.
  const draftDocsRef = useRef<DraftDoc[]>([]);
  // Champs de métadonnées par type de document, chargés à la demande. Le `ref` porte la vérité
  // (lisible sans attendre un rendu, et sert de verrou anti-appels concurrents) ; l'état ne sert
  // qu'à déclencher le rendu.
  const fieldsRef = useRef<Record<number, MetaDataField[]>>({});
  const [fieldsByType, setFieldsByType] = useState<Record<number, MetaDataField[]>>({});
  // Métadonnées communes, recopiées sur tout le lot via « Appliquer à tous » — seule saisie
  // partagée qui reste à l'indexation.
  const [cmMeta, setCmMeta] = useState<MetaValues>({});
  // Classement du lot, en LECTURE SEULE : valeur commune à tous les documents, ou `null` s'ils
  // diffèrent (lot QR hétérogène). Sert à afficher, et à savoir quels champs de type proposer.
  const [cmType, setCmType] = useState<number | null>(null);
  const [cmPlan, setCmPlan] = useState<number | null>(null);
  const [cmDossier, setCmDossier] = useState<number | null>(null);
  const [cmConfidentialite, setCmConfidentialite] = useState<number | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const [dt, pl, ds, conf] = await Promise.all([
          apiJson<DocTypeRow[]>('/referentials/document-types'),
          apiJson<(TreeRow & { planId: number })[]>('/referentials/plans'),
          apiJson<(TreeRow & { dossierId: number })[]>('/referentials/dossiers'),
          apiJson<{ confidentialiteId: number; label: string }[]>('/referentials/confidentialites'),
        ]);
        setDocTypes(dt);
        setPlans(pl);
        setDossiers(ds);
        setConfidentialites(conf);
      } catch {
        /* referentials are optional for upload; the form will just be sparse */
      }
    })();
  }, []);

  const typeOptions = useMemo(
    () => docTypes.map((t) => ({ value: t.documentTypeId, label: t.label })),
    [docTypes],
  );
  const typeLabel = useMemo(
    () => new Map(docTypes.map((t) => [t.documentTypeId, t.label])),
    [docTypes],
  );
  const planLabel = useMemo(() => new Map(plans.map((p) => [p.planId, p.label])), [plans]);
  const planTree = useMemo(
    () =>
      buildTree(
        plans,
        (p) => p.planId,
        (p) => p.label,
      ),
    [plans],
  );
  const confidentialiteLabel = useMemo(
    () => new Map(confidentialites.map((c) => [c.confidentialiteId, c.label])),
    [confidentialites],
  );

  /**
   * Chemin complet d'un dossier (« Direction et gouvernance › Instances et réunions »). Le seul
   * libellé serait ambigu : deux dossiers homonymes peuvent vivre sous deux grands dossiers
   * différents.
   */
  const dossierPath = useCallback(
    (targetId: number): string => {
      const byId = new Map(dossiers.map((d) => [d.dossierId, d]));
      const parts: string[] = [];
      let cur = byId.get(targetId);
      while (cur) {
        parts.unshift(cur.label);
        cur = cur.parentId != null ? byId.get(cur.parentId) : undefined;
      }
      return parts.join(' › ');
    },
    [dossiers],
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

  /**
   * Champs de métadonnées d'un type, mis en cache : un lot peut mélanger les types, et le tableau
   * d'indexation les redemanderait à chaque rendu. Renvoie la liste pour que l'appelant puisse
   * filtrer les valeurs dans la foulée (changement de type d'un document).
   */
  const loadFields = useCallback(async (typeId: number | null): Promise<MetaDataField[]> => {
    if (typeId == null) return [];
    const cached = fieldsRef.current[typeId];
    if (cached) return cached;
    try {
      const fields = await metaDataDocumentTypesApi.fields(typeId);
      fieldsRef.current = { ...fieldsRef.current, [typeId]: fields };
      setFieldsByType(fieldsRef.current);
      return fields;
    } catch {
      // Métadonnées indisponibles : l'indexation reste possible sur les champs standard.
      return [];
    }
  }, []);

  /**
   * Choix du type en amont : il précharge le dossier et le plan de classement PAR DÉFAUT
   * (paramétrage du type, écran « Paramétrage des types de documents »), que l'utilisateur peut
   * ensuite corriger dans les selects dédiés, et précharge ses champs de métadonnées pour que
   * l'indexation soit prête à la fin du traitement.
   */
  const onPickBatchType = useCallback(
    async (value: number | null) => {
      setBatchTypeId(value);
      setCmMeta({});
      setDefaultPlanId(null);
      setDossierId(null);
      setConfidentialiteId(null);
      if (value == null) return;
      void loadFields(value);
      try {
        const defaults = await documentTypeSettingsApi.defaults(value);
        setDefaultPlanId(defaults?.planId ?? null);
        setDossierId(defaults?.dossierId ?? null);
        setConfidentialiteId(defaults?.confidentialiteId ?? null);
      } catch {
        // Service indisponible : la destination reste vide, l'écran le signale et bloque la suite.
      }
    },
    [loadFields],
  );

  const loadDocuments = useCallback(async (batchId: number) => {
    const docs = await apiJson<BatchDoc[]>(`/batches/${batchId}/documents`);
    setDocuments(docs);
    return docs;
  }, []);

  const poll = useCallback(
    async (batchId: number) => {
      // Gros lots (jusqu'à ~200 fichiers) : la fusion + la file d'attente peuvent durer plusieurs
      // minutes. On attend donc longtemps (≈ 30 min) au lieu d'abandonner à ~3 min et de laisser
      // l'écran figé sur « Traitement en cours » alors que le worker finit plus tard.
      for (let i = 0; i < 900; i++) {
        try {
          const s = await apiJson<BatchStatus>(`/batches/${batchId}`);
          setStatus(s);
          if (s.status !== 0) {
            if (s.status === 1) await loadDocuments(batchId);
            return s;
          }
        } catch {
          /* hoquet réseau ponctuel : on retente au tour suivant plutôt que d'abandonner */
        }
        await new Promise((r) => setTimeout(r, 2000));
      }
      return null;
    },
    [loadDocuments],
  );

  const onSubmit = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      // En mode « avec intercalaires », le dossier et le plan viennent des intercalaires QR (pas
      // de pré-sélection). Le type part avec le lot : c'est le serveur qui classe les documents à
      // leur création, et l'indexation n'acceptera plus que les métadonnées.
      const body = {
        dossierId: useIntercalaires ? undefined : (dossierId ?? undefined),
        documentTypeId: batchTypeId ?? undefined,
        planId: useIntercalaires ? undefined : (defaultPlanId ?? undefined),
        confidentialiteId: useIntercalaires ? undefined : (confidentialiteId ?? undefined),
        useIntercalaires,
      };
      const created = await apiJson<Batch>('/batches', {
        method: 'POST',
        body: JSON.stringify(body),
      });
      setBatch(created);
      setStatus({ status: 0, fileCount: files.length, documentCount: 0, processedFiles: 0 });

      // Envoi par petits paquets séquentiels (gros lots : 200 PDF et au-delà) pour éviter
      // une requête multipart géante qui se fait couper ("Request aborted").
      // `onProgress` fait avancer la barre pendant l'envoi (sinon elle resterait figée).
      const pdfs = files.map((f) => f.originFileObj).filter(Boolean) as File[];
      setUploading(true);
      setUploadedFiles(0);
      await apiUploadChunked(`/batches/${created.batchId}/files`, pdfs, {
        onProgress: (sent) => setUploadedFiles(sent),
      });
      setUploading(false);
      message.success(
        useIntercalaires
          ? 'Lot téléversé, découpage QR + OCR en cours…'
          : 'Lot téléversé, chargement des documents en cours…',
      );
      const final = await poll(created.batchId);
      if (final?.status === 2)
        setError('Le traitement du lot a échoué. Vous pouvez relancer le traitement.');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Erreur inconnue');
    } finally {
      setUploading(false);
      setBusy(false);
    }
  }, [
    dossierId,
    defaultPlanId,
    confidentialiteId,
    batchTypeId,
    files,
    useIntercalaires,
    poll,
    message,
  ]);

  const reset = () => {
    setBatch(null);
    setStatus(null);
    setDocuments([]);
    setFiles([]);
    setError(null);
    setUploading(false);
    setUploadedFiles(0);
    // Vide aussi les champs de l'étape « Téléversement » (sinon ils restent remplis au lot suivant).
    setBatchTypeId(null);
    setDefaultPlanId(null);
    setDossierId(null);
    setCmMeta({});
    setWizardStep(0);
    autoOpenedBatchRef.current = null;
  };

  // En mode « avec intercalaires », le type, le dossier ET le plan proviennent des intercalaires
  // QR : rien n'est requis ici. En mode normal (fusion), le type du lot précharge des valeurs par
  // défaut (paramétrage du type), mais dossier et plan restent modifiables et doivent être
  // renseignés avant de continuer.
  const destinationOk =
    useIntercalaires || (batchTypeId != null && dossierId != null && defaultPlanId != null);
  const filesOk = files.length > 0;
  const canSubmit = filesOk && destinationOk;
  const destinationHint =
    batchTypeId == null
      ? 'Choisissez le type de document.'
      : dossierId == null
        ? 'Choisissez le dossier de destination.'
        : 'Choisissez le plan de classement.';
  const submitHint = canSubmit
    ? ''
    : files.length === 0
      ? 'Ajoutez au moins un fichier PDF.'
      : destinationHint;

  const currentDoc = draftDocs[idx] ?? null;
  // Un seul document (mode « sans intercalaire » fusionné, ou lot QR à 1 doc) : pas de tableau
  // ni d'« appliquer à tous » — le formulaire édite directement ce document.
  const isSingle = draftDocs.length === 1;
  // Champs à saisir : ceux du type commun au lot pour le formulaire partagé, ceux du type du
  // document sélectionné pour son panneau propre (un lot QR peut mélanger les types).
  const commonFields = fieldsByType[cmType ?? -1] ?? [];
  const currentFields = fieldsByType[currentDoc?.documentTypeId ?? -1] ?? [];

  // Keep the editable working copy in sync with the documents loaded from the server, and
  // resolve the batch-wide classification shown (read-only) at the top of the indexation panel.
  useEffect(() => {
    // Le classement arrive DÉJÀ POSÉ par le serveur (type du lot en repli du QR, plan du
    // paramétrage) : l'écran ne le recalcule plus, il l'affiche.
    const copy: DraftDoc[] = documents.map((d) => ({
      ...d,
      metaValues: Object.fromEntries(
        (d.metadataValues ?? []).map((v) => [v.metaDataId, v]),
      ) as MetaValues,
    }));
    // Charge les champs de tous les types présents dans le lot (types hérités des intercalaires
    // compris), pour que le formulaire dynamique soit prêt quelle que soit la ligne sélectionnée.
    [...new Set(copy.map((d) => d.documentTypeId))].forEach((t) => void loadFields(t));
    setDraftDocs(copy);
    setDirty(false);
    setCmType(commonValue(copy, (d) => d.documentTypeId));
    setCmPlan(commonValue(copy, (d) => d.planId));
    setCmDossier(commonValue(copy, (d) => d.dossierId));
    setCmConfidentialite(commonValue(copy, (d) => d.confidentialiteId));
    // Document unique : le formulaire commun EST celui du document, il doit donc repartir des
    // valeurs déjà enregistrées. À plusieurs, il reste vide (« un champ vide n'est pas modifié »).
    setCmMeta(copy.length === 1 ? copy[0]!.metaValues : {});
  }, [documents, loadFields]);

  // Miroir de la copie de travail, pour les gestionnaires à longue durée de vie (cf. `draftDocsRef`).
  useEffect(() => {
    draftDocsRef.current = draftDocs;
  }, [draftDocs]);

  // Load the PDF viewer whenever the active (selected) document changes.
  useEffect(() => {
    if (!modalOpen || !currentDoc) return;
    let cancelled = false;
    void (async () => {
      if (!currentDoc.file) {
        setViewerUrl((old) => {
          if (old) URL.revokeObjectURL(old);
          return null;
        });
        return;
      }
      try {
        setViewerLoading(true);
        const token = window.localStorage.getItem('token');
        const res = await fetch(
          `${API_BASE}/documents/${currentDoc.documentId}/files/${currentDoc.file.fileId}/content`,
          { headers: token ? { Authorization: `Bearer ${token}` } : {} },
        );
        if (!res.ok || cancelled) return;
        const blob = await res.blob();
        if (cancelled) return;
        const url = URL.createObjectURL(blob);
        setViewerUrl((old) => {
          if (old) URL.revokeObjectURL(old);
          return url;
        });
      } catch {
        /* viewer is best-effort */
      } finally {
        if (!cancelled) setViewerLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [modalOpen, idx, currentDoc?.documentId]);

  const openModal = (startIndex = 0) => {
    setIdx(startIndex);
    setModalOpen(true);
  };

  const closeModal = useCallback(() => {
    setModalOpen(false);
    setViewerUrl((old) => {
      if (old) URL.revokeObjectURL(old);
      return null;
    });
  }, []);

  // Close request (Esc / X) — guard against losing unsaved edits.
  const attemptClose = useCallback(() => {
    if (dirty) {
      confirm({
        title: 'Modifications non enregistrées',
        content: 'Vous avez des modifications non enregistrées. Fermer quand même ?',
        okText: 'Fermer sans enregistrer',
        danger: true,
        onOk: closeModal,
      });
    } else {
      closeModal();
    }
  }, [dirty, confirm, closeModal]);

  /** Saisie d'un champ de métadonnée sur une ligne du tableau (document courant). */
  const updateRowMeta = (index: number, metaDataId: number, value: MetaDataValue) => {
    setDirty(true);
    setDraftDocs((prev) =>
      prev.map((d, i) =>
        i === index ? { ...d, metaValues: { ...d.metaValues, [metaDataId]: value } } : d,
      ),
    );
  };

  /** Une valeur commune n'est poussée que si elle est réellement renseignée. */
  const isFilled = (v: MetaDataValue | undefined) =>
    v != null && (v.metaDataListItemId != null || (v.value ?? '').trim() !== '');

  /**
   * Recopie les métadonnées communes sur tous les documents du lot. Le classement n'y figure plus :
   * il est fixé en amont par le type du lot (ou par les intercalaires QR), donc identique partout.
   */
  const applyCommonToAll = () => {
    const filledMeta = Object.values(cmMeta).filter(isFilled);
    if (filledMeta.length === 0) {
      message.info('Renseignez au moins un champ commun à appliquer.');
      return;
    }
    setDirty(true);
    setDraftDocs((prev) =>
      prev.map((d) => {
        // Un lot peut mélanger les types : on ne pousse sur chaque document que les métadonnées
        // qui appartiennent à SON type, les autres n'auraient nulle part où s'afficher.
        const allowed = new Set(
          (fieldsRef.current[d.documentTypeId ?? -1] ?? []).map((f) => f.metaDataId),
        );
        const metaValues = { ...d.metaValues };
        filledMeta.forEach((v) => {
          if (allowed.has(v.metaDataId)) metaValues[v.metaDataId] = v;
        });
        return { ...d, metaValues };
      }),
    );
    message.success('Champs communs appliqués à tous les documents.');
  };

  /** Persist the indexation of every document; with `validate`, archive the whole batch. */
  const saveAll = async (validate: boolean) => {
    const docs = draftDocsRef.current;
    if (docs.length === 0) return;
    setSavingAll(true);
    try {
      for (const d of docs) {
        // Le classement n'est plus transmis : l'API le refuserait (il est posé à la création du
        // document, depuis le type du lot). Ne partent que les métadonnées et la validation.
        const body: Record<string, unknown> = {};
        if (validate) body.validate = true;
        // Envoi EXHAUSTIF des champs du type : un champ vidé à l'écran doit effacer sa valeur en
        // base. Si les champs du type n'ont pas pu être chargés, on n'envoie rien plutôt que de
        // risquer d'effacer des valeurs qu'on n'a jamais affichées.
        const fields = fieldsRef.current[d.documentTypeId ?? -1];
        if (fields) {
          body.metadataValues = fields.map((f) => ({
            metaDataId: f.metaDataId,
            value: d.metaValues[f.metaDataId]?.value ?? null,
            metaDataListItemId: d.metaValues[f.metaDataId]?.metaDataListItemId ?? null,
          }));
        }
        // Rien à envoyer (document sans métadonnée, hors validation) : inutile d'appeler l'API,
        // qui refuserait un corps vide.
        if (Object.keys(body).length === 0) continue;
        await apiJson(`/documents/${d.documentId}/indexation`, {
          method: 'PATCH',
          body: JSON.stringify(body),
        });
      }
      setDirty(false);
      // Reflect into the source list; when validating, the finalize effect resets the page.
      // Les métadonnées y sont reportées aussi : sinon l'effet de synchronisation reconstruirait
      // la copie de travail à partir des valeurs d'AVANT l'enregistrement.
      setDocuments(
        docs.map((d) => ({
          ...d,
          isArchived: validate ? true : d.isArchived,
          metadataValues: Object.values(d.metaValues),
        })),
      );
      if (!validate) message.success('Indexation enregistrée.');
    } catch (e) {
      message.error(e instanceof Error ? e.message : 'Échec de l’enregistrement');
    } finally {
      setSavingAll(false);
    }
  };

  const confirmValidateAll = () =>
    confirm({
      title: isSingle ? 'Valider le document' : 'Valider tout le lot',
      content: isSingle
        ? 'Le document sera archivé. Continuer ?'
        : 'Tous les documents seront archivés. Cette action finalise le lot. Continuer ?',
      okText: isSingle ? 'Valider le document' : 'Valider le lot',
      onOk: () => saveAll(true),
    });

  // Le contrôle de doublon de numéro de pièce a disparu avec le champ : la cote ne se saisit plus
  // à l'acquisition, elle serait donc toujours vide. L'endpoint `/documents/cotes/check` reste
  // disponible côté serveur pour les écrans qui, eux, éditent encore la cote.

  const validatedCount = documents.filter((d) => d.isArchived).length;
  const processing = status != null && status.status === 0;
  const ready = status != null && status.status === 1;
  const failed = status != null && status.status === 2;

  const phase: PipelinePhase = failed
    ? 'failed'
    : ready
      ? 'ready'
      : uploading
        ? 'uploading'
        : processing
          ? 'processing'
          : 'uploading';

  // As soon as processing finishes and at least one document was produced, open the
  // indexation viewer automatically (once per batch) — no extra click required.
  useEffect(() => {
    if (ready && batch && documents.length > 0 && autoOpenedBatchRef.current !== batch.batchId) {
      autoOpenedBatchRef.current = batch.batchId;
      openModal(0);
    }
  }, [ready, batch, documents.length]);

  // When every document has been validated the acquisition is finalized: close the viewer
  // and return to the upload form so the next batch can be started.
  useEffect(() => {
    if (ready && batch && documents.length > 0 && validatedCount === documents.length) {
      message.success('Acquisition finalisée — prêt pour un nouveau lot.');
      closeModal();
      reset();
    }
  }, [ready, batch, documents.length, validatedCount]);

  // Keyboard navigation inside the modal: ←/↑ ↓/→ change the active document; Enter saves.
  // Ignored while the focus is in an editable control (so editing keeps working).
  useEffect(() => {
    if (!modalOpen) return;
    const handler = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      const editing =
        !!t &&
        (['input', 'textarea'].includes(t.tagName.toLowerCase()) ||
          t.isContentEditable ||
          !!t.closest('.ant-select') ||
          !!t.closest('.ant-picker') ||
          !!t.closest('.ant-tree-select'));
      if (editing) return;
      if (e.key === 'ArrowDown' || e.key === 'ArrowRight') {
        e.preventDefault();
        setIdx((i) => Math.min(i + 1, draftDocs.length - 1));
      } else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') {
        e.preventDefault();
        setIdx((i) => Math.max(i - 1, 0));
      } else if (e.key === 'Enter') {
        e.preventDefault();
        void saveAll(false);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [modalOpen, draftDocs.length]);

  const columns: TableColumnsType<BatchDoc> = [
    {
      title: 'Document',
      dataIndex: 'label',
      key: 'label',
      render: (_, r, i) => <a onClick={() => openModal(i)}>{r.label}</a>,
    },
    {
      title: 'Type',
      dataIndex: 'documentTypeId',
      key: 'type',
      width: 200,
      render: (v: number | null) => (v != null ? (typeLabel.get(v) ?? '—') : '—'),
    },
    {
      title: 'Pages',
      dataIndex: 'file',
      key: 'pages',
      width: 90,
      align: 'center',
      render: (f: DocFile | null) => f?.pageCount ?? '—',
    },
    {
      title: 'Statut',
      dataIndex: 'isArchived',
      key: 'status',
      width: 150,
      render: (v: boolean) => <StatusBadge status={v ? 'validated' : 'pending'} />,
    },
  ];

  /**
   * Liste des documents du lot pendant l'indexation. Uniquement de la lecture : le classement est
   * décidé en amont (type du lot) ou par les intercalaires QR, et seules les métadonnées se
   * saisissent. Le tableau ne sert donc plus qu'à choisir le document affiché dans la visionneuse.
   */
  const editColumns: TableColumnsType<DraftDoc> = [
    {
      title: '',
      key: 'view',
      width: 40,
      align: 'center',
      render: (_, __, i) => (
        <icons.view
          size={16}
          strokeWidth={2}
          style={{
            color: i === idx ? 'var(--ant-color-primary)' : 'var(--ant-color-text-quaternary)',
          }}
        />
      ),
    },
    {
      title: 'Document',
      key: 'label',
      render: (_, r) => r.label,
    },
    {
      title: 'Type de document',
      key: 'type',
      width: 190,
      render: (_, r) => (r.documentTypeId != null ? (typeLabel.get(r.documentTypeId) ?? '—') : '—'),
    },
    {
      title: 'Statut',
      key: 'status',
      width: 120,
      render: (_, r) => <StatusBadge status={r.isArchived ? 'validated' : 'pending'} />,
    },
  ];

  const totalBytes = files.reduce((sum, f) => sum + (f.size ?? 0), 0);

  return (
    <div className="acq-readable" style={{ maxWidth: 820, margin: '0 auto' }}>
      <PageHeader icon="acquisition" title="Acquisition par lot" />

      <Steps
        size="small"
        style={{ marginBottom: 24 }}
        current={batch ? (ready ? 3 : 2) : wizardStep}
        status={failed ? 'error' : undefined}
        items={STEP_ITEMS}
      />

      {!batch && (
        <Card>
          {/* Étape 1/2 — Mode d'acquisition + destination */}
          {wizardStep === 0 && (
            <Space direction="vertical" size="large" style={{ width: '100%' }}>
              <div>
                <Text type="secondary" style={{ fontSize: 12 }}>
                  Mode d’acquisition
                </Text>
                <Row gutter={[8, 8]} style={{ marginTop: 4 }}>
                  <Col xs={24} md={12}>
                    <ModeOptionCard
                      selected={!useIntercalaires}
                      icon="document"
                      title="Sans intercalaire"
                      onSelect={() => setUseIntercalaires(false)}
                    />
                  </Col>
                  <Col xs={24} md={12}>
                    <ModeOptionCard
                      selected={useIntercalaires}
                      icon="qr"
                      title="Avec intercalaires (QR + OCR)"
                      onSelect={() => setUseIntercalaires(true)}
                    />
                  </Col>
                </Row>
              </div>

              <div>
                <Typography.Title level={5} style={{ marginTop: 0 }}>
                  Quels documents allez-vous numériser ?
                </Typography.Title>
                {useIntercalaires && (
                  <Text type="secondary">
                    Type de repli, utilisé pour les documents dont l’intercalaire QR n’indique pas
                    le type.
                  </Text>
                )}
                <div style={{ marginTop: 8 }}>
                  <Text type="secondary">
                    Type de document{' '}
                    {!useIntercalaires && (
                      <span style={{ color: 'var(--ant-color-error)' }}>*</span>
                    )}
                  </Text>
                  <Select
                    style={{ width: '100%', marginTop: 4 }}
                    value={batchTypeId ?? undefined}
                    onChange={(v) => void onPickBatchType((v as number) ?? null)}
                    options={typeOptions}
                    allowClear
                    showSearch
                    filterOption={filterByLabel}
                    placeholder="Sélectionnez le type de document du lot"
                  />
                </div>
              </div>

              {useIntercalaires ? (
                <Alert
                  type="info"
                  showIcon
                  message="Destination déterminée par les intercalaires"
                  description="En mode « avec intercalaires », le dossier de destination et le plan de classement de chaque document sont déterminés automatiquement par la lecture de ses intercalaires QR."
                />
              ) : batchTypeId == null ? null : (
                <>
                  {dossierId == null && defaultPlanId == null && (
                    // Type sans paramétrage : rien à préremplir, mais la destination reste
                    // choisissable à la main ci-dessous.
                    <Alert
                      type="info"
                      showIcon
                      style={{ marginBottom: 12 }}
                      message="Ce type de document n’est pas paramétré"
                      description={
                        <>
                          Aucun dossier ni plan par défaut n’est associé au type «&nbsp;
                          {typeLabel.get(batchTypeId) ?? ''}&nbsp;». Choisissez-les ci-dessous, ou
                          paramétrez le type dans{' '}
                          <Link href="/admin/archives/parametrage-types">
                            Paramétrage des types de documents
                          </Link>{' '}
                          pour la prochaine fois.
                        </>
                      }
                    />
                  )}
                  <Row gutter={[12, 12]}>
                    <Col xs={24} md={8}>
                      <Text type="secondary">
                        Dossier de destination{' '}
                        <span style={{ color: 'var(--ant-color-error)' }}>*</span>
                      </Text>
                      <TreeSelect
                        style={{ width: '100%', marginTop: 4 }}
                        value={dossierId ?? undefined}
                        onChange={(v) => setDossierId((v as number) ?? null)}
                        treeData={dossierTree}
                        treeDefaultExpandAll
                        allowClear
                        showSearch
                        filterTreeNode={filterByTitle}
                        placeholder="Sélectionnez le dossier de destination"
                      />
                    </Col>
                    <Col xs={24} md={8}>
                      <Text type="secondary">
                        Plan de classement{' '}
                        <span style={{ color: 'var(--ant-color-error)' }}>*</span>
                      </Text>
                      <TreeSelect
                        style={{ width: '100%', marginTop: 4 }}
                        value={defaultPlanId ?? undefined}
                        onChange={(v) => setDefaultPlanId((v as number) ?? null)}
                        treeData={planTree}
                        treeDefaultExpandAll
                        allowClear
                        showSearch
                        filterTreeNode={filterByTitle}
                        placeholder="Sélectionnez le plan de classement"
                      />
                    </Col>
                    <Col xs={24} md={8}>
                      <Text type="secondary">Confidentialité</Text>
                      {/* Préremplie depuis le paramétrage du type, mais modifiable ici — comme
                          le dossier et le plan ci-dessus (écrase le défaut du type au worker). */}
                      <Select
                        style={{ width: '100%', marginTop: 4 }}
                        value={confidentialiteId ?? undefined}
                        onChange={(v) => setConfidentialiteId((v as number) ?? null)}
                        options={confidentialites.map((c) => ({
                          value: c.confidentialiteId,
                          label: c.label,
                        }))}
                        allowClear
                        showSearch
                        filterOption={filterByLabel}
                        placeholder="Aucune — non paramétrée pour ce type"
                      />
                    </Col>
                  </Row>
                </>
              )}

              <div style={{ textAlign: 'right' }}>
                <Tooltip title={destinationOk ? '' : destinationHint}>
                  <span>
                    <Button
                      type="primary"
                      disabled={!destinationOk}
                      onClick={() => setWizardStep(1)}
                      icon={<icons.arrowRight size={16} />}
                      iconPosition="end"
                    >
                      Continuer
                    </Button>
                  </span>
                </Tooltip>
              </div>
            </Space>
          )}

          {/* Étape 2/2 — Fichiers et lancement */}
          {wizardStep === 1 && (
            <Space direction="vertical" size="large" style={{ width: '100%' }}>
              <Typography.Title level={5} style={{ marginTop: 0 }}>
                Ajoutez les fichiers scannés
              </Typography.Title>

              <Upload.Dragger
                multiple
                accept="application/pdf"
                beforeUpload={() => false}
                fileList={files}
                onChange={({ fileList }) => {
                  const pdfs = fileList.filter((f) =>
                    f.type ? f.type === 'application/pdf' : f.name.toLowerCase().endsWith('.pdf'),
                  );
                  if (pdfs.length !== fileList.length) {
                    message.error('Seuls les fichiers PDF sont acceptés.');
                  }
                  setFiles(pdfs);
                }}
              >
                <p className="ant-upload-drag-icon" style={{ color: 'var(--ant-color-primary)' }}>
                  <icons.upload size={40} strokeWidth={1.5} />
                </p>
                <p style={{ fontWeight: 600 }}>Glissez-déposez vos PDF ici</p>
                <p style={{ color: 'var(--ant-color-text-tertiary)', fontSize: 13 }}>
                  ou cliquez pour les sélectionner — format PDF uniquement
                </p>
              </Upload.Dragger>
              {files.length > 0 && (
                <Text type="secondary" style={{ fontSize: 12 }}>
                  {files.length} fichier(s) sélectionné(s) · {formatBytes(totalBytes)}
                </Text>
              )}

              {error && <Alert type="error" showIcon message={error} />}

              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                <Button onClick={() => setWizardStep(0)} icon={<icons.arrowLeft size={16} />}>
                  Précédent
                </Button>
                <Tooltip title={submitHint}>
                  <span style={{ display: 'inline-block' }}>
                    <Button
                      type="primary"
                      disabled={!canSubmit}
                      loading={busy}
                      onClick={onSubmit}
                      icon={<icons.scan size={18} />}
                    >
                      Lancer le traitement
                    </Button>
                  </span>
                </Tooltip>
              </div>
            </Space>
          )}
        </Card>
      )}

      {batch && (
        <Card
          title={`Lot #${batch.batchId}`}
          extra={
            <Space>
              {ready && documents.length > 0 && (
                <Button type="primary" icon={<icons.edit size={16} />} onClick={() => openModal(0)}>
                  Indexer / Valider
                </Button>
              )}
              <Button icon={<icons.add size={16} />} onClick={reset}>
                Nouveau lot
              </Button>
            </Space>
          }
        >
          {(processing || busy) && !failed && (
            <BatchPipeline
              phase={phase}
              processed={uploading ? uploadedFiles : (status?.processedFiles ?? 0)}
              documentCount={status?.documentCount ?? 0}
              fileCount={status?.fileCount || files.length}
              showQrStages={status?.useIntercalaires ?? useIntercalaires}
            />
          )}

          {failed && (
            <>
              <Alert
                type="error"
                showIcon
                message="Le traitement du lot a échoué"
                description="Une erreur est survenue pendant le chargement des documents. Vous pouvez relancer le traitement."
                style={{ marginBottom: 16 }}
              />
              <Space>
                <Button
                  type="primary"
                  loading={busy}
                  icon={<icons.refresh size={16} />}
                  onClick={onSubmit}
                >
                  Relancer le traitement
                </Button>
              </Space>
            </>
          )}

          {ready && (
            <>
              <Row gutter={12} style={{ marginBottom: 16 }}>
                <Col xs={12} sm={8} md={6}>
                  <StatusTile
                    tone="info"
                    label="Documents produits"
                    value={documents.length}
                    icon="document"
                  />
                </Col>
                <Col xs={12} sm={8} md={6}>
                  <StatusTile
                    tone={validatedCount === documents.length ? 'success' : 'warning'}
                    label="Validés"
                    value={validatedCount}
                    suffix={`/ ${documents.length}`}
                    icon="validated"
                  />
                </Col>
              </Row>
              {documents.length === 0 ? (
                <EmptyState
                  icon="acquisition"
                  title="Aucun document produit"
                  action={
                    <Button icon={<icons.add size={16} />} onClick={reset}>
                      Nouveau lot
                    </Button>
                  }
                />
              ) : (
                <Table<BatchDoc>
                  rowKey="documentId"
                  dataSource={documents}
                  columns={columns}
                  size="middle"
                  scroll={{ x: 'max-content' }}
                  pagination={{
                    pageSize: 10,
                    showSizeChanger: true,
                    showTotal: (t) => `${t} document(s)`,
                  }}
                />
              )}
            </>
          )}
        </Card>
      )}

      <Modal
        open={modalOpen}
        onCancel={attemptClose}
        maskClosable={false}
        footer={null}
        // Pleine largeur sous 768 px (une largeur en pourcentage n'est jamais relevée sur
        // mobile) ; 94 % inchangé au-dessus.
        width={{ xs: '100%', md: '94%' }}
        className="acq-readable"
        style={{ top: 16 }}
        title={
          <span className="da-display">
            Indexation du lot{batch ? ` #${batch.batchId}` : ''} — {draftDocs.length}{' '}
            {draftDocs.length > 1 ? 'documents' : 'document'}
          </span>
        }
        destroyOnHidden
      >
        <Row gutter={16} style={{ height: isWide ? 'calc(100vh - 130px)' : 'auto' }}>
          {/* Left: viewer of the selected document */}
          <Col
            xs={24}
            lg={13}
            style={{ height: isWide ? '100%' : '60vh', marginBottom: isWide ? 0 : 12 }}
          >
            <PdfViewer
              src={viewerUrl}
              loading={viewerLoading}
              style={{ minHeight: 200 }}
              empty={<EmptyState compact icon="document" title="Aucun aperçu" />}
            />
          </Col>

          {/* Right: common form + per-document editable table + actions */}
          <Col xs={24} lg={11} style={{ height: isWide ? '100%' : 'auto' }}>
            <div style={{ height: '100%', display: 'flex', flexDirection: 'column', gap: 12 }}>
              {/* Une seule zone de défilement pour tout le panneau : les actions de validation
                  restent ainsi toujours visibles en bas, quel que soit le nombre de champs. */}
              <div
                style={{
                  flex: 1,
                  minHeight: 0,
                  overflow: 'auto',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 12,
                }}
              >
                <Card
                  size="small"
                  title={
                    isSingle
                      ? 'Indexation du document'
                      : 'Indexation commune (appliquée à tous les documents)'
                  }
                >
                  {/* Classement : décidé à l'étape « Destination » par le type du lot (ou, en mode
                    QR, par les intercalaires). Rappelé ici pour vérification, jamais ressaisi. */}
                  <ClassementLu
                    items={[
                      {
                        label: 'Type de document',
                        value:
                          cmType != null ? (
                            (typeLabel.get(cmType) ?? '—')
                          ) : (
                            <Text type="secondary">Plusieurs types dans ce lot</Text>
                          ),
                      },
                      {
                        label: 'Plan de classement',
                        value:
                          cmPlan != null ? (
                            (planLabel.get(cmPlan) ?? '—')
                          ) : (
                            <Text type="secondary">—</Text>
                          ),
                      },
                      {
                        label: 'Dossier',
                        value:
                          cmDossier != null ? (
                            dossierPath(cmDossier)
                          ) : (
                            <Text type="secondary">—</Text>
                          ),
                      },
                      {
                        label: 'Confidentialité',
                        value:
                          cmConfidentialite != null ? (
                            (confidentialiteLabel.get(cmConfidentialite) ?? '—')
                          ) : (
                            <Text type="secondary">—</Text>
                          ),
                      },
                    ]}
                  />

                  {commonFields.length > 0 ? (
                    <div style={{ marginTop: 14 }}>
                      <div
                        style={{
                          display: 'flex',
                          justifyContent: 'space-between',
                          alignItems: 'baseline',
                          gap: 8,
                          marginBottom: 8,
                        }}
                      >
                        <Text strong style={{ fontSize: 13 }}>
                          Champs du type « {typeLabel.get(cmType!) ?? ''} »
                        </Text>
                        <Text type="secondary" style={{ fontSize: 12 }}>
                          {commonFields.length} champ{commonFields.length > 1 ? 's' : ''}
                        </Text>
                      </div>
                      <MetaDataFields
                        fields={commonFields}
                        values={cmMeta}
                        onChange={(metaDataId, value) => {
                          setCmMeta((prev) => ({ ...prev, [metaDataId]: value }));
                          if (isSingle) updateRowMeta(0, metaDataId, value);
                        }}
                      />
                      {!isSingle && (
                        <div
                          style={{
                            display: 'flex',
                            justifyContent: 'flex-end',
                            alignItems: 'center',
                            gap: 10,
                            marginTop: 10,
                          }}
                        >
                          <Text type="secondary" style={{ fontSize: 12 }}>
                            Un champ laissé vide n’est pas modifié.
                          </Text>
                          <Button icon={<icons.check size={16} />} onClick={applyCommonToAll}>
                            Appliquer à tous
                          </Button>
                        </div>
                      )}
                    </div>
                  ) : (
                    cmType != null && (
                      <Text
                        type="secondary"
                        style={{ fontSize: 12, display: 'block', marginTop: 12 }}
                      >
                        Ce type de document n’attend aucun champ supplémentaire.
                      </Text>
                    )
                  )}
                </Card>

                {!isSingle && (
                  <Card size="small" title="Documents du lot" styles={{ body: { padding: 0 } }}>
                    <Table<DraftDoc>
                      rowKey="documentId"
                      dataSource={draftDocs}
                      columns={editColumns}
                      size="small"
                      pagination={false}
                      scroll={{ x: 'max-content' }}
                      rowClassName={(_, i) => (i === idx ? 'ant-table-row-selected' : '')}
                      onRow={(_, i) => ({
                        onClick: () => setIdx(i ?? 0),
                        style: { cursor: 'pointer' },
                      })}
                    />
                  </Card>
                )}

                {/* Métadonnées du document sélectionné : trop nombreuses et trop variées pour tenir
                  en colonnes du tableau, elles se saisissent ici, en face de l'aperçu du PDF. */}
                {!isSingle && currentFields.length > 0 && (
                  <Card
                    size="small"
                    title={
                      <span>
                        Champs du document {idx + 1}/{draftDocs.length}
                        <Text type="secondary" style={{ fontWeight: 400, marginLeft: 6 }}>
                          — {typeLabel.get(currentDoc!.documentTypeId!) ?? ''}
                        </Text>
                      </span>
                    }
                  >
                    <MetaDataFields
                      size="small"
                      fields={currentFields}
                      values={currentDoc!.metaValues}
                      onChange={(metaDataId, value) => updateRowMeta(idx, metaDataId, value)}
                    />
                  </Card>
                )}
              </div>

              <div
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  gap: 12,
                  flexWrap: 'wrap',
                  paddingTop: 8,
                  borderTop: '1px solid var(--ant-color-border-secondary)',
                }}
              >
                <Text type="secondary">
                  {isSingle
                    ? validatedCount === 1
                      ? 'Document validé'
                      : 'Document à valider'
                    : `${validatedCount}/${draftDocs.length} validé(s)`}
                  {dirty && (
                    <Text type="warning" style={{ marginLeft: 10 }}>
                      • modifications non enregistrées
                    </Text>
                  )}
                </Text>
                <Space>
                  <Button type="primary" loading={savingAll} onClick={confirmValidateAll}>
                    {isSingle ? 'Valider le document' : 'Valider tout le lot'}
                  </Button>
                </Space>
              </div>
            </div>
          </Col>
        </Row>
      </Modal>
    </div>
  );
}

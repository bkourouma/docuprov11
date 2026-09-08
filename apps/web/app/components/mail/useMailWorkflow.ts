'use client';

import { useCallback, useEffect, useState } from 'react';
import { App } from 'antd';
import type { Dayjs } from 'dayjs';
import { getMe } from '../../lib/auth';
import { personName } from './mailFormat';
import {
  archiver,
  createInputation,
  dechargeCourrier,
  enregistrementReponse,
  fetchDocumentBlobUrl,
  getDocumentDetail,
  getMail,
  listActors,
  listDestinataireRoles,
  listInputationTypes,
  markTreated,
  removeInputation,
  treatOnRead,
  validationDG,
  type Actor,
  type DestinataireRole,
  type MailDetail,
} from '../../lib/courriers';

export type InputationType = { mailInputationTypeId: number; label: string; suivi: boolean };

export interface MailAction {
  key: string;
  label: string;
  type?: 'primary';
  run: () => Promise<unknown>;
  ok: string;
}

/**
 * Logique partagée d'un courrier ouvert (§08) : chargement, aperçu du document, formulaire
 * d'imputation (rôle → porteurs), et actions de workflow contextuelles. Factorisée hors de
 * `MailViewer` (popup) pour être réutilisée telle quelle par la page complète de Contrôle — seule
 * la présentation (popup vs page) diffère entre les deux.
 *
 * `autoTreatOnOpen` reproduit la validation automatique à la lecture du parapheur (§03.1) : les
 * imputations de type « suivi » sont traitées à l'ouverture.
 *
 * `allowArchive` : l'archivage (§03.1) clôt le courrier. Il n'a de sens qu'en fin de chaîne — le
 * bureau d'ordre (§06) le masque, sans quoi on pourrait clore un courrier avant même son contrôle.
 */
export function useMailWorkflow({
  mailId,
  autoTreatOnOpen = false,
  allowArchive = true,
  onlyMyImputations = false,
  onChanged,
}: {
  mailId: number | null;
  autoTreatOnOpen?: boolean;
  allowArchive?: boolean;
  /** §08 : ne charger que mes imputations et celles que j'ai créées (sauf destinataire principal). */
  onlyMyImputations?: boolean;
  onChanged?: () => void;
}) {
  const { message } = App.useApp();
  const [mail, setMail] = useState<MailDetail | null>(null);
  // Vrai d'emblée quand un courrier est attendu : évite qu'une page pleine affiche « introuvable »
  // le temps que l'effet de chargement démarre (le popup, lui, monte toujours avec mailId=null).
  const [loading, setLoading] = useState(mailId != null);
  const [busy, setBusy] = useState<string | null>(null);

  const [viewerUrl, setViewerUrl] = useState<string | null>(null);
  const [viewerLoading, setViewerLoading] = useState(false);
  // Document affiché dans l'aperçu. `null` = le premier rattaché (comportement par défaut) ; un
  // id explicite quand l'utilisateur choisit une pièce dans l'onglet Fichiers.
  const [viewerDocumentId, setViewerDocumentId] = useState<number | null>(null);

  const [actors, setActors] = useState<Actor[]>([]);
  const [roles, setRoles] = useState<DestinataireRole[]>([]);
  const [types, setTypes] = useState<InputationType[]>([]);
  const [impOpen, setImpOpen] = useState(false);
  const [impRole, setImpRole] = useState<number | null>(null);
  const [impActors, setImpActors] = useState<number[]>([]);
  const [impType, setImpType] = useState<number | null>(null);
  const [impInstr, setImpInstr] = useState('');
  const [impDeadline, setImpDeadline] = useState<Dayjs | null>(null);

  // Identité effective (§08 acteur) : permet de savoir si l'utilisateur courant est l'auteur
  // d'une imputation donnée (seul habilité à la supprimer).
  const [currentUserGroupId, setCurrentUserGroupId] = useState<number | null>(null);

  // Lookups du panneau d'imputation (chargés une fois).
  useEffect(() => {
    void (async () => {
      const [a, r, t, me] = await Promise.all([
        listActors().catch(() => [] as Actor[]),
        listDestinataireRoles().catch(() => [] as DestinataireRole[]),
        listInputationTypes().catch(() => [] as InputationType[]),
        getMe().catch(() => null),
      ]);
      setActors(a);
      setRoles(r);
      setTypes(t);
      setCurrentUserGroupId(me?.userGroupId ?? null);
    })();
  }, []);

  // Porteurs du rôle choisi (§08) : l'imputé se sélectionne parmi eux, pas dans tous les acteurs.
  const roleActors = impRole == null ? [] : actors.filter((a) => a.roleId === impRole);

  const load = useCallback(
    async (id: number) => {
      setLoading(true);
      try {
        setMail(await getMail(id, { onlyMyImputations }));
      } catch (e) {
        message.error(e instanceof Error ? e.message : 'Courrier introuvable');
      } finally {
        setLoading(false);
      }
    },
    [message, onlyMyImputations],
  );

  // Ouverture : charge le courrier, puis (parapheur) déclenche la validation automatique à la lecture.
  useEffect(() => {
    if (mailId == null) {
      setMail(null);
      setImpOpen(false);
      setImpRole(null);
      setImpActors([]);
      return;
    }
    let cancelled = false;
    void (async () => {
      if (autoTreatOnOpen) {
        await treatOnRead(mailId).catch(() => undefined);
      }
      if (!cancelled) await load(mailId);
    })();
    return () => {
      cancelled = true;
    };
  }, [mailId, autoTreatOnOpen, load]);

  // Document lié : aperçu best-effort de la pièce choisie, à défaut du 1er document rattaché
  // (binaire absent = placeholder, pas d'erreur).
  useEffect(() => {
    const documentId = viewerDocumentId ?? mail?.documents[0]?.document?.documentId;
    if (documentId == null) {
      setViewerUrl(null);
      return;
    }
    let cancelled = false;
    let created: string | null = null;
    setViewerLoading(true);
    void (async () => {
      try {
        const detail = await getDocumentDetail(documentId);
        const file = detail.currentVersion?.files[0];
        if (!file) return;
        const url = await fetchDocumentBlobUrl(documentId, file.fileId);
        if (cancelled) {
          if (url) URL.revokeObjectURL(url);
          return;
        }
        created = url;
        setViewerUrl(url);
      } catch {
        // aperçu indisponible : on laisse le placeholder
      } finally {
        if (!cancelled) setViewerLoading(false);
      }
    })();
    return () => {
      cancelled = true;
      if (created) URL.revokeObjectURL(created);
      setViewerUrl(null);
    };
  }, [mail?.documents, viewerDocumentId]);

  const act = useCallback(
    async (key: string, fn: () => Promise<unknown>, ok: string) => {
      if (mailId == null) return;
      setBusy(key);
      try {
        await fn();
        message.success(ok);
        await load(mailId);
        onChanged?.();
      } catch (e) {
        message.error(e instanceof Error ? e.message : 'Action impossible');
      } finally {
        setBusy(null);
      }
    },
    [mailId, load, message, onChanged],
  );

  const submitInputation = async () => {
    if (mailId == null || impActors.length === 0 || impType == null) return;
    await act(
      'imputer',
      () =>
        Promise.all(
          impActors.map((userGroupId) =>
            createInputation({
              mailId,
              userGroupId,
              mailInputationTypeId: impType,
              instructions: impInstr.trim() || undefined,
              deadline: impDeadline?.toISOString(),
            }),
          ),
        ),
      impActors.length > 1 ? 'Imputations créées.' : 'Imputation créée.',
    );
    setImpOpen(false);
    setImpRole(null);
    setImpActors([]);
    setImpType(null);
    setImpInstr('');
    setImpDeadline(null);
  };

  const deleteImputation = (mailInputationId: number) =>
    act(
      `supprimer-${mailInputationId}`,
      () => removeInputation(mailInputationId),
      'Imputation supprimée.',
    );

  /**
   * Nom lisible d'un acteur (app_user_group) — le détail ne renvoie que son identifiant. On ne
   * garde que la personne : `Actor.label` est de la forme « Nom — Groupe », où le groupe ne sert
   * qu'à lever l'ambiguïté dans les listes de SÉLECTION. En affichage il n'apporte que du bruit.
   */
  const actorLabel = (userGroupId: number) =>
    personName(actors.find((a) => a.userGroupId === userGroupId)?.label ?? `Acteur ${userGroupId}`);

  // Actions contextuelles (§03.2) : dépendent des drapeaux/dates du courrier. Le contrôle (§06)
  // n'y figure pas — il est automatique à la première imputation du destinataire.
  const actions: MailAction[] = mail
    ? (
        [
          mail.valider &&
            mail.dateTraited == null && {
              key: 'traiter',
              label: 'Marquer traité',
              type: 'primary' as const,
              run: () => markTreated(mail.mailId),
              ok: 'Courrier traité.',
            },
          mail.valider &&
            !mail.validationDG && {
              key: 'dg',
              label: 'Validation DG',
              run: () => validationDG(mail.mailId),
              ok: 'Validation DG enregistrée.',
            },
          mail.valider &&
            !mail.decharge && {
              key: 'decharge',
              label: 'Décharger',
              run: () => dechargeCourrier(mail.mailId),
              ok: 'Courrier déchargé.',
            },
          mail.valider &&
            !mail.enregistrementReponse && {
              key: 'reponse',
              label: 'Enregistrer la réponse',
              run: () => enregistrementReponse(mail.mailId),
              ok: 'Réponse enregistrée.',
            },
          allowArchive &&
            mail.dateTraited == null && {
              key: 'archiver',
              label: 'Archiver',
              run: () => archiver(mail.mailId),
              ok: 'Courrier archivé.',
            },
        ] as Array<MailAction | false>
      ).filter((a): a is MailAction => a !== false)
    : [];

  return {
    mail,
    loading,
    busy,
    viewerUrl,
    viewerLoading,
    viewerDocumentId,
    setViewerDocumentId,
    actors,
    roles,
    types,
    impOpen,
    setImpOpen,
    impRole,
    setImpRole,
    impActors,
    setImpActors,
    impType,
    setImpType,
    impInstr,
    setImpInstr,
    impDeadline,
    setImpDeadline,
    roleActors,
    act,
    submitInputation,
    deleteImputation,
    actorLabel,
    actions,
    currentUserGroupId,
  };
}

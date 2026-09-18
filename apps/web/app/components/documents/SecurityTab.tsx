'use client';

import { useCallback, useEffect, useState } from 'react';
import { App, Alert, Button, Col, Row, Space, Table, Tag, Typography } from 'antd';
import type { TableColumnsType } from 'antd';
import dayjs from 'dayjs';
import {
  documentsApi,
  type DocumentIntegrityResult,
  type DocumentIntegrityView,
  type DocumentSealView,
} from '../../lib/archives';
import { InfoCard, InfoRow } from '../InfoCard';
// Les deux intertitres de cet onglet partagent leur ligne avec un badge de verdict : ils gardent
// leur `Text strong` en flex plutôt que le `SectionTitle` en bloc des autres onglets.
import { StateTag, TabSkeleton, sectionDivider, type StateTone } from './shared';
import { icons } from '../../theme/icons';
import { fontSize, space } from '../../theme/tokens';

const { Text } = Typography;

/** Poids lisible — le coffre stocke des PDF, pas des octets qu'on lit à l'unité. */
function formatBytes(n: number | null): string {
  if (n == null) return '—';
  if (n < 1024) return `${n} o`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} Ko`;
  return `${(n / 1024 / 1024).toFixed(1)} Mo`;
}

/**
 * Verdict d'un coup d'œil : les états du cachet ne se résument pas à « valide / invalide ».
 * L'absence de verdict (non scellé, clé inconnue) reste un Tag neutre — colorer un « on ne sait
 * pas » lui donnerait un sens qu'il n'a pas.
 *
 * `integrityOk` entre dans le verdict depuis le 2026-09-15, et c'est une correction de fond.
 * `verifySeal` ne relit JAMAIS le coffre : il compare les empreintes ENREGISTRÉES à celles qui
 * ont été scellées. Un binaire altéré sur le disque laisse donc `contentMatches` à `true`, et le
 * cachet s'affichait « Scellé et intact » — en vert — sur un document dont la vérification venait
 * d'établir qu'il était compromis. Le moteur avait raison (il répond à « les références ont-elles
 * bougé ? »), l'affichage mentait. Constaté en test le 2026-09-15 : trois octets ajoutés à
 * `511.pdf`, bandeau rouge en haut, badge vert en bas.
 *
 * On ne corrige PAS en faisant relire le coffre au cachet : l'onglet serait alors relu à chaque
 * consultation, ce que toute l'architecture de cet écran évite. On corrige le verdict.
 */
function sealVerdict(seal: DocumentSealView | null, integrityOk: boolean | null | undefined) {
  if (!seal?.sealed) return <Tag>Non scellé</Tag>;
  if (seal.knownKey === false) return <Tag>Clé inconnue</Tag>;
  if (!seal.signatureValid) return <StateTag tone="danger">Cachet invalide</StateTag>;
  // Ordre délibéré : un horodatage retouché est une falsification, à annoncer avant une simple
  // évolution de contenu — qui, elle, peut être parfaitement légitime.
  if (seal.timestampMatches === false) return <StateTag tone="danger">Horodatage altéré</StateTag>;
  // Le coffre diverge de ce qui est scellé : le cachet reste authentique, mais il n'atteste plus
  // le binaire présent. DISTINCT de `contentMatches` ci-dessous — celui-là signale une évolution
  // des références (nouvelle version réindexée), qui est légitime et se règle en re-scellant.
  if (integrityOk === false) return <StateTag tone="danger">Contenu du coffre altéré</StateTag>;
  if (!seal.contentMatches) return <StateTag tone="warning">Contenu modifié depuis</StateTag>;
  return <StateTag tone="success">Scellé et intact</StateTag>;
}

const STATUS_TAG: Record<
  DocumentIntegrityResult['files'][number]['status'],
  { tone: StateTone; label: string }
> = {
  ok: { tone: 'success', label: 'Empreinte conforme' },
  imprinted: { tone: 'brand', label: 'Empreinte de référence posée' },
  mismatch: { tone: 'danger', label: 'Empreinte NON conforme' },
  missing: { tone: 'danger', label: 'Fichier absent du coffre' },
};

/**
 * Onglet « Sécurité et conformité » : intégrité RÉELLEMENT vérifiable des binaires.
 *
 * Le module source affichait six lignes dont deux étaient câblées en dur (« Horodatage : Oui »,
 * « Autorité de certification : SELF-SIGNED ») sans qu'aucune vérification n'ait lieu. On ne les
 * reproduit pas : afficher une conformité non vérifiée serait pire que de ne rien afficher dans
 * un contexte d'archivage probatoire. Cet onglet ne montre donc que ce qu'il contrôle vraiment —
 * présence du binaire sur le coffre et empreinte SHA-256 — et dit explicitement ce qui manque.
 *
 * Mise en page en `InfoCard`/`InfoRow`, comme « Cycle de vie » et « Information » : les
 * `Descriptions` bordées d'AntD faisaient de cet onglet le seul de la fiche à ressembler à une
 * grille, là où tous les autres présentent des cartes « Libellé : valeur ».
 *
 * Les deux ACTIONS sont gardées par le niveau effectif (2026-09-15), la lecture ne l'étant pas :
 *  - `canVerify` (Modification, 3) — vérifier écrit un verdict et POSE l'empreinte de référence au
 *    premier passage, ce n'est pas une lecture ;
 *  - `canSeal` (Archivistique, 5) — le cachet fonde la valeur probante, même niveau que le cycle
 *    de vie.
 * À la différence d'`AccessTab`, qui masque simplement ses contrôles, le bouton absent est ici
 * remplacé par la RAISON de son absence : les deux gestes sont la raison d'être de l'onglet, les
 * escamoter sans un mot laisserait l'utilisateur devant un écran inexplicablement inerte. Le
 * serveur reste seul juge — ces drapeaux ne font qu'éviter un aller-retour voué au 403.
 */
export function SecurityTab({
  documentId,
  canVerify,
  canSeal,
}: {
  documentId: number;
  canVerify: boolean;
  canSeal: boolean;
}) {
  const { message } = App.useApp();
  const [view, setView] = useState<DocumentIntegrityView | null>(null);
  const [seal, setSeal] = useState<DocumentSealView | null>(null);
  const [loading, setLoading] = useState(true);
  const [verifying, setVerifying] = useState(false);
  const [sealing, setSealing] = useState(false);
  const [lastRun, setLastRun] = useState<DocumentIntegrityResult | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [integrity, sealState] = await Promise.all([
        documentsApi.integrity(documentId),
        documentsApi.seal(documentId).catch(() => null),
      ]);
      setView(integrity);
      setSeal(sealState);
    } catch (e) {
      message.error(e instanceof Error ? e.message : 'Chargement impossible');
    } finally {
      setLoading(false);
    }
  }, [documentId, message]);

  const applySeal = async () => {
    setSealing(true);
    try {
      await documentsApi.applySeal(documentId);
      message.success('Cachet apposé.');
      await load();
    } catch (e) {
      message.error(e instanceof Error ? e.message : 'Scellement impossible');
    } finally {
      setSealing(false);
    }
  };

  useEffect(() => {
    void load();
  }, [load]);

  const verify = async () => {
    setVerifying(true);
    try {
      const res = await documentsApi.verifyIntegrity(documentId);
      setLastRun(res);
      if (res.integrityOk === false) {
        message.error('Intégrité NON conforme — voir le détail par fichier.');
      } else if (res.files.some((f) => f.status === 'imprinted')) {
        message.success('Empreinte de référence posée.');
      } else {
        message.success('Intégrité conforme.');
      }
      await load();
    } catch (e) {
      message.error(e instanceof Error ? e.message : 'Vérification impossible');
    } finally {
      setVerifying(false);
    }
  };

  if (loading) {
    return <TabSkeleton rows={6} />;
  }

  const verdict =
    view?.integrityOk == null ? (
      <Tag>Jamais vérifié</Tag>
    ) : view.integrityOk ? (
      <StateTag tone="success">Conforme</StateTag>
    ) : (
      <StateTag tone="danger">Non conforme</StateTag>
    );

  const fileColumns: TableColumnsType<NonNullable<DocumentIntegrityView['files']>[number]> = [
    { title: 'Fichier', key: 'name', render: (_, r) => r.originalName || r.vaultName },
    {
      title: 'Nom au coffre',
      key: 'vault',
      width: 140,
      render: (_, r) => <span className="da-mono">{r.vaultName}</span>,
    },
    { title: 'Taille', key: 'size', width: 100, render: (_, r) => formatBytes(r.byteLength) },
    {
      title: 'Empreinte SHA-256',
      key: 'hash',
      render: (_, r) =>
        r.hash ? (
          <Text className="da-mono" style={{ fontSize: fontSize.xs }} copyable={{ text: r.hash }}>
            {r.hash.slice(0, 16)}…
          </Text>
        ) : (
          <Text type="secondary">Non posée</Text>
        ),
    },
    {
      title: 'Dernier passage',
      key: 'status',
      width: 220,
      render: (_, r) => {
        const run = lastRun?.files.find((f) => f.fileId === r.fileId);
        if (!run) return '—';
        const tag = STATUS_TAG[run.status];
        return <StateTag tone={tag.tone}>{tag.label}</StateTag>;
      },
    },
  ];

  return (
    <Space direction="vertical" size="large" style={{ width: '100%' }}>
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          gap: space.md,
          flexWrap: 'wrap',
        }}
      >
        <Space size={space.sm}>
          <Text strong style={{ fontSize: fontSize.sm }}>
            Intégrité du document
          </Text>
          {verdict}
        </Space>
        {canVerify ? (
          <Button
            type="primary"
            icon={<icons.check size={16} />}
            loading={verifying}
            onClick={() => void verify()}
          >
            Vérifier maintenant
          </Button>
        ) : (
          <Text type="secondary" style={{ fontSize: fontSize.xs }}>
            Niveau Modification requis pour lancer une vérification
          </Text>
        )}
      </div>

      {view?.integrityOk === false && (
        <Alert
          type="error"
          showIcon
          message="L’intégrité de ce document n’est pas garantie"
          description="Au moins un binaire est absent du coffre ou son empreinte ne correspond plus à celle enregistrée. Le document a pu être modifié ou remplacé hors de l’application."
        />
      )}

      <Row gutter={[16, 16]}>
        <Col xs={24} lg={12}>
          <InfoCard icon="check" title="Vérification">
            <InfoRow
              label="Dernière vérification"
              value={
                view?.dateLastVerified
                  ? dayjs(view.dateLastVerified).format('DD/MM/YYYY HH:mm')
                  : 'Jamais'
              }
            />
            <InfoRow label="Algorithme" value="SHA-256" />
          </InfoCard>
        </Col>
        <Col xs={24} lg={12}>
          <InfoCard icon="document" title="Fichiers">
            <InfoRow label="Fichiers contrôlés" value={view?.files.length ?? 0} />
            <InfoRow
              label="Empreintes posées"
              value={
                view ? `${view.files.filter((f) => f.hash).length} / ${view.files.length}` : '—'
              }
            />
          </InfoCard>
        </Col>
      </Row>

      <Table
        rowKey="fileId"
        dataSource={view?.files ?? []}
        columns={fileColumns}
        size="small"
        scroll={{ x: 'max-content' }}
        pagination={false}
      />

      {/* --- Cachet serveur : signature électronique + horodatage --- */}
      <div style={sectionDivider}>
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            gap: space.md,
            marginBottom: space.sm,
            flexWrap: 'wrap',
          }}
        >
          <Space size={space.sm}>
            <Text strong style={{ fontSize: fontSize.sm }}>
              Cachet serveur
            </Text>
            {sealVerdict(seal, view?.integrityOk)}
          </Space>
          {canSeal ? (
            <Button
              icon={<icons.lock size={16} />}
              loading={sealing}
              onClick={() => void applySeal()}
            >
              {seal?.sealed ? 'Renouveler le cachet' : 'Apposer le cachet'}
            </Button>
          ) : (
            <Text type="secondary" style={{ fontSize: fontSize.xs }}>
              Niveau Archivistique requis pour {seal?.sealed ? 'renouveler' : 'apposer'} un cachet
            </Text>
          )}
        </div>

        {seal?.sealed ? (
          <>
            <Row gutter={[16, 16]}>
              <Col xs={24} lg={12}>
                <InfoCard icon="dates" title="Horodatage">
                  <InfoRow
                    label="Horodaté le"
                    value={
                      <Space size={6}>
                        {seal.sealedAt ? dayjs(seal.sealedAt).format('DD/MM/YYYY HH:mm:ss') : '—'}
                        {seal.timestampMatches === false && (
                          <StateTag tone="danger">Altéré en base</StateTag>
                        )}
                      </Space>
                    }
                  />
                  <InfoRow label="Algorithme" value={seal.algorithm ?? '—'} />
                </InfoCard>
              </Col>
              <Col xs={24} lg={12}>
                <InfoCard icon="lock" title="Signature">
                  <InfoRow
                    label="Signature"
                    value={
                      seal.knownKey === false ? (
                        <Tag>Clé inconnue</Tag>
                      ) : seal.signatureValid ? (
                        <StateTag tone="success">Authentique</StateTag>
                      ) : (
                        <StateTag tone="danger">Invalide</StateTag>
                      )
                    }
                  />
                  {/* « Empreintes scellées » et non « Contenu scellé » (2026-09-15) : c'est bien
                      ce que la ligne compare — les empreintes ENREGISTRÉES face à celles couvertes
                      par la signature. L'ancien libellé se lisait « le document n'a pas changé »,
                      une affirmation que cette ligne n'est pas en mesure de faire : le coffre,
                      c'est la vérification d'intégrité au-dessus qui en répond. */}
                  <InfoRow
                    label="Empreintes scellées"
                    value={
                      seal.knownKey === false ? (
                        <Tag>Non vérifiable</Tag>
                      ) : seal.contentMatches ? (
                        <StateTag tone="success">Inchangées</StateTag>
                      ) : (
                        <StateTag tone="warning">Modifiées depuis le scellement</StateTag>
                      )
                    }
                  />
                  <InfoRow
                    label="Empreinte de la clé"
                    value={
                      <Text
                        className="da-mono"
                        style={{ fontSize: fontSize.xs }}
                        copyable={{ text: seal.keyFingerprint }}
                      >
                        {seal.keyFingerprint?.slice(0, 24)}…
                      </Text>
                    }
                  />
                </InfoCard>
              </Col>
            </Row>

            {seal.knownKey === false && (
              <Alert
                style={{ marginTop: space.md }}
                type="warning"
                showIcon
                message="Cachet apposé par une autre clé"
                description="Ce cachet vient d’une autre installation, ou la clé de scellement a changé. Rien ne peut en être conclu : renouvelez le cachet pour repartir d’une attestation vérifiable."
              />
            )}
            {seal.knownKey !== false && seal.signatureValid === false && (
              <Alert
                style={{ marginTop: space.md }}
                type="error"
                showIcon
                message="Cachet invalide"
                description="La signature ne correspond pas à la charge scellée : le cachet a été altéré en base. Il ne prouve plus rien."
              />
            )}
            {/* Le cas que le verdict vert masquait avant le 2026-09-15 : cachet parfaitement
                authentique, mais le binaire du coffre ne correspond plus à ce qu'il couvre.
                Dire ce que le cachet prouve ENCORE évite de le faire passer pour inutile — il
                établit précisément que la fraude est au coffre et non dans la base. */}
            {seal.knownKey !== false &&
              seal.signatureValid === true &&
              view?.integrityOk === false && (
                <Alert
                  style={{ marginTop: space.md }}
                  type="error"
                  showIcon
                  message="Le cachet n’atteste plus le fichier présent au coffre"
                  description="La signature et les empreintes scellées sont intactes : le cachet n’a pas été touché. Mais la vérification d’intégrité ci-dessus établit que le binaire du coffre ne correspond plus à ces empreintes. Le fichier a donc été modifié ou remplacé hors de l’application, après le scellement. Restaurez le binaire d’origine ; ne renouvelez le cachet qu’une fois le contenu rétabli — re-sceller maintenant reviendrait à attester le fichier altéré."
                />
              )}
            {seal.knownKey !== false &&
              seal.signatureValid === true &&
              seal.timestampMatches === false && (
                <Alert
                  style={{ marginTop: space.md }}
                  type="error"
                  showIcon
                  message="Horodatage altéré en base"
                  description="La date enregistrée diverge de celle couverte par la signature. La date affichée ci-dessus est la date SIGNÉE, seule digne de foi ; celle de la base a été modifiée hors de l’application."
                />
              )}
            {/* `integrityOk !== false` en garde : quand le coffre est altéré, l'alerte ci-dessus
                dit déjà l'essentiel et elle est plus grave. Deux bandeaux se disputant la même
                ligne brouilleraient la seule action à mener. */}
            {seal.knownKey !== false &&
              seal.signatureValid === true &&
              view?.integrityOk !== false &&
              seal.contentMatches === false && (
                <Alert
                  style={{ marginTop: space.md }}
                  type="warning"
                  showIcon
                  message="Nouvelle version depuis le scellement"
                  description="Le cachet est authentique, mais les empreintes de référence ont changé depuis qu’il a été apposé — c’est ce qui se produit après une réindexation ou une nouvelle version numérisée. Il n’atteste donc plus le contenu actuel. Renouvelez-le si cette évolution est légitime."
                />
              )}
          </>
        ) : (
          <Text type="secondary" style={{ fontSize: fontSize.xs }}>
            Aucun cachet. L’apposer signe les empreintes des binaires et l’instant du scellement :
            toute modification ultérieure du contenu — ou de la date elle-même — devient détectable.
          </Text>
        )}
      </div>

    </Space>
  );
}

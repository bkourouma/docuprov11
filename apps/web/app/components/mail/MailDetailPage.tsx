'use client';

import { useState, type CSSProperties, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import {
  Alert,
  App,
  Button,
  Card,
  Col,
  DatePicker,
  Descriptions,
  Drawer,
  Empty,
  Form,
  Input,
  List,
  Popconfirm,
  Row,
  Select,
  Skeleton,
  Space,
  Tabs,
  Tag,
  Timeline,
  Typography,
} from 'antd';
import { PageHeader } from '../PageHeader';
import { EmptyState } from '../EmptyState';
import { PdfViewer } from '../viewer/PdfViewer';
import { icons } from '../../theme/icons';
import { space } from '../../theme/tokens';
import { destinataireLabel, downloadDocument, treatRecipient } from '../../lib/courriers';
import { DeadlineAlert } from './DeadlineAlert';
import { MailStatusTag, MailTypeTag } from './tags';
import { useMailWorkflow } from './useMailWorkflow';
import { fmt, fmtDt, imputationHistory, personName } from './mailFormat';

/**
 * Largeur de confort des blocs de lecture (Descriptions, bandeaux). Sans plafond, sur un moniteur
 * large, la valeur s'éloigne tellement de son libellé que l'œil perd la ligne entre les deux.
 */
const CONTENT_MAX_WIDTH = 960;

/**
 * Hauteur des actions de ligne de liste. Les boutons `size="small"` d'AntD tombent à 28 px, très
 * en dessous de la cible pointable de 40 px visée par le relook (§6.9) — l'écart se paie sur les
 * listes de pièces, où l'on vise deux boutons voisins.
 */
const ROW_ACTION_HEIGHT = 40;

/**
 * Badge d'état sur la palette du relook, en remplacement des presets AntD (`green`/`gold`/`blue`)
 * qui portent leur propre nuancier, étranger à la palette.
 *
 * Les statuts d'AntD (`<Tag color="success">`) ne conviennent pas davantage : ils peignent le
 * LIBELLÉ avec la sémantique elle-même posée sur son propre fond doux, ce qui mesure 2,6:1
 * (succès) à 4,2:1 (avertissement) sur cette palette — sous le seuil AA. La teinte reste donc sur
 * la surface et la bordure, qui ne portent pas de texte, et le libellé garde la couleur de texte
 * du thème (11:1 en clair, 12:1 en sombre).
 */
function stateTagStyle(tone: 'success' | 'warning' | 'info'): CSSProperties {
  return {
    marginInlineEnd: 0,
    background: `var(--ant-color-${tone}-bg)`,
    borderColor: `var(--ant-color-${tone}-border)`,
    color: 'var(--ant-color-text)',
  };
}

/**
 * Squelette de la fiche pendant son chargement. Un spinner centré ne réservait aucune place : la
 * page passait d'un bloc vide à la fiche complète d'un coup. Le squelette reprend la silhouette
 * réelle — titre, badges d'état, barre d'actions, carte à onglets — pour que rien ne saute.
 */
function MailDetailSkeleton() {
  return (
    <div aria-busy="true" aria-label="Chargement du courrier">
      <Skeleton.Input active size="large" style={{ width: 'min(420px, 70%)' }} />
      <div style={{ display: 'flex', gap: space.sm, marginTop: space.md, marginBottom: space.md }}>
        <Skeleton.Button active size="small" style={{ width: 96 }} />
        <Skeleton.Button active size="small" style={{ width: 132 }} />
      </div>
      <div style={{ marginBottom: space.lg }}>
        <Skeleton.Button active style={{ width: 190 }} />
      </div>
      <Card>
        <div style={{ maxWidth: CONTENT_MAX_WIDTH }}>
          <Skeleton active title={{ width: 180 }} paragraph={{ rows: 6 }} />
        </div>
      </Card>
    </div>
  );
}

/**
 * Page complète de consultation d'un courrier, en onglets (indexation / imputations) — plus
 * d'espace qu'en popup. Le document ne s'affiche pas en permanence à côté : un bouton l'ouvre
 * dans un panneau coulissant, à la demande.
 *
 * Utilisée par le Contrôle (§06), le Parapheur (§08) et le Suivi (§09), chacun via sa route
 * `[mailId]` ; seuls les interrupteurs changent :
 *  - `canTreatImputations` (Parapheur, Suivi) : bouton « Traiter » + statut sur chaque imputation
 *    (§10). Le Contrôle le masque — le traitement se fait depuis le menu dédié du destinataire.
 *  - `canDeleteOwnImputations` (Contrôle) : une imputation peut être supprimée, mais seulement
 *    par son auteur (§08).
 *  - `showWorkflowActions` (Parapheur, Suivi) : actions d'état du courrier (§03.2) sous l'en-tête,
 *    comme dans le pied du `MailViewer` popup.
 */
export function MailDetailPage({
  mailId,
  listHref,
  listLabel,
  autoTreatOnOpen = false,
  allowArchive = true,
  showWorkflowActions = false,
  canTreatImputations = false,
  canDeleteOwnImputations = false,
  canAddImputations = true,
  showFilesTab = false,
  onlyMyImputations = false,
  extraActions,
}: {
  mailId: number | null;
  /** Liste d'origine — fil d'Ariane et « Retour à la liste ». */
  listHref: string;
  listLabel: string;
  /** §03.1 : traite les imputations « suivi » à l'ouverture (Parapheur). */
  autoTreatOnOpen?: boolean;
  /** §03.1 : l'archivage clôt le courrier — masqué au bureau d'ordre (§06). */
  allowArchive?: boolean;
  /** Actions d'état du courrier (§03.2) sous l'en-tête. */
  showWorkflowActions?: boolean;
  /** Bouton « Traiter » + statut sur chaque imputation (§10). */
  canTreatImputations?: boolean;
  /** Suppression d'une imputation par son auteur (§08). */
  canDeleteOwnImputations?: boolean;
  /** Bouton « Ajouter une imputation » + son formulaire. */
  canAddImputations?: boolean;
  /** Onglet « Fichiers » : toutes les pièces rattachées au courrier (§12/§13). */
  showFilesTab?: boolean;
  /**
   * §08 : n'afficher que les imputations de l'utilisateur et celles qu'il a créées. Le serveur
   * accorde la vue complète au destinataire principal du courrier (et à l'admin).
   */
  onlyMyImputations?: boolean;
  /** Boutons supplémentaires à côté de « Visualiser le courrier ». */
  extraActions?: ReactNode;
}) {
  const router = useRouter();
  const { message } = App.useApp();
  const [docOpen, setDocOpen] = useState(false);
  // État local (et non `act`) : télécharger ne mute pas le courrier, il ne faut donc ni le
  // recharger ni afficher un toast de succès — le fichier qui arrive est la confirmation.
  const [downloadingId, setDownloadingId] = useState<number | null>(null);

  const downloadFile = async (mailDocumentId: number, documentId: number, label: string) => {
    setDownloadingId(mailDocumentId);
    try {
      if (!(await downloadDocument(documentId, label))) {
        message.error("Fichier introuvable : le binaire de ce document n'est pas disponible.");
      }
    } catch (e) {
      message.error(e instanceof Error ? e.message : 'Téléchargement impossible');
    } finally {
      setDownloadingId(null);
    }
  };

  const {
    mail,
    loading,
    busy,
    viewerUrl,
    viewerLoading,
    setViewerDocumentId,
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
  } = useMailWorkflow({ mailId, autoTreatOnOpen, allowArchive, onlyMyImputations });

  const backToList = () => router.push(listHref);

  if (!mail) {
    if (loading) {
      return <MailDetailSkeleton />;
    }
    // Id invalide, courrier supprimé ou accès refusé (P3 deny-by-default) : l'URL étant désormais
    // accessible en direct (favori, lien périmé), ce cas est normal — on garde une porte de sortie
    // au lieu d'un spinner sans fin.
    return (
      <div>
        <PageHeader
          icon="mail"
          title="Courrier introuvable"
          breadcrumb={[{ label: listLabel, href: listHref }, { label: 'Introuvable' }]}
          actions={<Button onClick={backToList}>Retour à la liste</Button>}
        />
        <Card>
          <EmptyState icon="mail" title="Courrier introuvable" />
        </Card>
      </div>
    );
  }

  return (
    <div>
      <PageHeader
        icon="mail"
        title={mail.title}
        breadcrumb={[
          { label: listLabel, href: listHref },
          { label: mail.nReference ?? `#${mail.mailId}` },
        ]}
        actions={<Button onClick={backToList}>Retour à la liste</Button>}
      />

      {/* Statut courant du courrier (§8.H) — absent jusqu'ici de la page de détail, alors que la
          worklist d'origine l'affiche : un utilisateur arrivant par lien direct n'avait aucun
          moyen de le voir sans deviner depuis les onglets. */}
      <Space size={space.sm} style={{ marginBottom: space.md }}>
        <MailTypeTag mailType={mail.mailType} />
        <MailStatusTag status={mail.status} />
      </Space>

      <DeadlineAlert dateButoire={mail.dateButoire} treated={mail.dateTraited != null} />

      {/* Boutons hors du PageHeader : un titre de courrier est un texte libre, potentiellement
          long, et le flex du header ne le rétrécit pas gracieusement s'il doit aussi les caser sur
          la même ligne (il finit par écraser le titre lettre par lettre). */}
      <Space wrap style={{ marginBottom: space.lg }}>
        <Button
          icon={<icons.view size={16} />}
          onClick={() => {
            setViewerDocumentId(null); // revient au document principal du courrier
            setDocOpen(true);
          }}
        >
          Visualiser le courrier
        </Button>
        {extraActions}
        {showWorkflowActions &&
          actions.map((a) => (
            <Button
              key={a.key}
              type={a.type}
              loading={busy === a.key}
              onClick={() => void act(a.key, a.run, a.ok)}
            >
              {a.label}
            </Button>
          ))}
      </Space>

      <Card>
        <Tabs
          defaultActiveKey="courrier"
          items={[
            {
              key: 'courrier',
              label: 'Courrier',
              children: (
                // Plafond de largeur : la carte occupe toute la page, mais une paire
                // libellé/valeur étirée sur 1600 px ne se lit plus.
                <div style={{ maxWidth: CONTENT_MAX_WIDTH }}>
                  <Descriptions column={2} size="small" bordered>
                    <Descriptions.Item label="N° enregistrement">
                      {mail.nReference ? <span className="da-mono">{mail.nReference}</span> : '—'}
                    </Descriptions.Item>
                    <Descriptions.Item label="Date du courrier">
                      <span style={{ whiteSpace: 'nowrap' }}>{fmt(mail.date)}</span>
                    </Descriptions.Item>
                    <Descriptions.Item label="Enregistré le">
                      <span style={{ whiteSpace: 'nowrap' }}>
                        {fmtDt(mail.dateEnregistrementCourrier)}
                      </span>
                    </Descriptions.Item>
                    <Descriptions.Item label="Correspondant">
                      {mail.externalEntity?.label || '—'}
                    </Descriptions.Item>
                    <Descriptions.Item label="Destinataire">
                      {destinataireLabel(mail)}
                    </Descriptions.Item>
                    <Descriptions.Item label="Description">
                      {mail.description || '—'}
                    </Descriptions.Item>
                  </Descriptions>

                  {mail.documents.length > 1 && (
                    <Alert
                      type="info"
                      showIcon
                      style={{ marginTop: space.md }}
                      message={`${mail.documents.length} documents rattachés — l'aperçu affiche le premier.`}
                    />
                  )}
                </div>
              ),
            },
            {
              key: 'imputations',
              label: `Imputations (${mail.inputations.length})`,
              children: (
                <>
                  {canAddImputations && impOpen ? (
                    /*
                      Formulaire à labels posés AU-DESSUS des champs : les libellés vivaient
                      auparavant dans les placeholders et disparaissaient dès la première saisie —
                      impossible, en relisant, de savoir lequel des deux Selects portait le rôle.
                      `component={false}` : on veut la mise en page et les labels d'AntD, pas un
                      <form> qui capturerait la touche Entrée (la soumission reste le bouton).
                    */
                    <Form component={false} layout="vertical">
                      <Space
                        direction="vertical"
                        size="small"
                        style={{
                          width: '100%',
                          marginBottom: space.lg,
                          maxWidth: CONTENT_MAX_WIDTH,
                        }}
                      >
                        <Row gutter={[space.md, space.md]}>
                          <Col xs={24} sm={12}>
                            <Form.Item
                              label="Rôle"
                              htmlFor="imp-role"
                              required
                              style={{ marginBottom: 0 }}
                            >
                              <Select
                                id="imp-role"
                                style={{ width: '100%' }}
                                showSearch
                                optionFilterProp="label"
                                placeholder="Sélectionner un rôle"
                                value={impRole ?? undefined}
                                onChange={(v) => {
                                  setImpRole(v as number);
                                  setImpActors([]);
                                }}
                                options={roles.map((r) => ({ value: r.roleId, label: r.label }))}
                              />
                            </Form.Item>
                          </Col>
                          <Col xs={24} sm={12}>
                            <Form.Item
                              label="Imputer à"
                              htmlFor="imp-actors"
                              required
                              style={{ marginBottom: 0 }}
                            >
                              <Select
                                id="imp-actors"
                                style={{ width: '100%' }}
                                mode="multiple"
                                showSearch
                                optionFilterProp="label"
                                placeholder={
                                  impRole == null
                                    ? 'Choisissez d’abord un rôle'
                                    : 'Un ou plusieurs destinataires'
                                }
                                disabled={impRole == null}
                                value={impActors}
                                onChange={(v) => setImpActors(v as number[])}
                                options={roleActors.map((a) => ({
                                  value: a.userGroupId,
                                  label: personName(a.label),
                                }))}
                                notFoundContent={
                                  impRole != null && roleActors.length === 0
                                    ? 'Aucun utilisateur actif ne porte ce rôle'
                                    : undefined
                                }
                              />
                            </Form.Item>
                          </Col>
                        </Row>
                        <Row gutter={[space.md, space.md]}>
                          <Col xs={24} sm={12}>
                            <Form.Item
                              label="Type d'imputation"
                              htmlFor="imp-type"
                              required
                              style={{ marginBottom: 0 }}
                            >
                              <Select
                                id="imp-type"
                                style={{ width: '100%' }}
                                showSearch
                                optionFilterProp="label"
                                placeholder="Sélectionner un type"
                                value={impType ?? undefined}
                                onChange={(v) => setImpType(v as number)}
                                options={types.map((t) => ({
                                  value: t.mailInputationTypeId,
                                  label: t.label,
                                }))}
                              />
                            </Form.Item>
                          </Col>
                          <Col xs={24} sm={12}>
                            {/*
                              Échéance à la journée : l'heure n'apportait rien au Contrôle. La valeur
                              est calée sur la fin du jour choisi, faute de quoi une échéance au
                              25/07 (stockée 00:00) serait « dépassée » dès le matin du 25.
                              Millisecondes à zéro : la colonne est à la seconde (TIMESTAMPTZ(0)) et
                              PostgreSQL ARRONDIT, 23:59:59.999 devenait le lendemain 00:00:00.
                            */}
                            <Form.Item
                              label="Échéance (facultatif)"
                              htmlFor="imp-deadline"
                              style={{ marginBottom: 0 }}
                            >
                              <DatePicker
                                id="imp-deadline"
                                style={{ width: '100%' }}
                                format="DD/MM/YYYY"
                                placeholder="JJ/MM/AAAA"
                                value={impDeadline}
                                onChange={(d) => setImpDeadline(d ? d.endOf('day').millisecond(0) : null)}
                              />
                            </Form.Item>
                          </Col>
                        </Row>
                        <Form.Item
                          label="Instructions (facultatif)"
                          htmlFor="imp-instructions"
                          style={{ marginBottom: 0 }}
                        >
                          <Input.TextArea
                            id="imp-instructions"
                            rows={2}
                            placeholder="Consignes de traitement à l'attention du destinataire"
                            value={impInstr}
                            onChange={(e) => setImpInstr(e.target.value)}
                          />
                        </Form.Item>
                        <Space>
                          <Button
                            type="primary"
                            loading={busy === 'imputer'}
                            disabled={impActors.length === 0 || impType == null}
                            onClick={() => void submitInputation()}
                          >
                            Imputer
                          </Button>
                          <Button
                            onClick={() => {
                              setImpOpen(false);
                              setImpRole(null);
                              setImpActors([]);
                            }}
                          >
                            Annuler
                          </Button>
                        </Space>
                      </Space>
                    </Form>
                  ) : canAddImputations ? (
                    <div
                      style={{
                        display: 'flex',
                        justifyContent: 'flex-end',
                        marginBottom: space.md,
                      }}
                    >
                      <Button icon={<icons.add size={16} />} onClick={() => setImpOpen(true)}>
                        Ajouter une imputation
                      </Button>
                    </div>
                  ) : null}
                  {mail.inputations.length === 0 ? (
                    <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="Aucune imputation" />
                  ) : (
                    <List
                      size="small"
                      dataSource={[...mail.inputations].sort(
                        (a, b) => a.mailInputationId - b.mailInputationId,
                      )}
                      renderItem={(i) => {
                        const itemActions = [
                          // §10 : traitement des imputations d'un destinataire, sans forcer le
                          // statut du courrier (à la différence de « Marquer traité »).
                          ...(canTreatImputations && !i.dateTreated
                            ? [
                                <Button
                                  key="traiter"
                                  style={{ height: ROW_ACTION_HEIGHT }}
                                  loading={busy === `traiter-${i.userId}`}
                                  onClick={() =>
                                    void act(
                                      `traiter-${i.userId}`,
                                      () => treatRecipient(mail.mailId, i.userId),
                                      `Imputations de ${actorLabel(i.userId)} traitées.`,
                                    )
                                  }
                                >
                                  Traiter
                                </Button>,
                              ]
                            : []),
                          // Réservé à l'auteur (§08) : un destinataire ne supprime pas ce qu'un
                          // autre lui a imputé, seul celui qui l'a créée le peut.
                          ...(canDeleteOwnImputations &&
                          i.createdBy != null &&
                          i.createdBy === currentUserGroupId
                            ? [
                                <Popconfirm
                                  key="supprimer"
                                  title="Supprimer cette imputation ?"
                                  description="Cette action est définitive."
                                  okText="Oui"
                                  cancelText="Non"
                                  onConfirm={() => void deleteImputation(i.mailInputationId)}
                                >
                                  <Button
                                    danger
                                    style={{ height: ROW_ACTION_HEIGHT }}
                                    loading={busy === `supprimer-${i.mailInputationId}`}
                                  >
                                    Supprimer
                                  </Button>
                                </Popconfirm>,
                              ]
                            : []),
                        ];
                        return (
                          <List.Item actions={itemActions.length ? itemActions : undefined}>
                            <List.Item.Meta
                              title={
                                <Space size={6} wrap>
                                  <Typography.Text strong>
                                    {i.type?.label ?? `Type ${i.mailInputationTypeId}`}
                                  </Typography.Text>
                                  <Typography.Text type="secondary">
                                    {actorLabel(i.userId)}
                                  </Typography.Text>
                                  {canTreatImputations && (
                                    <Tag
                                      style={stateTagStyle(i.dateTreated ? 'success' : 'warning')}
                                    >
                                      {i.dateTreated ? 'Traitée' : 'En attente'}
                                    </Tag>
                                  )}
                                </Space>
                              }
                              description={
                                <>
                                  {i.instructions && (
                                    <Typography.Paragraph
                                      style={{ marginBottom: 8 }}
                                      ellipsis={{ rows: 3, expandable: true, symbol: 'plus' }}
                                    >
                                      {i.instructions}
                                    </Typography.Paragraph>
                                  )}
                                  {/* Historique de l'imputation : création → échéance → traitement. */}
                                  <Timeline
                                    style={{ marginTop: 4, marginBottom: 0 }}
                                    items={imputationHistory(i, actorLabel)}
                                  />
                                </>
                              }
                            />
                          </List.Item>
                        );
                      }}
                    />
                  )}
                </>
              ),
            },
            // §12/§13 : toutes les pièces rattachées — le courrier lui-même, la réponse de départ
            // qui lui a été liée, et la décharge signée intégrée. Consultation seule.
            ...(showFilesTab
              ? [
                  {
                    key: 'fichiers',
                    label: `Fichiers (${mail.documents.length})`,
                    children:
                      mail.documents.length === 0 ? (
                        <Empty
                          image={Empty.PRESENTED_IMAGE_SIMPLE}
                          description="Aucun fichier rattaché"
                        />
                      ) : (
                        <List
                          size="small"
                          dataSource={mail.documents}
                          renderItem={(d) => (
                            <List.Item
                              actions={
                                d.document
                                  ? [
                                      // Cibles à 40 px : deux boutons voisins dans une ligne de
                                      // liste, la taille `small` d'AntD (28 px) les rend trop
                                      // faciles à confondre au clic comme au doigt.
                                      <Button
                                        key="voir"
                                        icon={<icons.view size={16} />}
                                        style={{ height: ROW_ACTION_HEIGHT }}
                                        onClick={() => {
                                          setViewerDocumentId(d.document!.documentId);
                                          setDocOpen(true);
                                        }}
                                      >
                                        Visualiser
                                      </Button>,
                                      <Button
                                        key="telecharger"
                                        icon={<icons.download size={16} />}
                                        style={{ height: ROW_ACTION_HEIGHT }}
                                        loading={downloadingId === d.mailDocumentId}
                                        onClick={() =>
                                          void downloadFile(
                                            d.mailDocumentId,
                                            d.document!.documentId,
                                            d.document!.label,
                                          )
                                        }
                                      >
                                        Télécharger
                                      </Button>,
                                    ]
                                  : undefined
                              }
                            >
                              <List.Item.Meta
                                avatar={<icons.document size={18} />}
                                title={
                                  <Space size={6} wrap>
                                    <Typography.Text>
                                      {d.document?.label ?? 'Document introuvable'}
                                    </Typography.Text>
                                    <Tag style={stateTagStyle(d.decharge ? 'success' : 'info')}>
                                      {d.decharge ? 'Décharge signée' : 'Courrier'}
                                    </Tag>
                                  </Space>
                                }
                              />
                            </List.Item>
                          )}
                        />
                      ),
                  },
                ]
              : []),
          ]}
        />
      </Card>

      {/* Tiroir large : la visionneuse embarque sa barre d'outils (zoom, recherche, vignettes). */}
      <Drawer
        title="Aperçu du courrier"
        placement="right"
        width="min(1100px, 96vw)"
        open={docOpen}
        onClose={() => setDocOpen(false)}
        styles={{
          // En-tête sur le fond de layout : sans lui, le bandeau blanc du tiroir se confond avec
          // la page blanche du PDF juste en dessous et la limite de la barre d'outils disparaît.
          header: { background: 'var(--ant-color-bg-layout)' },
          body: { padding: 0, display: 'flex', flexDirection: 'column' },
        }}
      >
        <PdfViewer
          src={viewerUrl}
          loading={viewerLoading}
          fileName={`${mail?.nReference || `courrier-${mailId}`}.pdf`}
          style={{ flex: 1, border: 'none', borderRadius: 0 }}
          empty={<EmptyState compact icon="document" title="Aucun aperçu" />}
        />
      </Drawer>
    </div>
  );
}

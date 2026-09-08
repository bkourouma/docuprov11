'use client';

import type { CSSProperties } from 'react';
import {
  Alert,
  Button,
  Col,
  DatePicker,
  Descriptions,
  Empty,
  Form,
  Input,
  List,
  Modal,
  Row,
  Select,
  Space,
  Spin,
  Tabs,
  Tag,
  Timeline,
  Typography,
} from 'antd';
import { EmptyState } from '../EmptyState';
import { PdfViewer } from '../viewer/PdfViewer';
import { icons } from '../../theme/icons';
import { radii, space } from '../../theme/tokens';
import { destinataireLabel, treatRecipient } from '../../lib/courriers';
import { DeadlineAlert } from './DeadlineAlert';
import { MailStatusTag, MailTypeTag } from './tags';
import { useMailWorkflow } from './useMailWorkflow';
import { fmt, fmtDt, imputationHistory, personName } from './mailFormat';

/**
 * Badge d'état sur la palette du relook (même contrainte que sur la fiche pleine page) : les
 * statuts d'AntD peignent le libellé avec la sémantique posée sur son propre fond doux, ce qui
 * tombe à 2,6:1 en succès. La teinte tient la surface et la bordure, le libellé reste sur la
 * couleur de texte du thème.
 */
function stateTagStyle(tone: 'success' | 'warning'): CSSProperties {
  return {
    marginInlineEnd: 0,
    background: `var(--ant-color-${tone}-bg)`,
    borderColor: `var(--ant-color-${tone}-border)`,
    color: 'var(--ant-color-text)',
  };
}

/**
 * Visionneuse de courrier (MailViewer, §08) : document à gauche, panneau à onglets à droite
 * (« Courrier » = indexation, « Imputations » = historique + création), actions de workflow en
 * pied. Les actions proposées dépendent de l'état du courrier (drapeaux + dates, §03.2) ; le back
 * applique en plus le garde de menu.
 *
 * Le contrôle bureau d'ordre (§06) n'a pas de bouton : le back le déclenche automatiquement quand
 * le destinataire principal impute le courrier (`autoValiderOnImputation`).
 *
 * `autoTreatOnOpen` reproduit la validation automatique à la lecture du parapheur (§03.1) :
 * les imputations de type « suivi » sont traitées à l'ouverture.
 *
 * `allowArchive` : l'archivage (§03.1) clôt le courrier. Il n'a de sens qu'en fin de chaîne — le
 * bureau d'ordre (§06) le masque, sans quoi on pourrait clore un courrier avant même son contrôle.
 *
 * Popup générique utilisée par Parapheur, Suivi, Validation, Départ, Intégration décharge et
 * Recherche. Le Contrôle (§06), lui, a sa propre page complète (`controle/[mailId]/page.tsx`) qui
 * réutilise la même logique via `useMailWorkflow`.
 */
export function MailViewer({
  mailId,
  onClose,
  onChanged,
  autoTreatOnOpen = false,
  allowArchive = true,
}: {
  mailId: number | null;
  onClose: () => void;
  onChanged?: () => void;
  autoTreatOnOpen?: boolean;
  allowArchive?: boolean;
}) {
  const {
    mail,
    loading,
    busy,
    viewerUrl,
    viewerLoading,
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
    actorLabel,
    actions,
  } = useMailWorkflow({ mailId, autoTreatOnOpen, allowArchive, onChanged });

  return (
    <Modal
      open={mailId != null}
      onCancel={onClose}
      // Pleine largeur sous 768 px : 88 % d'un écran de 360 perdait 12 % de la place pour rien
      // (une largeur en pourcentage n'est jamais relevée sur mobile). Inchangé au-dessus.
      width={{ xs: '100%', md: '88%' }}
      style={{ top: space.lg }}
      destroyOnHidden
      // Surface flottante de la grille §4.2 : rayon des modales et ombre de popover. La popup
      // reste une popup — la basculer en page changerait la route du menu Validation.
      styles={{ content: { borderRadius: radii.lg, boxShadow: 'var(--da-shadow-popover)' } }}
      title={<span className="da-display">{mail?.title ?? 'Courrier'}</span>}
      footer={
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            gap: space.md,
            flexWrap: 'wrap',
          }}
        >
          <Space wrap>
            {actions.map((a) => (
              <Button
                key={a.key}
                type={a.type}
                size="small"
                loading={busy === a.key}
                onClick={() => void act(a.key, a.run, a.ok)}
              >
                {a.label}
              </Button>
            ))}
          </Space>
          <Button type="primary" onClick={onClose}>
            Fermer
          </Button>
        </div>
      }
    >
      {loading || !mail ? (
        <div style={{ display: 'grid', placeItems: 'center', padding: space.xxxl }}>
          <Spin />
        </div>
      ) : (
        <>
          {/* Statut + échéance : absents jusqu'ici de la popup, alors que la worklist d'origine les
              montre tous les deux — un utilisateur ouvrant cette fiche n'avait aucun repère. */}
          <Space size={space.sm} style={{ marginBottom: space.sm }}>
            <MailTypeTag mailType={mail.mailType} />
            <MailStatusTag status={mail.status} />
          </Space>
          <DeadlineAlert dateButoire={mail.dateButoire} treated={mail.dateTraited != null} />

          <Row gutter={space.lg} style={{ height: 'calc(100vh - 220px)' }}>
            {/* Gauche : aperçu du document lié */}
            <Col xs={24} lg={14} style={{ height: '100%', marginBottom: space.md }}>
              <PdfViewer
                src={viewerUrl}
                loading={viewerLoading}
                fileName={`${mail.nReference || `courrier-${mail.mailId}`}.pdf`}
                empty={<EmptyState compact icon="document" title="Aucun aperçu" />}
              />
            </Col>

            {/* Droite : panneau à onglets — indexation d'un côté, imputations de l'autre. */}
            <Col xs={24} lg={10} style={{ height: '100%', overflow: 'auto' }}>
              <Tabs
                defaultActiveKey="courrier"
                items={[
                  {
                    key: 'courrier',
                    label: 'Courrier',
                    children: (
                      <>
                        <Descriptions column={1} size="small" bordered>
                          <Descriptions.Item label="N° enregistrement">
                            {mail.nReference ? (
                              <span className="da-mono">{mail.nReference}</span>
                            ) : (
                              '—'
                            )}
                          </Descriptions.Item>
                          <Descriptions.Item label="Date du courrier">
                            {fmt(mail.date)}
                          </Descriptions.Item>
                          <Descriptions.Item label="Enregistré le">
                            {fmtDt(mail.dateEnregistrementCourrier)}
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
                      </>
                    ),
                  },
                  {
                    key: 'imputations',
                    label: `Imputations (${mail.inputations.length})`,
                    children: (
                      <>
                        {!impOpen && (
                          <div
                            style={{
                              display: 'flex',
                              justifyContent: 'flex-end',
                              marginBottom: space.md,
                            }}
                          >
                            <Button
                              size="small"
                              icon={<icons.add size={14} />}
                              onClick={() => setImpOpen(true)}
                            >
                              Ajouter une imputation
                            </Button>
                          </div>
                        )}
                        {mail.inputations.length === 0 ? (
                          <Empty
                            image={Empty.PRESENTED_IMAGE_SIMPLE}
                            description="Aucune imputation"
                          />
                        ) : (
                          <List
                            size="small"
                            dataSource={[...mail.inputations].sort(
                              (a, b) => a.mailInputationId - b.mailInputationId,
                            )}
                            renderItem={(i) => (
                              <List.Item
                                actions={
                                  // §10 : traitement des imputations d'un destinataire, sans forcer
                                  // le statut du courrier (à la différence de « Marquer traité »,
                                  // qui traite tout).
                                  i.dateTreated
                                    ? undefined
                                    : [
                                        <Button
                                          key="traiter"
                                          size="small"
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
                                }
                              >
                                <List.Item.Meta
                                  title={
                                    <Space size={6} wrap>
                                      <Typography.Text strong>
                                        {i.type?.label ?? `Type ${i.mailInputationTypeId}`}
                                      </Typography.Text>
                                      <Typography.Text type="secondary">
                                        {actorLabel(i.userId)}
                                      </Typography.Text>
                                      <Tag
                                        style={stateTagStyle(i.dateTreated ? 'success' : 'warning')}
                                      >
                                        {i.dateTreated ? 'Traitée' : 'En attente'}
                                      </Tag>
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
                            )}
                          />
                        )}

                        {impOpen ? (
                          /*
                          Mêmes vrais labels que sur la fiche pleine page : les libellés vivaient
                          dans les placeholders et s'effaçaient dès la saisie, alors que trois
                          Selects se suivent ici sans rien pour les distinguer une fois remplis.
                          `component={false}` : pas de <form> imbriqué dans la modale.
                          Les identifiants sont préfixés `mv-` pour ne pas entrer en collision avec
                          ceux de la fiche pleine page, qui porte le même formulaire.
                        */
                          <Form component={false} layout="vertical">
                            <Space
                              direction="vertical"
                              size="small"
                              style={{ width: '100%', marginTop: space.md }}
                            >
                              <Form.Item
                                label="Rôle"
                                htmlFor="mv-imp-role"
                                required
                                style={{ marginBottom: 0 }}
                              >
                                <Select
                                  id="mv-imp-role"
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
                              <Form.Item
                                label="Imputer à"
                                htmlFor="mv-imp-actors"
                                required
                                style={{ marginBottom: 0 }}
                              >
                                <Select
                                  id="mv-imp-actors"
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
                              <Form.Item
                                label="Type d'imputation"
                                htmlFor="mv-imp-type"
                                required
                                style={{ marginBottom: 0 }}
                              >
                                <Select
                                  id="mv-imp-type"
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
                              <Form.Item
                                label="Instructions (facultatif)"
                                htmlFor="mv-imp-instructions"
                                style={{ marginBottom: 0 }}
                              >
                                <Input.TextArea
                                  id="mv-imp-instructions"
                                  rows={2}
                                  placeholder="Consignes de traitement à l'attention du destinataire"
                                  value={impInstr}
                                  onChange={(e) => setImpInstr(e.target.value)}
                                />
                              </Form.Item>
                              <Form.Item
                                label="Échéance (facultatif)"
                                htmlFor="mv-imp-deadline"
                                style={{ marginBottom: 0 }}
                              >
                                <DatePicker
                                  id="mv-imp-deadline"
                                  style={{ width: '100%' }}
                                  showTime
                                  format="DD/MM/YYYY HH:mm"
                                  placeholder="JJ/MM/AAAA HH:mm"
                                  value={impDeadline}
                                  onChange={(d) => setImpDeadline(d)}
                                />
                              </Form.Item>
                              <Space>
                                <Button
                                  type="primary"
                                  size="small"
                                  loading={busy === 'imputer'}
                                  disabled={impActors.length === 0 || impType == null}
                                  onClick={() => void submitInputation()}
                                >
                                  Imputer
                                </Button>
                                <Button
                                  size="small"
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
                        ) : null}
                      </>
                    ),
                  },
                ]}
              />
            </Col>
          </Row>
        </>
      )}
    </Modal>
  );
}

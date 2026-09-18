'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { App, Alert, Button, Card, Col, Progress, Row, Space, Table, Typography } from 'antd';
import type { TableColumnsType } from 'antd';
import dayjs from 'dayjs';
import { PageHeader } from '../../components/PageHeader';
import { KpiCard } from '../../components/KpiCard';
import { EmptyState } from '../../components/EmptyState';
import { StateTag } from '../../components/documents/shared';
import { InfoTooltip } from '../../components/InfoTooltip';
import { icons } from '../../theme/icons';
import { fontSize, space } from '../../theme/tokens';
import {
  documentsApi,
  type IntegrityCoverage,
  type IntegritySweepResult,
  type NonCompliantRow,
  type SealFondsResult,
} from '../../lib/archives';

const { Text } = Typography;

/**
 * Bilan CUMULÉ d'un balayage complet — la somme des tranches, plus le fait que l'utilisateur
 * l'ait arrêté en route. `IntegritySweepResult` décrit une seule tranche ; l'écran, lui, rend
 * compte du geste entier.
 */
interface BilanBalayage extends IntegritySweepResult {
  interrompu: boolean;
}

/**
 * Taille d'UNE tranche. Le bouton en enchaîne autant qu'il faut pour couvrir le fonds : découper
 * reste indispensable — chaque contrôle relit le binaire entier, et une requête unique sur un
 * fonds de plusieurs milliers de pièces lirait des dizaines de gigaoctets en tenant la connexion
 * ouverte plusieurs minutes, jusqu'à ce que le navigateur ou le proxy la coupe. C'est donc le
 * NAVIGATEUR qui enchaîne, pas l'utilisateur. 500 est le plafond accepté par le serveur.
 */
const TRANCHE = 50;

/**
 * Docu-Archives — Intégrité du fonds.
 *
 * L'onglet « Sécurité et conformité » d'une fiche répond pour UNE pièce. Cet écran répond pour le
 * FONDS, ce qui est la seule échelle à laquelle « nos archives sont contrôlées » veut dire quelque
 * chose. Il porte donc deux choses que la fiche ne peut pas porter :
 *  - la couverture, en chiffres : combien de documents sont mesurables, mesurés, conformes, scellés ;
 *  - le balayage par tranches, qui rattrape le fonds existant sans monopoliser le serveur.
 *
 * Deux compteurs à ne pas confondre, d'où leur séparation visuelle et leurs infobulles :
 * « empreintes posées » dit que la pièce est MESURABLE (l'empreinte est posée à l'ingestion depuis
 * le 2026-09-15), « documents vérifiés » dit qu'on l'a effectivement MESURÉE. Un fonds entièrement
 * mesurable peut n'avoir jamais été mesuré — c'était exactement l'état de la base avant cet écran.
 */
export default function IntegritePage() {
  const { message } = App.useApp();
  const [couverture, setCouverture] = useState<IntegrityCoverage | null>(null);
  const [nonConformes, setNonConformes] = useState<NonCompliantRow[]>([]);
  const [chargement, setChargement] = useState(true);
  const [balayage, setBalayage] = useState(false);
  const [dernierPassage, setDernierPassage] = useState<BilanBalayage | null>(null);
  const [progression, setProgression] = useState<{ faits: number; total: number } | null>(null);
  // `useRef` et non un état : la boucle de balayage lit le drapeau À CHAQUE tour, or une closure
  // ne verrait jamais une valeur d'état mise à jour après son démarrage.
  const demandeArret = useRef(false);
  const [scellement, setScellement] = useState(false);
  const [bilanScellement, setBilanScellement] = useState<SealFondsResult | null>(null);

  const charger = useCallback(async () => {
    setChargement(true);
    try {
      const [cov, nc] = await Promise.all([
        documentsApi.integrityCoverage(),
        documentsApi.integrityNonCompliant(),
      ]);
      setCouverture(cov);
      setNonConformes(nc);
    } catch (e) {
      message.error(e instanceof Error ? e.message : 'Chargement impossible');
    } finally {
      setChargement(false);
    }
  }, [message]);

  useEffect(() => {
    void charger();
  }, [charger]);

  /**
   * Balaie le fonds ENTIER en enchaînant les tranches côté navigateur.
   *
   * Nombre de passes borné à `total / TRANCHE` : le serveur sert toujours les documents dont la
   * vérification est la plus ancienne (jamais vérifiés d'abord), et chaque passage remet ceux
   * qu'il traite en fin de file. Les tranches balaient donc le fonds une fois et une seule, sans
   * curseur à transporter — et la borne interdit la boucle infinie le jour où cette propriété
   * cesserait d'être vraie. Deux autres sorties : une tranche vide (plus rien d'éligible) et la
   * demande d'arrêt de l'utilisateur.
   */
  const balayerLeFonds = async () => {
    const total = couverture?.documents ?? 0;
    if (total === 0) {
      message.info('Aucun document au fonds.');
      return;
    }
    setBalayage(true);
    demandeArret.current = false;
    setProgression({ faits: 0, total });

    const bilan: BilanBalayage = {
      traites: 0,
      conformes: 0,
      nonConformes: 0,
      empreintesPosees: 0,
      echecs: [],
      restants: 0,
      interrompu: false,
    };

    try {
      const passes = Math.ceil(total / TRANCHE);
      for (let i = 0; i < passes; i++) {
        if (demandeArret.current) {
          bilan.interrompu = true;
          break;
        }
        // Dernière tranche ajustée au reste à parcourir : à taille fixe, elle déborderait et
        // recontrôlerait des pièces déjà vues dans ce même passage — le bilan annoncerait alors
        // plus de documents que n'en compte le fonds, ce qui se lit comme une erreur.
        const taille = Math.min(TRANCHE, total - bilan.traites);
        const res = await documentsApi.sweepIntegrity(taille);
        bilan.traites += res.traites;
        bilan.conformes += res.conformes;
        bilan.nonConformes += res.nonConformes;
        bilan.empreintesPosees += res.empreintesPosees;
        bilan.echecs.push(...res.echecs);
        bilan.restants = res.restants;
        setProgression({ faits: Math.min(bilan.traites, total), total });
        // Tranche vide : plus aucun document éligible (tous sans binaire, par exemple). Continuer
        // ferait tourner la boucle pour rien.
        if (res.traites === 0) break;
        if (bilan.traites >= total) break;
      }

      setDernierPassage(bilan);
      if (bilan.nonConformes > 0) {
        message.error(`${bilan.nonConformes} document(s) NON conforme(s) — voir la liste ci-dessous.`);
      } else if (bilan.interrompu) {
        message.warning(`Balayage interrompu après ${bilan.traites} document(s).`);
      } else {
        message.success(`${bilan.traites} document(s) contrôlé(s), tous conformes.`);
      }
      await charger();
    } catch (e) {
      message.error(e instanceof Error ? e.message : 'Balayage impossible');
      // Le bilan partiel vaut mieux que rien : les tranches déjà passées ont RÉELLEMENT contrôlé
      // leurs documents, et une non-conformité déjà trouvée doit rester à l'écran.
      if (bilan.traites > 0) setDernierPassage({ ...bilan, interrompu: true });
      await charger();
    } finally {
      setBalayage(false);
      setProgression(null);
    }
  };

  /**
   * Scelle le fonds par tranches, comme le balayage — mais sur un critère qui RÉTRÉCIT à chaque
   * passage (les documents jamais scellés), donc la boucle s'arrête d'elle-même quand il n'en
   * reste plus. Borne de sécurité malgré tout : un échec systématique sur les mêmes pièces
   * laisserait `restants` constant et ferait tourner la boucle indéfiniment.
   */
  const scellerLeFonds = async () => {
    setScellement(true);
    const cumul: SealFondsResult = { examines: 0, scelles: 0, echecs: [], restants: 0 };
    try {
      const passesMax = Math.ceil((couverture?.documents ?? 0) / TRANCHE) + 1;
      for (let i = 0; i < passesMax; i++) {
        const res = await documentsApi.sealFonds(TRANCHE);
        cumul.examines += res.examines;
        cumul.scelles += res.scelles;
        cumul.echecs.push(...res.echecs);
        cumul.restants = res.restants;
        if (res.examines === 0 || res.restants === 0) break;
        // Aucune pièce scellée alors qu'il en restait : elles échouent toutes, insister est vain.
        if (res.scelles === 0) break;
      }
      setBilanScellement(cumul);
      if (cumul.scelles > 0) message.success(`${cumul.scelles} document(s) scellé(s).`);
      else message.info('Aucun document à sceller : le fonds est déjà couvert.');
      await charger();
    } catch (e) {
      message.error(e instanceof Error ? e.message : 'Scellement impossible');
      if (cumul.scelles > 0) setBilanScellement(cumul);
      await charger();
    } finally {
      setScellement(false);
    }
  };

  const colonnes: TableColumnsType<NonCompliantRow> = [
    {
      title: 'Document',
      dataIndex: 'label',
      key: 'label',
      render: (value: string, r) => (
        <Link href={`/documents/${r.documentId}`} title={value} className="line-clamp-2">
          {value}
        </Link>
      ),
    },
    {
      title: 'Constaté le',
      dataIndex: 'dateLastVerified',
      key: 'dateLastVerified',
      width: 170,
      render: (v: string | null) => (v ? dayjs(v).format('DD/MM/YYYY HH:mm') : '—'),
    },
    {
      title: '',
      key: 'etat',
      width: 180,
      render: () => <StateTag tone="danger">Intégrité non garantie</StateTag>,
    },
  ];

  const resteAFaire = couverture ? couverture.jamaisVerifies > 0 : false;

  return (
    <div>
      <PageHeader
        icon="lock"
        title="Intégrité du fonds"
        breadcrumb={[{ label: 'Docu-Archives' }, { label: 'Intégrité du fonds' }]}
        actions={
          balayage ? (
            // Un balayage de plusieurs milliers de pièces peut durer : il doit rester
            // interruptible. La tranche en cours va à son terme — l'arrêter au milieu laisserait
            // des documents relus sans verdict enregistré.
            <Button danger onClick={() => (demandeArret.current = true)}>
              Arrêter après la tranche en cours
            </Button>
          ) : (
            <Space wrap size={space.sm}>
              <Button
                type="primary"
                icon={<icons.check size={16} />}
                onClick={() => void balayerLeFonds()}
              >
                Contrôler tout le fonds
              </Button>
              {/* Action SECONDAIRE : le contrôle est le geste courant, le scellement un rattrapage
                  qu'on ne fait qu'une fois — les documents acquis depuis le 15/09/2026 sont scellés
                  d'office à l'ingestion. */}
              <Button
                icon={<icons.lock size={16} />}
                loading={scellement}
                disabled={!!couverture && couverture.scelles >= couverture.documents}
                onClick={() => void scellerLeFonds()}
              >
                Sceller les documents non scellés
              </Button>
            </Space>
          )
        }
      />

      <Row gutter={[16, 16]} style={{ marginBottom: space.lg }}>
        <Col xs={24} sm={12} lg={6}>
          <KpiCard
            label="Documents au fonds"
            value={couverture?.documents ?? null}
            icon="archive"
            loading={chargement}
          />
        </Col>
        <Col xs={24} sm={12} lg={6}>
          <KpiCard
            label="Empreintes posées"
            value={
              couverture ? `${couverture.fichiersAvecEmpreinte} / ${couverture.fichiers}` : null
            }
            icon="document"
            hint="Une empreinte rend le fichier MESURABLE. Elle est posée automatiquement à l’entrée au coffre ; un document plus ancien la reçoit à son premier contrôle."
            loading={chargement}
          />
        </Col>
        <Col xs={24} sm={12} lg={6}>
          <KpiCard
            label="Documents vérifiés"
            value={couverture ? `${couverture.verifies} / ${couverture.documents}` : null}
            icon="check"
            hint="Vérifié = on a relu le binaire sur le coffre et comparé son empreinte. C’est ce chiffre, et non les empreintes posées, qui dit ce qu’on a réellement contrôlé."
            tone={resteAFaire ? 'warning' : 'success'}
            loading={chargement}
          />
        </Col>
        <Col xs={24} sm={12} lg={6}>
          <KpiCard
            label="Non conformes"
            value={couverture?.nonConformes ?? null}
            icon="alert"
            tone={couverture && couverture.nonConformes > 0 ? 'danger' : 'default'}
            hausseDefavorable
            loading={chargement}
          />
        </Col>
        <Col xs={24} sm={12} lg={6}>
          <KpiCard
            label="Documents scellés"
            value={couverture ? `${couverture.scelles} / ${couverture.documents}` : null}
            icon="lock"
            hint="Scellé = signé et daté par le serveur. Depuis le 15/09/2026 c’est automatique à l’acquisition et à la validation de l’indexation ; les documents antérieurs se rattrapent avec le bouton « Sceller les documents non scellés »."
            tone={
              couverture && couverture.scelles >= couverture.documents ? 'success' : 'warning'
            }
            loading={chargement}
          />
        </Col>
      </Row>

      {/* Progression du balayage en cours. Un balayage long sans retour visible se lit comme une
          application figée : on montre les documents déjà contrôlés, pas un pourcentage seul. */}
      {progression && (
        <Card style={{ marginBottom: space.lg }}>
          <Space direction="vertical" size={space.xs} style={{ width: '100%' }}>
            <Text strong>
              Contrôle en cours : {progression.faits} / {progression.total} document(s)
            </Text>
            <Progress
              percent={
                progression.total > 0
                  ? Math.round((progression.faits / progression.total) * 100)
                  : 0
              }
              status="active"
            />
            <Text type="secondary" style={{ fontSize: fontSize.xs }}>
              Le fonds est parcouru par tranches de {TRANCHE} documents, les jamais contrôlés
              d’abord. Vous pouvez arrêter à tout moment : ce qui est déjà contrôlé reste acquis.
            </Text>
          </Space>
        </Card>
      )}

      {bilanScellement && (
        <Alert
          style={{ marginBottom: space.lg }}
          type={bilanScellement.echecs.length > 0 ? 'warning' : 'success'}
          showIcon
          message={`Scellement : ${bilanScellement.scelles} document(s) scellé(s)`}
          description={
            <Space direction="vertical" size={2}>
              {bilanScellement.restants > 0 && (
                <span>{bilanScellement.restants} document(s) restent non scellés.</span>
              )}
              {bilanScellement.echecs.length > 0 && (
                <span>
                  {bilanScellement.echecs.length} échec(s) :{' '}
                  {bilanScellement.echecs.map((e) => `#${e.documentId}`).join(', ')}. Un document
                  sans empreinte de référence ne peut pas être scellé — lancez d’abord un contrôle.
                </span>
              )}
            </Space>
          }
        />
      )}

      {/* Compte rendu du passage qu'on vient de lancer — visible seulement après une action, et
          distinct des compteurs ci-dessus qui décrivent l'état du fonds, pas ce dernier geste. */}
      {dernierPassage && (
        <Alert
          style={{ marginBottom: space.lg }}
          type={
            dernierPassage.nonConformes > 0
              ? 'error'
              : dernierPassage.interrompu
                ? 'warning'
                : 'success'
          }
          showIcon
          message={
            dernierPassage.interrompu
              ? `Balayage interrompu : ${dernierPassage.traites} document(s) contrôlé(s)`
              : `Fonds contrôlé : ${dernierPassage.traites} document(s)`
          }
          description={
            <Space direction="vertical" size={2}>
              <span>
                {dernierPassage.conformes} conforme(s), {dernierPassage.nonConformes} non
                conforme(s)
                {dernierPassage.empreintesPosees > 0 &&
                  `, ${dernierPassage.empreintesPosees} empreinte(s) de référence posée(s)`}
                .
              </span>
              {dernierPassage.restants > 0 && (
                <span>
                  {dernierPassage.restants} document(s) n’ont encore jamais été contrôlés. Relancez
                  le balayage : il reprend là où il s’est arrêté.
                </span>
              )}
              {dernierPassage.interrompu && dernierPassage.restants === 0 && (
                <span>
                  Le fonds n’a pas été parcouru en entier. Relancez le balayage : il reprend par
                  les documents dont le contrôle est le plus ancien.
                </span>
              )}
              {dernierPassage.echecs.length > 0 && (
                <span>
                  {dernierPassage.echecs.length} document(s) n’ont pas pu être contrôlés (erreur
                  technique) : {dernierPassage.echecs.map((e) => `#${e.documentId}`).join(', ')}.
                </span>
              )}
            </Space>
          }
        />
      )}

      <Card
        title={
          <Space size={space.sm}>
            <span>Documents non conformes</span>
            <InfoTooltip title="Le binaire a changé sur le coffre depuis son archivage, ou il a disparu. Ouvrez la fiche pour voir quel fichier est en cause.">
              <Text type="secondary" style={{ fontSize: fontSize.xs }}>
                que signale cette liste ?
              </Text>
            </InfoTooltip>
          </Space>
        }
        style={{ marginBottom: space.lg }}
      >
        {!chargement && nonConformes.length === 0 ? (
          <Space direction="vertical" size={space.xs} style={{ width: '100%' }}>
            <EmptyState compact icon="check" title="Aucun écart constaté" />
            {/* Formulation prudente à dessein : ne rien avoir constaté n'est PAS la même chose
                qu'avoir tout contrôlé. Sur un écran d'archivage probatoire, laisser croire l'un
                pour l'autre serait le pire service à rendre. */}
            <Text type="secondary" style={{ fontSize: fontSize.xs, textAlign: 'center' }}>
              {resteAFaire
                ? 'Sur les documents déjà contrôlés — il en reste à passer en revue.'
                : 'Sur l’ensemble des documents du fonds, tous contrôlés.'}
            </Text>
          </Space>
        ) : (
          <Table
            rowKey="documentId"
            columns={colonnes}
            dataSource={nonConformes}
            loading={chargement}
            size="small"
            scroll={{ x: 'max-content' }}
            pagination={false}
          />
        )}
      </Card>

      <Alert
        type="info"
        showIcon
        message="Ce que ce contrôle établit"
        description={
          <>
            Le balayage relit chaque binaire sur le coffre et compare son empreinte SHA-256 à celle
            enregistrée. Il parcourt le fonds par tranches de {TRANCHE} documents, en commençant par
            ceux qui n’ont jamais été contrôlés — le découpage évite de tenir le serveur des minutes
            durant sur un fonds volumineux, mais les tranches s’enchaînent seules jusqu’au bout.
            <br />
            Un document sans empreinte de référence — cas du fonds antérieur au 15/09/2026 — la
            reçoit à son premier passage. Cela authentifie les contrôles suivants, mais n’établit
            rien sur le passé du fichier. Le scellement, lui, reste un geste par document, depuis
            l’onglet « Sécurité et conformité » de sa fiche.
          </>
        }
      />
    </div>
  );
}

'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import dynamic from 'next/dynamic';
import Link from 'next/link';
import { Alert, App, Button, Skeleton, Space, Tooltip } from 'antd';
import { PageHeader } from '../../components/PageHeader';
import { HeroBanner } from '../../components/HeroBanner';
import { DashboardSkeleton } from '../../components/skeletons';
import { icons, iconDefaults } from '../../theme/icons';
import {
  PeriodFilter,
  presetToPeriod,
  type PeriodState,
} from '../../dashboards/components/PeriodFilter';
import { MentionPerimetre } from './components/ZoneFiles';
import { ModaleAjoutWidget } from '../../components/dashboard/ModaleAjoutWidget';
import {
  rendreWidget,
  widgetConnu,
  type ContexteWidget,
  type DonneesWidgets,
} from './components/widget-registry';
import {
  fetchAgencement,
  fetchAlertes,
  fetchCharge,
  fetchDelais,
  fetchFiles,
  fetchFlux,
  fetchHygiene,
  fetchRepartition,
  fetchRetards,
  fetchSynthese,
  resetAgencement,
  saveAgencement,
  type AgencementResponse,
  type DashboardFilter,
  type Granularity,
  type MailScope,
  type RepartitionDimension,
  type WidgetDataKey,
  type WidgetDefinition,
  type WidgetPlacement,
  type WidgetResolu,
} from './lib/api';

// react-grid-layout mesure le DOM au montage : jamais de rendu serveur.
const GrilleWidgets = dynamic(
  () => import('../../components/dashboard/GrilleWidgets').then((m) => m.GrilleWidgets),
  { ssr: false, loading: () => <Skeleton active paragraph={{ rows: 8 }} /> },
) as typeof import('../../components/dashboard/GrilleWidgets').GrilleWidgets;

const DONNEES_VIDES: DonneesWidgets = {
  alertes: null,
  files: null,
  synthese: null,
  flux: null,
  repartition: null,
  retards: null,
  delais: null,
  charge: null,
  hygiene: null,
};

/**
 * Tableau de bord Docu-Courriers — **personnalisable par utilisateur**.
 *
 * L'écran ne décide plus de ce qu'il affiche : il rend l'agencement que le serveur lui renvoie,
 * déjà filtré par les permissions. Trois conséquences :
 *
 *  1. **Seules les données des widgets placés sont chargées** (`dataKeys`) : retirer un widget
 *     supprime aussi sa requête, au lieu d'appeler les neuf endpoints en toutes circonstances.
 *  2. **Le périmètre reste au serveur.** L'écran n'ajoute aucune règle d'accès de son côté.
 *  3. **Le mode édition est explicite** : hors de lui, la grille est figée, pour qu'un glissement
 *     accidentel ne modifie pas une mise en page qu'on croit stable.
 */
export default function TableauDeBordCourriersPage() {
  const { message } = App.useApp();

  const [agencement, setAgencement] = useState<AgencementResponse | null>(null);
  /** Copie de travail du mode édition — le serveur n'est touché qu'à l'enregistrement. */
  const [brouillon, setBrouillon] = useState<WidgetResolu[] | null>(null);
  const [edition, setEdition] = useState(false);
  const [modaleAjout, setModaleAjout] = useState(false);
  const [enregistrement, setEnregistrement] = useState(false);

  const [period, setPeriod] = useState<PeriodState>({
    preset: '30d',
    period: presetToPeriod('30d'),
  });
  const [granularity, setGranularity] = useState<Granularity>('day');
  const [dimension, setDimension] = useState<RepartitionDimension>('type');

  const [donnees, setDonnees] = useState<DonneesWidgets>(DONNEES_VIDES);
  const [chargement, setChargement] = useState(true);

  // Les widgets de STOCK ne reçoivent pas de bornes de période : les envoyer laisserait croire
  // qu'elles s'y appliquent.
  const filtreStock = useMemo<DashboardFilter>(() => ({}), []);
  const filtrePeriode = useMemo<DashboardFilter>(
    () => ({ dateFrom: period.period.from, dateTo: period.period.to }),
    [period],
  );

  // --- Agencement ----------------------------------------------------------
  useEffect(() => {
    let vivant = true;
    fetchAgencement()
      .then((a) => {
        if (vivant) setAgencement(a);
      })
      .catch((e: unknown) => {
        if (vivant) {
          message.error(e instanceof Error ? e.message : 'Erreur de chargement de l’agencement');
          setChargement(false);
        }
      });
    return () => {
      vivant = false;
    };
  }, [message]);

  const widgetsAffiches = brouillon ?? agencement?.widgets ?? [];
  const dataKeys = useMemo<WidgetDataKey[]>(
    () => [...new Set(widgetsAffiches.map((w) => w.dataKey))],
    [widgetsAffiches],
  );
  // Chaîne stable : évite de relancer le chargement à chaque déplacement de widget.
  const cleDonnees = useMemo(() => [...dataKeys].sort().join(','), [dataKeys]);

  // --- Données -------------------------------------------------------------
  const chargerDonnees = useCallback(async () => {
    const requises = cleDonnees ? (cleDonnees.split(',') as WidgetDataKey[]) : [];
    if (requises.length === 0) {
      setDonnees(DONNEES_VIDES);
      setChargement(false);
      return;
    }

    setChargement(true);
    const veut = (k: WidgetDataKey) => requises.includes(k);
    try {
      const [alertes, files, synthese, flux, repartition, retards, delais, charge, hygiene] =
        await Promise.all([
          veut('alertes') ? fetchAlertes(filtreStock) : null,
          veut('files') ? fetchFiles(filtreStock) : null,
          veut('synthese') ? fetchSynthese(filtrePeriode) : null,
          veut('flux') ? fetchFlux({ ...filtrePeriode, granularity }) : null,
          veut('repartition') ? fetchRepartition({ ...filtrePeriode, dimension }) : null,
          veut('retards') ? fetchRetards(filtreStock) : null,
          veut('delais') ? fetchDelais(filtrePeriode) : null,
          // 403 attendu hors périmètre global : absorbé pour ne pas faire échouer tout l'écran.
          veut('charge') ? fetchCharge(filtrePeriode).catch(() => null) : null,
          veut('hygiene') ? fetchHygiene(filtreStock) : null,
        ]);
      setDonnees({
        alertes,
        files,
        synthese,
        flux,
        repartition,
        retards,
        delais,
        charge,
        hygiene,
      });
    } catch (e) {
      message.error(e instanceof Error ? e.message : 'Erreur de chargement du tableau de bord');
    } finally {
      setChargement(false);
    }
  }, [cleDonnees, filtreStock, filtrePeriode, granularity, dimension, message]);

  const agencementCharge = agencement !== null;
  useEffect(() => {
    if (agencementCharge) void chargerDonnees();
  }, [agencementCharge, chargerDonnees]);

  // --- Édition -------------------------------------------------------------
  const entrerEdition = () => {
    setBrouillon(agencement?.widgets ?? []);
    setEdition(true);
  };

  const annulerEdition = () => {
    setBrouillon(null);
    setEdition(false);
  };

  /** Positions renvoyées par la grille — fusionnées dans le brouillon sans perdre les métadonnées. */
  const majPositions = useCallback((placements: WidgetPlacement[]) => {
    setBrouillon((actuel) => {
      if (!actuel) return actuel;
      const parId = new Map(placements.map((p) => [p.id, p]));
      let change = false;
      const suivant = actuel.map((w) => {
        const p = parId.get(w.id);
        if (!p) return w;
        if (p.x === w.x && p.y === w.y && p.w === w.w && p.h === w.h) return w;
        change = true;
        return { ...w, x: p.x, y: p.y, w: p.w, h: p.h };
      });
      // Sans ce garde-fou, react-grid-layout et React se relanceraient mutuellement en boucle.
      return change ? suivant : actuel;
    });
  }, []);

  const retirerWidget = (id: string) =>
    setBrouillon((actuel) => (actuel ? actuel.filter((w) => w.id !== id) : actuel));

  const ajouterWidget = (def: WidgetDefinition) => {
    setBrouillon((actuel) => {
      const liste = actuel ?? [];
      if (liste.some((w) => w.id === def.id)) return liste;
      // Placé sous l'existant : insérer au milieu bousculerait une mise en page choisie.
      const y = liste.reduce((max, w) => Math.max(max, w.y + w.h), 0);
      return [...liste, { ...def, x: 0, y, w: def.w, h: def.h }];
    });
    setModaleAjout(false);
  };

  const enregistrer = async () => {
    if (!brouillon) return;
    setEnregistrement(true);
    try {
      // Le serveur renvoie l'agencement re-filtré : on adopte SA version, pas la nôtre.
      const a = await saveAgencement(
        brouillon.map((w) => ({ id: w.id, x: w.x, y: w.y, w: w.w, h: w.h })),
      );
      setAgencement(a);
      setBrouillon(null);
      setEdition(false);
      message.success('Tableau de bord enregistré');
    } catch (e) {
      message.error(e instanceof Error ? e.message : 'Erreur d’enregistrement');
    } finally {
      setEnregistrement(false);
    }
  };

  const reinitialiser = async () => {
    setEnregistrement(true);
    try {
      const a = await resetAgencement();
      setAgencement(a);
      setBrouillon(null);
      setEdition(false);
      message.success('Agencement par défaut rétabli');
    } catch (e) {
      message.error(e instanceof Error ? e.message : 'Erreur de réinitialisation');
    } finally {
      setEnregistrement(false);
    }
  };

  const premierChargement = useRef(true);
  if (agencement) premierChargement.current = false;

  const scope: MailScope = agencement?.scope ?? 'all';

  const ctx: ContexteWidget = {
    donnees,
    loading: chargement,
    scope,
    granularity,
    onGranularityChange: setGranularity,
    dimension,
    onDimensionChange: setDimension,
  };

  return (
    <div className="dash-readable" style={{ width: '100%' }}>
      <PageHeader
        icon="analytics"
        title="Tableau de bord courrier"
        actions={
          <Space wrap>
            {!edition && <PeriodFilter value={period} onChange={setPeriod} />}
            {scope !== 'none' &&
              (edition ? (
                <>
                  <Button size="small" onClick={() => setModaleAjout(true)}>
                    Ajouter un widget
                  </Button>
                  <Tooltip title="Rétablir l'agencement livré et suivre ses évolutions futures">
                    <Button size="small" danger onClick={reinitialiser} loading={enregistrement}>
                      Réinitialiser
                    </Button>
                  </Tooltip>
                  <Button size="small" onClick={annulerEdition}>
                    Annuler
                  </Button>
                  <Button
                    size="small"
                    type="primary"
                    onClick={enregistrer}
                    loading={enregistrement}
                  >
                    Enregistrer
                  </Button>
                </>
              ) : (
                <Button size="small" onClick={entrerEdition} disabled={!agencement}>
                  Personnaliser
                </Button>
              ))}
          </Space>
        }
      />

      {scope === 'none' ? (
        <Alert
          type="info"
          showIcon
          message="Aucun périmètre de suivi ne vous est accordé"
          description="Le tableau de bord reste vide tant qu'une permission de suivi (permanent ou sur vos imputations) n'a pas été attribuée à votre rôle."
        />
      ) : (
        <>
          {!edition && (
            <HeroBanner
              title="Bienvenue sur Docu-Courriers"
              description="Suivez les retards, les files d'attente et les volumes de traitement en un coup d'œil."
              actions={
                <>
                  <Link href="/courriers/enregistrement">
                    <Button type="primary" icon={<icons.add {...iconDefaults} size={16} />}>
                      Enregistrer un courrier
                    </Button>
                  </Link>
                  <Link href="/courriers/controle">
                    <Button icon={<icons.mail {...iconDefaults} size={16} />}>
                      Courriers arrivés
                    </Button>
                  </Link>
                  <Link href="/courriers/recherche">
                    <Button icon={<icons.search {...iconDefaults} size={16} />}>
                      Rechercher un courrier
                    </Button>
                  </Link>
                </>
              }
            />
          )}

          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              gap: 12,
              flexWrap: 'wrap',
              marginBottom: 12,
            }}
          >
            <MentionPerimetre scope={scope} />
            {edition && (
              <Alert
                type="info"
                showIcon
                banner
                style={{ padding: '2px 8px' }}
                message="Glissez l'en-tête d'un widget pour le déplacer, son coin inférieur droit pour le redimensionner."
              />
            )}
          </div>

          {premierChargement.current && !agencement ? (
            <DashboardSkeleton />
          ) : (
            <GrilleWidgets
              widgets={widgetsAffiches}
              ctx={ctx}
              edition={edition}
              onLayoutChange={majPositions}
              onRetirer={retirerWidget}
              rendre={rendreWidget}
              connu={widgetConnu}
            />
          )}
        </>
      )}

      <ModaleAjoutWidget
        ouvert={modaleAjout}
        disponibles={agencement?.disponibles ?? []}
        dejaPlaces={widgetsAffiches.map((w) => w.id)}
        onAjouter={ajouterWidget}
        onFermer={() => setModaleAjout(false)}
      />
    </div>
  );
}

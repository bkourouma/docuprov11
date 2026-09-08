'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import dynamic from 'next/dynamic';
import Link from 'next/link';
import { App, Button, Skeleton, Space, Tooltip, Typography } from 'antd';
import { PageHeader } from '../components/PageHeader';
import { HeroBanner, heroGhostStyle } from '../components/HeroBanner';
import { ModaleAjoutWidget } from '../components/dashboard/ModaleAjoutWidget';
import { icons, iconDefaults } from '../theme/icons';
import { fmtInt } from '../theme/charts';
import { PeriodFilter, presetToPeriod, type PeriodState } from './components/PeriodFilter';
import { rendreWidget, widgetConnu, type ContexteWidget } from './components/widget-registry';
import {
  fetchAgencement,
  fetchOverview,
  resetAgencement,
  saveAgencement,
  type AgencementResponse,
  type AnalyticsFilter,
  type AnalyticsOverview,
  type Basis,
  type Granularity,
  type WidgetDefinition,
  type WidgetPlacement,
  type WidgetResolu,
} from './lib/api';

// react-grid-layout mesure le DOM au montage : jamais de rendu serveur.
const GrilleWidgets = dynamic(
  () => import('../components/dashboard/GrilleWidgets').then((m) => m.GrilleWidgets),
  { ssr: false, loading: () => <Skeleton active paragraph={{ rows: 8 }} /> },
) as typeof import('../components/dashboard/GrilleWidgets').GrilleWidgets;

/**
 * Tableau de bord Docu-Archives — **personnalisable par utilisateur**, comme son homologue
 * courrier (`/courriers/tableau-de-bord`), dont il reprend l'architecture et les composants de
 * grille.
 *
 * Une différence de fond avec le module courrier : **tous les widgets se nourrissent du même
 * agrégat** `POST /analytics/overview`. Il n'y a donc pas de chargement à la carte — ajouter ou
 * retirer un widget ne change pas les requêtes émises, seulement ce qui est dessiné. C'est ce qui
 * permet de garder l'écran à une seule requête malgré neuf widgets.
 *
 * Le mode édition reste explicite : hors de lui, la grille est figée, pour qu'un glissement
 * accidentel ne modifie pas une mise en page qu'on croit stable.
 */
export default function DashboardsPage() {
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
  const [basis] = useState<Basis>('created_at');
  const [gran] = useState<Granularity>('day');

  const [data, setData] = useState<AnalyticsOverview | null>(null);
  const [loading, setLoading] = useState(true);

  const filter = useMemo<AnalyticsFilter>(
    () => ({
      dateFrom: period.period.from,
      dateTo: period.period.to,
      granularity: gran,
      basis,
    }),
    [period, gran, basis],
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
          message.error(e instanceof Error ? e.message : "Erreur de chargement de l'agencement");
        }
      });
    return () => {
      vivant = false;
    };
  }, [message]);

  const widgetsAffiches = brouillon ?? agencement?.widgets ?? [];

  // --- Données -------------------------------------------------------------
  const charger = useCallback(async () => {
    setLoading(true);
    try {
      setData(await fetchOverview(filter));
    } catch (e) {
      message.error(e instanceof Error ? e.message : 'Erreur de chargement du tableau de bord');
    } finally {
      setLoading(false);
    }
  }, [filter, message]);

  useEffect(() => {
    void charger();
  }, [charger]);

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
      message.error(e instanceof Error ? e.message : "Erreur d'enregistrement");
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

  const k = data?.kpis;
  const ctx: ContexteWidget = { data, loading };

  return (
    <div className="dash-readable" style={{ width: '100%' }}>
      <PageHeader
        icon="dashboard"
        title="Tableaux de bord"
        actions={
          <Space wrap>
            {!edition && <PeriodFilter value={period} onChange={setPeriod} />}
            {edition ? (
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
                <Button size="small" type="primary" onClick={enregistrer} loading={enregistrement}>
                  Enregistrer
                </Button>
              </>
            ) : (
              <Button size="small" onClick={entrerEdition} disabled={!agencement}>
                Personnaliser
              </Button>
            )}
          </Space>
        }
      />

      {/* Bandeau d'accueil : hors grille, comme dans Docu-Courriers. Il ne porte pas de donnée
          analysable et servirait mal de widget — le masquer en édition rend la grille au premier
          plan, qui est ce qu'on manipule à ce moment-là. */}
      {!edition && (
        <HeroBanner
          title="Bienvenue sur Docu-Archives"
          description={
            <>
              Tout le fonds est {fmtInt(k?.totalDocuments)} document(s), dont{' '}
              {fmtInt(k?.documentsArchived)} archivé(s) et {fmtInt(k?.documentsPending)} en attente
              d&apos;indexation.
            </>
          }
          actions={
            <>
              <Link href="/acquisition">
                <Button icon={<icons.acquisition {...iconDefaults} size={16} />}>
                  Démarrer une acquisition
                </Button>
              </Link>
              <Link href="/intercalaires">
                <Button
                  ghost
                  style={heroGhostStyle}
                  icon={<icons.intercalaires {...iconDefaults} size={16} />}
                >
                  Générer des intercalaires
                </Button>
              </Link>
              <Link href="/search">
                <Button
                  ghost
                  style={heroGhostStyle}
                  icon={<icons.search {...iconDefaults} size={16} />}
                >
                  Rechercher un document
                </Button>
              </Link>
            </>
          }
        />
      )}

      {edition && (
        <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginBottom: 12 }}>
          Glissez l&apos;en-tête d&apos;un widget pour le déplacer, son coin inférieur droit pour le
          redimensionner.
        </Typography.Paragraph>
      )}

      {agencement === null ? (
        <Skeleton active paragraph={{ rows: 10 }} />
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

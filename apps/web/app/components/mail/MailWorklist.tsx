'use client';

import { useCallback, useEffect, useState } from 'react';
import { App, Button, Card, Grid, Table } from 'antd';
import type { TableColumnsType, TablePaginationConfig } from 'antd';
import type { TableRowSelection } from 'antd/es/table/interface';
import dayjs from 'dayjs';
import { destinataireLabel, type MailListResult, type MailSummary } from '../../lib/courriers';
import { CountBadge } from '../CountBadge';
import { EmptyState } from '../EmptyState';
import { TableSkeleton } from '../skeletons';
import { MailStatusTag, MailTypeTag } from './tags';

const fmt = (iso: string | null) => (iso ? dayjs(iso).format('DD/MM/YYYY') : '—');

/** Formulation unique du comptage : le titre de carte et le pied de pagination ne divergent plus. */
const courriersLabel = (n: number) => `courrier${n > 1 ? 's' : ''}`;

/**
 * Cible tactile ≥ 40 px sur les boutons d'action de ligne. Contrainte : ces boutons sont
 * fournis par les pages appelantes via `extraColumns`, ils ne peuvent donc être agrandis que
 * par une règle descendante portée par le tableau lui-même — l'agrandissement passe par la
 * boîte du bouton, jamais par la taille de l'icône. Le padding vertical de leur cellule leur
 * est rendu, sinon la ligne passerait de 36 à 54 px et perdrait la densité de production.
 */
const ROW_ACTION_HIT_AREA = [
  '[&_.ant-table-tbody_.ant-btn]:h-[40px]',
  '[&_.ant-table-tbody_.ant-btn]:min-w-[40px]',
  '[&_.ant-table-tbody_td:has(.ant-btn)]:py-0',
  '[&_.ant-table-tbody_td:has(.ant-btn)]:align-middle',
].join(' ');

/**
 * Indicateur visuel « en retard / bientôt échu » dans la colonne Date butoir. Volontairement
 * DISTINCT du système de paliers exacts de `dateButoireAlert` (7/3/1/0/-1/-2/-3, réservé aux
 * rappels planifiés e-mail + `DeadlineAlert`) : ici on veut un signal continu, visible d'un coup
 * d'œil sur toute ligne en retard ou proche de l'échéance — pas seulement les jours pile.
 *
 * Les deux teintes passent par les variables de thème, qui portent les dérivés FORTS AA de la
 * palette (`colorError` = danger, `colorWarning` = warning) : lisibles en texte sur les deux
 * fonds de carte, alors que les vifs correspondants ne le seraient pas.
 */
/** Jours de retard d'un courrier non traité (0 = à l'heure, sans échéance ou déjà traité). */
function daysLate(iso: string | null, treated: boolean): number {
  if (!iso || treated) return 0;
  const deadline = dayjs(iso);
  if (!deadline.isValid()) return 0;
  return Math.max(0, dayjs().startOf('day').diff(deadline.startOf('day'), 'day'));
}

function DateButoireCell({ iso, treated }: { iso: string | null; treated: boolean }) {
  if (!iso) return <>—</>;
  const deadline = dayjs(iso);
  if (!deadline.isValid()) return <>{fmt(iso)}</>;
  if (treated) return <>{fmt(iso)}</>;

  // Le délai est TOUJOURS écrit à côté de la date : « retard 3 j », « aujourd'hui »,
  // « dans 2 j ». La couleur ne fait que le renforcer — rouge en retard, ambre à trois
  // jours ou moins — elle ne porte jamais seule l'état (WCAG 1.4.1).
  const days = deadline.startOf('day').diff(dayjs().startOf('day'), 'day');
  if (days < 0) {
    return (
      <span style={{ color: 'var(--ant-color-error)', fontWeight: 600, whiteSpace: 'nowrap' }}>
        {fmt(iso)} · retard {Math.abs(days)} j
      </span>
    );
  }
  const delai = days === 0 ? 'aujourd’hui' : `dans ${days} j`;
  if (days <= 3) {
    return (
      <span style={{ color: 'var(--ant-color-warning)', fontWeight: 600, whiteSpace: 'nowrap' }}>
        {fmt(iso)} · {delai}
      </span>
    );
  }
  return (
    <span style={{ whiteSpace: 'nowrap' }}>
      {fmt(iso)}
      <span style={{ color: 'var(--ant-color-text-secondary)' }}> · {delai}</span>
    </span>
  );
}

/**
 * Grille de worklist courrier réutilisable (files Contrôle/Suivi/Validation/Départ). Pagination
 * serveur ; pas de tri d'en-tête (les endpoints de file ne trient pas — évite le tri cassé §06).
 *
 * Table de PRODUCTION : `size="small"` (lignes ≈ 32-36 px via `cellPaddingBlockSM` du thème).
 *
 * Signature « Registre » : le N° d'enregistrement tient la MARGE (colonne `da-marge` : calée
 * à droite, bordée du double filet rouge), et le pied de table donne le nombre de lignes de
 * la page et celles qui restent à reporter sur les pages suivantes. Une ligne en retard a son numéro de
 * marge en rouge, et les retards de la page sont annoncés en tête de carte.
 *
 * Sous 768 px la date butoir est rappelée sous l'objet et la marge se resserre : le retard
 * reste visible sans faire défiler le tableau.
 * `hideStatusColumn`/`hideDeadlineColumn` restent à `false` par défaut ; ce sont les pages qui
 * masquent ces colonnes, choix conservé tel quel.
 */
export function MailWorklist({
  load,
  refreshSignal = 0,
  extraColumns,
  rowSelection,
  onOpen,
  emptyTitle = 'Aucun courrier',
  hideStatusColumn = false,
  hideDeadlineColumn = false,
}: {
  load: (page: number, pageSize: number) => Promise<MailListResult>;
  refreshSignal?: number;
  extraColumns?: TableColumnsType<MailSummary>;
  rowSelection?: TableRowSelection<MailSummary>;
  onOpen?: (mail: MailSummary) => void;
  emptyTitle?: string;
  hideStatusColumn?: boolean;
  hideDeadlineColumn?: boolean;
}) {
  const { message } = App.useApp();
  // `md === false` et non `!screens.md` : au premier rendu le point de rupture est inconnu,
  // et un écran de bureau ne doit pas passer une image en mise en page étroite.
  const narrow = Grid.useBreakpoint().md === false;
  const [rows, setRows] = useState<MailSummary[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const [loading, setLoading] = useState(true);
  const [firstLoad, setFirstLoad] = useState(true);
  // Échec du chargement : un registre qui n'a pas pu être lu ne doit pas s'annoncer vide.
  const [failed, setFailed] = useState(false);

  const fetchPage = useCallback(async () => {
    setLoading(true);
    try {
      const res = await load(page, pageSize);
      setRows(res.rows);
      setTotal(res.total);
      setFailed(false);
    } catch (e) {
      setFailed(true);
      message.error(e instanceof Error ? e.message : 'Erreur de chargement');
    } finally {
      setLoading(false);
      setFirstLoad(false);
    }
  }, [load, page, pageSize, message]);

  useEffect(() => {
    void fetchPage();
  }, [fetchPage, refreshSignal]);

  const columns: TableColumnsType<MailSummary> = [
    {
      // Écran étroit : l'en-tête se réduit à « N° » pour que la marge ne prenne pas 40 %
      // de la ligne.
      title: narrow ? 'N°' : 'N° enregistrement',
      dataIndex: 'nReference',
      key: 'nReference',
      width: narrow ? 116 : 148,
      // La marge numérotée du registre : le numéro, en gras, à gauche du double filet rouge.
      className: 'da-marge',
      render: (v: string | null) => v ?? '—',
    },
    {
      title: 'Objet',
      dataIndex: 'title',
      key: 'title',
      ellipsis: true,
      render: (v: string, r) => (
        <>
          <span className="da-objet-line">{onOpen ? <a onClick={() => onOpen(r)}>{v}</a> : v}</span>
          {/* Rappel de l'échéance sous l'objet, affiché sous 768 px seulement (globals.css) :
              la colonne « Date butoir » y est hors écran. */}
          {!hideDeadlineColumn && r.dateButoire && (
            <span className="da-objet-due">
              <DateButoireCell iso={r.dateButoire} treated={r.dateTraited != null} />
            </span>
          )}
        </>
      ),
    },
    {
      title: 'Sens',
      dataIndex: 'mailType',
      key: 'mailType',
      width: 84,
      render: (v: number) => <MailTypeTag mailType={v} />,
    },
    {
      title: 'Correspondant',
      key: 'externalEntity',
      width: 144,
      ellipsis: true,
      render: (_, r) => r.externalEntity?.label || '—',
    },
    {
      title: 'Destinataire',
      key: 'destinataire',
      width: 140,
      ellipsis: true,
      render: (_, r) => destinataireLabel(r),
    },
    ...(hideStatusColumn
      ? []
      : [
          {
            title: 'Statut',
            dataIndex: 'status',
            key: 'status',
            width: 120,
            render: (v: number) => <MailStatusTag status={v} />,
          },
        ]),
    ...(hideDeadlineColumn
      ? []
      : [
          {
            title: 'Date butoir',
            dataIndex: 'dateButoire',
            key: 'dateButoire',
            // « 19/11/2026 · retard 3 j » doit tenir sur une ligne.
            width: 168,
            render: (v: string | null, r: MailSummary) => (
              <DateButoireCell iso={v} treated={r.dateTraited != null} />
            ),
          },
        ]),
    ...(extraColumns ?? []),
  ];

  // Retards de la page. Ils ne sont comptés que si la colonne « Date butoir » est affichée :
  // annoncer une alerte que la liste ne montre pas n'aurait pas de sens.
  const isLate = (r: MailSummary) =>
    !hideDeadlineColumn && daysLate(r.dateButoire, r.dateTraited != null) > 0;
  const lateOnPage = rows.filter(isLate).length;
  // Lignes restant sur les pages suivantes : le « à reporter » du pied de registre.
  const carriedOver = Math.max(0, total - page * pageSize);
  const lignes = (n: number) => `${n} ligne${n > 1 ? 's' : ''}`;

  // Largeur minimale du tableau : la somme des colonnes à largeur fixe, plus 184 px garantis
  // à « Objet » (la seule colonne élastique). Le total (924 px sur la file de suivi) tient dans
  // les 926 px qu'offre la carte à 1280 px, panneau de navigation ouvert ; au-dessus, « Objet » absorbe la place restante,
  // en dessous le tableau défile au lieu d'écraser l'objet — et plus jamais il ne pousse la
  // date butoir hors de l'écran, comme le faisait `x: 'max-content'` sur un objet long.
  const fixedWidth = columns.reduce((sum, c) => sum + (typeof c.width === 'number' ? c.width : 0), 0);
  const minTableWidth = fixedWidth + 184 + (rowSelection ? 32 : 0);

  const onChange = (pagination: TablePaginationConfig) => {
    setPage(pagination.current ?? 1);
    setPageSize(pagination.pageSize ?? 25);
  };

  return (
    <Card
      // Le tableau EST le papier du registre : il court d'un bord à l'autre de la carte.
      styles={{ body: { padding: 0 } }}
      title={
        // Le compteur garde sa place pendant le chargement : plus de titre « Chargement… »
        // brut, donc plus de saut de l'en-tête de carte à l'arrivée des données. Les retards
        // de la page sont annoncés ici, en tête : c'est ce que le décideur lit en premier.
        // Lecture en échec : pas de tête du tout — un comptage n'aurait aucun sens à côté du
        // message d'erreur.
        failed && rows.length === 0 && !loading ? undefined : (
          <span className="da-list-head">
            {firstLoad && loading ? (
              <CountBadge value="…" label="courriers" />
            ) : (
              <CountBadge value={total} label={courriersLabel(total)} />
            )}
            {lateOnPage > 0 && (
              <span className="da-list-late">{lateOnPage} en retard sur cette page</span>
            )}
          </span>
        )
      }
    >
      {firstLoad && loading ? (
        <div style={{ padding: 24 }}>
          <TableSkeleton rows={8} columns={columns.length} />
        </div>
      ) : failed && rows.length === 0 && !loading ? (
        // Échec de lecture : dit comme tel, avec de quoi relancer — jamais « aucun courrier ».
        <div style={{ padding: 24 }}>
          <EmptyState
            icon="alert"
            title="La liste n’a pas pu être chargée"
            action={<Button onClick={() => void fetchPage()}>Réessayer</Button>}
          />
        </div>
      ) : total === 0 && !loading ? (
        <div style={{ padding: 24 }}>
          <EmptyState icon="mail" title={emptyTitle} />
        </div>
      ) : (
        <Table<MailSummary>
          rowKey="mailId"
          className={`da-registre ${ROW_ACTION_HIT_AREA}`}
          columns={columns}
          dataSource={rows}
          loading={loading && !firstLoad}
          size="small"
          scroll={{ x: minTableWidth }}
          rowSelection={rowSelection}
          // Ligne en retard : son numéro de marge passe au rouge (globals.css).
          rowClassName={(r) => (isLate(r) ? 'da-row-late' : '')}
          summary={() => {
            // La colonne de sélection, quand elle existe, occupe l'indice 0.
            const offset = rowSelection ? 1 : 0;
            return (
              <Table.Summary>
                <Table.Summary.Row>
                  {rowSelection && <Table.Summary.Cell index={0} />}
                  <Table.Summary.Cell index={offset} className="da-marge">
                    {lignes(rows.length)}
                  </Table.Summary.Cell>
                  <Table.Summary.Cell index={offset + 1} colSpan={columns.length - 1}>
                    {carriedOver > 0 ? `${lignes(carriedOver)} à reporter` : 'Fin du registre'}
                  </Table.Summary.Cell>
                </Table.Summary.Row>
              </Table.Summary>
            );
          }}
          pagination={{
            current: page,
            pageSize,
            total,
            showSizeChanger: true,
            pageSizeOptions: [10, 25, 50, 100],
            // Le total est déjà en tête de carte : le pied dit où l'on est dans le registre.
            showTotal: (t) => `Folio ${page} sur ${Math.max(1, Math.ceil(t / pageSize))}`,
          }}
          onChange={onChange}
        />
      )}
    </Card>
  );
}

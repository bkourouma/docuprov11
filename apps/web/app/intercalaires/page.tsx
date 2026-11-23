'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { App, Badge, Button, Card, Checkbox, Col, Input, Row, Space, Typography } from 'antd';
import { motion } from 'motion/react';
import { API_BASE, apiJson } from '../lib/api';
import { PageHeader } from '../components/PageHeader';
import { EmptyState } from '../components/EmptyState';
import { LoadFailure } from '../components/LoadFailure';
import { TableSkeleton } from '../components/skeletons';
import { icons, type IconName } from '../theme/icons';
import { fade } from '../theme/motion';
import { colors, radii } from '../theme/tokens';

const { Text, Paragraph } = Typography;

/**
 * Aperçu de feuille A4 : ces deux valeurs simulent le papier et l'encre d'une
 * impression, pas des surfaces de l'interface — elles ne suivent donc pas le
 * mode sombre (dérogation, cf. specs/002-relook/plan.md arbitrage n°13).
 */
const SHEET_PAPER = '#ffffff';
const SHEET_INK = '#111111';

interface Category {
  code: string;
  label: string;
  isBlank: boolean;
}
interface Item {
  id: number;
  label: string;
  depth: number;
}

/** Pick a coherent icon for a category code. */
function categoryIcon(cat: Category): IconName {
  if (cat.isBlank) return 'qr';
  const c = cat.code.toUpperCase();
  if (c.includes('TYPE')) return 'documentType';
  if (c.includes('PLAN') || c.includes('CLASS')) return 'classification';
  if (c.includes('DOSSIER')) return 'dossier';
  if (c.includes('LOC') || c.includes('GEO')) return 'geolocalisation';
  return 'folderTree';
}

/** Petit motif QR (mock) pour l'aperçu de la feuille. */
function QrMock({ size = 96 }: { size?: number }) {
  const cells = [
    [1, 1, 1, 0, 1, 0, 1, 1, 1],
    [1, 0, 1, 0, 0, 1, 1, 0, 1],
    [1, 1, 1, 0, 1, 0, 1, 1, 1],
    [0, 0, 0, 0, 1, 1, 0, 0, 0],
    [1, 0, 1, 1, 0, 1, 1, 1, 0],
    [0, 1, 0, 1, 1, 0, 0, 1, 1],
    [1, 1, 1, 0, 0, 1, 1, 0, 1],
    [1, 0, 1, 1, 1, 0, 1, 1, 0],
    [1, 1, 1, 0, 1, 1, 0, 0, 1],
  ];
  const n = cells.length;
  const s = size / n;
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden>
      <rect width={size} height={size} fill={SHEET_PAPER} />
      {cells.flatMap((row, y) =>
        row.map((v, x) =>
          v ? (
            <rect key={`${x}-${y}`} x={x * s} y={y * s} width={s} height={s} fill={SHEET_INK} />
          ) : null,
        ),
      )}
    </svg>
  );
}

/** Aperçu d'une feuille d'intercalaire A4 (vignette). */
function SheetPreview({ label, isBlank }: { label: string; isBlank: boolean }) {
  return (
    <div
      style={{
        aspectRatio: '1 / 1.414',
        width: '100%',
        maxWidth: 240,
        margin: '0 auto',
        background: SHEET_PAPER,
        border: '1px solid var(--ant-color-border)',
        borderRadius: radii.sm,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 16,
        padding: 20,
      }}
    >
      <QrMock size={104} />
      <div style={{ textAlign: 'center' }}>
        <div
          className="da-mono"
          style={{ fontSize: 11, color: 'var(--ant-color-text-tertiary)', letterSpacing: '0.08em' }}
        >
          INTERCALAIRE
        </div>
        <div style={{ fontSize: 16, fontWeight: 700, marginTop: 4, color: SHEET_INK }}>
          {isBlank ? 'Séparateur vierge' : label || 'Libellé de l’élément'}
        </div>
      </div>
    </div>
  );
}

export default function IntercalairesPage() {
  const { message } = App.useApp();
  const [categories, setCategories] = useState<Category[]>([]);
  const [category, setCategory] = useState('TYPE_DOCUMENT');
  const [items, setItems] = useState<Item[]>([]);
  const [selected, setSelected] = useState<number[]>([]);
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    apiJson<Category[]>('/intercalaires/categories')
      .then((cats) => {
        setCategories(cats);
        if (cats.length && !cats.some((c) => c.code === category)) setCategory(cats[0]!.code);
      })
      .catch(() => undefined);
  }, []);

  const [loadFailed, setLoadFailed] = useState(false);
  const loadItems = useCallback(async (cat: string) => {
    setLoading(true);
    setSelected([]);
    setQuery('');
    try {
      setItems(await apiJson<Item[]>(`/intercalaires/items?category=${cat}`));
      setLoadFailed(false);
    } catch {
      setLoadFailed(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadItems(category);
  }, [category, loadItems]);

  const current = categories.find((c) => c.code === category);
  const isBlank = current?.isBlank ?? false;
  const canGenerate = isBlank || selected.length > 0;

  const filtered = useMemo(
    () =>
      query.trim()
        ? items.filter((it) => it.label.toLowerCase().includes(query.toLowerCase()))
        : items,
    [items, query],
  );
  const allFilteredSelected =
    filtered.length > 0 && filtered.every((it) => selected.includes(it.id));

  const toggleAll = () => {
    if (allFilteredSelected) {
      const ids = new Set(filtered.map((it) => it.id));
      setSelected((s) => s.filter((x) => !ids.has(x)));
    } else {
      setSelected((s) => Array.from(new Set([...s, ...filtered.map((it) => it.id)])));
    }
  };

  const previewLabel = useMemo(() => {
    const firstSel = items.find((it) => it.id === selected[0]);
    return firstSel?.label ?? '';
  }, [items, selected]);

  const generate = useCallback(async () => {
    setBusy(true);
    try {
      const token = window.localStorage.getItem('token');
      const res = await fetch(`${API_BASE}/intercalaires/generate`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ category, itemIds: selected }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const blob = await res.blob();
      window.open(URL.createObjectURL(blob), '_blank');
    } catch (e) {
      message.error(e instanceof Error ? e.message : 'Erreur de génération');
    } finally {
      setBusy(false);
    }
  }, [category, selected, message]);

  return (
    <div style={{ paddingBottom: 80 }}>
      <PageHeader icon="intercalaires" title="Génération d’intercalaires" />

      <Row gutter={[16, 16]} align="top">
        {/* Sélecteur de catégorie */}
        <Col xs={24} md={8} lg={6}>
          <Card title="Catégorie" styles={{ body: { padding: 8 } }}>
            <Space direction="vertical" size={4} style={{ width: '100%' }}>
              {categories.map((c) => {
                const Glyph = icons[categoryIcon(c)];
                const active = c.code === category;
                return (
                  <button
                    key={c.code}
                    onClick={() => setCategory(c.code)}
                    aria-pressed={active}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 10,
                      width: '100%',
                      padding: '10px 12px',
                      border: 'none',
                      borderRadius: radii.base,
                      cursor: 'pointer',
                      textAlign: 'left',
                      fontWeight: active ? 600 : 400,
                      // Catégorie active : remplissage plein, miroir exact de l'item de
                      // menu actif de la barre latérale (signature Plus Admin n°3). Le
                      // token vaut la même teinte dans les deux thèmes, d'où l'usage
                      // direct plutôt qu'une variable de thème.
                      background: active ? colors.menuActiveBg : 'transparent',
                      color: active ? '#ffffff' : 'var(--ant-color-text)',
                    }}
                  >
                    <Glyph size={18} strokeWidth={1.75} />
                    <span>{c.label}</span>
                  </button>
                );
              })}
            </Space>
          </Card>
        </Col>

        {/* Liste des éléments */}
        <Col xs={24} md={16} lg={12}>
          <Card
            title={current?.label ?? 'Éléments'}
            extra={
              !isBlank &&
              filtered.length > 0 && (
                <Space>
                  <Badge
                    count={selected.length}
                    color="var(--ant-color-primary)"
                    showZero={false}
                  />
                  <Button size="small" onClick={toggleAll}>
                    {allFilteredSelected ? 'Tout désélectionner' : 'Tout sélectionner'}
                  </Button>
                </Space>
              )
            }
          >
            {isBlank ? (
              <Card
                type="inner"
                style={{
                  background: 'var(--ant-color-info-bg)',
                  borderColor: 'var(--ant-color-info-border)',
                }}
              >
                <Space align="start">
                  <icons.qr size={20} style={{ color: 'var(--ant-color-info)' }} />
                  <div>
                    <Text strong>Séparateur vierge</Text>
                    <Paragraph type="secondary" style={{ margin: 0 }}>
                      Une feuille unique à QR code sera générée. Aucune sélection nécessaire.
                    </Paragraph>
                  </div>
                </Space>
              </Card>
            ) : loading ? (
              <TableSkeleton rows={6} columns={1} />
            ) : loadFailed && items.length === 0 ? (
              <LoadFailure title="Les éléments n’ont pas pu être chargés" onRetry={() => loadItems(category)} />
            ) : items.length === 0 ? (
              <EmptyState icon="folderTree" title="Aucun élément" />
            ) : (
              <>
                <Input
                  allowClear
                  placeholder="Filtrer les éléments…"
                  prefix={
                    <icons.search
                      size={16}
                      strokeWidth={1.75}
                      style={{ color: 'var(--ant-color-text-tertiary)' }}
                    />
                  }
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  style={{ marginBottom: 12 }}
                />
                <motion.div
                  key={category}
                  variants={fade}
                  initial="hidden"
                  animate="show"
                  style={{
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 2,
                    maxHeight: 420,
                    overflow: 'auto',
                  }}
                >
                  {filtered.length === 0 ? (
                    <EmptyState compact icon="search" title="Aucun résultat" />
                  ) : (
                    filtered.map((it) => (
                      <label
                        key={it.id}
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: 8,
                          padding: '6px 8px',
                          paddingLeft: 8 + it.depth * 20,
                          borderRadius: radii.base,
                          cursor: 'pointer',
                        }}
                      >
                        <Checkbox
                          checked={selected.includes(it.id)}
                          onChange={(e) =>
                            setSelected((s) =>
                              e.target.checked ? [...s, it.id] : s.filter((x) => x !== it.id),
                            )
                          }
                        />
                        <span>{it.label}</span>
                      </label>
                    ))
                  )}
                </motion.div>
              </>
            )}
          </Card>
        </Col>

        {/* Aperçu */}
        <Col xs={24} lg={6}>
          <Card title="Aperçu de la feuille">
            <SheetPreview label={previewLabel} isBlank={isBlank} />
            <Paragraph
              type="secondary"
              style={{ fontSize: 12, textAlign: 'center', marginTop: 12, marginBottom: 0 }}
            >
              {isBlank
                ? 'Une feuille unique sera générée.'
                : selected.length > 0
                  ? `${selected.length} feuille(s) seront générées.`
                  : 'Sélectionnez des éléments pour générer leurs feuilles.'}
            </Paragraph>
          </Card>
        </Col>
      </Row>

      {/* Barre d'action collante — le débord latéral suit la gouttière de .da-page
          (variable --da-page-pad-x), sinon il se désynchronise du padding de page. */}
      <div className="da-sticky-actions">
        <Text type="secondary">
          {isBlank
            ? 'Séparateur vierge — 1 feuille'
            : `${selected.length} élément(s) sélectionné(s)`}
        </Text>
        <Space>
          {!isBlank && selected.length > 0 && (
            <Button onClick={() => setSelected([])}>Tout désélectionner</Button>
          )}
          <Button
            type="primary"
            icon={<icons.qr size={18} />}
            disabled={!canGenerate}
            loading={busy}
            onClick={generate}
          >
            Générer le PDF
          </Button>
        </Space>
      </div>
    </div>
  );
}

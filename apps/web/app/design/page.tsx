'use client';

/**
 * Galerie du design system « Plus Admin » (relook 002).
 * Route /design — SURFACE DE VÉRIFICATION du relook (PRD relook.md §9.2) :
 * elle expose la grille de rondeur §4.2, les 6 signatures §4.5, les badges AA,
 * les deux densités de tables et l'échelle d'espacement. Chaque valeur affichée
 * vient de theme/tokens.ts ou des variables CSS — aucune couleur en dur.
 */
import { useState } from 'react';
import {
  Avatar,
  Button,
  Card,
  Col,
  DatePicker,
  Dropdown,
  Form,
  Input,
  Modal,
  Popover,
  Row,
  Select,
  Space,
  Table,
  Tag,
  Tooltip,
  Typography,
} from 'antd';
import { PageHeader } from '../components/PageHeader';
import { StatTile } from '../components/StatTile';
import { StatusTile } from '../components/StatusTile';
import { icons } from '../theme/icons';
import { colors, colorsDark, fontSize, radii } from '../theme/tokens';

const { Text, Title } = Typography;

/* ----------------------------------------------------------------------- */

function Swatch({ name, value, note }: { name: string; value: string; note?: string }) {
  return (
    <div style={{ width: 132 }}>
      <div
        style={{
          height: 56,
          borderRadius: radii.sm,
          background: value,
          border: '1px solid var(--ant-color-border-secondary)',
        }}
      />
      <div style={{ marginTop: 6 }}>
        <div style={{ fontSize: 12, fontWeight: 600 }}>{name}</div>
        <div className="da-mono" style={{ fontSize: 11, color: 'var(--ant-color-text-tertiary)' }}>
          {value}
        </div>
        {note && (
          <div style={{ fontSize: 11, color: 'var(--ant-color-text-tertiary)' }}>{note}</div>
        )}
      </div>
    </div>
  );
}

function Section({
  title,
  hint,
  children,
}: {
  title: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <Card title={title} style={{ marginBottom: 24 }}>
      {hint && (
        <Text type="secondary" style={{ display: 'block', marginBottom: 16 }}>
          {hint}
        </Text>
      )}
      {children}
    </Card>
  );
}

function RadiusSample({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, alignItems: 'flex-start' }}>
      {children}
      <Text type="secondary" style={{ fontSize: 12 }}>
        {label}
      </Text>
    </div>
  );
}

/* --- Données factices des tables de démonstration ----------------------- */

interface DemoRow {
  key: number;
  libelle: string;
  type: string;
  date: string;
}
const DEMO_ROWS: DemoRow[] = [
  { key: 1, libelle: 'Facture fournisseur 2026-0812', type: 'Facture', date: '12/07/2026' },
  { key: 2, libelle: 'Marché public — avenant n°2', type: 'Contrat', date: '03/07/2026' },
  { key: 3, libelle: 'Courrier préfecture — réponse', type: 'Courrier', date: '28/06/2026' },
  { key: 4, libelle: 'PV du conseil du 15 juin', type: 'Procès-verbal', date: '15/06/2026' },
];
const DEMO_COLS = [
  { title: 'Libellé', dataIndex: 'libelle' },
  { title: 'Type', dataIndex: 'type' },
  { title: 'Enregistré le', dataIndex: 'date' },
];

/* ----------------------------------------------------------------------- */

export default function DesignPage() {
  const [modalOpen, setModalOpen] = useState(false);
  const CollapseGlyph = icons['collapse'];

  const semantics = [
    { name: 'Succès', strong: colors.success, vivid: colors.successVivid },
    { name: 'Info', strong: colors.info, vivid: colors.infoVivid },
    { name: 'Alerte', strong: colors.warning, vivid: colors.warningVivid },
    { name: 'Danger', strong: colors.danger, vivid: colors.dangerVivid },
  ];

  return (
    <div>
      <PageHeader title="Design system — Plus Admin" />

      {/* 1. Palette ------------------------------------------------------- */}
      <Section
        title="Palette (thème clair — les valeurs sombres sont dans colorsDark)"
        hint="Règle d'or §4.1 : les sémantiques VIVES ne portent jamais de texte (pastilles, icônes, remplissages) ; tout texte d'état et tout fond de badge passe par les dérivés FORTS AA."
      >
        <Space size={16} wrap>
          <Swatch name="primary" value={colors.primary} />
          <Swatch name="menuActiveBg" value={colors.menuActiveBg} />
          <Swatch name="primarySoft" value={colors.primarySoft} />
          <Swatch name="bgLayout" value={colors.bgLayout} />
          <Swatch name="border" value={colors.border} />
          <Swatch name="borderControl" value={colors.borderControl} />
          <Swatch name="text" value={colors.text} />
          <Swatch name="textStrong" value={colors.textStrong} />
          <Swatch name="textSecondary" value={colors.textSecondary} />
        </Space>
        <Title level={5} style={{ marginTop: 20 }}>
          Sémantiques : forte (texte + badge) vs vive (surface seule)
        </Title>
        <Space size={16} wrap>
          {semantics.map((s) => (
            <div key={s.name} style={{ display: 'flex', gap: 8 }}>
              <Swatch name={`${s.name} — forte`} value={s.strong} note="texte OK (≥ 4,5:1)" />
              <Swatch name={`${s.name} — vive`} value={s.vivid} note="jamais de texte" />
            </div>
          ))}
        </Space>
        <Title level={5} style={{ marginTop: 20 }}>
          Sombre (extraits)
        </Title>
        <Space size={16} wrap>
          <Swatch name="primary (sombre)" value={colorsDark.primary} />
          <Swatch name="bgLayout (sombre)" value={colorsDark.bgLayout} />
          <Swatch name="bgContainer (sombre)" value={colorsDark.bgContainer} />
          <Swatch name="borderControl (sombre)" value={colorsDark.borderControl} />
        </Space>
      </Section>

      {/* 2. Typographie ---------------------------------------------------- */}
      <Section
        title="Typographie — Open Sans"
        hint="Graisses 300 / 400 / 600 / 700 uniquement ; Geist Mono pour les cotes et références."
      >
        <Space direction="vertical" size={8}>
          <span style={{ fontWeight: 300, fontSize: 20 }}>Open Sans 300 — top bar</span>
          <span style={{ fontWeight: 400, fontSize: fontSize.base }}>
            Open Sans 400 · 14 px — corps, tables, labels
          </span>
          <span style={{ fontWeight: 400, fontSize: fontSize.sm }}>
            Open Sans 400 · 13 px — champs de saisie
          </span>
          <span style={{ fontWeight: 600, fontSize: fontSize.xs }}>
            OPEN SANS 600 · 12 PX — BOUTONS
          </span>
          <span
            style={{
              fontWeight: 700,
              fontSize: fontSize.md,
              color: 'var(--ant-color-text-heading)',
            }}
          >
            Open Sans 700 · 16 px — titre de carte
          </span>
          <span className="da-mono" style={{ fontSize: fontSize.base }}>
            Geist Mono — ARR-2026-000814 · N° pièce 042
          </span>
        </Space>
      </Section>

      {/* 3. Grille de rondeur ---------------------------------------------- */}
      <Section
        title="Grille de rondeur (règle d'or §4.2)"
        hint="Champs 8 px · cartes 12 px · boutons 8 px · badges 4 px · modales, dropdowns, popovers, infobulles 12 px · pilules 50 px · avatars cercle. Aucun autre rayon n'existe."
      >
        <Space size={24} wrap align="end">
          <RadiusSample label={`Champ — ${radii.field} px`}>
            <Input placeholder="Saisie" style={{ width: 160 }} />
          </RadiusSample>
          <RadiusSample label={`Carte — ${radii.card} px`}>
            <div
              style={{
                width: 120,
                height: 56,
                borderRadius: radii.card,
                border: '1px solid var(--ant-color-border)',
                background: 'var(--ant-color-bg-container)',
              }}
            />
          </RadiusSample>
          <RadiusSample label={`Bouton — ${radii.field} px`}>
            <Button type="primary">Enregistrer</Button>
          </RadiusSample>
          <RadiusSample label={`Badge — ${radii.base} px`}>
            <Tag color={colors.success} style={{ color: '#fff', fontWeight: 600, fontSize: 11 }}>
              Validé
            </Tag>
          </RadiusSample>
          <RadiusSample label={`Infobulle / Popover — ${radii.card} px`}>
            <Space>
              <Tooltip title={`Infobulle ${radii.card} px`}>
                <Button>Tooltip</Button>
              </Tooltip>
              <Popover content={`Popover ${radii.card} px`} title="Aperçu">
                <Button>Popover</Button>
              </Popover>
            </Space>
          </RadiusSample>
          <RadiusSample label={`Dropdown — ${radii.card} px`}>
            <Dropdown
              menu={{
                items: [
                  { key: '1', label: 'Excel' },
                  { key: '2', label: 'CSV' },
                  { key: '3', label: 'PDF' },
                ],
              }}
            >
              <Button>Exporter</Button>
            </Dropdown>
          </RadiusSample>
          <RadiusSample label={`Modale — ${radii.card} px`}>
            <Button onClick={() => setModalOpen(true)}>Ouvrir la modale</Button>
          </RadiusSample>
          <RadiusSample label="Pilule — 50 px">
            <Tag
              className="da-pill"
              color={colors.primary}
              style={{ color: '#fff', fontWeight: 600 }}
            >
              12 résultats
            </Tag>
          </RadiusSample>
          <RadiusSample label="Avatar — cercle">
            <Avatar style={{ background: colors.primary }}>AD</Avatar>
          </RadiusSample>
        </Space>
        <Modal
          title="Modale de démonstration"
          open={modalOpen}
          onOk={() => setModalOpen(false)}
          onCancel={() => setModalOpen(false)}
          okText="Fermer"
        >
          Rayon {radii.card} px, ombre portée réservée aux surfaces flottantes.
        </Modal>
      </Section>

      {/* 4. Signatures Plus Admin ------------------------------------------ */}
      <Section title="Les 6 signatures Plus Admin (§4.5)">
        <Space direction="vertical" size={16} style={{ width: '100%' }}>
          {/* 1 : top bar + bouton de repli (la languette rose, ex-signature n°2, a été retirée) */}
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 12,
              height: 60,
              background: 'var(--da-topbar-bg)',
              color: 'var(--da-on-topbar)',
              borderRadius: radii.card,
              overflow: 'hidden',
            }}
          >
            <span
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                width: 32,
                height: 32,
                marginInlineStart: 12,
                borderRadius: 4,
                background: 'rgba(255, 255, 255, 0.14)',
              }}
              aria-hidden
            >
              <CollapseGlyph size={20} strokeWidth={1.75} />
            </span>
            <span style={{ fontWeight: 300 }}>
              1 · Top bar bleu roi constante ({colors.topbarBg}) + bouton de repli discret
            </span>
          </div>
          {/* 3 : item de menu actif rempli */}
          <div
            style={{
              background: colors.menuActiveBg,
              color: '#fff',
              fontWeight: 600,
              padding: '10px 16px',
            }}
          >
            2 · Item de menu actif rempli pleine largeur ({colors.menuActiveBg})
          </div>
          {/* 4 : dégradé signature */}
          <div
            style={{
              background: 'linear-gradient(to right, var(--da-brand-from), var(--da-brand-to))',
              borderRadius: radii.card,
              padding: '18px 20px',
              display: 'flex',
              justifyContent: 'flex-end',
            }}
          >
            <span style={{ color: 'var(--da-on-brand)', fontWeight: 600 }}>
              3 · Dégradé signature cyan → bleu roi (texte posé côté bleu)
            </span>
          </div>
          {/* 5 : cartes plates bordées */}
          <Card size="small">
            4 · Carte plate bordée : bordure fine, <Text strong>aucune ombre</Text> — la hiérarchie
            vient du fond de page, pas des ombres.
          </Card>
          {/* 6-7 : rayons nets + badges pleins */}
          <Space wrap>
            <Text>5 · Petits rayons nets (section précédente) · 6 · Badges pleins AA :</Text>
            {semantics.map((s) => (
              <Tag
                key={`badge-${s.name}`}
                color={s.strong}
                style={{ color: '#fff', fontWeight: 600, fontSize: 11 }}
              >
                {s.name}
              </Tag>
            ))}
            <Text type="secondary">et pastilles vives sans texte :</Text>
            {semantics.map((s) => (
              <span
                key={`dot-${s.name}`}
                aria-hidden
                style={{
                  display: 'inline-block',
                  width: 12,
                  height: 12,
                  borderRadius: '50%',
                  background: s.vivid,
                }}
              />
            ))}
          </Space>
        </Space>
      </Section>

      {/* 5. Tables — deux densités ----------------------------------------- */}
      <Section
        title="Tables — deux densités (§4.4)"
        hint="Production (size=small, lignes 32-36 px) pour les files et recherches ; consultation (middle, padding 15 px) pour les référentiels et registres."
      >
        <Row gutter={24}>
          <Col xs={24} lg={12}>
            <Title level={5}>Production — size=&quot;small&quot;</Title>
            <Table<DemoRow>
              size="small"
              columns={DEMO_COLS}
              dataSource={DEMO_ROWS}
              pagination={false}
            />
          </Col>
          <Col xs={24} lg={12}>
            <Title level={5}>Consultation — size=&quot;middle&quot;</Title>
            <Table<DemoRow>
              size="middle"
              columns={DEMO_COLS}
              dataSource={DEMO_ROWS}
              pagination={false}
            />
          </Col>
        </Row>
      </Section>

      {/* 6. Formulaires ----------------------------------------------------- */}
      <Section
        title="Formulaires (§6.2)"
        hint="Densité UNIQUE : tous les champs et boutons de l'application sont à 36 px, rayon 8 px, libellés 14 px au-dessus. Le gabarit 46 px n'existe plus nulle part."
      >
        <Row gutter={24}>
          <Col xs={24} lg={12}>
            <Form layout="vertical" style={{ maxWidth: 400 }}>
              <Form.Item label="Objet du courrier">
                <Input placeholder="ex. Demande de subvention" />
              </Form.Item>
              <Form.Item label="Type de document">
                <Select
                  placeholder="Choisir…"
                  options={[
                    { value: 1, label: 'Facture' },
                    { value: 2, label: 'Contrat' },
                  ]}
                />
              </Form.Item>
              <Form.Item label="Date du courrier">
                <DatePicker style={{ width: '100%' }} format="DD/MM/YYYY" />
              </Form.Item>
            </Form>
          </Col>
        </Row>
      </Section>

      {/* 7. Tuiles ---------------------------------------------------------- */}
      <Section
        title="Tuiles de synthèse"
        hint="StatTile (décoratives) et StatusTile (sémantiques fortes AA) — re-basées Plus Admin."
      >
        <Row gutter={[16, 16]}>
          <Col xs={12} lg={6}>
            <StatTile tone="ink" label="Documents au fonds" value={12840} />
          </Col>
          <Col xs={12} lg={6}>
            <StatTile tone="sky" label="Lots ce mois" value={32} />
          </Col>
          <Col xs={12} lg={6}>
            <StatTile tone="violet" label="Types actifs" value={18} />
          </Col>
          <Col xs={12} lg={6}>
            <StatTile tone="coral" label="Exports" value={241} />
          </Col>
          <Col xs={12} lg={6}>
            <StatusTile tone="success" label="Traités" value={182} />
          </Col>
          <Col xs={12} lg={6}>
            <StatusTile tone="warning" label="Échéance proche" value={9} />
          </Col>
          <Col xs={12} lg={6}>
            <StatusTile tone="danger" label="En retard" value={3} />
          </Col>
          <Col xs={12} lg={6}>
            <StatusTile tone="info" label="En cours" value={27} />
          </Col>
        </Row>
      </Section>

      {/* 8. Espacement & ombres --------------------------------------------- */}
      <Section
        title="Espacement (8 / 16 / 24 / 28) et ombres"
        hint="Une seule échelle d'espacement ; cartes sans ombre, popovers 0 3px 21px."
      >
        <Space direction="vertical" size={8} style={{ marginBottom: 20 }}>
          {[8, 16, 24, 28].map((s) => (
            <div key={s} style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <div
                style={{
                  width: s * 4,
                  height: 10,
                  background: colors.primarySoft,
                  borderRadius: 2,
                }}
              />
              <Text type="secondary" style={{ fontSize: 12 }}>
                {s} px
              </Text>
            </div>
          ))}
        </Space>
        <Space size={24} wrap>
          <div
            style={{
              width: 180,
              padding: 16,
              borderRadius: radii.card,
              border: '1px solid var(--ant-color-border)',
              background: 'var(--ant-color-bg-container)',
            }}
          >
            Carte plate — aucune ombre
          </div>
          <div
            style={{
              width: 180,
              padding: 16,
              borderRadius: radii.card,
              background: 'var(--ant-color-bg-elevated)',
              border: '1px solid var(--ant-color-border-secondary)',
              boxShadow: 'var(--da-shadow-popover)',
            }}
          >
            Surface flottante — 0 3px 21px
          </div>
        </Space>
      </Section>
    </div>
  );
}

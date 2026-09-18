'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Alert, Button, ConfigProvider, Form, Grid, Input, Typography } from 'antd';
import { motion } from 'motion/react';
import { API_BASE } from '../lib/api';
import { Logo } from '../components/BrandMark';
import { CLIENT_BRAND } from '../theme/client-brand';
import { icons } from '../theme/icons';
import { fadeUp } from '../theme/motion';

interface LoginForm {
  username: string;
  password: string;
}

/**
 * Palette de l'écran de connexion — vert AGEF, demandé par le client.
 *
 * LOCALE À CETTE PAGE, et non posée sur les tokens `--da-brand-*` : ceux-ci
 * habillent la barre du haut et tout le reste de l'application, qui restent au
 * bleu Plus Admin.
 *
 * Ce vert est TRÈS clair (luminance 0,82) : du blanc dessus tomberait à 1,2:1.
 * Tout ce qui s'y pose passe donc en encre sombre — mais en encre NEUTRE, celle
 * du design system, et non dans un vert foncé assorti : une encre teintée sur un
 * champ de la même teinte se fond perceptivement, le texte paraît délavé même
 * quand le ratio est bon (le vert foncé précédent mesurait pourtant 10,2:1).
 * Ratios sur `#d8f0da` : `ink` 17,1:1, `inkMuted` 10,8:1.
 */
const AGEF = {
  panel: '#d8f0da',
  /** Même teinte, à peine plus dense : n'affleure qu'au coin, comme le cyan du dégradé d'origine. */
  panelDeep: '#c2e7c8',
  /** `colors.text` du design system. */
  ink: '#030303',
  /** `colors.textStrong` — atténué par la graisse et la taille, pas par un gris pâle. */
  inkMuted: '#313131',
  /** Vert foncé réservé aux FORMES décoratives : elles ne portent pas de texte. */
  decor: '#0f3d1c',
  /** Contour : le fond du bouton ne tranche pas sur le blanc de la carte (1,2:1), c'est
      la bordure qui délimite la cible — 3,25:1, le minimum exigé pour un élément d'interface. */
  border: '#5f9c6b',
} as const;

/** Panneau de marque (gauche desktop / bandeau mobile) : fond « Encre », motif QR → archive. */
function BrandPanel({ compact = false }: { compact?: boolean }) {
  return (
    <div
      style={{
        position: 'relative',
        overflow: 'hidden',
        // Structure du dégradé d'origine conservée : le vert demandé couvre toute la
        // zone de texte, une nuance à peine plus dense n'affleure qu'au coin opposé.
        background: `linear-gradient(155deg, ${AGEF.panel} 0%, ${AGEF.panel} 60%, ${AGEF.panelDeep} 165%)`,
        color: AGEF.ink,
        padding: compact ? '28px 24px' : '48px 56px',
        display: 'flex',
        flexDirection: 'column',
        justifyContent: compact ? 'center' : 'space-between',
        minHeight: compact ? undefined : '100vh',
      }}
    >
      {/* Motif décoratif QR → archive */}
      {!compact && (
        <svg
          aria-hidden
          width="420"
          height="420"
          viewBox="0 0 420 420"
          style={{ position: 'absolute', right: -80, bottom: -60, opacity: 0.16 }}
        >
          {/* Motif sombre et non blanc : sur un fond clair, un décor blanc
              disparaîtrait purement et simplement. */}
          <g fill="none" stroke={AGEF.decor} strokeWidth="6">
            <rect x="30" y="30" width="90" height="90" rx="5" />
            <rect x="55" y="55" width="40" height="40" rx="4" fill={AGEF.decor} stroke="none" />
          </g>
          <g fill={AGEF.decor}>
            <rect x="150" y="34" width="26" height="26" rx="4" />
            <rect x="190" y="34" width="26" height="26" rx="4" opacity="0.6" />
            <rect x="150" y="74" width="26" height="26" rx="4" opacity="0.6" />
          </g>
          {/* Les « lignes d'archive » gardent leur rôle de contrepoint : un vert
              moyen, seule teinte distincte de l'encre sur le panneau. */}
          <g fill={AGEF.border}>
            <rect x="30" y="170" width="260" height="14" rx="4" />
            <rect x="30" y="205" width="200" height="14" rx="4" opacity="0.8" />
            <rect x="30" y="240" width="230" height="14" rx="4" opacity="0.6" />
            <rect x="30" y="275" width="150" height="14" rx="4" opacity="0.4" />
          </g>
        </svg>
      )}

      {/* Le panneau porte la seule marque du produit : la marque de l'organisation
          cliente vit côté formulaire, en filigrane. */}
      <div style={{ position: 'relative', zIndex: 1 }}>
        <Logo height={compact ? 28 : 40} />
      </div>

      {!compact && (
        <div style={{ position: 'relative', zIndex: 1, maxWidth: 420 }}>
          <Typography.Title
            level={2}
            className="da-display"
            style={{ color: AGEF.ink, marginBottom: 12 }}
          >
            Vos archives, retrouvées en un instant.
          </Typography.Title>
          <Typography.Paragraph style={{ color: AGEF.inkMuted, fontSize: 16, margin: 0 }}>
            Transformez vos piles de documents papier en archives numériques classées et
            recherchables — des intercalaires QR jusqu'à la recherche plein-texte.
          </Typography.Paragraph>
        </div>
      )}

      {!compact && (
        <div
          style={{
            position: 'relative',
            zIndex: 1,
            color: AGEF.inkMuted,
            fontSize: 13,
          }}
        >
          {CLIENT_BRAND
            ? `Espace d'archivage de ${CLIENT_BRAND.longNameInSentence} — intercalaires QR, acquisition par lot, recherche & export.`
            : "Génération d'intercalaires · Acquisition par lot · Recherche & export"}
        </div>
      )}
    </div>
  );
}

export default function LoginPage() {
  const router = useRouter();
  const screens = Grid.useBreakpoint();
  const isWide = screens.lg;
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onFinish = async (values: LoginForm) => {
    setLoading(true);
    setError(null);
    // Edge/Chrome autofill peut ajouter un espace de fin : on nettoie pour que les identifiants correspondent.
    const payload = { username: values.username.trim(), password: values.password.trim() };
    try {
      const res = await fetch(`${API_BASE}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        setError(
          'Identifiants invalides — vérifiez votre nom d’utilisateur et votre mot de passe.',
        );
        return;
      }
      const data = (await res.json()) as { accessToken: string };
      window.localStorage.setItem('token', data.accessToken);
      // En dev, navigation document (et non client) : si /dashboards se compile encore
      // à cet instant, une transition client pourrait être avalée par le rebuild HMR
      // et laisser l'utilisateur sur un spinner. En prod, router.replace (instantané).
      if (process.env.NODE_ENV === 'development') {
        window.location.replace('/dashboards');
      } else {
        router.replace('/dashboards');
      }
    } catch {
      setError('Connexion impossible — réessayez ou vérifiez que le serveur est démarré.');
    } finally {
      setLoading(false);
    }
  };

  const Lock = icons['lock'];

  return (
    <div style={{ minHeight: '100vh', display: 'flex', flexDirection: isWide ? 'row' : 'column' }}>
      {isWide ? (
        <div style={{ flex: '0 0 46%', maxWidth: 620 }}>
          <BrandPanel />
        </div>
      ) : (
        <BrandPanel compact />
      )}

      <div
        style={{
          position: 'relative',
          flex: 1,
          display: 'grid',
          placeItems: 'center',
          padding: '32px 24px',
          background: 'var(--ant-color-bg-container, #fff)',
        }}
      >
        {/* Filigrane du logo client. Décoratif : `aria-hidden`, et l'appartenance
            reste énoncée en toutes lettres sous le titre du formulaire. */}
        {CLIENT_BRAND && (
          <div aria-hidden className="da-client-watermark-clip">
            <div
              className="da-client-watermark"
              style={{ backgroundImage: `url(${CLIENT_BRAND.logoSrc})` }}
            />
          </div>
        )}

        {/* Conteneur en verre dépoli : le motif court sous toute la colonne et
            reste visible au travers ; c'est le flou de `backdrop-filter` qui rend
            la saisie lisible, pas un aplat opaque. */}
        {/* La carte ne doit porter AUCUNE opacité animée, ni en avoir une au-dessus
            d'elle : Chromium désactive `backdrop-filter` sous un ancêtre dont
            l'opacité est animée, et le verre dépoli disparaîtrait. Le cadre reste
            donc statique, c'est son contenu qui s'anime. */}
        {/* `ConfigProvider` local plutôt que du CSS : le survol et le focus des champs
            sont peints par Ant Design à partir de `colorPrimary`. Les rattraper en CSS
            demanderait de surenchérir sur sa spécificité, alors qu'un fournisseur
            imbriqué fusionne proprement avec le thème global — lequel reste au bleu
            pour tout le reste de l'application. */}
        <ConfigProvider
          theme={{
            token: {
              colorPrimary: AGEF.border,
              colorPrimaryHover: '#4d8459',
              controlOutline: 'rgba(95, 156, 107, 0.2)',
            },
          }}
        >
          <div
            className="da-login-card"
            style={{
              position: 'relative',
              zIndex: 1,
              width: '100%',
              maxWidth: 420,
              padding: isWide ? '36px 36px 32px' : '28px 24px 24px',
            }}
          >
            <motion.div variants={fadeUp} initial="hidden" animate="show">
              <Typography.Title level={3} className="da-display" style={{ marginBottom: 4 }}>
                Connexion
              </Typography.Title>
              {/* Pas de `type="secondary"` : ce gris est calibré pour un blanc plein,
                  il s'affadit sur une carte translucide posée sur le motif. */}
              <Typography.Paragraph style={{ color: AGEF.inkMuted, marginBottom: 24 }}>
                {CLIENT_BRAND
                  ? `Accédez à l'espace d'archivage de ${CLIENT_BRAND.longNameInSentence}.`
                  : "Accédez à votre espace d'archivage."}
              </Typography.Paragraph>

              {error && (
                <Alert type="error" showIcon message={error} style={{ marginBottom: 16 }} />
              )}

              <Form layout="vertical" onFinish={onFinish} requiredMark={false} autoComplete="off">
                <Form.Item
                  name="username"
                  label="Nom d'utilisateur"
                  rules={[{ required: true, message: 'Saisissez votre nom d’utilisateur.' }]}
                >
                  <Input
                    autoFocus
                    autoComplete="off"
                    placeholder="ex. agent.archives"
                    prefix={
                      <icons.users
                        size={16}
                        strokeWidth={1.75}
                        style={{ color: 'var(--ant-color-text-tertiary)' }}
                      />
                    }
                  />
                </Form.Item>
                <Form.Item
                  name="password"
                  label="Mot de passe"
                  rules={[{ required: true, message: 'Saisissez votre mot de passe.' }]}
                >
                  <Input.Password
                    autoComplete="new-password"
                    placeholder="••••••••"
                    prefix={
                      <Lock
                        size={16}
                        strokeWidth={1.75}
                        style={{ color: 'var(--ant-color-text-tertiary)' }}
                      />
                    }
                  />
                </Form.Item>
                <Button
                  type="primary"
                  htmlType="submit"
                  block
                  loading={loading}
                  className="da-login-cta"
                  style={{ marginTop: 4 }}
                >
                  Se connecter
                </Button>
              </Form>

              {/* Un flex, et non `Space` : les enfants de `Space` sont des blocs, si bien
              qu'un texte replié sur deux lignes (carte étroite, mobile) laisse le
              cadenas seul sur la sienne. Aligné en tête, l'icône reste au texte. */}
              <div
                style={{
                  marginTop: 20,
                  display: 'flex',
                  alignItems: 'flex-start',
                  gap: 6,
                  // Secondaire et non tertiaire : le tertiaire tombe sous les 4,5:1
                  // dès que le motif affleure derrière le verre.
                  color: 'var(--ant-color-text-secondary)',
                  fontSize: 12,
                }}
              >
                <Lock size={13} strokeWidth={1.75} style={{ flex: 'none', marginTop: 2 }} />
                <span>Connexion sécurisée — vos accès sont journalisés.</span>
              </div>
            </motion.div>
          </div>
        </ConfigProvider>
      </div>
    </div>
  );
}

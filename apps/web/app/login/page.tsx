'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Alert, Button, Form, Grid, Input, Space, Typography } from 'antd';
import { motion } from 'motion/react';
import { API_BASE } from '../lib/api';
import { Logo } from '../components/BrandMark';
import { icons } from '../theme/icons';
import { fadeUp } from '../theme/motion';

interface LoginForm {
  username: string;
  password: string;
}

/** Panneau de marque (gauche desktop / bandeau mobile) : fond « Encre », motif QR → archive. */
function BrandPanel({ compact = false }: { compact?: boolean }) {
  return (
    <div
      style={{
        position: 'relative',
        overflow: 'hidden',
        // Dégradé signature : le bleu roi couvre toute la zone de texte (blanc à
        // 9,25:1), le cyan n'affleure qu'au coin opposé — seul il tomberait à 1,87:1.
        background:
          'linear-gradient(155deg, var(--da-brand-to) 0%, var(--da-brand-to) 60%, var(--da-brand-from) 165%)',
        color: 'var(--da-on-brand)',
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
          style={{ position: 'absolute', right: -80, bottom: -60, opacity: 0.12 }}
        >
          <g fill="none" stroke="var(--da-on-brand)" strokeWidth="6">
            <rect x="30" y="30" width="90" height="90" rx="5" />
            <rect
              x="55"
              y="55"
              width="40"
              height="40"
              rx="4"
              fill="var(--da-on-brand)"
              stroke="none"
            />
          </g>
          <g fill="var(--da-on-brand)">
            <rect x="150" y="34" width="26" height="26" rx="4" />
            <rect x="190" y="34" width="26" height="26" rx="4" opacity="0.6" />
            <rect x="150" y="74" width="26" height="26" rx="4" opacity="0.6" />
          </g>
          {/* Les « lignes d'archive » reprennent le cyan du dégradé signature : posées
              sur le bleu roi du panneau, elles restent le seul contrepoint de teinte. */}
          <g fill="var(--da-brand-from)">
            <rect x="30" y="170" width="260" height="14" rx="4" />
            <rect x="30" y="205" width="200" height="14" rx="4" opacity="0.8" />
            <rect x="30" y="240" width="230" height="14" rx="4" opacity="0.6" />
            <rect x="30" y="275" width="150" height="14" rx="4" opacity="0.4" />
          </g>
        </svg>
      )}

      <div style={{ position: 'relative', zIndex: 1 }}>
        <Logo height={compact ? 28 : 40} />
      </div>

      {!compact && (
        <div style={{ position: 'relative', zIndex: 1, maxWidth: 420 }}>
          <Typography.Title
            level={2}
            className="da-display"
            style={{ color: 'var(--da-on-brand)', marginBottom: 12 }}
          >
            Vos archives, retrouvées en un instant.
          </Typography.Title>
          <Typography.Paragraph
            style={{ color: 'var(--da-on-brand-muted)', fontSize: 16, margin: 0 }}
          >
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
            color: 'var(--da-on-brand-muted)',
            fontSize: 13,
          }}
        >
          Génération d'intercalaires · Acquisition par lot · Recherche &amp; export
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
          flex: 1,
          display: 'grid',
          placeItems: 'center',
          padding: '32px 24px',
          background: 'var(--ant-color-bg-container, #fff)',
        }}
      >
        <motion.div
          variants={fadeUp}
          initial="hidden"
          animate="show"
          style={{ width: '100%', maxWidth: 380 }}
        >
          <Typography.Title level={3} className="da-display" style={{ marginBottom: 4 }}>
            Connexion
          </Typography.Title>
          <Typography.Paragraph type="secondary" style={{ marginBottom: 24 }}>
            Accédez à votre espace d'archivage.
          </Typography.Paragraph>

          {error && <Alert type="error" showIcon message={error} style={{ marginBottom: 16 }} />}

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
              style={{ marginTop: 4 }}
            >
              Se connecter
            </Button>
          </Form>

          <Space
            size={6}
            style={{ marginTop: 20, color: 'var(--ant-color-text-tertiary)', fontSize: 12 }}
          >
            <Lock size={13} strokeWidth={1.75} />
            <span>Connexion sécurisée — vos accès sont journalisés.</span>
          </Space>
        </motion.div>
      </div>
    </div>
  );
}

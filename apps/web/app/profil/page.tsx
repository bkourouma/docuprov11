'use client';

import { useEffect, useState } from 'react';
import {
  App,
  Alert,
  Avatar,
  Button,
  Card,
  Col,
  Form,
  Input,
  Row,
  Space,
  Spin,
  Typography,
} from 'antd';
import dayjs from 'dayjs';
import { PageHeader } from '../components/PageHeader';
import { InfoCard, InfoRow } from '../components/InfoCard';
import { StateTag } from '../components/documents/shared';
import { icons } from '../theme/icons';
import { fontSize, space } from '../theme/tokens';
import { changeMyPassword, getMyProfile, type MyProfile } from '../lib/auth';
import { newPasswordError } from '../login/password-policy';

const { Text } = Typography;

/** Largeur maximale de la colonne du formulaire — au-delà, la ligne devient trop longue. */
const FORM_MAX = 460;

interface PasswordForm {
  currentPassword: string;
  newPassword: string;
  confirmPassword: string;
}

/** Initiales de l'avatar, mêmes règles que la barre supérieure. */
function initials(p: MyProfile): string {
  const base = p.fullName || `${p.firstName} ${p.lastName}`.trim() || p.username;
  const parts = base.trim().split(/\s+/);
  return ((parts[0]?.[0] ?? '') + (parts[1]?.[0] ?? '')).toUpperCase() || '?';
}

/** Valeur absente : un tiret cadratin plutôt qu'un vide, qui se lirait comme un défaut d'affichage. */
const orDash = (v: string | null | undefined) => (v?.trim() ? v : '—');

export default function ProfilPage() {
  const { message } = App.useApp();
  const [form] = Form.useForm<PasswordForm>();
  const [profile, setProfile] = useState<MyProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void getMyProfile()
      .then((p) => {
        if (!cancelled) setProfile(p);
      })
      .catch((e: unknown) => {
        if (!cancelled) message.error(e instanceof Error ? e.message : 'Chargement impossible');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [message]);

  const submit = async (v: PasswordForm) => {
    setSaving(true);
    try {
      await changeMyPassword(v.currentPassword, v.newPassword);
      message.success('Mot de passe modifié.');
      form.resetFields();
      // `mustChangePwd` est effacé côté serveur : l'alerte d'obligation doit disparaître aussi.
      setProfile((p) => (p ? { ...p, mustChangePwd: false } : p));
    } catch (e) {
      message.error(e instanceof Error ? e.message : 'Modification impossible');
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div style={{ display: 'grid', placeItems: 'center', minHeight: 240 }}>
        <Spin />
      </div>
    );
  }

  if (!profile) {
    return <Alert type="error" showIcon message="Profil indisponible" />;
  }

  return (
    <div style={{ maxWidth: 1100 }}>
      <PageHeader icon="users" title="Mon profil" />

      {profile.mustChangePwd && (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 16 }}
          message="Vous devez changer votre mot de passe"
          description="Le compte a été créé ou réinitialisé par un administrateur : choisissez un mot de passe personnel ci-dessous."
        />
      )}

      {/* Bandeau d'identité : le nom, le compte, et les marqueurs qui changent ce que l'écran
          autorise (administrateur, compte désactivé). */}
      <Card style={{ marginBottom: 16 }}>
        <div style={{ display: 'flex', gap: space.lg, alignItems: 'center', flexWrap: 'wrap' }}>
          <Avatar
            size={64}
            style={{
              background: 'var(--ant-color-primary-bg)',
              color: 'var(--ant-color-primary)',
              fontSize: fontSize.lg,
              fontWeight: 600,
              flex: 'none',
            }}
          >
            {initials(profile)}
          </Avatar>
          <div style={{ minWidth: 0 }}>
            <Typography.Title level={4} style={{ margin: 0 }}>
              {orDash(profile.fullName)}
            </Typography.Title>
            <Text type="secondary" className="da-mono">
              {profile.username}
            </Text>
            <div style={{ marginTop: space.sm, display: 'flex', gap: space.sm, flexWrap: 'wrap' }}>
              {profile.isAdmin && <StateTag tone="brand">Administrateur</StateTag>}
              {profile.role && <StateTag tone="info">{profile.role.name}</StateTag>}
              {profile.confidentialite ? (
                <StateTag tone="warning">Habilitation : {profile.confidentialite.label}</StateTag>
              ) : (
                <StateTag tone="neutral">Aucune habilitation</StateTag>
              )}
              {profile.isDisabled && <StateTag tone="danger">Compte désactivé</StateTag>}
            </div>
          </div>
        </div>
      </Card>

      <Row gutter={[16, 16]}>
        <Col xs={24} lg={12}>
          <Space direction="vertical" size="middle" style={{ width: '100%' }}>
            <InfoCard icon="users" title="Identité">
              <InfoRow label="Nom" value={orDash(profile.lastName)} />
              <InfoRow label="Prénom" value={orDash(profile.firstName)} />
              <InfoRow label="Identifiant de connexion" value={profile.username} />
              <InfoRow label="Matricule" value={orDash(profile.matricule)} />
            </InfoCard>

            <InfoCard icon="mail" title="Contact">
              <InfoRow label="Adresse e-mail" value={orDash(profile.email)} />
              <InfoRow label="Téléphone" value={orDash(profile.phone)} />
            </InfoCard>

            <InfoCard icon="lock" title="Compte">
              <InfoRow
                label="Créé le"
                value={dayjs(profile.createdAt).format('DD/MM/YYYY à HH:mm')}
              />
              <InfoRow label="Statut" value={profile.isDisabled ? 'Désactivé' : 'Actif'} />
              <InfoRow
                label="Changement de mot de passe"
                value={profile.mustChangePwd ? 'Exigé à la prochaine connexion' : 'Non requis'}
              />
            </InfoCard>
          </Space>
        </Col>

        <Col xs={24} lg={12}>
          <Space direction="vertical" size="middle" style={{ width: '100%' }}>
            <InfoCard icon="roles" title="Droits">
              <InfoRow
                label="Rôle"
                value={profile.role ? profile.role.name : 'Aucun rôle attribué'}
              />
              {profile.role?.description && (
                <InfoRow label="Description du rôle" value={profile.role.description} />
              )}
              <InfoRow
                label="Rattachement organisationnel"
                value={orDash(profile.role?.organigramme?.label)}
              />
              <InfoRow
                label="Menus accessibles"
                value={profile.isAdmin ? 'Tous (administrateur)' : `${profile.menuCount} menu(s)`}
              />
              <InfoRow
                label="Profils"
                value={
                  profile.groups.length === 0
                    ? '—'
                    : profile.groups
                        .map((g) => (g.isDefault ? `${g.name} (par défaut)` : g.name))
                        .join(', ')
                }
              />
            </InfoCard>

            <InfoCard icon="lock" title="Habilitation de confidentialité">
              {/* Le rang explique CE QUE l'habilitation ouvre : sans lui, « Interne » ne dit pas
                  qu'un document « Confidentiel » restera invisible en recherche. */}
              <InfoRow
                label="Niveau"
                value={profile.confidentialite ? profile.confidentialite.label : 'Aucun'}
              />
              <Text type="secondary" style={{ fontSize: fontSize.xs }}>
                {profile.isAdmin
                  ? 'Administrateur : tous les documents restent accessibles, quel que soit leur niveau.'
                  : profile.confidentialite
                    ? `Vous accédez aux documents dont le niveau est inférieur ou égal à « ${profile.confidentialite.label} ». Les documents d'un niveau supérieur n'apparaissent pas en recherche.`
                    : 'Sans habilitation, seuls les documents sans niveau de confidentialité vous sont accessibles.'}
              </Text>
            </InfoCard>

            <InfoCard icon="lock" title="Changer mon mot de passe">
              <Form<PasswordForm>
                form={form}
                layout="vertical"
                onFinish={(v) => void submit(v)}
                requiredMark
                style={{ maxWidth: FORM_MAX }}
              >
                <Form.Item
                  name="currentPassword"
                  label="Mot de passe actuel"
                  rules={[{ required: true, message: 'Le mot de passe actuel est obligatoire' }]}
                >
                  <Input.Password autoComplete="current-password" />
                </Form.Item>
                <Form.Item
                  name="newPassword"
                  label="Nouveau mot de passe"
                  rules={[
                    { required: true, message: 'Le nouveau mot de passe est obligatoire' },
                    // Longueur minimale ET refus des espaces de début/fin : l'écran de connexion
                    // les retire à la saisie, un tel mot de passe verrouillerait le compte.
                    {
                      validator: (_, value: string | undefined) => {
                        const problem = newPasswordError(value);
                        return problem ? Promise.reject(new Error(problem)) : Promise.resolve();
                      },
                    },
                  ]}
                >
                  <Input.Password autoComplete="new-password" />
                </Form.Item>
                <Form.Item
                  name="confirmPassword"
                  label="Confirmer le nouveau mot de passe"
                  dependencies={['newPassword']}
                  rules={[
                    { required: true, message: 'La confirmation est obligatoire' },
                    // Confirmation vérifiée ICI : le serveur ne reçoit qu'un mot de passe, une
                    // faute de frappe passerait sinon inaperçue jusqu'à la prochaine connexion.
                    ({ getFieldValue }) => ({
                      validator: (_, value) =>
                        !value || getFieldValue('newPassword') === value
                          ? Promise.resolve()
                          : Promise.reject(new Error('Les deux saisies diffèrent')),
                    }),
                  ]}
                >
                  <Input.Password autoComplete="new-password" />
                </Form.Item>
                <Button
                  type="primary"
                  htmlType="submit"
                  loading={saving}
                  icon={<icons.check size={16} />}
                >
                  Modifier le mot de passe
                </Button>
              </Form>
            </InfoCard>
          </Space>
        </Col>
      </Row>
    </div>
  );
}

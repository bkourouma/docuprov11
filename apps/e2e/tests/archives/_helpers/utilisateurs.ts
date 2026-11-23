/**
 * Utilisateurs à droits restreints, partagés par toutes les specs du module Archives (tâche T4).
 *
 * Contrat API lu dans le code (ne pas deviner) :
 *  - `POST /roles` { name, description?, menuKeys } → rôle avec `menuKeys` EFFECTIVEMENT retenues :
 *    `sanitizeMenuKeys` (roles/menu-catalog.ts) écarte SILENCIEUSEMENT toute clé inconnue, masquée
 *    (`HIDDEN_MENU_KEYS`) ou l'accueil `/`. L'aide le vérifie et échoue fort plutôt que de créer
 *    un compte sans le menu demandé (le test « avec le menu » passerait alors pour un refus).
 *  - `POST /users` { username, firstName, lastName, email (obligatoire), password (≥ 6),
 *    roleId?, confidentialiteId? } → { userId, username }. Le service force `mustChangePwd = true`.
 *  - `POST /auth/change-password` { currentPassword, newPassword } (jeton de l'utilisateur) efface
 *    `mustChangePwd` : c'est ce que fait l'aide, pour livrer un compte « mot de passe définitif ».
 *
 * `confidentialite` est un IDENTIFIANT de niveau (`confidentialite.confidentialite_id`, champ
 * `confidentialiteId` du DTO), PAS un rang. Absent : aucune habilitation (l'utilisateur ne voit
 * que les documents sans exigence de confidentialité, cf. `DocumentsService`).
 *
 * Le compte n'a AUCUN profil (`app_user_group`) : son jeton porte `userGroupId = null`. Les specs
 * qui ont besoin d'un compte-groupe (droits nominatifs) passent par `compteGroupeDe` (documents.ts).
 */
import { request } from '@playwright/test';
import type { ApiClient } from '../../../fixtures';

export interface UtilisateurTest {
  username: string;
  password: string;
  userId: number;
  roleId: number;
}

interface RoleCree {
  roleId: number;
  menuKeys: string[];
}

/** Partie aléatoire courte : le mot de passe et l'e-mail ne doivent rien devoir au préfixe. */
function alea(): string {
  return `${Date.now().toString(36)}${Math.floor(Math.random() * 1e9).toString(36)}`;
}

/** Préfixe réduit à ce qu'acceptent un identifiant et une adresse e-mail. */
function nettoyer(prefix: string): string {
  const net = prefix
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Za-z0-9._-]/g, '-')
    .toLowerCase();
  return net.length > 0 ? net : 'e2e';
}

/**
 * Efface `mustChangePwd` en changeant le mot de passe AVEC LE JETON DE L'UTILISATEUR.
 *
 * Le client `api` ne sait parler qu'en administrateur : on ouvre donc la session par
 * `api.raw.post('/auth/login')` (route publique, l'en-tête admin y est ignoré), puis on déduit
 * l'URL de base de l'API de l'URL de cette même réponse — aucune hypothèse sur la configuration
 * du paquet e2e (port, préfixe) n'est nécessaire.
 */
async function definirMotDePasse(
  api: ApiClient,
  username: string,
  initial: string,
  definitif: string,
): Promise<void> {
  const login = await api.raw.post('/auth/login', { username, password: initial });
  if (!login.ok()) {
    throw new Error(
      `Connexion de ${username} impossible (${login.status()}) : ${await login.text()}`,
    );
  }
  const { accessToken } = (await login.json()) as { accessToken?: string };
  if (!accessToken) throw new Error(`Connexion de ${username} sans jeton`);

  const urlLogin = login.url();
  const base = urlLogin.slice(0, urlLogin.lastIndexOf('/auth/login'));
  const contexte = await request.newContext();
  try {
    const r = await contexte.post(`${base}/auth/change-password`, {
      headers: { Authorization: `Bearer ${accessToken}` },
      data: { currentPassword: initial, newPassword: definitif },
    });
    if (!r.ok()) {
      throw new Error(
        `Changement du mot de passe de ${username} refusé (${r.status()}) : ${await r.text()}`,
      );
    }
  } finally {
    await contexte.dispose();
  }
}

/**
 * Crée un rôle n'ouvrant que les menus donnés (clés de menu, ex. '/archives/communiquer'),
 * puis un utilisateur portant ce rôle, mot de passe défini (pas de changement forcé).
 *
 * `menus: []` est permis : rôle sans aucun menu (seul l'accueil `/`, toujours accordé).
 */
export async function creerUtilisateurAvecMenus(
  api: ApiClient,
  opts: { prefix: string; menus: string[]; confidentialite?: number },
): Promise<UtilisateurTest> {
  const base = nettoyer(opts.prefix);
  const suffixe = alea();
  const username = `${base}-${suffixe}`;

  const role = (await api.post('/roles', {
    name: `E2E ${opts.prefix} ${suffixe}`.slice(0, 200),
    description: 'Rôle de test E2E (droits restreints)',
    menuKeys: opts.menus,
  })) as RoleCree;

  const demandes = [...new Set(opts.menus)].sort();
  const retenus = [...role.menuKeys].sort();
  if (demandes.join('|') !== retenus.join('|')) {
    throw new Error(
      `Menus non assignables écartés par l'API pour ${opts.prefix} : demandés [${demandes.join(
        ', ',
      )}], retenus [${retenus.join(', ')}] (voir ASSIGNABLE_MENU_KEYS, roles/menu-catalog.ts)`,
    );
  }

  const initial = `Init-${alea()}`;
  const password = `E2e-${alea()}`;
  const cree = (await api.post('/users', {
    username,
    firstName: 'E2E',
    lastName: base.slice(0, 50),
    email: `${username}@e2e.test`,
    password: initial,
    roleId: role.roleId,
    ...(opts.confidentialite !== undefined ? { confidentialiteId: opts.confidentialite } : {}),
  })) as { userId: number; username: string };

  await definirMotDePasse(api, username, initial, password);

  return { username, password, userId: cree.userId, roleId: role.roleId };
}

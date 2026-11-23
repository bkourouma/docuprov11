import type { ApiClient } from '../../../fixtures';
import { HttpError, loginApi } from './http';
import { slug, uniqueSuffix } from './unique';

/**
 * Acteur courrier = rôle NON système portant `menus` + utilisateur actif de ce rôle, membre d'un
 * groupe par défaut (donc doté d'une identité effective `userGroupId`), au mot de passe utilisable.
 * Un rôle neuf par appel : le destinataire d'un courrier Arrivée est un RÔLE (§05), un rôle partagé
 * entre tests mélangerait leurs files Contrôle.
 *
 * Endpoints utilisés (lus dans le code, phase A) :
 *  - `POST /roles` `{ name, description, menuKeys }` → `{ roleId, name, menuKeys, ... }`
 *    (`menuKeys` passe par `sanitizeMenuKeys` : une clé inconnue ou masquée est ignorée en silence).
 *  - `GET /users/groups/all`, `POST /users/groups/all` `{ name }` → `{ groupId, name }`.
 *  - `POST /users` `{ username, firstName, lastName, email, password, roleId, groupId }`
 *    → `{ userId, username }` ; l'API pose `mustChangePwd = true` et crée l'`app_user_group`
 *    par défaut (`isDefault = true`) quand `groupId` est fourni. `fullName` = « prénom nom ».
 *  - `GET /courriers/actors` → `[{ userGroupId, label: 'Nom — Groupe', roleId }]` : c'est ainsi
 *    qu'on lit le `userGroupId` sans se connecter (le rôle étant neuf, un seul acteur le porte).
 *  - `POST /auth/change-password` `{ currentPassword, newPassword }` AU NOM du compte : remet
 *    `mustChangePwd` à false. On « change » vers le MÊME mot de passe (l'API ne l'interdit pas) :
 *    ainsi un échec de cet appel n'invalide pas le mot de passe renvoyé.
 *
 * Hypothèses à vérifier en phase B :
 *  - Le web ne force PAS d'écran de changement de mot de passe (seul `/profil` affiche une alerte
 *    quand `mustChangePwd`) : l'appel `change-password` est une hygiène, pas une condition. S'il
 *    échoue (base d'URL de `http.ts` erronée), un avertissement est journalisé et l'acteur reste
 *    utilisable par `loginAs`/`apiAs`.
 *  - `fullName` renvoyé = celui que compose l'API (« prénom nom ») : avec `opts.fullName` d'un seul
 *    mot, le nom de famille par défaut « E2E » est ajouté.
 */
export interface CourrierActor {
  username: string;
  password: string;
  userId: number;
  userGroupId: number;
  roleId: number;
  roleName: string;
  fullName: string;
}

/** Groupe (profil) commun aux comptes E2E courrier : une identité effective exige un groupe. */
const E2E_GROUP_NAME = 'E2E Courriers';

interface GroupRow {
  groupId: number;
  name: string;
}
interface ActorRow {
  userGroupId: number;
  label: string;
  roleId: number | null;
}

async function ensureE2eGroup(api: ApiClient): Promise<number> {
  const groups = (await api.get('/users/groups/all')) as GroupRow[];
  const found = groups.find((g) => g.name === E2E_GROUP_NAME);
  if (found) return found.groupId;
  // Course possible entre workers : deux groupes homonymes seraient sans conséquence (le nom
  // n'est pas unique et ne porte aucun droit).
  const created = (await api.post('/users/groups/all', { name: E2E_GROUP_NAME })) as GroupRow;
  return created.groupId;
}

function splitName(fullName: string | undefined, fallbackLast: string): { firstName: string; lastName: string } {
  const parts = (fullName ?? '').trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return { firstName: 'Agent', lastName: fallbackLast };
  if (parts.length === 1) return { firstName: parts[0]!, lastName: 'E2E' };
  return { firstName: parts[0]!, lastName: parts.slice(1).join(' ') };
}

export async function createCourrierActor(
  api: ApiClient,
  opts: { prefix: string; menus: string[]; fullName?: string },
): Promise<CourrierActor> {
  const suffix = uniqueSuffix();
  const base = slug(opts.prefix) || 'acteur';
  const roleName = `${opts.prefix} ${suffix}`;

  const role = (await api.post('/roles', {
    name: roleName,
    description: 'Rôle créé par les tests E2E Docu-Courriers',
    menuKeys: opts.menus,
  })) as { roleId: number; name: string };

  const groupId = await ensureE2eGroup(api);

  const username = `${base}-${suffix}`.slice(0, 60);
  // Au moins 6 caractères (MIN_PASSWORD_LENGTH) ; mélange pour passer d'éventuelles règles futures.
  const password = `E2e!${suffix}`;
  // Nom de famille unique par défaut : le libellé « Nom — Groupe » doit être sélectionnable sans
  // ambiguïté dans les listes (en copie, imputation).
  const { firstName, lastName } = splitName(opts.fullName, `${base}-${suffix}`);

  const user = (await api.post('/users', {
    username,
    firstName,
    lastName,
    email: `${username}@e2e.test`,
    password,
    roleId: role.roleId,
    groupId,
  })) as { userId: number; username: string };

  const actors = (await api.get('/courriers/actors')) as ActorRow[];
  const mine = actors.filter((a) => a.roleId === role.roleId);
  if (mine.length !== 1) {
    throw new Error(
      `createCourrierActor : ${mine.length} identité(s) effective(s) trouvée(s) pour le rôle ${role.roleId} (1 attendue).`,
    );
  }

  try {
    const self = await loginApi(username, password);
    await self.post('/auth/change-password', { currentPassword: password, newPassword: password });
  } catch (e) {
    // Non bloquant : voir l'en-tête (aucun écran forcé côté web).
    const detail = e instanceof HttpError ? `${e.status} ${e.path}` : String(e);
    console.warn(`[e2e courriers] change-password ignoré pour ${username} : ${detail}`);
  }

  return {
    username,
    password,
    userId: user.userId,
    userGroupId: mine[0]!.userGroupId,
    roleId: role.roleId,
    roleName: role.name,
    fullName: `${firstName} ${lastName}`,
  };
}

/**
 * GED — éditeur : mentions « @ » (GET /collab/documents/:id/mention-candidates) et notification de la
 * personne mentionnée après l'enregistrement automatique.
 * Sources : mention-suggestion.ts, collab-documents.service.ts (mentionCandidates),
 * collab-server.service.ts (trackMentions/flushMentions), collab-persistence.service.ts (notifyMentions).
 */
import { test, expect } from '../../../fixtures';
import {
  COLLAB_TIMEOUT,
  PERMISSION,
  createEditorUser,
  createSpaceAndDocument,
  grantDocument,
  openEditor,
  typeAtEnd,
  waitSaved,
  type RawApi,
} from '../_helpers/editeur';

interface Candidate {
  userGroupId: number;
  name: string;
}

const candidatesPath = (documentId: number, q: string) =>
  `/collab/documents/${documentId}/mention-candidates?q=${encodeURIComponent(q)}`;

test.describe('Éditeur — mentions', () => {
  test('GED-36 candidats : personnes ayant accès seulement, ni soi-même, ni requête trop courte', async ({
    api,
    apiAs,
    uniq,
  }) => {
    const { documentId } = await createSpaceAndDocument(api, uniq, 'ged36c');
    const bob = await createEditorUser(api, apiAs, uniq('ged36c'));

    // Document non restreint : tout compte actif y a accès, donc est mentionnable.
    const found = await api.get<Candidate[]>(candidatesPath(documentId, bob.username));
    expect(found).toContainEqual({ userGroupId: bob.userGroupId, name: bob.name });
    expect(await api.get<Candidate[]>(candidatesPath(documentId, bob.username.slice(0, 1)))).toEqual([]);

    // On ne se mentionne pas soi-même.
    const self = await bob.api.get<Candidate[]>(candidatesPath(documentId, bob.username));
    expect(self.map((c) => c.userGroupId)).not.toContain(bob.userGroupId);

    // Document restreint (droit nominatif à l'administrateur seul) : Bob n'est plus proposé, et lui
    // reçoit le 404 uniforme.
    const me = await api.get<{ userGroupId: number }>('/auth/me');
    await grantDocument(api, documentId, me.userGroupId, PERMISSION.Modification);
    const after = await api.get<Candidate[]>(candidatesPath(documentId, bob.username));
    expect(after.map((c) => c.userGroupId)).not.toContain(bob.userGroupId);
    const denied = await bob.api.raw.get(candidatesPath(documentId, bob.username));
    expect(denied.status()).toBe(404);

    // Requête trop longue : refus de validation.
    const tooLong = await (api as unknown as RawApi).raw.get(candidatesPath(documentId, 'x'.repeat(101)));
    expect(tooLong.status()).toBe(400);
  });

  test('GED-36 mentionner une personne avec « @ » l’insère et la notifie', async ({ page, api, apiAs, uniq }) => {
    const { documentId, label } = await createSpaceAndDocument(api, uniq, 'ged36m');
    const bob = await createEditorUser(api, apiAs, uniq('ged36m'));

    const box = await openEditor(page, expect, documentId);
    await typeAtEnd(page, expect, box, 'Pour action :');
    // Espace avant « @ » : préfixe exigé par la suggestion Tiptap.
    await page.keyboard.type(` @${bob.username}`);

    const list = page.getByRole('listbox', { name: 'Personnes à mentionner' });
    await expect(list).toBeVisible();
    await expect(page.getByText('Mentionner une personne ne lui donne pas accès au document.')).toBeVisible();
    await list.getByRole('option', { name: bob.name, exact: true }).click();
    await expect(list).toBeHidden();
    await expect(box).toContainText(`@${bob.name}`);
    await waitSaved(page, expect);

    // Notification envoyée après l'autosave (debounce serveur 2 à 10 s).
    await expect
      .poll(
        async () => {
          const res = await bob.api.get<{ rows: Array<{ message: string }> }>('/notifications');
          return res.rows.map((r) => r.message).join('\n');
        },
        { timeout: COLLAB_TIMEOUT + 10_000, message: 'notification de mention reçue par la personne mentionnée' },
      )
      .toContain(`vous a mentionné dans le document « ${label} »`);
  });
});

/**
 * GED — éditeur : collaboration temps réel à deux contextes navigateur (deux personnes).
 * Chaîne testée : navigateur -> ws://<hôte web>/api/collab (URL déduite de la page, `deriveWsUrl`)
 * -> relais d'upgrade du rewrite Next `/api/:path*` -> écouteur `upgrade` de l'API (Hocuspocus).
 * Sources : EditorShell.tsx (provider, présence, curseurs), lib/editeur.ts (deriveWsUrl),
 * collab-server.service.ts (handleUpgrade, onAuthenticate, beforeHandleAwareness).
 */
import { test, expect } from '../../../fixtures';
import {
  COLLAB_TIMEOUT,
  PERMISSION,
  createEditorUser,
  createSpaceAndDocument,
  escapeRegExp,
  grantDocument,
  openEditor,
  openUserPage,
  typeAtEnd,
} from '../_helpers/editeur';

test.describe('Éditeur — collaboration à deux', () => {
  test('GED-38 la saisie de l’un apparaît chez l’autre, avec la présence et le curseur du collaborateur', async ({
    page,
    api,
    apiAs,
    browser,
    loginAs,
    uniq,
  }) => {
    test.setTimeout(120_000);
    const { documentId } = await createSpaceAndDocument(api, uniq, 'ged38');
    const bob = await createEditorUser(api, apiAs, uniq('ged38'));
    await grantDocument(api, documentId, bob.userGroupId, PERMISSION.Modification);
    const admin = await api.get<{ fullName: string | null; username: string }>('/auth/me');
    const adminName = admin.fullName?.trim() || admin.username;
    expect(
      (await bob.api.get<{ mode: string }>(`/collab/documents/${documentId}/session`)).mode,
      'Bob doit pouvoir écrire',
    ).toBe('write');

    const boxA = await openEditor(page, expect, documentId);
    const { page: pageB, context } = await openUserPage(browser, loginAs, bob, test.info().project.use.baseURL);
    try {
      const boxB = await openEditor(pageB, expect, documentId);

      // Présence : chacun voit l'autre dans la liste des personnes connectées.
      await expect(page.getByRole('list', { name: /^Personnes connectées/ })).toHaveAttribute(
        'aria-label',
        new RegExp(escapeRegExp(bob.name)),
        { timeout: COLLAB_TIMEOUT },
      );
      await expect(pageB.getByRole('list', { name: /^Personnes connectées/ })).toHaveAttribute(
        'aria-label',
        new RegExp(escapeRegExp(adminName)),
        { timeout: COLLAB_TIMEOUT },
      );

      // A écrit -> B reçoit.
      const fromA = `Écrit par A ${uniq('ged38')}`;
      await typeAtEnd(page, expect, boxA, fromA);
      await expect(boxB).toContainText(fromA, { timeout: COLLAB_TIMEOUT });

      // B écrit -> A reçoit ; les deux contenus coexistent.
      const fromB = `Écrit par B ${uniq('ged38')}`;
      await typeAtEnd(pageB, expect, boxB, ` ${fromB}`);
      await expect(boxA).toContainText(fromB, { timeout: COLLAB_TIMEOUT });
      await expect(boxA).toContainText(fromA);
      await expect(boxB).toContainText(fromA);

      // Curseur distant étiqueté au nom du collaborateur (CollaborationCaret).
      await expect.soft(boxA.getByText(bob.name, { exact: true }), 'curseur de Bob chez A').toBeVisible();

      // Le contenu commun est persisté : B quitte, A recharge, tout est là.
      await context.close();
      await page.reload();
      await expect(boxA).toContainText(fromA, { timeout: COLLAB_TIMEOUT });
      await expect(boxA).toContainText(fromB);
    } finally {
      await context.close().catch(() => undefined);
    }
  });
});

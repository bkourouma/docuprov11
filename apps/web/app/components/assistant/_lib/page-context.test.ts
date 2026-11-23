// Tests du contexte de page de l'assistant.
// Lancer : cd apps/web && npx tsx --test app/components/assistant/_lib/page-context.test.ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { asstPageContextSchema, type AsstPageContext } from '@archivage/types';
import { describePageContext, pageContextFromPath } from './page-context';

/** Vérifie le contrat zod puis renvoie le contexte. */
function ctx(path: string): AsstPageContext | null {
  const r = pageContextFromPath(path);
  if (r !== null) assert.equal(asstPageContextSchema.safeParse(r).success, true, `contrat violé pour ${path}`);
  return r;
}

test('courriers : section + identifiant', () => {
  assert.deepEqual(ctx('/courriers/controle/4321'), { route: '/courriers/controle', subjectType: 'mail', subjectId: '4321' });
  for (const s of ['parapheur', 'recherche', 'suivi']) {
    assert.deepEqual(ctx(`/courriers/${s}/7`), { route: `/courriers/${s}`, subjectType: 'mail', subjectId: '7' });
  }
});

test('documents, éditeur, espaces', () => {
  assert.deepEqual(ctx('/documents/12'), { route: '/documents', subjectType: 'document', subjectId: '12' });
  assert.deepEqual(ctx('/editeur/9'), { route: '/editeur', subjectType: 'document', subjectId: '9' });
  assert.deepEqual(ctx('/espaces/5'), { route: '/espaces', subjectType: 'space', subjectId: '5' });
});

test('éditeur/nouveau et routes sans sujet : route seule', () => {
  assert.deepEqual(ctx('/editeur/nouveau'), { route: '/editeur/nouveau' });
  assert.deepEqual(ctx('/courriers/controle'), { route: '/courriers/controle' });
  assert.deepEqual(ctx('/documents'), { route: '/documents' });
  assert.deepEqual(ctx('/workflows/inbox'), { route: '/workflows/inbox' });
  assert.deepEqual(ctx('/'), { route: '/' });
});

test('identifiant invalide : jamais de sujet', () => {
  assert.deepEqual(ctx('/documents/abc'), { route: '/documents' });
  assert.deepEqual(ctx('/courriers/controle/12a'), { route: '/courriers/controle' });
  assert.deepEqual(ctx('/espaces/-3'), { route: '/espaces' });
  assert.deepEqual(ctx('/documents/1234567890123456789'), { route: '/documents' }); // 19 chiffres
  assert.deepEqual(ctx('/documents/123456789012345678'), {
    route: '/documents',
    subjectType: 'document',
    subjectId: '123456789012345678',
  }); // 18 chiffres : accepté
});

test('query, hash et slash final retirés', () => {
  assert.deepEqual(ctx('/documents/12?tab=2#x'), { route: '/documents', subjectType: 'document', subjectId: '12' });
  assert.deepEqual(ctx('/documents/12/'), { route: '/documents', subjectType: 'document', subjectId: '12' });
  assert.deepEqual(ctx('/recherche?q=secret#top'), { route: '/recherche' });
  assert.deepEqual(ctx('/recherche/'), { route: '/recherche' });
  const r = ctx('/a?token=abc');
  assert.equal(JSON.stringify(r).includes('token'), false);
});

test('/login, vide, invalide -> null', () => {
  assert.equal(pageContextFromPath('/login'), null);
  assert.equal(pageContextFromPath('/login/'), null);
  assert.equal(pageContextFromPath('/login?next=/x'), null);
  assert.equal(pageContextFromPath(''), null);
  assert.equal(pageContextFromPath('   '), null);
  assert.equal(pageContextFromPath('documents/12'), null);
  assert.equal(pageContextFromPath('?x=1'), null);
});

test('route tronquée à 200 caractères', () => {
  const r = ctx('/' + 'a'.repeat(500));
  assert.equal(r?.route.length, 200);
});

test('describePageContext', () => {
  assert.equal(describePageContext(pageContextFromPath('/courriers/controle/4321')), 'courrier n° 4321');
  assert.equal(describePageContext(pageContextFromPath('/documents/12')), 'document n° 12');
  assert.equal(describePageContext(pageContextFromPath('/editeur/3')), 'document n° 3');
  assert.equal(describePageContext(pageContextFromPath('/espaces/5')), 'espace n° 5');
  assert.equal(describePageContext(pageContextFromPath('/recherche')), null);
  assert.equal(describePageContext(null), null);
});

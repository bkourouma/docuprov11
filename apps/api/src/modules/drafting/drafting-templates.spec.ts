import { GED_DRAFT_TEMPLATE_ID_REGEX } from '@archivage/types';
import { htmlToYDoc, sanitizeEditorHtml, validateYDocStructure } from '@archivage/editor/server';
import { DRAFT_TEMPLATES, type DraftTemplate, findDraftTemplate } from './drafting-templates';

// `sanitize-html` -> `htmlparser2` (ESM pur) n'est pas transformé par la configuration jest de l'API :
// on charge le VRAI module par le `require` natif de Node (>= 22), hors du registre de jest.
jest.mock('@archivage/editor/server', () => {
  const getBuiltin = (process as unknown as { getBuiltinModule?: (id: string) => unknown }).getBuiltinModule;
  if (typeof getBuiltin !== 'function') throw new Error('Node >= 22 requis pour ce test.');
  const nativeModule = getBuiltin('node:module') as typeof import('node:module');
  return nativeModule.createRequire(__filename)('@archivage/editor/server');
});

const normalize = (html: string): string => html.replace(/\s+/g, ' ').trim();

const CATEGORIES = ['Courrier', 'Réunion', 'Note', 'Rapport', 'Attestation', 'Général'];

describe('catalogue des modèles de rédaction', () => {
  it('contient exactement 8 modèles, le modèle vide en premier', () => {
    expect(DRAFT_TEMPLATES).toHaveLength(8);
    expect(DRAFT_TEMPLATES.map((t) => t.id)).toEqual([
      'vide',
      'courrier-officiel',
      'lettre-reponse',
      'compte-rendu-reunion',
      'proces-verbal',
      'note-de-service',
      'rapport-synthese',
      'attestation',
    ]);
  });

  it('a des identifiants uniques conformes à GED_DRAFT_TEMPLATE_ID_REGEX', () => {
    const ids = DRAFT_TEMPLATES.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) {
      expect(id).toMatch(GED_DRAFT_TEMPLATE_ID_REGEX);
    }
  });

  it("le modèle 'vide' est premier et a pour squelette exactement '<p></p>'", () => {
    expect(DRAFT_TEMPLATES[0]).toMatchObject({ id: 'vide', category: 'Général', skeletonHtml: '<p></p>' });
  });

  it('chaque modèle a un libellé, une description, une consigne et une catégorie connue, non vides', () => {
    for (const t of DRAFT_TEMPLATES) {
      expect(t.label.trim().length).toBeGreaterThan(0);
      expect(t.description.trim().length).toBeGreaterThan(0);
      expect(t.guidance.trim().length).toBeGreaterThan(0);
      expect(CATEGORIES).toContain(t.category);
    }
  });

  it('une consigne ne contient pas de HTML', () => {
    for (const t of DRAFT_TEMPLATES) {
      expect(t.guidance).not.toMatch(/[<>]/);
    }
  });

  it('chaque squelette reste petit (moins de 2000 caractères)', () => {
    for (const t of DRAFT_TEMPLATES) {
      expect(t.skeletonHtml.length).toBeLessThan(2000);
    }
  });

  it('chaque squelette est inchangé par sanitizeEditorHtml (après normalisation des espaces)', () => {
    for (const t of DRAFT_TEMPLATES) {
      expect({ id: t.id, html: normalize(sanitizeEditorHtml(t.skeletonHtml)) }).toEqual({
        id: t.id,
        html: normalize(t.skeletonHtml),
      });
    }
  });

  it('chaque squelette passe htmlToYDoc puis validateYDocStructure', () => {
    for (const t of DRAFT_TEMPLATES) {
      const doc = htmlToYDoc(t.skeletonHtml);
      try {
        expect({ id: t.id, result: validateYDocStructure(doc) }).toEqual({ id: t.id, result: { ok: true } });
      } finally {
        doc.destroy();
      }
    }
  });

  it('le catalogue et chaque entrée sont gelés', () => {
    expect(Object.isFrozen(DRAFT_TEMPLATES)).toBe(true);
    for (const t of DRAFT_TEMPLATES) {
      expect(Object.isFrozen(t)).toBe(true);
      expect(Reflect.set(t, 'label', 'modifié')).toBe(false);
    }
    expect(() => {
      (DRAFT_TEMPLATES as DraftTemplate[]).push({ ...DRAFT_TEMPLATES[0], id: 'intrus' });
    }).toThrow(TypeError);
    expect(DRAFT_TEMPLATES).toHaveLength(8);
  });
});

describe('findDraftTemplate', () => {
  it('renvoie le modèle correspondant à un identifiant connu', () => {
    expect(findDraftTemplate('attestation')?.label).toBe('Attestation');
  });

  it('renvoie undefined pour un identifiant inconnu', () => {
    expect(findDraftTemplate('inconnu')).toBeUndefined();
    expect(findDraftTemplate('')).toBeUndefined();
  });

  it("renvoie undefined pour 'constructor' et '__proto__'", () => {
    expect(findDraftTemplate('constructor')).toBeUndefined();
    expect(findDraftTemplate('__proto__')).toBeUndefined();
    expect(findDraftTemplate('toString')).toBeUndefined();
  });
});

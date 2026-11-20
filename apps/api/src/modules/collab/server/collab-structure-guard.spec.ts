import { COMMENTS_KEY, EDITOR_FRAGMENT } from '@archivage/editor';
import * as Y from 'yjs';
import {
  RoomStructureGuard,
  classifyUpdate,
  defaultStructureValidator,
  emptyStructureCounters,
  isIntegrated,
  type RoomStructureGuardOptions,
  type StructureValidator,
} from './collab-structure-guard';

// Validation RÉELLE du paquet éditeur, sans son point d'entrée HTML (ESM non transformé par jest).
jest.mock('@archivage/editor/server', () => jest.requireActual('./editor-structure.fake'));

// ------------------------------------------------------------------------------ utilitaires

/** Document « serveur » : un paragraphe de texte. */
function serverDoc(text = 'base'): { doc: Y.Doc; text: Y.XmlText; paragraph: Y.XmlElement } {
  const doc = new Y.Doc();
  const paragraph = new Y.XmlElement('paragraph');
  const xmlText = new Y.XmlText();
  doc.transact(() => {
    doc.getXmlFragment(EDITOR_FRAGMENT).insert(0, [paragraph]);
    paragraph.insert(0, [xmlText]);
    xmlText.insert(0, text);
  });
  return { doc, text: xmlText, paragraph };
}

/** Client synchronisé sur `server` ; renvoie le client et ses mises à jour suivantes. */
function clientOf(server: Y.Doc): { doc: Y.Doc; updates: Uint8Array[] } {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, Y.encodeStateAsUpdate(server));
  const updates: Uint8Array[] = [];
  doc.on('update', (u: Uint8Array) => updates.push(u));
  return { doc, updates };
}

function firstText(doc: Y.Doc): Y.XmlText {
  return (doc.getXmlFragment(EDITOR_FRAGMENT).get(0) as Y.XmlElement).get(0) as Y.XmlText;
}

function nest(doc: Y.Doc, parent: Y.XmlFragment | Y.XmlElement, depth: number): Y.XmlElement {
  let deepest!: Y.XmlElement;
  doc.transact(() => {
    let current: Y.XmlFragment | Y.XmlElement = parent;
    for (let i = 0; i < depth; i += 1) {
      const quote = new Y.XmlElement('blockquote');
      current.insert(current.length, [quote]);
      current = quote;
    }
    current.insert(0, [new Y.XmlElement('paragraph')]);
    deepest = current as Y.XmlElement;
  });
  return deepest;
}

const OPTIONS: RoomStructureGuardOptions = {
  maxDepth: 64,
  maxNodes: 100_000,
  burstMs: 1000,
  msPerSecond: 500,
  shadowIdleMs: 60_000,
  lockTimeoutMs: 5_000,
};

// =========================================================================================

describe('classifyUpdate : règle « structurelle »', () => {
  it('frappe de texte dans un paragraphe existant : neutre', () => {
    const { doc } = serverDoc();
    const c = clientOf(doc);
    firstText(c.doc).insert(4, ' et la suite');
    expect(classifyUpdate(c.updates[0], doc).structural).toBe(false);
  });

  it('frappe en plusieurs caractères fusionnés (origines internes à la mise à jour) : neutre', () => {
    const { doc } = serverDoc();
    const c = clientOf(doc);
    const t = firstText(c.doc);
    for (const ch of 'abc') t.insert(t.length, ch);
    t.insert(0, '>');
    const merged = Y.mergeUpdates(c.updates);
    expect(classifyUpdate(merged, doc).structural).toBe(false);
  });

  it('effacement de texte : neutre', () => {
    const { doc } = serverDoc('bonjour');
    const c = clientOf(doc);
    firstText(c.doc).delete(0, 3);
    expect(classifyUpdate(c.updates[0], doc).structural).toBe(false);
  });

  it('hors du fragment (commentaires, autre racine) : neutre', () => {
    const { doc } = serverDoc();
    const c = clientOf(doc);
    c.doc.transact(() => {
      const comment = new Y.Map<unknown>();
      c.doc.getMap(COMMENTS_KEY).set('c1', comment);
      comment.set('body', 'remarque');
    });
    c.doc.getText('autre').insert(0, 'libre');
    expect(classifyUpdate(c.updates[0], doc).structural).toBe(false);
    expect(classifyUpdate(c.updates[1], doc).structural).toBe(false);
  });

  it.each([
    ['nouveau paragraphe', (d: Y.Doc) => d.getXmlFragment(EDITOR_FRAGMENT).insert(1, [new Y.XmlElement('paragraph')])],
    ['Y.XmlText à la racine', (d: Y.Doc) => d.getXmlFragment(EDITOR_FRAGMENT).insert(0, [new Y.XmlText('x')])],
    ['attribut d’élément', (d: Y.Doc) => (d.getXmlFragment(EDITOR_FRAGMENT).get(0) as Y.XmlElement).setAttribute('level', '9')],
    ['marque (format)', (d: Y.Doc) => firstText(d).format(0, 2, { bold: true })],
    ['texte avec marque', (d: Y.Doc) => firstText(d).insert(0, 'x', { inconnue: true })],
    ['suppression d’un paragraphe', (d: Y.Doc) => d.getXmlFragment(EDITOR_FRAGMENT).delete(0, 1)],
    ['blockquote imbriqués', (d: Y.Doc) => nest(d, d.getXmlFragment(EDITOR_FRAGMENT), 3)],
  ])('%s : structurelle', (_label, change) => {
    const { doc } = serverDoc();
    const c = clientOf(doc);
    change(c.doc);
    expect(c.updates.length).toBeGreaterThan(0);
    const footprint = classifyUpdate(Y.mergeUpdates(c.updates), doc);
    expect(footprint.structural).toBe(true);
    expect(footprint.why).toEqual(expect.any(String));
  });

  it('texte brut forgé à la racine du fragment (parent déduit de l’origine) : structurel', () => {
    const { doc } = serverDoc();
    const forger = new Y.Doc();
    const root = forger.getText(EDITOR_FRAGMENT); // la racine vue comme un texte : insertion « à côté » du paragraphe
    Y.applyUpdate(forger, Y.encodeStateAsUpdate(doc));
    const updates: Uint8Array[] = [];
    forger.on('update', (u: Uint8Array) => updates.push(u));
    root.insert(root.length, 'nu');
    const decoded = Y.decodeUpdate(updates[0]);
    expect((decoded.structs[0] as Y.Item).parent).toBeNull(); // parent implicite
    expect(classifyUpdate(updates[0], doc).structural).toBe(true);
  });

  it('mise à jour illisible : structurelle (jamais de faux négatif)', () => {
    const { doc } = serverDoc();
    expect(classifyUpdate(new Uint8Array([1, 2, 3, 250]), doc).structural).toBe(true);
  });

  it('empreinte : structures et suppressions apportées, vérifiables après application', () => {
    const { doc } = serverDoc('abcdef');
    const c = clientOf(doc);
    c.doc.transact(() => {
      firstText(c.doc).delete(0, 2);
      firstText(c.doc).insert(0, 'Z');
    });
    const footprint = classifyUpdate(c.updates[0], doc);
    expect(footprint.ends.get(c.doc.clientID)).toBe(1);
    expect(footprint.deletes).toHaveLength(1);
    expect(isIntegrated(doc, footprint)).toBe(false);
    Y.applyUpdate(doc, c.updates[0]);
    expect(isIntegrated(doc, footprint)).toBe(true);
  });
});

describe('RoomStructureGuard', () => {
  function guardFor(
    live: Y.Doc,
    overrides: Partial<RoomStructureGuardOptions> = {},
    validator: StructureValidator = defaultStructureValidator,
    clock?: { now: () => number; sleep: (ms: number) => Promise<void> },
  ) {
    const counters = emptyStructureCounters();
    const guard = new RoomStructureGuard(
      live,
      { ...OPTIONS, ...overrides },
      counters,
      validator,
      clock?.now,
      clock?.sleep,
    );
    guard.attach();
    return { guard, counters };
  }

  it('valide sur la copie miroir : conforme admise, non conforme refusée sans toucher la salle', async () => {
    const { doc } = serverDoc();
    const { guard, counters } = guardFor(doc);
    const c = clientOf(doc);
    c.doc.getXmlFragment(EDITOR_FRAGMENT).insert(1, [new Y.XmlElement('paragraph')]);
    const ok = await guard.admit(c.updates[0], 'a', classifyUpdate(c.updates[0], doc), () => true);
    expect(ok).toEqual({ ok: true });
    Y.applyUpdate(doc, c.updates[0]);
    guard.settle('a');
    expect(guard.hasShadow()).toBe(true);

    c.doc.getXmlFragment(EDITOR_FRAGMENT).insert(0, [new Y.XmlText('poison')]);
    const bad = await guard.admit(c.updates[1], 'a', classifyUpdate(c.updates[1], doc), () => true);
    expect(bad).toEqual({ ok: false, invalid: true, reason: expect.any(String) });
    expect(guard.hasShadow()).toBe(false); // copie empoisonnée écartée
    expect(doc.getXmlFragment(EDITOR_FRAGMENT).length).toBe(2); // salle intacte
    expect(defaultStructureValidator(doc, OPTIONS).ok).toBe(true);
    expect(counters).toMatchObject({ updateChecks: 2, rejected: 1, shadowBuilds: 1 });

    // Copie reconstruite depuis la salle (saine) à la validation suivante.
    const d = clientOf(doc);
    d.doc.getXmlFragment(EDITOR_FRAGMENT).insert(2, [new Y.XmlElement('paragraph')]);
    expect(await guard.admit(d.updates[0], 'b', classifyUpdate(d.updates[0], doc), () => true)).toEqual({ ok: true });
    guard.settle('b');
    expect(counters.shadowBuilds).toBe(2);
    guard.dispose();
  });

  it('miroir : les mises à jour neutres de la salle suivent la copie (aucune reconstruction)', async () => {
    const { doc, text } = serverDoc();
    const { guard, counters } = guardFor(doc);
    const c = clientOf(doc);
    c.doc.getXmlFragment(EDITOR_FRAGMENT).insert(1, [new Y.XmlElement('paragraph')]);
    await guard.admit(c.updates[0], 'a', classifyUpdate(c.updates[0], doc), () => true);
    Y.applyUpdate(doc, c.updates[0]);
    guard.settle('a');
    text.insert(0, 'frappe '); // directement dans la salle : suivie par la copie
    const d = clientOf(doc);
    d.doc.getXmlFragment(EDITOR_FRAGMENT).insert(0, [new Y.XmlElement('paragraph')]);
    await guard.admit(d.updates[0], 'b', classifyUpdate(d.updates[0], doc), () => true);
    guard.settle('b');
    expect(counters.shadowBuilds).toBe(1);
    guard.dispose();
  });

  it('une seule validation à la fois par salle : la suivante attend l’application de la précédente', async () => {
    const { doc } = serverDoc();
    const { guard } = guardFor(doc);
    const a = clientOf(doc);
    const b = clientOf(doc);
    a.doc.getXmlFragment(EDITOR_FRAGMENT).insert(1, [new Y.XmlElement('paragraph')]);
    b.doc.getXmlFragment(EDITOR_FRAGMENT).insert(0, [new Y.XmlElement('heading')]);
    const order: string[] = [];
    const first = guard.admit(a.updates[0], 'a', classifyUpdate(a.updates[0], doc), () => true).then((r) => {
      order.push('a');
      return r;
    });
    const second = guard.admit(b.updates[0], 'b', classifyUpdate(b.updates[0], doc), () => true).then((r) => {
      order.push('b');
      return r;
    });
    expect(await first).toEqual({ ok: true });
    await new Promise((r) => setTimeout(r, 20));
    expect(order).toEqual(['a']); // b attend : a n'est pas encore appliquée
    Y.applyUpdate(doc, a.updates[0]);
    guard.settle('a');
    expect(await second).toEqual({ ok: true });
    expect(order).toEqual(['a', 'b']);
    guard.settle('b');
    guard.dispose();
  });

  it('mise à jour admise mais jamais appliquée (lecture seule entre-temps) : copie écartée', async () => {
    const { doc } = serverDoc();
    const { guard, counters } = guardFor(doc);
    const c = clientOf(doc);
    c.doc.getXmlFragment(EDITOR_FRAGMENT).insert(1, [new Y.XmlElement('paragraph')]);
    await guard.admit(c.updates[0], 'a', classifyUpdate(c.updates[0], doc), () => true);
    guard.settle('a'); // non appliquée à la salle
    expect(guard.hasShadow()).toBe(false);
    const d = clientOf(doc);
    d.doc.getXmlFragment(EDITOR_FRAGMENT).insert(0, [new Y.XmlElement('paragraph')]);
    await guard.admit(d.updates[0], 'b', classifyUpdate(d.updates[0], doc), () => true);
    guard.settle('b');
    expect(counters.shadowBuilds).toBe(2);
    guard.dispose();
  });

  it('budget de calcul par salle : au-delà, la validation suivante attend la recharge', async () => {
    const { doc } = serverDoc();
    let t = 0;
    const sleeps: number[] = [];
    const clock = {
      now: () => t,
      sleep: async (ms: number) => {
        sleeps.push(ms);
        t += ms;
      },
    };
    // Chaque validation « coûte » 300 ms ; rafale 500 ms, recharge 100 ms/s.
    const slow: StructureValidator = (d, limits) => {
      t += 300;
      return defaultStructureValidator(d, limits);
    };
    const { guard, counters } = guardFor(doc, { burstMs: 500, msPerSecond: 100 }, slow, clock);
    for (let i = 0; i < 3; i += 1) {
      const c = clientOf(doc);
      c.doc.getXmlFragment(EDITOR_FRAGMENT).insert(0, [new Y.XmlElement('paragraph')]);
      expect(await guard.admit(c.updates[0], i, classifyUpdate(c.updates[0], doc), () => true)).toEqual({ ok: true });
      Y.applyUpdate(doc, c.updates[0]);
      guard.settle(i);
    }
    expect(counters.updateChecks).toBe(3);
    // 500 - 300 (+30 rechargés pendant la 2e) - 300 = -70 ms => attente de (70 + 1) / (100 ms/s) avant la 3e.
    expect(sleeps).toEqual([710]);
    guard.dispose();
  });

  it('fermeture de la salle : les attentes se terminent sans validation', async () => {
    const { doc } = serverDoc();
    const { guard, counters } = guardFor(doc);
    const a = clientOf(doc);
    const b = clientOf(doc);
    a.doc.getXmlFragment(EDITOR_FRAGMENT).insert(1, [new Y.XmlElement('paragraph')]);
    b.doc.getXmlFragment(EDITOR_FRAGMENT).insert(0, [new Y.XmlElement('paragraph')]);
    await guard.admit(a.updates[0], 'a', classifyUpdate(a.updates[0], doc), () => true);
    const waiting = guard.admit(b.updates[0], 'b', classifyUpdate(b.updates[0], doc), () => true);
    guard.dispose();
    expect(await waiting).toEqual({ ok: false, invalid: false, reason: expect.any(String) });
    expect(counters.updateChecks).toBe(1);
    expect(await guard.admit(b.updates[0], 'b', classifyUpdate(b.updates[0], doc), () => true)).toMatchObject({
      ok: false,
      invalid: false,
    });
  });

  it('checkLive : aucune revalidation tant que la salle ne change pas', () => {
    const { doc, text } = serverDoc();
    const validator = jest.fn(defaultStructureValidator);
    const { guard, counters } = guardFor(doc, {}, validator);
    expect(guard.checkLive()).toEqual({ ok: true });
    expect(guard.checkLive()).toEqual({ ok: true });
    expect(validator).toHaveBeenCalledTimes(1);
    text.insert(0, 'x');
    expect(guard.checkLive()).toEqual({ ok: true });
    expect(counters.liveChecks).toBe(2);
    doc.getXmlFragment(EDITOR_FRAGMENT).insert(0, [new Y.XmlText('poison')]);
    expect(guard.checkLive().ok).toBe(false);
    expect(guard.checkLive().ok).toBe(false); // un verdict non conforme n'est jamais mis en cache
    expect(counters.liveChecks).toBe(4);
    guard.dispose();
  });

  it('copie libérée après inactivité', async () => {
    const { doc } = serverDoc();
    let t = 0;
    const { guard } = guardFor(doc, { shadowIdleMs: 1000 }, defaultStructureValidator, {
      now: () => t,
      sleep: async () => undefined,
    });
    const c = clientOf(doc);
    c.doc.getXmlFragment(EDITOR_FRAGMENT).insert(1, [new Y.XmlElement('paragraph')]);
    await guard.admit(c.updates[0], 'a', classifyUpdate(c.updates[0], doc), () => true);
    Y.applyUpdate(doc, c.updates[0]);
    guard.settle('a');
    t = 500;
    guard.releaseIfIdle();
    expect(guard.hasShadow()).toBe(true);
    t = 1500;
    guard.releaseIfIdle();
    expect(guard.hasShadow()).toBe(false);
    guard.dispose();
  });

  it('3000 blockquote imbriqués : refusés sans dépassement de pile', async () => {
    const { doc } = serverDoc();
    const { guard } = guardFor(doc);
    const c = clientOf(doc);
    nest(c.doc, c.doc.getXmlFragment(EDITOR_FRAGMENT), 3000);
    const footprint = classifyUpdate(c.updates[0], doc);
    expect(footprint.structural).toBe(true);
    const verdict = await guard.admit(c.updates[0], 'a', footprint, () => true);
    expect(verdict).toMatchObject({ ok: false, invalid: true });
    guard.dispose();
  });
});

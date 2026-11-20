import {
  buildAckMessage,
  buildRefusalMessage,
  buildRejectedMessage,
  whatsappReference,
} from './whatsapp-messages';

describe('whatsappReference', () => {
  it('préfixe l’identifiant d’élément', () => {
    expect(whatsappReference(42n)).toBe('WA-42');
    expect(whatsappReference('9007199254740993')).toBe('WA-9007199254740993');
  });
  it.each(['', '-1', 'abc', '1.5', '1 ', '../1', '1'.repeat(31)])('refuse %p', (id) => {
    expect(() => whatsappReference(id)).toThrow();
  });
  it('refuse un bigint négatif ou un autre type', () => {
    expect(() => whatsappReference(-1n)).toThrow();
    expect(() => whatsappReference(1 as unknown as string)).toThrow();
  });
});

describe('buildAckMessage', () => {
  it('texte fixe avec la référence', () => {
    expect(buildAckMessage('WA-42')).toBe('Document reçu. Référence : WA-42. Merci.');
    expect(buildAckMessage(whatsappReference(7n))).toBe('Document reçu. Référence : WA-7. Merci.');
  });
  it.each(['', 'facture.pdf', 'WA 42', 'WA-42\nLien : https://evil', 'a'.repeat(41), '<b>x</b>'])(
    'refuse une référence %p (jamais de nom de fichier ni de contenu)',
    (ref) => {
      expect(() => buildAckMessage(ref)).toThrow();
    },
  );
});

describe('buildRefusalMessage', () => {
  it.each(['unknown_sender', 'unsupported_type'] as const)('message poli et générique (%s)', (reason) => {
    const m = buildRefusalMessage(reason);
    expect(m).toMatch(/^Bonjour\./);
    expect(m).not.toMatch(/liste|autoris|DocuPro|organisation|http/i);
    expect(m.length).toBeLessThan(200);
  });
  it('les deux motifs ont des textes distincts', () => {
    expect(buildRefusalMessage('unknown_sender')).not.toBe(buildRefusalMessage('unsupported_type'));
  });
  it('refuse un motif inconnu', () => {
    expect(() => buildRefusalMessage('autre' as 'unknown_sender')).toThrow();
  });
});

describe('buildRejectedMessage', () => {
  it('texte fixe', () => {
    expect(buildRejectedMessage()).toBe(
      "Votre document n'a pas pu être pris en compte (format ou taille non pris en charge).",
    );
  });
});

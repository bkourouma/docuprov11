import { updateEmailTemplateSchema } from './email-template.dto';

/**
 * Corps de `PUT /parametres/email-template`. L'écran contrôle déjà l'e-mail et l'URL, mais l'API
 * reste la seule autorité : un appel direct ne doit pas pouvoir enregistrer ce que l'écran refuse.
 */
describe('updateEmailTemplateSchema', () => {
  const parse = (body: unknown) => updateEmailTemplateSchema.safeParse(body);

  describe('contactEmail', () => {
    it('accepte une adresse valide, espaces de bord retirés', () => {
      const r = parse({ contactEmail: '  contact@exemple.ci ' });
      expect(r.success && r.data.contactEmail).toBe('contact@exemple.ci');
    });

    it.each(['pas-un-email', 'contact@', '@exemple.ci', 'contact exemple.ci'])(
      'refuse « %s »',
      (v) => {
        const r = parse({ contactEmail: v });
        expect(r.success).toBe(false);
        if (!r.success) expect(r.error.issues[0].message).toBe('Adresse e-mail invalide');
      },
    );

    it('normalise la chaîne vide (ou blanche) en null : « efface ce champ »', () => {
      for (const v of ['', '   ', null]) {
        const r = parse({ contactEmail: v });
        expect(r.success && r.data.contactEmail).toBeNull();
      }
    });

    it('laisse le champ ABSENT absent (mise à jour partielle)', () => {
      const r = parse({ orgName: 'Groupe Exemple SA' });
      expect(r.success && 'contactEmail' in r.data).toBe(false);
    });

    it('refuse une adresse de plus de 200 caractères', () => {
      expect(parse({ contactEmail: `${'a'.repeat(195)}@exemple.ci` }).success).toBe(false);
    });
  });

  describe('websiteUrl', () => {
    it.each(['https://exemple.ci', 'http://exemple.ci/contact'])('accepte %s', (v) => {
      expect(parse({ websiteUrl: v }).success).toBe(true);
    });

    it.each(['exemple.ci', 'www.exemple.ci', '//exemple.ci', 'ftp://exemple.ci'])(
      'refuse une URL non absolue http(s) : %s',
      (v) => {
        expect(parse({ websiteUrl: v }).success).toBe(false);
      },
    );
  });

  it('ignore une clé inconnue au lieu de l’écrire', () => {
    const r = parse({ orgName: 'X', logoFileName: '../../etc/passwd' });
    expect(r.success && r.data).toEqual({ orgName: 'X' });
  });
});

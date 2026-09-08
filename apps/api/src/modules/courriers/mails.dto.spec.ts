import {
  createArriveeSchema,
  mailSearchSchema,
  paginationQuerySchema,
  validationDirectionSchema,
} from './mails.dto';
import { updateObjetSchema } from './mail-referentials.dto';

describe('Docu-Courriers DTO (Zod)', () => {
  describe('createArriveeSchema', () => {
    it('accepte un corps valide et coerce la date ISO en Date', () => {
      const r = createArriveeSchema.safeParse({
        title: 'Objet',
        date: '2026-07-15',
        destinataireRoleId: 3,
      });
      expect(r.success).toBe(true);
      if (r.success) expect(r.data.date).toBeInstanceOf(Date);
    });

    it('rejette un titre vide et un destinataire manquant', () => {
      expect(
        createArriveeSchema.safeParse({ title: '', date: '2026-07-15', destinataireRoleId: 3 })
          .success,
      ).toBe(false);
      expect(createArriveeSchema.safeParse({ title: 'X', date: '2026-07-15' }).success).toBe(false);
    });

    // §05 : le destinataire est une fonction, pas une personne — un acteur nommé n'est plus un
    // destinataire recevable, et le laisser passer silencieusement créerait un courrier sans rôle.
    it('rejette un destinataire donné comme acteur (ancien destinataireUserGroupId)', () => {
      expect(
        createArriveeSchema.safeParse({
          title: 'Objet',
          date: '2026-07-15',
          destinataireUserGroupId: 3,
        }).success,
      ).toBe(false);
    });
  });

  describe('validationDirectionSchema', () => {
    it('exige au moins un id', () => {
      expect(validationDirectionSchema.safeParse({ mailIds: [] }).success).toBe(false);
      expect(validationDirectionSchema.safeParse({ mailIds: [1, 2] }).success).toBe(true);
    });
  });

  describe('paginationQuerySchema', () => {
    it('coerce les chaînes de query en nombres', () => {
      const r = paginationQuerySchema.safeParse({ page: '2', pageSize: '50' });
      expect(r.success).toBe(true);
      if (r.success) expect(r.data).toEqual({ page: 2, pageSize: 50 });
    });
  });

  describe('mailSearchSchema', () => {
    it('accepte des critères partiels', () => {
      expect(mailSearchSchema.safeParse({ fullText: 'facture', mailType: 0 }).success).toBe(true);
    });
  });

  describe('updateObjetSchema', () => {
    it('rejette une mise à jour sans aucun champ', () => {
      expect(updateObjetSchema.safeParse({}).success).toBe(false);
      expect(updateObjetSchema.safeParse({ dureeSuiviExterne: 5 }).success).toBe(true);
    });
  });
});

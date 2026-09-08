import { MailStatus } from '@archivage/types';
import {
  statusTransition,
  statusTransitionWithDecharge,
  markTraite,
  markDecharge,
  markDepartRedige,
  archiveEffect,
} from './mail-status';

describe('mail-status (machine à états §03.1)', () => {
  const now = new Date('2026-07-15T10:00:00.000Z');
  const other = new Date('2026-01-01T00:00:00.000Z');

  describe('statusTransition (surcharge 2 args)', () => {
    it('stampe DateTraited au passage Traité, pas DateDecharge', () => {
      expect(statusTransition(MailStatus.Traite, now)).toEqual({
        status: MailStatus.Traite,
        dateTraited: now,
      });
    });

    it('stampe DateDecharge au passage Déchargé, pas DateTraited', () => {
      expect(statusTransition(MailStatus.Decharge, now)).toEqual({
        status: MailStatus.Decharge,
        dateDecharge: now,
      });
    });

    it('ne stampe aucune date pour Redaction / Rédigé', () => {
      expect(statusTransition(MailStatus.Redaction, now)).toEqual({ status: MailStatus.Redaction });
      expect(statusTransition(MailStatus.Redige, now)).toEqual({ status: MailStatus.Redige });
    });
  });

  describe('statusTransitionWithDecharge (surcharge 3 args, quirk §03.6-1)', () => {
    it('force TOUJOURS DateDecharge, même au passage Rédigé (Départ), sans DateTraited', () => {
      const patch = statusTransitionWithDecharge(MailStatus.Redige, other);
      expect(patch).toEqual({ status: MailStatus.Redige, dateDecharge: other });
      expect(patch.dateTraited).toBeUndefined();
    });
  });

  describe('transitions nommées', () => {
    it('markTraite → Traité + DateTraited', () => {
      expect(markTraite(now)).toEqual({ status: MailStatus.Traite, dateTraited: now });
    });

    it('markDecharge → Déchargé + DateDecharge', () => {
      expect(markDecharge(now)).toEqual({ status: MailStatus.Decharge, dateDecharge: now });
    });

    it('markDepartRedige → Rédigé + DateDecharge (date d’archivage du Départ)', () => {
      expect(markDepartRedige(now)).toEqual({ status: MailStatus.Redige, dateDecharge: now });
    });

    it('archiveEffect → DateTraited uniquement (statut inchangé)', () => {
      expect(archiveEffect(now)).toEqual({ dateTraited: now });
    });
  });
});

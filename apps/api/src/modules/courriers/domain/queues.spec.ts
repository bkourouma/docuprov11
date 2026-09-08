import { MailStatus, MailType } from '@archivage/types';
import {
  isVisibleInLists,
  isInControleQueue,
  isInValidationDirectionQueue,
  isInSuiviQueue,
  isInDepartQueue,
  type MailQueueView,
} from './queues';

const base: MailQueueView = {
  isDeleted: false,
  valider: false,
  validationDirection: false,
  dateTraited: null,
  mailType: MailType.Arrivee,
  status: MailStatus.Redaction,
  dateFollowUp: null,
  endDateFollowUp: null,
};
const v = (o: Partial<MailQueueView>): MailQueueView => ({ ...base, ...o });
const d = new Date('2026-07-15T00:00:00.000Z');

describe('queues (files de travail §03.2/§03.4)', () => {
  describe('Visibilité listes (§03.1)', () => {
    it('Arrivée en Redaction reste visible', () => {
      expect(
        isVisibleInLists(v({ mailType: MailType.Arrivee, status: MailStatus.Redaction })),
      ).toBe(true);
    });
    it('Départ en Redaction est masqué', () => {
      expect(isVisibleInLists(v({ mailType: MailType.Depart, status: MailStatus.Redaction }))).toBe(
        false,
      );
    });
    it('Départ hors Redaction est visible', () => {
      expect(isVisibleInLists(v({ mailType: MailType.Depart, status: MailStatus.Redige }))).toBe(
        true,
      );
    });
    it('un courrier supprimé n’est jamais visible', () => {
      expect(
        isVisibleInLists(
          v({ mailType: MailType.Arrivee, status: MailStatus.Redaction, isDeleted: true }),
        ),
      ).toBe(false);
    });
  });

  it('Contrôle : Valider==false, non supprimé', () => {
    expect(isInControleQueue(v({ valider: false }))).toBe(true);
    expect(isInControleQueue(v({ valider: true }))).toBe(false);
    expect(isInControleQueue(v({ valider: false, isDeleted: true }))).toBe(false);
  });

  it('Validation Direction : validé, non validé Direction, non traité', () => {
    expect(isInValidationDirectionQueue(v({ valider: true }))).toBe(true);
    expect(isInValidationDirectionQueue(v({ valider: true, validationDirection: true }))).toBe(
      false,
    );
    expect(isInValidationDirectionQueue(v({ valider: true, dateTraited: d }))).toBe(false);
    expect(isInValidationDirectionQueue(v({ valider: false }))).toBe(false);
  });

  it('Suivi : non traité (DateTraited == null)', () => {
    expect(isInSuiviQueue(v({ dateTraited: null }))).toBe(true);
    expect(isInSuiviQueue(v({ dateTraited: d }))).toBe(false);
  });

  describe('Courrier Départ', () => {
    it('Départ traité → dans la file', () => {
      expect(isInDepartQueue(v({ mailType: MailType.Depart, status: MailStatus.Traite }))).toBe(
        true,
      );
    });
    it('Départ en suivi ouvert (DateFollowUp!=null && EndDateFollowUp==null) → dans la file', () => {
      expect(
        isInDepartQueue(v({ mailType: MailType.Depart, dateFollowUp: d, endDateFollowUp: null })),
      ).toBe(true);
    });
    it('Départ suivi clôturé → hors file', () => {
      expect(
        isInDepartQueue(v({ mailType: MailType.Depart, dateFollowUp: d, endDateFollowUp: d })),
      ).toBe(false);
    });
    it('Arrivée → jamais dans la file Départ', () => {
      expect(isInDepartQueue(v({ mailType: MailType.Arrivee, status: MailStatus.Traite }))).toBe(
        false,
      );
    });
  });
});

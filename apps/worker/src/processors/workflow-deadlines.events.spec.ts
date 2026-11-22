// Docu-Flow W3 - émetteur d'événements : jamais d'exception, jamais de blocage, no-op sans initialisation.
import {
  documentDepositedPayload,
  emitWorkflowEvent,
  safeEmitDocumentDeposited,
  initWorkflowEventEmitter,
  workflowEventJobId,
  WF_EVENT_JOB_OPTIONS,
  type WfEventPayload,
} from './workflow-deadlines.events';

const EVENT: WfEventPayload = {
  type: 'deadline.reached',
  subjectType: 'mail',
  subjectId: '42',
  occurredAt: '2026-11-21T10:00:00.000Z',
  occurrenceKey: '2026-11-21',
  triggerId: 7,
  fields: { hoursOverdue: 2 },
};

const flush = () => new Promise((r) => setImmediate(r));

describe('émetteur d\'événements workflow', () => {
  afterEach(() => initWorkflowEventEmitter(null));

  it('non initialisé : ne fait rien et ne lève pas', () => {
    expect(() => emitWorkflowEvent(EVENT)).not.toThrow();
  });

  it('émet un job avec identifiant sans ":" et options de rétention', () => {
    const add = jest.fn().mockResolvedValue(undefined);
    initWorkflowEventEmitter({ add });
    emitWorkflowEvent(EVENT);
    expect(add).toHaveBeenCalledTimes(1);
    const [name, data, opts] = add.mock.calls[0]!;
    expect(name).toBe('wf-event');
    expect(data).toBe(EVENT);
    expect(opts.jobId).not.toContain(':');
    expect(opts.jobId).toBe('wfe_deadline.reached_mail_42_2026-11-21_t7');
    expect(opts).toMatchObject({
      attempts: 3,
      backoff: { type: 'exponential' },
      removeOnComplete: { age: 3600, count: 1000 },
      removeOnFail: { age: 86400 },
    });
    expect(WF_EVENT_JOB_OPTIONS.attempts).toBe(3);
  });

  it('remplace ":" y compris dans l\'occurrence', () => {
    expect(workflowEventJobId({ ...EVENT, occurrenceKey: 'a:b:c' })).not.toContain(':');
  });

  it('queue.add qui rejette : aucune exception, échec journalisé sans contenu', async () => {
    const add = jest.fn().mockRejectedValue(new Error('redis down'));
    const warn = jest.fn();
    initWorkflowEventEmitter({ add }, { warn });
    expect(() => emitWorkflowEvent(EVENT)).not.toThrow();
    await flush();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(warn.mock.calls[0])).not.toContain('redis down');
  });

  it('queue.add qui lève de façon synchrone : aucune exception', () => {
    const add = jest.fn(() => {
      throw new Error('boom');
    });
    initWorkflowEventEmitter({ add: add as never });
    expect(() => emitWorkflowEvent(EVENT)).not.toThrow();
  });

  it('un journal défaillant ne fait pas échouer non plus', async () => {
    const add = jest.fn().mockRejectedValue(new Error('x'));
    initWorkflowEventEmitter({ add }, {
      warn: () => {
        throw new Error('log cassé');
      },
    });
    expect(() => emitWorkflowEvent(EVENT)).not.toThrow();
    await flush();
  });

  it('ne bloque pas : retourne avant la résolution de la file', () => {
    let resolve!: () => void;
    const add = jest.fn(() => new Promise<void>((r) => (resolve = r)));
    initWorkflowEventEmitter({ add });
    expect(emitWorkflowEvent(EVENT)).toBeUndefined();
    resolve();
  });
});

describe('documentDepositedPayload', () => {
  it('champs du catalogue seulement, absents = null, jamais de texte libre', () => {
    const doc = { documentId: 5, dossierId: 3, label: 'Contrat confidentiel', overview: 'texte' } as never;
    const e = documentDepositedPayload(doc, { source: 'externe', pageCount: null }, new Date('2026-11-21T10:00:00Z'));
    expect(e).toMatchObject({ type: 'document.deposited', subjectType: 'document', subjectId: '5' });
    expect(e.fields).toEqual({
      documentTypeId: null,
      planId: null,
      locationId: null,
      dossierId: 3,
      confidentialiteId: null,
      batchId: null,
      createdBy: null,
      pageCount: null,
      source: 'externe',
    });
    expect(JSON.stringify(e)).not.toContain('Contrat');
  });
});

describe('safeEmitDocumentDeposited', () => {
  afterEach(() => initWorkflowEventEmitter(null));

  it("émet l'événement document.deposited", () => {
    const emit = jest.fn();
    safeEmitDocumentDeposited({ documentId: 5, documentTypeId: 2 }, { source: 'externe', pageCount: 3 }, emit);
    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit.mock.calls[0][0]).toMatchObject({ type: 'document.deposited', subjectId: '5' });
  });

  it('constructeur qui lève (document invalide) : aucune exception, journalisé', () => {
    const warn = jest.fn();
    initWorkflowEventEmitter(null, { warn });
    const emit = jest.fn();
    expect(() => safeEmitDocumentDeposited(null as never, { source: 'fusion' }, emit)).not.toThrow();
    expect(emit).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('émetteur qui lève : aucune exception, même si le journal lève aussi', () => {
    initWorkflowEventEmitter(null, {
      warn: () => {
        throw new Error('log');
      },
    });
    const emit = () => {
      throw new Error('file en panne');
    };
    expect(() => safeEmitDocumentDeposited({ documentId: 1 }, { source: 'acquisition' }, emit)).not.toThrow();
  });

  it('sans émetteur initialisé : ne fait rien', () => {
    expect(() => safeEmitDocumentDeposited({ documentId: 1 }, { source: 'acquisition' })).not.toThrow();
  });
});

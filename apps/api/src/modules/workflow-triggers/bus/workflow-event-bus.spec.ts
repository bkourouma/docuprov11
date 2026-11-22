import { Logger } from '@nestjs/common';
import { WF_EVENT_BUS_MAX_PENDING, type WfDomainEvent } from '../domain/contracts';
import { mailArrivedEvent } from '../domain/events';
import { WorkflowEventBus } from './workflow-event-bus';

const mailEvent = (mailId = 1): WfDomainEvent =>
  mailArrivedEvent({ mailId, mailType: 0, status: 1 }, { now: new Date('2026-11-21T10:00:00Z') });

describe('WorkflowEventBus', () => {
  let bus: WorkflowEventBus;

  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    bus = new WorkflowEventBus();
  });
  afterEach(() => jest.restoreAllMocks());

  it('accepte un événement valide et le remet aux écouteurs', async () => {
    const seen: WfDomainEvent[] = [];
    bus.subscribe((e) => {
      seen.push(e);
    });
    expect(bus.emit(mailEvent(7))).toBe(true);
    await bus.idle();
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ type: 'mail.arrived', subjectType: 'mail', subjectId: '7' });
  });

  it('ignore un événement invalide sans lever', async () => {
    const listener = jest.fn();
    bus.subscribe(listener);
    expect(bus.emit({ type: 'inconnu' })).toBe(false);
    expect(bus.emit(null)).toBe(false);
    expect(bus.emit({ ...mailEvent(), fields: { objet: 'texte libre' } })).toBe(false);
    await bus.idle();
    expect(listener).not.toHaveBeenCalled();
    expect(bus.pendingCount).toBe(0);
  });

  it('rejette sans lever quand la file est pleine', () => {
    for (let i = 0; i < WF_EVENT_BUS_MAX_PENDING; i += 1) expect(bus.emit(mailEvent(i + 1))).toBe(true);
    expect(bus.pendingCount).toBe(WF_EVENT_BUS_MAX_PENDING);
    expect(bus.emit(mailEvent(999_999))).toBe(false);
    expect(bus.pendingCount).toBe(WF_EVENT_BUS_MAX_PENDING);
  });

  it('ne bloque jamais : emit rend la main avant tout traitement', async () => {
    const listener = jest.fn();
    bus.subscribe(listener);
    bus.emit(mailEvent());
    expect(listener).not.toHaveBeenCalled();
    expect(bus.pendingCount).toBe(1);
    await bus.idle();
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('ignore un écouteur qui lève (synchrone ou asynchrone) et exécute les suivants', async () => {
    const calls: string[] = [];
    bus.subscribe(() => {
      calls.push('a');
      throw new Error('boom');
    });
    bus.subscribe(async () => {
      calls.push('b');
      throw new Error('boom async');
    });
    bus.subscribe(() => {
      calls.push('c');
    });
    bus.emit(mailEvent());
    await bus.idle();
    expect(calls).toEqual(['a', 'b', 'c']);
  });

  it('exécute les écouteurs séquentiellement, dans l\'ordre, événement par événement', async () => {
    const trace: string[] = [];
    const tick = () => new Promise<void>((r) => setTimeout(r, 5));
    bus.subscribe(async (e) => {
      trace.push(`1-début-${e.subjectId}`);
      await tick();
      trace.push(`1-fin-${e.subjectId}`);
    });
    bus.subscribe((e) => {
      trace.push(`2-${e.subjectId}`);
    });
    bus.emit(mailEvent(1));
    bus.emit(mailEvent(2));
    await bus.idle();
    expect(trace).toEqual(['1-début-1', '1-fin-1', '2-1', '1-début-2', '1-fin-2', '2-2']);
  });

  it('se désabonne : l\'écouteur retiré ne reçoit plus rien', async () => {
    const listener = jest.fn();
    const off = bus.subscribe(listener);
    bus.emit(mailEvent(1));
    await bus.idle();
    off();
    off(); // idempotent
    bus.emit(mailEvent(2));
    await bus.idle();
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('idle() attend le traitement complet, y compris des événements émis pendant le drainage', async () => {
    const seen: string[] = [];
    bus.subscribe(async (e) => {
      seen.push(e.subjectId);
      if (e.subjectId === '1') bus.emit(mailEvent(2));
      await new Promise<void>((r) => setTimeout(r, 2));
    });
    bus.emit(mailEvent(1));
    await bus.idle();
    expect(seen).toEqual(['1', '2']);
    expect(bus.pendingCount).toBe(0);
  });
});

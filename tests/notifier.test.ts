import { describe, expect, it } from 'vitest';
import { EventNotifier } from '../src/notifier.js';

describe('EventNotifier', () => {
  it('fires a registered resolver on notify for the same document', () => {
    const n = new EventNotifier();
    let fired = false;
    n.register('t1', () => {
      fired = true;
    });
    n.notify('t1');
    expect(fired).toBe(true);
  });

  it('does not fire a resolver for a different document', () => {
    const n = new EventNotifier();
    let fired = false;
    n.register('t1', () => {
      fired = true;
    });
    n.notify('t2');
    expect(fired).toBe(false);
  });

  it('fires all resolvers registered for a document', () => {
    const n = new EventNotifier();
    let count = 0;
    n.register('t1', () => {
      count++;
    });
    n.register('t1', () => {
      count++;
    });
    n.register('t1', () => {
      count++;
    });
    n.notify('t1');
    expect(count).toBe(3);
  });

  it('unsubscribe stops the resolver from firing', () => {
    const n = new EventNotifier();
    let fired = false;
    const unsub = n.register('t1', () => {
      fired = true;
    });
    unsub();
    n.notify('t1');
    expect(fired).toBe(false);
  });

  it('a resolver may unregister itself during notify without losing peer fires', () => {
    // This is the long-poll wake pattern: a wait handler wakes, drains, and self-unsubscribes
    // synchronously from inside its own resolver. Other concurrently-registered resolvers must
    // still fire in the same notify() call.
    const n = new EventNotifier();
    let fired1 = false;
    let fired2 = false;
    let unsub1: () => void = () => {};
    unsub1 = n.register('t1', () => {
      fired1 = true;
      unsub1();
    });
    n.register('t1', () => {
      fired2 = true;
    });
    n.notify('t1');
    expect(fired1).toBe(true);
    expect(fired2).toBe(true);
  });

  it('size() tracks total registrations across documents', () => {
    const n = new EventNotifier();
    expect(n.size()).toBe(0);
    const u1 = n.register('t1', () => {});
    const u2 = n.register('t2', () => {});
    const u3 = n.register('t2', () => {});
    expect(n.size()).toBe(3);
    u1();
    expect(n.size()).toBe(2);
    u2();
    u3();
    expect(n.size()).toBe(0);
  });

  it('a throwing resolver does not stop other resolvers', () => {
    const n = new EventNotifier();
    let fired2 = false;
    n.register('t1', () => {
      throw new Error('boom');
    });
    n.register('t1', () => {
      fired2 = true;
    });
    expect(() => n.notify('t1')).not.toThrow();
    expect(fired2).toBe(true);
  });

  it('notify is a no-op when no resolvers are registered for the document', () => {
    const n = new EventNotifier();
    expect(() => n.notify('never-seen')).not.toThrow();
  });

  it('repeated unsubscribe is idempotent', () => {
    const n = new EventNotifier();
    const u = n.register('t1', () => {});
    u();
    expect(() => u()).not.toThrow();
    expect(n.size()).toBe(0);
  });
});

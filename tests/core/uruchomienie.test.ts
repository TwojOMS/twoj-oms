import { afterEach, describe, it, expect, vi } from 'vitest';
import { createServer } from 'node:net';
import { otworzBaze } from '../../src/core/baza.ts';
import { uruchomAplikacje } from '../../src/core/uruchomienie.ts';
import { modulRdzen } from '../../src/moduly/rdzen/modul.ts';
import type { ModulOms } from '../../src/core/kontrakty.ts';

const env = { OMS_SPRZEDAWCA_NIP: '1234563218', OMS_RACHUNEK: '34109010140000000000000000' };
const sprzatanie: (() => Promise<void>)[] = [];
afterEach(async () => { for (const zamknij of sprzatanie.splice(0).reverse()) await zamknij(); vi.restoreAllMocks(); });

describe('cykl aplikacji', () => {
  it('uruchamia zegary po listen, zatrzymuje je i zamyka bazę, także przy drugim close', async () => {
    const db = otworzBaze(':memory:');
    const kolejnosc: string[] = [];
    const ustaw = setInterval;
    const uchwyty: ReturnType<typeof setInterval>[] = [];
    vi.spyOn(globalThis, 'setInterval').mockImplementation(((fn: () => void, ms: number) => {
      kolejnosc.push('zegar'); const uchwyt = ustaw(fn, ms); uchwyty.push(uchwyt); return uchwyt;
    }) as typeof setInterval);
    const modul: ModulOms = { nazwa: 'sonda', wersja: '1.0.0', wymaga: ['rdzen'], konfiguracja: () => ({}), migracje: [], uprawnienia: [], menu: [],
      zbuduj: () => ({
        trasy: (app) => { app.addHook('onListen', async () => { kolejnosc.push('listen'); }); },
        zegary: [{ nazwa: 'sonda', odstepMs: 60000, przebieg: async () => {} }],
      }) };
    const wynik = await uruchomAplikacje({ moduly: [modulRdzen as ModulOms, modul], env, db, host: '127.0.0.1', port: 0 });
    sprzatanie.push(wynik.zamknij);
    expect(kolejnosc).toEqual(['listen', 'zegar']);
    const wyczysc = vi.spyOn(globalThis, 'clearInterval');
    await wynik.zamknij(); await wynik.zamknij();
    expect(wyczysc.mock.calls).toEqual([[uchwyty[0]]]);
    expect(wynik.aplikacja.app.server.listening).toBe(false);
    expect(() => db.prepare('SELECT 1')).toThrow();
  });
  it('błąd konfiguracji zamyka bazę bez uruchamiania zegarów', async () => {
    const db = otworzBaze(':memory:');
    const ustaw = vi.spyOn(globalThis, 'setInterval');
    // PRZ-108.10: pusty NIP nie jest już błędem konfiguracji (można w panelu) — błąd daje NIP ze złą sumą kontrolną.
    await expect(uruchomAplikacje({ moduly: [modulRdzen as ModulOms], env: { OMS_SPRZEDAWCA_NIP: '1234563219' }, db, host: '127.0.0.1', port: 0 })).rejects.toThrow('OMS_SPRZEDAWCA_NIP');
    expect(ustaw).not.toHaveBeenCalled();
    expect(() => db.prepare('SELECT 1')).toThrow();
  });
  it('nieudane listen zamyka app i bazę bez startowania zegarów', async () => {
    const serwer = createServer();
    await new Promise<void>((r) => serwer.listen(0, '127.0.0.1', r));
    sprzatanie.push(() => new Promise<void>((r) => serwer.close(() => r())));
    const adres = serwer.address();
    if (!adres || typeof adres === 'string') throw new Error('Brak portu');
    const db = otworzBaze(':memory:'); let zamkniety = false;
    const ustaw = vi.spyOn(globalThis, 'setInterval');
    const modul: ModulOms = { nazwa: 'sonda', wersja: '1.0.0', wymaga: ['rdzen'], konfiguracja: () => ({}), migracje: [], uprawnienia: [], menu: [],
      zbuduj: () => ({
        trasy: (app) => { app.addHook('onClose', async () => { zamkniety = true; }); },
        zegary: [{ nazwa: 'sonda', odstepMs: 1000, przebieg: async () => {} }],
      }) };
    await expect(uruchomAplikacje({ moduly: [modulRdzen as ModulOms, modul], env, db, host: '127.0.0.1', port: adres.port })).rejects.toThrow('EADDRINUSE');
    expect(zamkniety).toBe(true);
    expect(ustaw).not.toHaveBeenCalled();
    expect(() => db.prepare('SELECT 1')).toThrow();
  });
  it('zakończenie czeka na trwający przebieg, który nadal może korzystać z bazy', async () => {
    const db = otworzBaze(':memory:');
    let zwolnij!: () => void; let wystartowal!: () => void;
    const start = new Promise<void>((r) => { wystartowal = r; });
    const blokada = new Promise<void>((r) => { zwolnij = r; });
    let wynikBazy: unknown;
    const modul: ModulOms = { nazwa: 'sonda', wersja: '1.0.0', wymaga: ['rdzen'], konfiguracja: () => ({}), migracje: [], uprawnienia: [], menu: [],
      zbuduj: () => ({ zegary: [{ nazwa: 'sonda', odstepMs: 10, przebieg: async () => {
        wystartowal(); await blokada; wynikBazy = db.prepare('SELECT 42 AS n').get();
      } }] }) };
    const wynik = await uruchomAplikacje({ moduly: [modulRdzen as ModulOms, modul], env, db, host: '127.0.0.1', port: 0 });
    sprzatanie.push(async () => { zwolnij(); await wynik.zamknij(); });
    await start;
    let zamkniety = false;
    const zamkniecie = wynik.zamknij().then(() => { zamkniety = true; });
    await new Promise((r) => setImmediate(r));
    expect(zamkniety).toBe(false);
    zwolnij(); await zamkniecie;
    expect(wynikBazy).toEqual({ n: 42 });
    expect(() => db.prepare('SELECT 1')).toThrow();
  });
  it('błąd onClose nie zamyka bazy przed przebiegiem zegara i zostaje przekazany wywołującemu', async () => {
    const db = otworzBaze(':memory:');
    const bladHooka = new Error('błąd zamknięcia sondy');
    let zwolnij!: () => void; let wystartowal!: () => void; let hookWykonany!: () => void;
    const start = new Promise<void>((r) => { wystartowal = r; });
    const blokada = new Promise<void>((r) => { zwolnij = r; });
    const hook = new Promise<void>((r) => { hookWykonany = r; });
    let wynikBazy: unknown;
    const logi: string[] = [];
    const modul: ModulOms = { nazwa: 'sonda', wersja: '1.0.0', wymaga: ['rdzen'], konfiguracja: () => ({}), migracje: [], uprawnienia: [], menu: [],
      zbuduj: () => ({
        trasy: (app) => { app.addHook('onClose', async () => { hookWykonany(); throw bladHooka; }); },
        zegary: [{ nazwa: 'sonda', odstepMs: 10, przebieg: async () => {
          wystartowal(); await blokada; wynikBazy = db.prepare('SELECT 42 AS n').get();
        } }],
      }) };
    const wynik = await uruchomAplikacje({ moduly: [modulRdzen as ModulOms, modul], env, db, host: '127.0.0.1', port: 0, log: (t) => logi.push(t) });
    sprzatanie.push(async () => { zwolnij(); await wynik.zamknij().catch(() => {}); });
    await start;
    let zakonczone = false;
    const zamkniecie = wynik.zamknij().then(
      () => { zakonczone = true; return undefined; },
      (e: unknown) => { zakonczone = true; return e; },
    );
    await hook;
    await new Promise((r) => setImmediate(r));
    expect(zakonczone).toBe(false);
    expect(db.prepare('SELECT 7 AS n').get()).toEqual({ n: 7 });
    zwolnij();
    expect(await zamkniecie).toBe(bladHooka);
    expect(wynikBazy).toEqual({ n: 42 });
    expect(logi).toEqual([]);
    expect(() => db.prepare('SELECT 1')).toThrow();
  });
});

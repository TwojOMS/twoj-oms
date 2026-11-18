// Jedna lista kont Allegro w module magazynu (dla ekranów ofert i pętli).
// Prawdziwe repozytorium kanałów na bazie w pamięci, klienci to atrapy (żadnego połączenia z Allegro).
import { describe, it, expect, vi, afterEach } from 'vitest';
import Fastify from 'fastify';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { modulRdzen } from '../../../src/moduly/rdzen/modul.ts';
import { migracjaKanalowSprzedazy } from '../../../src/moduly/kanaly/migracje/0001-kanaly-sprzedazy.ts';
import { migracjaDiagnostykiAllegro } from '../../../src/moduly/kanaly/migracje/0002-diagnostyka-allegro.ts';
import { migracjaTypuKanaluISklepow } from '../../../src/moduly/kanaly/migracje/0003-kanaly-typ-sklepy.ts';
import { migracjaOfertKanalow } from '../../../src/moduly/magazyn/migracje/0001-oferty-kanalow.ts';
import { migracjaOfertAllegro } from '../../../src/moduly/magazyn/migracje/0002-oferty-allegro.ts';
import { createRepozytoriumKanalow } from '../../../src/moduly/kanaly/repozytorium-kanalow.ts';
import { modulMagazyn } from '../../../src/moduly/magazyn/modul.ts';
import * as karta from '../../../src/moduly/magazyn/karta.js';
import * as lista from '../../../src/moduly/magazyn/lista.js';
import { szyfrTestowy } from '../../pomoc/sejf-testowy.ts';

vi.mock('../../../src/moduly/magazyn/karta.js', async (orig) => {
  const m = await orig<typeof import('../../../src/moduly/magazyn/karta.js')>();
  return {
    ...m,
    createKartaMagazynu: vi.fn(m.createKartaMagazynu),
    registerKartaMagazynu: vi.fn(m.registerKartaMagazynu),
  };
});
vi.mock('../../../src/moduly/magazyn/lista.js', async (orig) => {
  const m = await orig<typeof import('../../../src/moduly/magazyn/lista.js')>();
  return { ...m, registerListaMagazynu: vi.fn(m.registerListaMagazynu) };
});

const aktor = { id: 1, login: 'admin' };
const OFERTY = ['allegro:api:sale:offers:write', 'allegro:api:sale:settings:read'];
const jwt = (scope: string[]) =>
  ['e30', Buffer.from(JSON.stringify({ scope })).toString('base64url'), 'podpis'].join('.');

const bazy: { close: () => void }[] = [];
afterEach(() => {
  for (const db of bazy.splice(0)) db.close();
  vi.clearAllMocks();
});

function zbuduj({ repozytorium = true } = {}) {
  const db = openOmsDb(':memory:', {
    moduly: [
      modulRdzen,
      { nazwa: 'kanaly', migracje: [migracjaKanalowSprzedazy, migracjaDiagnostykiAllegro, migracjaTypuKanaluISklepow] },
      { nazwa: 'magazyn', migracje: [migracjaOfertKanalow, migracjaOfertAllegro] },
    ],
  } as any);
  bazy.push(db);
  const repo = createRepozytoriumKanalow({
    db,
    definicjeEnv: [{ klucz: 'allegro-polcien', typ: 'allegro', etykieta: 'Półcień (plik)' }] as any,
    konfiguracjaEnv: { 'allegro-polcien': { api: 'https://api.allegro.pl', od: '2026-10-01T00:00:00Z' } },
    teraz: () => new Date('2026-11-14T10:00:00Z'),
  });
  const tokeny = (kanal: string, scope: string[]) =>
    db
      .prepare(
        `INSERT INTO tokeny_kanalu (kanal, access_token, refresh_token, wygasa_at, refresh_wygasa_at, zaktualizowane_at)
    VALUES (?, ?, ?, '2026-11-14T11:00:00Z', '2027-01-01T00:00:00Z', '2026-11-14T10:00:00Z')`,
      )
      .run(
        kanal,
        szyfrTestowy(db, 'tokeny_kanalu', 'access_token', kanal, jwt(scope)),
        szyfrTestowy(db, 'tokeny_kanalu', 'refresh_token', kanal, 'REFRESH-ATRAPA'),
      );
  const panel = (nazwa: string, srodowisko: 'produkcja' | 'sandbox', zmiana: string) => {
    const w = repo.utworzSzkic({ nazwa, odUtc: '2026-10-31T23:00:00Z', srodowisko }, aktor);
    if (!w.ok) throw new Error(w.komunikat);
    db.prepare(`UPDATE kanaly_sprzedazy SET ${zmiana} WHERE klucz = ?`).run(w.dane.klucz);
    return w.dane.klucz;
  };
  tokeny('allegro-polcien', ['allegro:api:orders:read', ...OFERTY]);
  const zPanelu = panel('Półcień sandbox', 'sandbox', `autoryzacja = 'polaczone'`);
  tokeny(zPanelu, ['allegro:api:orders:read']);
  const rozlaczone = panel('Półcień stare', 'produkcja', `autoryzacja = 'odlaczone'`);
  const konflikt = panel('Półcień konflikt', 'produkcja', `autoryzacja = 'polaczone', zrodlo = 'env'`);
  // Atrapa „naiwnej” mapy klientów: ma klienta także dla konta rozłączonego i z konfliktem klucza.
  const klienci: Record<string, object> = Object.fromEntries(
    ['allegro-polcien', zPanelu, rozlaczone, konflikt, 'erli-polcien'].map((k) => [k, { atrapa: k }]),
  );
  const usluga = (modul: string, nazwa: string) => {
    if (modul === 'kanaly' && nazwa === 'config') return { definicje: [], sklepy: {}, kanaly: {} };
    if (modul === 'kanaly' && nazwa === 'klienciKanalow') return klienci;
    if (modul === 'kanaly' && nazwa === 'klienciSklepow') return {};
    if (modul === 'kanaly' && nazwa === 'repozytoriumKanalow' && repozytorium) return repo;
    if (modul === 'magazyn') return (z.uslugi as Record<string, unknown>)[nazwa];
    throw new Error(`Usługa „${modul}.${nazwa}” nie istnieje`);
  };
  const z = modulMagazyn.zbuduj({
    db,
    konfiguracja: modulMagazyn.konfiguracja({ OMS_KATALOG_ZDJEC: '/nieistniejacy/zdjecia-polcien' }),
    teraz: () => new Date('2026-11-14T10:00:00Z'),
    log: vi.fn(),
    usluga,
  } as any);
  z.trasy!(Fastify() as any);
  type Konto = { klucz: string; klient: unknown; tylkoOdczyt: () => boolean; zgoda: boolean; srodowisko: string };
  const kontaAllegro = (vi.mocked(karta.createKartaMagazynu).mock.calls[0][0] as any).kontaAllegro as () => Konto[];
  return { db, repo, klienci, kontaAllegro, zPanelu, rozlaczone, konflikt };
}

describe('konta Allegro w module magazynu', () => {
  it('konto z env i konto z panelu są na liście, ze zgodą i środowiskiem', () => {
    const { kontaAllegro, zPanelu } = zbuduj();
    const konta = kontaAllegro();
    expect(konta.map((k) => k.klucz).sort()).toEqual(['allegro-polcien', zPanelu].sort());
    const env = konta.find((k) => k.klucz === 'allegro-polcien')!,
      panel = konta.find((k) => k.klucz === zPanelu)!;
    expect({ zgoda: env.zgoda, srodowisko: env.srodowisko }).toEqual({ zgoda: true, srodowisko: 'produkcja' });
    expect({ zgoda: panel.zgoda, srodowisko: panel.srodowisko }).toEqual({ zgoda: false, srodowisko: 'sandbox' });
  });

  it('konto rozłączone albo z konfliktem klucza nie trafia na listę, mimo klienta w mapie', () => {
    const { kontaAllegro, rozlaczone, konflikt, repo } = zbuduj();
    expect(repo.konfliktKlucza(konflikt)).toBe(true);
    const klucze = kontaAllegro().map((k) => k.klucz);
    expect(klucze).not.toContain(rozlaczone);
    expect(klucze).not.toContain(konflikt);
    expect(klucze).not.toContain('erli-polcien');
  });

  it('klient to ten sam obiekt co w klienciKanalow', () => {
    const { kontaAllegro, klienci, zPanelu } = zbuduj();
    for (const k of kontaAllegro()) expect(k.klient).toBe(klienci[k.klucz]);
    expect(kontaAllegro().find((k) => k.klucz === zPanelu)!.klient).toBe(klienci[zPanelu]);
  });

  it('tylko odczyt czyta blokadę zapisów z repozytorium kanałów na żywo', () => {
    const { kontaAllegro, repo } = zbuduj();
    const konto = kontaAllegro().find((k) => k.klucz === 'allegro-polcien')!;
    expect(konto.tylkoOdczyt()).toBe(false);
    const spy = vi.spyOn(repo, 'zapisyZablokowane').mockReturnValue(true);
    expect(konto.tylkoOdczyt()).toBe(true);
    expect(spy).toHaveBeenCalledWith('allegro-polcien');
  });

  it('brak usługi repozytoriumKanalow → pusta lista bez wyjątku', () => {
    const { kontaAllegro } = zbuduj({ repozytorium: false });
    expect(() => kontaAllegro()).not.toThrow();
    expect(kontaAllegro()).toEqual([]);
  });

  it('ta sama lista trafia do opcji tras, createKartaMagazynu i registerKartaMagazynu', () => {
    const { kontaAllegro } = zbuduj();
    expect(typeof kontaAllegro).toBe('function');
    expect((vi.mocked(karta.registerKartaMagazynu).mock.calls[0][1] as any).kontaAllegro).toBe(kontaAllegro);
    expect((vi.mocked(lista.registerListaMagazynu).mock.calls[0][1] as any).kontaAllegro).toBe(kontaAllegro);
  });
});

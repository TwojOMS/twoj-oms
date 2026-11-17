// Zegar pętli ofert w module magazynu: tylko bieżące konta ERLI, klient z modułu kanałów,
// tryb tylko odczyt z repozytorium kanałów. Atrapa klienta (licznik wywołań), żadnego połączenia z ERLI.
import { describe, it, expect, vi } from 'vitest';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { modulRdzen } from '../../../src/moduly/rdzen/modul.ts';
import { migracjaKanalowSprzedazy } from '../../../src/moduly/kanaly/migracje/0001-kanaly-sprzedazy.ts';
import { migracjaDiagnostykiAllegro } from '../../../src/moduly/kanaly/migracje/0002-diagnostyka-allegro.ts';
import { migracjaTypuKanaluISklepow } from '../../../src/moduly/kanaly/migracje/0003-kanaly-typ-sklepy.ts';
import { migracjaOfertKanalow } from '../../../src/moduly/magazyn/migracje/0001-oferty-kanalow.ts';
import { migracjaOfertAllegro } from '../../../src/moduly/magazyn/migracje/0002-oferty-allegro.ts';
import { wstawOferte, zapiszUstawieniaOfertKonta, zmienOferte, ofertaPoId } from '../../../src/oms/db/oferty-kanalow.ts';
import { modulMagazyn } from '../../../src/moduly/magazyn/modul.ts';
import { ODSTEP_PETLI_OFERT_MS } from '../../../src/moduly/magazyn/services/petla-ofert.js';
import * as petlaAllegro from '../../../src/moduly/magazyn/services/petla-ofert-allegro.js';
import * as petlaWoo from '../../../src/moduly/magazyn/services/petla-stanow-woo.js';
import * as straznikStanow from '../../../src/moduly/magazyn/services/straznik-stanow.js';
import { przelaczStany } from '../../../src/oms/db/stany-magazynowe.js';
import { modulyDla } from '../../../src/moduly/lista.ts';
import { ENV_DEMO } from '../../../scripts/demo-dane.mjs';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { szyfrTestowy } from '../../pomoc/sejf-testowy.ts';

// Pętla Allegro bez zmian zachowania — tylko podglądamy, z czym moduł ją buduje.
vi.mock('../../../src/moduly/magazyn/services/petla-ofert-allegro.js', async orig => {
  const m = await orig<typeof import('../../../src/moduly/magazyn/services/petla-ofert-allegro.js')>();
  return { ...m, createPetlaOfertAllegro: vi.fn(m.createPetlaOfertAllegro) };
});
// Tak samo pętla stanów Woo i strażnik — prawdziwe zachowanie, podgląd argumentów.
vi.mock('../../../src/moduly/magazyn/services/petla-stanow-woo.js', async orig => {
  const m = await orig<typeof import('../../../src/moduly/magazyn/services/petla-stanow-woo.js')>();
  return { ...m, createPetlaStanowWoo: vi.fn(m.createPetlaStanowWoo) };
});
vi.mock('../../../src/moduly/magazyn/services/straznik-stanow.js', async orig => {
  const m = await orig<typeof import('../../../src/moduly/magazyn/services/straznik-stanow.js')>();
  return { ...m, createStraznikStanow: vi.fn(m.createStraznikStanow) };
});

const SHA = 'a1'.repeat(32);

// D44 + E3.17: dziewięć metod klienta konta, które pętla Allegro dostaje wprost (`konto.allegro`).
const WEZLY_D44 = ['wgrajZdjecie', 'stanOperacji', 'szukajProduktow', 'ofertyPoSygnaturze', 'komendaIlosci', 'komendaCeny',
  'wynikKomendy', 'oplatyOferty', 'podgladOplat'];
const jwt = (scope: string[]) => ['e30', Buffer.from(JSON.stringify({ scope })).toString('base64url'), 'podpis'].join('.');
type OpcjeAllegro = { zgoda?: boolean; listaRzuca?: boolean };

function zbuduj({ repozytorium = true, zablokowane = false, env = {} as Record<string, string>, zdjecieLokalne = false,
  allegro: opcjeAllegro = null as OpcjeAllegro | null, woo = null as Record<string, unknown> | null, pelnaBaza = false } = {}) {
  // `pelnaBaza` — wszystkie moduły (zamówienia, stany), żeby pętla Woo przy włączonych stanach doszła do sklepu.
  const db = openOmsDb(':memory:', { moduly: pelnaBaza ? modulyDla(ENV_DEMO) : [modulRdzen,
    { nazwa: 'kanaly', migracje: [migracjaKanalowSprzedazy, migracjaDiagnostykiAllegro, migracjaTypuKanaluISklepow] },
    { nazwa: 'magazyn', migracje: opcjeAllegro ? [migracjaOfertKanalow, migracjaOfertAllegro] : [migracjaOfertKanalow] }] } as any);
  const erli = { szukajProduktow: vi.fn(async () => []), utworzProdukt: vi.fn(), zmienProdukt: vi.fn(), zmienProdukty: vi.fn(), pobierzProdukt: vi.fn() };
  const usuniete = { szukajProduktow: vi.fn(async () => []) };
  // Atrapa klienta Allegro: każda metoda liczy wywołania i nic nie wysyła (żadnego allegro.pl).
  const allegro: Record<string, ReturnType<typeof vi.fn>> = Object.fromEntries([...WEZLY_D44, 'ofertyKonta', 'utworzOferte',
    'edytujOferte', 'pobierzOferte'].map(n => [n, vi.fn(async () => ({}))]));
  const klienci: Record<string, unknown> = { 'erli-polcien': erli, 'erli-usuniete': usuniete, 'allegro-polcien': opcjeAllegro ? allegro : {} };
  const repo = { listaTypu: (t: string) => {
      if (t === 'erli') return [{ klucz: 'erli-polcien' }];
      if (!opcjeAllegro) return [];
      if (opcjeAllegro.listaRzuca) throw new Error('lista kont Allegro niedostępna');
      return [{ klucz: 'allegro-polcien', zrodlo: 'env', autoryzacja: 'brak', srodowisko: 'produkcja' }];
    },
    zapisyZablokowane: vi.fn(() => zablokowane), konfliktKlucza: vi.fn(() => false), zwolnijOperacje: vi.fn(() => 1) };
  if (opcjeAllegro) {
    db.prepare(`INSERT INTO tokeny_kanalu (kanal, access_token, refresh_token, wygasa_at, refresh_wygasa_at, zaktualizowane_at)
      VALUES ('allegro-polcien', ?, ?, '2026-11-14T11:00:00Z', '2027-01-01T00:00:00Z', '2026-11-14T10:00:00Z')`)
      .run(szyfrTestowy(db, 'tokeny_kanalu', 'access_token', 'allegro-polcien',
        jwt(['allegro:api:orders:read', ...(opcjeAllegro.zgoda === false ? [] : ['allegro:api:sale:offers:write', 'allegro:api:sale:settings:read'])])),
      szyfrTestowy(db, 'tokeny_kanalu', 'refresh_token', 'allegro-polcien', 'REFRESH-ATRAPA'));
  }
  const log = vi.fn();
  for (const [id, sku] of [[1, 'LMP-01'], [2, 'LMP-02']] as const) {
    db.prepare(`INSERT INTO karty_produktow (id, sku, nazwa, utworzony_at, zmieniony_at) VALUES (?, ?, ?, ?, ?)`)
      .run(id, sku, `Lampa Półcień ${sku}`, '2026-11-01T00:00:00.000Z', '2026-11-01T00:00:00.000Z');
    db.prepare(`UPDATE karty_produktow SET cena_gr = 10000, stawka_vat = '23' WHERE id = ?`).run(id);
    if (zdjecieLokalne) db.prepare(`INSERT INTO zdjecia_kart (karta_id, kolejnosc, zrodlo, plik, sha256, typ, rozmiar, utworzono_at)
      VALUES (?, 0, 'oms', ?, ?, 'image/webp', 2048, ?)`).run(id, `${SHA}.webp`, SHA, '2026-11-01T00:00:00.000Z');
    else db.prepare(`INSERT INTO zdjecia_kart (karta_id, kolejnosc, zrodlo, adres_zrodlowy, utworzono_at) VALUES (?, 0, 'woo', ?, ?)`)
      .run(id, `https://polcien.example/z/${sku}.png`, '2026-11-01T00:00:00.000Z');
  }
  const usluga = (modul: string, nazwa: string) => {
    // `woo` — sklep Woo z klientem-atrapą i drugi sklep w konfiguracji bez klienta (nie wchodzi do pętli).
    if (modul === 'kanaly' && nazwa === 'config') return { definicje: [], sklepy: woo ? { 'woo-polcien': {}, 'woo-bez-klienta': {} } : {}, kanaly: {} };
    if (modul === 'kanaly' && nazwa === 'klienciKanalow') return klienci;
    if (modul === 'kanaly' && nazwa === 'klienciSklepow') return woo ? { 'woo-polcien': woo } : {};
    if (modul === 'kanaly' && nazwa === 'repozytoriumKanalow' && repozytorium) return repo;
    throw new Error(`Usługa „${modul}.${nazwa}” nie istnieje`);
  };
  const z = modulMagazyn.zbuduj({ db, konfiguracja: modulMagazyn.konfiguracja({ OMS_KATALOG_ZDJEC: '/nieistniejacy/zdjecia-polcien', ...env }), teraz: () => new Date('2026-11-13T10:00:00Z'), log, usluga } as any);
  return { db, z, erli, usuniete, repo, log, allegro };
}

describe('zegar pętli ofert w module magazynu', () => {
  it('zegar petlaOfert co 5 minut czyta tylko bieżące konta ERLI', async () => {
    const { db, z, erli, usuniete } = zbuduj();
    wstawOferte(db, { kartaId: 1, kanal: 'erli-polcien', idZewnetrzne: 'pc7k2q-K1', pochodzenie: 'przejeta', stan: 'aktywna' });
    wstawOferte(db, { kartaId: 2, kanal: 'erli-usuniete', idZewnetrzne: 'pc7k2q-K2', pochodzenie: 'przejeta', stan: 'aktywna' });
    const zegar = z.zegary?.find(x => x.nazwa === 'petlaOfert');
    expect(zegar?.odstepMs).toBe(ODSTEP_PETLI_OFERT_MS);
    await zegar!.przebieg();
    expect(erli.szukajProduktow).toHaveBeenCalledTimes(1);
    expect(usuniete.szukajProduktow).not.toHaveBeenCalled();
    db.close();
  });

  it.each([[false, 1], [true, 0]])('blokada zapisów z repozytorium kanałów = %s → POST %i razy', async (zablokowane, posty) => {
    const { db, z, erli, repo } = zbuduj({ zablokowane });
    zapiszUstawieniaOfertKonta(db, 'erli-polcien', { czynne: true, narzutProcent: 0, progPotwierdzeniaProcent: 20, stalaIlosc: 5,
      czasWysylkiDni: 2, cennikDostaw: 'Cennik Półcień', stawkaVat: '23' });
    wstawOferte(db, { kartaId: 1, kanal: 'erli-polcien', idZewnetrzne: 'pc7k2q-K1', stan: 'do_wyslania' });
    await z.zegary!.find(x => x.nazwa === 'petlaOfert')!.przebieg();
    expect(repo.zapisyZablokowane).toHaveBeenCalledWith('erli-polcien');
    expect(erli.utworzProdukt).toHaveBeenCalledTimes(posty);
    db.close();
  });

  it('adres publiczny zdjęć z env trafia do pętli: zdjęcie tylko w OMS-ie → URL /z/<sha>.<ext>', async () => {
    const ustaw = (db: any) => { zapiszUstawieniaOfertKonta(db, 'erli-polcien', { czynne: true, narzutProcent: 0, progPotwierdzeniaProcent: 20,
      stalaIlosc: 5, czasWysylkiDni: 2, cennikDostaw: 'Cennik Półcień', stawkaVat: '23' });
      wstawOferte(db, { kartaId: 1, kanal: 'erli-polcien', idZewnetrzne: 'pc7k2q-K1', stan: 'do_wyslania' }); };
    const z1 = zbuduj({ zdjecieLokalne: true, env: { OMS_PUBLICZNY_ADRES_ZDJEC: 'https://zdjecia.polcien.example/' } });
    ustaw(z1.db);
    await z1.z.zegary!.find(x => x.nazwa === 'petlaOfert')!.przebieg();
    expect(z1.erli.utworzProdukt).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(z1.erli.utworzProdukt.mock.calls[0])).toContain(`"url":"https://zdjecia.polcien.example/z/${SHA}.webp"`);
    z1.db.close();
    // Bez zmiennej: zdjęcie tylko w OMS-ie blokuje wysyłkę (komunikat o OMS_PUBLICZNY_ADRES_ZDJEC), bez POST.
    const z2 = zbuduj({ zdjecieLokalne: true });
    ustaw(z2.db);
    await z2.z.zegary!.find(x => x.nazwa === 'petlaOfert')!.przebieg();
    expect(z2.erli.utworzProdukt).not.toHaveBeenCalled();
    z2.db.close();
  });

  it('bez repozytorium kanałów (moduł bez kanałów ERLI) zegar nie robi nic i nie rzuca', async () => {
    const { db, z, erli } = zbuduj({ repozytorium: false });
    wstawOferte(db, { kartaId: 1, kanal: 'erli-polcien', idZewnetrzne: 'pc7k2q-K1', pochodzenie: 'przejeta', stan: 'aktywna' });
    await expect(z.zegary!.find(x => x.nazwa === 'petlaOfert')!.przebieg()).resolves.toBeUndefined();
    expect(erli.szukajProduktow).not.toHaveBeenCalled();
    db.close();
  });
});

// Zegar pętli ofert Allegro: osobny od ERLI, konto z katalogiem i węzłami D44 z klienta modułu kanałów.
describe('zegar pętli ofert Allegro', () => {
  const opcjePetli = () => vi.mocked(petlaAllegro.createPetlaOfertAllegro).mock.calls.at(-1)![0] as any;
  const zegarAllegro = (z: any) => z.zegary!.find((x: any) => x.nazwa === 'petlaOfertAllegro')!;
  /** Szkic na Allegro czekający na „Aktywuj” — najkrótsza droga do zapisu (PATCH) w przebiegu konta. */
  const szkicDoAktywacji = (db: any) => {
    zapiszUstawieniaOfertKonta(db, 'allegro-polcien', { czynne: true, aktywujPoSprawdzeniu: true });
    const o = wstawOferte(db, { kartaId: 1, kanal: 'allegro-polcien', idZewnetrzne: '7700000001', pochodzenie: 'oms', tryb: 'zarzadzana', stan: 'nieaktywna' });
    zmienOferte(db, o.id, { wyslanePola: { szkic: true, aktywuj: true } });
    return o.id;
  };

  it('zegar petlaOfertAllegro zarejestrowany raz, co 5 minut, obok petlaOfert (ERLI)', () => {
    const { db, z } = zbuduj({ allegro: {} });
    expect(z.zegary!.filter(x => x.nazwa === 'petlaOfertAllegro')).toHaveLength(1);
    expect(z.zegary!.filter(x => x.nazwa === 'petlaOfert')).toHaveLength(1);
    expect(zegarAllegro(z).odstepMs).toBe(ODSTEP_PETLI_OFERT_MS);
    db.close();
  });

  it('konto ma katalog (5 metod) i allegro (9 metod z podgladOplat) na kliencie z modułu kanałów', async () => {
    const { db, allegro } = zbuduj({ allegro: {} });
    const konta = opcjePetli().konta();
    expect(konta.map((k: any) => k.klucz)).toEqual(['allegro-polcien']);
    const [k] = konta;
    expect(k.zgoda).toBe(true);
    expect(Object.keys(k.allegro).sort()).toEqual([...WEZLY_D44].sort());
    expect(Object.keys(k.katalog)).toEqual(expect.arrayContaining(['odczytOfert', 'wystawOferte', 'zmienOferte', 'zmienIloscCene', 'stanOferty']));
    await k.allegro.oplatyOferty('7700000001');
    expect(allegro.oplatyOferty).toHaveBeenCalledWith('7700000001');
    await k.katalog.stanOferty('7700000001');
    expect(allegro.pobierzOferte).toHaveBeenCalledWith('7700000001');
    db.close();
  });

  it('zwolnijOperacje idzie do repozytorium kanałów', () => {
    const { db, repo } = zbuduj({ allegro: {} });
    opcjePetli().zwolnijOperacje('allegro-polcien', 'PATCH', '/sale/product-offers/7700000001');
    expect(repo.zwolnijOperacje).toHaveBeenCalledWith('allegro-polcien', 'PATCH', '/sale/product-offers/7700000001');
    db.close();
  });

  it('czytajZdjecie: plik z magazynu OMS binarnie; bez pliku — tylko bezpieczny pobieracz (bez adresów prywatnych)', async () => {
    const katalog = mkdtempSync(join(tmpdir(), 'zdjecia-polcien-'));
    try {
      const bajty = Buffer.from('RIFF-atrapa-zdjecia-lampy');
      writeFileSync(join(katalog, `${SHA}.webp`), bajty);
      const { db } = zbuduj({ allegro: {}, env: { OMS_KATALOG_ZDJEC: katalog } });
      const czytaj = opcjePetli().czytajZdjecie;
      const odczyt = czytaj({ id: 1, kolejnosc: 0, sha256: SHA, typ: 'image/webp', adres_zrodlowy: null });
      await expect(odczyt).resolves.toBeInstanceOf(Uint8Array);
      const wynik = await odczyt;
      expect(Buffer.from(wynik).equals(bajty)).toBe(true);
      await expect(czytaj({ id: 2, kolejnosc: 1, sha256: null, typ: null, adres_zrodlowy: 'https://127.0.0.1/z/lampa.png' }))
        .rejects.toThrow('Niedozwolony adres sieciowy zdjęcia.');
      await expect(czytaj({ id: 3, kolejnosc: 2, sha256: 'b2'.repeat(32), typ: 'image/png', adres_zrodlowy: null })).rejects.toThrow();
      db.close();
    } finally { rmSync(katalog, { recursive: true, force: true }); }
  });

  it('przebieg zegara aktywuje szkic przez klienta konta (PATCH) i zwalnia operację', async () => {
    const { db, z, allegro, repo } = zbuduj({ allegro: {} });
    const id = szkicDoAktywacji(db);
    await zegarAllegro(z).przebieg();
    expect(allegro.edytujOferte).toHaveBeenCalledWith('7700000001', { publication: { status: 'ACTIVE' } });
    expect(repo.zwolnijOperacje).toHaveBeenCalledWith('allegro-polcien', 'PATCH', '/sale/product-offers/7700000001');
    expect(ofertaPoId(db, id)!.stan).toBe('sprawdzana');
    db.close();
  });

  it('konto bez zgody na oferty → przebieg nie woła klienta Allegro ani razu', async () => {
    const { db, z, allegro } = zbuduj({ allegro: { zgoda: false } });
    szkicDoAktywacji(db);
    await zegarAllegro(z).przebieg();
    for (const f of Object.values(allegro)) expect(f).not.toHaveBeenCalled();
    db.close();
  });

  it('błąd przebiegu Allegro trafia do logu i nie zatrzymuje zegara ERLI', async () => {
    const { db, z, erli, log } = zbuduj({ allegro: { listaRzuca: true } });
    wstawOferte(db, { kartaId: 1, kanal: 'erli-polcien', idZewnetrzne: 'pc7k2q-K1', pochodzenie: 'przejeta', stan: 'aktywna' });
    await expect(zegarAllegro(z).przebieg()).resolves.toBeUndefined();
    expect(log).toHaveBeenCalledWith('oferty-allegro: przebieg: lista kont Allegro niedostępna');
    await z.zegary!.find(x => x.nazwa === 'petlaOfert')!.przebieg();
    expect(erli.szukajProduktow).toHaveBeenCalledTimes(1);
    db.close();
  });

  it('dwa przebiegi naraz → drugi pominięty, jeden PATCH (wToku)', async () => {
    const { db, z, allegro } = zbuduj({ allegro: {} });
    szkicDoAktywacji(db);
    const czekajace: ((v: unknown) => void)[] = [];
    allegro.edytujOferte.mockImplementation(() => new Promise(r => { czekajace.push(r); }));
    const p1 = zegarAllegro(z).przebieg();
    const p2 = zegarAllegro(z).przebieg();
    await new Promise(r => setTimeout(r, 20));
    expect(allegro.edytujOferte).toHaveBeenCalledTimes(1);
    for (const r of czekajace) r({});
    await Promise.all([p1, p2]);
    db.close();
  });
});

describe('zegary pętli stanów Woo i strażnika stanów', () => {
  const opcjeWoo = () => vi.mocked(petlaWoo.createPetlaStanowWoo).mock.calls.at(-1)![0] as any;
  const opcjeStraznika = () => vi.mocked(straznikStanow.createStraznikStanow).mock.calls.at(-1)![0] as any;
  const zegar = (z: any, nazwa: string) => z.zegary!.find((x: any) => x.nazwa === nazwa)!;
  /** Atrapa klienta Woo: każda metoda liczy wywołania i nic nie wysyła (żadnego sklepu). */
  const atrapaWoo = () => Object.fromEntries(['pobierzStany', 'pobierzStanyWariantow', 'zapiszStanyHurtem']
    .map(n => [n, vi.fn(async () => [])])) as Record<string, ReturnType<typeof vi.fn>>;

  it('zegar petlaStanowWoo co 5 minut i straznikStanow co 30 s — każdy zarejestrowany raz', () => {
    const { db, z } = zbuduj({ allegro: {}, woo: atrapaWoo() });
    expect(z.zegary!.filter(x => x.nazwa === 'petlaStanowWoo')).toHaveLength(1);
    expect(z.zegary!.filter(x => x.nazwa === 'straznikStanow')).toHaveLength(1);
    expect(zegar(z, 'petlaStanowWoo').odstepMs).toBe(ODSTEP_PETLI_OFERT_MS);
    expect(zegar(z, 'straznikStanow').odstepMs).toBe(30_000);
    db.close();
  });

  it('kontaWoo: sklepy z konfiguracji z klientem z modułu kanałów (ta sama instancja); sklep bez klienta pominięty', () => {
    const woo = atrapaWoo();
    const { db } = zbuduj({ woo });
    const konta = opcjeWoo().konta();
    expect(konta.map((k: any) => k.klucz)).toEqual(['woo-polcien']);
    expect(konta[0].klient).toBe(woo);
    expect(opcjeWoo().pollerMs).toBeGreaterThanOrEqual(120_000);
    db.close();
  });

  it('strażnik dostaje trzy pętle: ERLI, Allegro i Woo (ta sama instancja co zegar Woo)', () => {
    const { db } = zbuduj({ allegro: {}, woo: atrapaWoo() });
    const petle = opcjeStraznika().petle;
    expect(Object.keys(petle).sort()).toEqual(['allegro', 'erli', 'woo']);
    for (const p of Object.values(petle) as any[]) expect(typeof p.przyspiesz).toBe('function');
    expect(petle.woo).toBe(vi.mocked(petlaWoo.createPetlaStanowWoo).mock.results.at(-1)!.value);
    db.close();
  });

  // B1: oferta Woo objęta pętlą (ilość z OMS, konto czynne) — kontrola odwrotna dowodzi, że 0 przy wyłączonych to D14,
  // a nie brak czegokolwiek do odczytu.
  it.each([[true, 'woła klienta Woo'], [false, 'nie woła klienta Woo ani razu (D14)']])(
    'stany włączone = %s: przebiegi zegarów Woo i strażnika %s', async (wlaczone, _opis) => {
      const woo = atrapaWoo();
      const { db, z } = zbuduj({ woo, pelnaBaza: true });
      zapiszUstawieniaOfertKonta(db, 'woo-polcien', { czynne: true });
      const o = wstawOferte(db, { kartaId: 1, kanal: 'woo-polcien', idZewnetrzne: '501', stan: 'aktywna', tryb: 'obserwowana' });
      zmienOferte(db, o.id, { iloscZOms: true }, { teraz: '2026-11-13T09:30:00.000Z' });
      if (wlaczone) przelaczStany(db, { wlacz: true, at: '2026-11-13T09:00:00.000Z' });
      await zegar(z, 'petlaStanowWoo').przebieg();
      await zegar(z, 'straznikStanow').przebieg();
      const wywolania = Object.values(woo).reduce((suma, f) => suma + f.mock.calls.length, 0);
      if (wlaczone) expect(woo.pobierzStany).toHaveBeenCalledWith(['501']);
      else expect(wywolania).toBe(0);
      db.close();
    });

  it('błąd przebiegu Woo trafia do logu i nie zatrzymuje zegara ERLI', async () => {
    vi.mocked(petlaWoo.createPetlaStanowWoo).mockImplementationOnce(() => ({
      przebieg: async () => { throw new Error('sklep Woo nie odpowiada'); }, przyspiesz: () => {} }) as any);
    const { db, z, erli, log } = zbuduj({ woo: atrapaWoo() });
    wstawOferte(db, { kartaId: 1, kanal: 'erli-polcien', idZewnetrzne: 'pc7k2q-K1', pochodzenie: 'przejeta', stan: 'aktywna' });
    await expect(zegar(z, 'petlaStanowWoo').przebieg()).resolves.toBeUndefined();
    expect(log).toHaveBeenCalledWith('stany-woo: przebieg: sklep Woo nie odpowiada');
    await zegar(z, 'petlaOfert').przebieg();
    expect(erli.szukajProduktow).toHaveBeenCalledTimes(1);
    db.close();
  });

  it('strażnik przy włączonych stanach bez tabel zamówień: błąd odcisku w logu, zegar nie rzuca', async () => {
    const { db, z, log } = zbuduj({ woo: atrapaWoo() });
    przelaczStany(db, { wlacz: true, at: '2026-11-13T09:00:00.000Z' });
    await expect(zegar(z, 'straznikStanow').przebieg()).resolves.toBeUndefined();
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/^straznik-stanow: odcisk: /));
    db.close();
  });
});

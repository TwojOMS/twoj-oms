import { describe, it, expect, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { modulyDla } from '../../../src/moduly/lista.ts';
import { modulMagazyn } from '../../../src/moduly/magazyn/modul.ts';
import { migracjaOfertAllegro } from '../../../src/moduly/magazyn/migracje/0002-oferty-allegro.ts';
import { ENV_DEMO, wygenerujDaneDemo } from '../../../scripts/demo-dane.mjs';
import { klienciKataloguDemo } from '../../../scripts/demo-dane-katalog.mjs';
import { odswiezMagazyn } from '../../../src/moduly/magazyn/services/magazyn-sync.js';
import { utworzKartyZNiepowiazanych } from '../../../src/oms/db/magazyn.js';
import { ustawZnacznikAi } from '../../../src/moduly/magazyn/services/znacznik-ai.js';
import {
  wstawOferte, ofertaPoId, przypiszIdZewnetrzne, zapiszWgraneZdjecie, wgraneZdjeciaAllegro,
  ustawieniaOfertKonta, zapiszUstawieniaOfertKonta,
} from '../../../src/oms/db/oferty-kanalow.ts';

// Migracja magazyn/0002: mapy Allegro (kategorie, reguły parametrów, marki, GPSR marek),
// nadpisania karty, zdjęcia wgrane do Allegro, nowe ustawienia konta. Wyłącznie dokładanie.
// Dane zmyślone: „Pracownia Półcień”, lampy LMP-*.

const KORZEN = fileURLToPath(new URL('../../../', import.meta.url));
const NOWE_TABELE = ['allegro_mapa_kategorii', 'allegro_reguly_parametrow', 'allegro_marki', 'allegro_marki_gpsr',
  'karty_allegro', 'zdjecia_kart_allegro'];
const NOWE_KOLUMNY = { oferty_ustawienia_kont: ['zwroty_id', 'reklamacje_id', 'gwarancja_id', 'lokalizacja_json',
  'aktywuj_po_sprawdzeniu', 'bezpieczenstwo_domyslne', 'slowniki_json'] };
const T0 = '2026-11-14T10:00:00.000Z';
const T1 = '2026-11-14T10:05:00.000Z';
const TERAZ = () => new Date(T0);

const katalogi = [];
const bazy = [];
afterEach(() => {
  for (const db of bazy.splice(0)) if (db.isOpen) db.close();
  for (const k of katalogi.splice(0)) rmSync(k, { recursive: true, force: true });
});

function nowyPlik() {
  const k = mkdtempSync(join(tmpdir(), 'oms-prz160-e301-'));
  katalogi.push(k);
  return join(k, 'oms.sqlite');
}
const bez0002 = (moduly) => moduly.map((m) => (m.nazwa === 'magazyn' ? { ...m, migracje: m.migracje.filter((x) => x.numer !== 2) } : m));
const kolumny = (db, t) => db.prepare(`PRAGMA table_info(${t})`).all().map((k) => k.name);
const tabele = (db) => db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all().map((w) => w.name);
const schemat = (db) => db.prepare("SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name").all();

// Odcisk: kolumny i zawartość każdej istniejącej tabeli, bez kolumn dodanych przez 0002.
function odcisk(db, lista) {
  const wynik = {};
  for (const t of lista) {
    const pomin = NOWE_KOLUMNY[t] ?? [];
    const wiersze = db.prepare(`SELECT * FROM "${t}"`).all()
      .map((w) => JSON.stringify(Object.entries(w).filter(([k]) => !pomin.includes(k))))
      .sort();
    wynik[t] = { kolumny: kolumny(db, t).filter((k) => !pomin.includes(k)), wiersze };
  }
  return wynik;
}

function bazaPamieci() {
  const db = openOmsDb(':memory:', { moduly: modulyDla(ENV_DEMO), teraz: TERAZ });
  bazy.push(db);
  const karta = db.prepare('INSERT INTO karty_produktow (id, sku, nazwa, utworzony_at, zmieniony_at) VALUES (?, ?, ?, ?, ?)');
  karta.run(501, 'LMP-501', 'Lampa Półcień mała', T0, T0);
  karta.run(502, 'LMP-502', 'Lampa Półcień duża', T0, T0);
  const zdj = db.prepare(`INSERT INTO zdjecia_kart (id, karta_id, kolejnosc, zrodlo, adres_zrodlowy, ai, ai_reczne, utworzono_at)
    VALUES (?, ?, ?, 'oms', ?, ?, 1, ?)`);
  zdj.run(71, 501, 0, 'https://sklep.polcien.example/lampa-mala-1.jpg', 0, T0);
  zdj.run(72, 501, 1, 'https://sklep.polcien.example/lampa-mala-2.jpg', 1, T0);
  return db;
}

describe('migracja magazyn/0002 — oferty Allegro', () => {
  it('moduł magazynu niesie migrację numer 2', () => {
    expect(modulMagazyn.migracje).toContain(migracjaOfertAllegro);
    expect(migracjaOfertAllegro.numer).toBe(2);
  });

  it('baza demo: istniejące tabele, ich schemat i dane po migracji są takie same jak przed', async () => {
    const plik = nowyPlik();
    const stare = bez0002(modulyDla(ENV_DEMO));
    let db = openOmsDb(plik, { moduly: stare, teraz: TERAZ });
    wygenerujDaneDemo(db, { dzis: '2026-11-13', env: ENV_DEMO });
    const { sklepy, allegro, kanalySklepow, kanalyAllegro } = klienciKataloguDemo();
    const teraz = () => '2026-11-13T04:00:00.000Z';
    await odswiezMagazyn({ db, sklepy, allegro, teraz, kanalySklepow, kanalyAllegro, log: () => {} });
    utworzKartyZNiepowiazanych(db, { teraz, kanalySklepow });
    const karta = db.prepare('SELECT id FROM karty_produktow ORDER BY id LIMIT 1').get().id;
    db.prepare(`INSERT INTO oferty_kanalow (karta_id, kanal, id_zewnetrzne, pochodzenie, tryb, stan, utworzono_at, zmieniono_at)
      VALUES (?, 'allegro_polcien', 'ext:QX7P2M-K1', 'oms', 'zarzadzana', 'szkic', ?, ?)`).run(karta, T0, T0);
    db.prepare(`INSERT INTO oferty_ustawienia_kont (klucz, oferty_czynne, narzut_bp, stala_ilosc, cennik_dostaw, zmieniono_at)
      VALUES ('allegro_polcien', 1, 1250, 5, 'cennik-7', ?)`).run(T0);
    db.prepare(`INSERT INTO zdjecia_kart (karta_id, kolejnosc, zrodlo, adres_zrodlowy, ai, ai_reczne, utworzono_at)
      VALUES (?, 0, 'oms', 'https://sklep.polcien.example/a.jpg', 0, 1, ?)`).run(karta, T0);
    db.close();
    // Odcisk po ponownym otwarciu tą samą wersją — skutki samego otwarcia nie mieszają się z migracją.
    db = openOmsDb(plik, { moduly: stare, teraz: TERAZ });
    const stareTabele = tabele(db).filter((t) => t !== 'migracje');
    for (const t of NOWE_TABELE) expect(stareTabele).not.toContain(t);
    expect(db.prepare('SELECT count(*) n FROM karty_produktow').get().n).toBeGreaterThan(1);
    const przed = odcisk(db, stareTabele);
    const schematPrzed = schemat(db).filter((w) => w.name !== 'migracje' && w.name !== 'oferty_ustawienia_kont');
    db.close();

    db = openOmsDb(plik, { moduly: modulyDla(ENV_DEMO), teraz: TERAZ });
    bazy.push(db);
    expect(odcisk(db, stareTabele)).toEqual(przed);
    const schematPo = schemat(db);
    expect(schematPo.filter((w) => schematPrzed.some((p) => p.name === w.name))).toEqual(schematPrzed);
    expect(kolumny(db, 'oferty_ustawienia_kont')).toEqual(expect.arrayContaining(NOWE_KOLUMNY.oferty_ustawienia_kont));
    for (const t of NOWE_TABELE) expect(tabele(db)).toContain(t);
    for (const t of NOWE_TABELE) expect(db.prepare(`SELECT count(*) n FROM ${t}`).get().n).toBe(0);
    expect(db.prepare("SELECT numer FROM migracje WHERE modul = 'magazyn' AND numer = 2").get()).toEqual({ numer: 2 });
    // Istniejący wiersz ustawień: nowe pola puste, „aktywuj po sprawdzeniu” = nie (D30).
    expect(db.prepare(`SELECT zwroty_id, reklamacje_id, gwarancja_id, lokalizacja_json, aktywuj_po_sprawdzeniu,
      bezpieczenstwo_domyslne, slowniki_json FROM oferty_ustawienia_kont WHERE klucz = 'allegro_polcien'`).get())
      .toEqual({ zwroty_id: null, reklamacje_id: null, gwarancja_id: null, lokalizacja_json: null, aktywuj_po_sprawdzeniu: 0,
        bezpieczenstwo_domyslne: null, slowniki_json: null });
    expect(ustawieniaOfertKonta(db, 'allegro_polcien')).toMatchObject({ czynne: true, narzutBp: 1250, stalaIlosc: 5,
      cennikDostaw: 'cennik-7', aktywujPoSprawdzeniu: false, zwrotyId: null, lokalizacja: null, slowniki: null });
  });

  it('drugie uruchomienie migracji nie zmienia schematu ani danych', () => {
    const db = bazaPamieci();
    db.prepare(`INSERT INTO allegro_reguly_parametrow (srodowisko, kategoria_allegro_id, parametr_id, rodzaj, wartosc_json, zmieniono_at)
      VALUES ('sandbox', '257931', '11323', 'stala', '"Nowy"', ?)`).run(T0);
    zapiszUstawieniaOfertKonta(db, 'allegro_polcien', { aktywujPoSprawdzeniu: true, zwrotyId: 'zw-1' }, { teraz: T0 });
    const przed = [schemat(db), odcisk(db, tabele(db))];
    migracjaOfertAllegro.wykonaj(db);
    migracjaOfertAllegro.wykonaj(db);
    expect([schemat(db), odcisk(db, tabele(db))]).toEqual(przed);
  });

  it('strażnik migracji zielony', () => {
    expect(execFileSync(process.execPath, ['scripts/straznik-migracji.mjs'], { cwd: KORZEN, encoding: 'utf8' })).toBe('');
  });
});

describe('nowe tabele — klucze i ograniczenia', () => {
  it('reguły parametrów: dwie reguły jednej kategorii przechodzą, ten sam parametr drugi raz — odmowa', () => {
    const db = bazaPamieci();
    const wstaw = (parametr, rodzaj = 'stala') => db.prepare(`INSERT INTO allegro_reguly_parametrow
      (srodowisko, kategoria_allegro_id, parametr_id, rodzaj, wartosc_json, pole, zmieniono_at) VALUES ('sandbox', '257931', ?, ?, ?, ?, ?)`)
      .run(parametr, rodzaj, rodzaj === 'stala' ? '"Nowy"' : null, rodzaj === 'pole' ? 'ean' : null, T0);
    expect(() => wstaw('11323')).not.toThrow();
    expect(() => wstaw('225693', 'pole')).not.toThrow();
    expect(db.prepare('SELECT count(*) n FROM allegro_reguly_parametrow').get().n).toBe(2);
    expect(() => wstaw('11323', 'na_karcie')).toThrow(/UNIQUE|PRIMARY/);
    expect(() => wstaw('99', 'inne')).toThrow(/CHECK/);
  });

  it('mapa kategorii: jedna kategoria Allegro na kategorię karty i środowisko', () => {
    const db = bazaPamieci();
    const wstaw = (srodowisko, id) => db.prepare(`INSERT INTO allegro_mapa_kategorii (kategoria_karty, srodowisko,
      kategoria_allegro_id, sciezka_json, potwierdzil, potwierdzono_at) VALUES ('Lampy', ?, ?, '[]', 'administrator', ?)`).run(srodowisko, id, T0);
    expect(() => wstaw('sandbox', '257931')).not.toThrow();
    expect(() => wstaw('produkcja', '257931')).not.toThrow();
    expect(() => wstaw('sandbox', '1')).toThrow(/UNIQUE|PRIMARY/);
    expect(() => wstaw('test', '1')).toThrow(/CHECK/);
  });

  it('marki: lista sprawdzonych kategorii domyślnie pusta; GPSR marki tylko „konto” albo „wybrany”', () => {
    const db = bazaPamieci();
    db.prepare(`INSERT INTO allegro_marki (marka, srodowisko, parametr_id, wartosc_id, wartosc_tekst, zmieniono_at)
      VALUES ('Półcień', 'sandbox', '248811', '248811_1', 'Półcień', ?)`).run(T0);
    expect(db.prepare('SELECT kategorie_sprawdzone_json k FROM allegro_marki').get()).toEqual({ k: '[]' });
    const gpsr = (zrodlo) => db.prepare(`INSERT INTO allegro_marki_gpsr (marka, konto, zrodlo, producent_id, zmieniono_at)
      VALUES ('Półcień', 'allegro_polcien', ?, 'prod-1', ?)`).run(zrodlo, T0);
    expect(() => gpsr('domyslny')).toThrow(/CHECK/);
    expect(() => gpsr('wybrany')).not.toThrow();
    expect(() => gpsr('konto')).toThrow(/UNIQUE|PRIMARY/);
  });

  it('karty_allegro: jeden wiersz nadpisań na kartę, znika z kartą', () => {
    const db = bazaPamieci();
    const wstaw = () => db.prepare(`INSERT INTO karty_allegro (karta_id, nazwa, kategoria_id, parametry_json, zmieniono_at)
      VALUES (502, 'Lampa Półcień duża, mosiądz', '257931', '[]', ?)`).run(T0);
    expect(() => wstaw()).not.toThrow();
    expect(() => wstaw()).toThrow(/UNIQUE|PRIMARY/);
    db.prepare('DELETE FROM karty_produktow WHERE id = 502').run();
    expect(db.prepare('SELECT count(*) n FROM karty_allegro').get().n).toBe(0);
  });
});

describe('przypiszIdZewnetrzne (D31)', () => {
  it('zamienia `ext:…` na numer oferty raz; drugi raz i wiersz bez `ext:` — odmowa', () => {
    const db = bazaPamieci();
    const o = wstawOferte(db, { kartaId: 501, kanal: 'allegro_polcien', idZewnetrzne: 'ext:QX7P2M-K501' }, { teraz: T0 });
    const po = przypiszIdZewnetrzne(db, o.id, '7712345678', { teraz: T1 });
    expect(po).toMatchObject({ idZewnetrzne: '7712345678', zmienionoAt: T1 });
    expect(() => przypiszIdZewnetrzne(db, o.id, '7712345679', { teraz: T1 })).toThrow(/ext:/);
    expect(ofertaPoId(db, o.id).idZewnetrzne).toBe('7712345678');

    const bez = wstawOferte(db, { kartaId: 502, kanal: 'allegro_polcien', idZewnetrzne: 'QX7P2M-K502' }, { teraz: T0 });
    expect(() => przypiszIdZewnetrzne(db, bez.id, '7712345680', { teraz: T1 })).toThrow(/ext:/);
    expect(ofertaPoId(db, bez.id)).toMatchObject({ idZewnetrzne: 'QX7P2M-K502', zmienionoAt: T0 });
  });

  it('wartość wielkimi literami „EXT:” nie jest znacznikiem; nowy numer nie może być pusty ani `ext:`', () => {
    const db = bazaPamieci();
    const duze = wstawOferte(db, { kartaId: 501, kanal: 'allegro_polcien', idZewnetrzne: 'EXT:QX7P2M-K501' }, { teraz: T0 });
    expect(() => przypiszIdZewnetrzne(db, duze.id, '7712345678', { teraz: T1 })).toThrow(/ext:/);
    const o = wstawOferte(db, { kartaId: 502, kanal: 'allegro_polcien', idZewnetrzne: 'ext:QX7P2M-K502' }, { teraz: T0 });
    expect(() => przypiszIdZewnetrzne(db, o.id, ' ', { teraz: T1 })).toThrow();
    expect(() => przypiszIdZewnetrzne(db, o.id, 'ext:inne', { teraz: T1 })).toThrow();
    expect(ofertaPoId(db, o.id).idZewnetrzne).toBe('ext:QX7P2M-K502');
    expect(przypiszIdZewnetrzne(db, 4242, '7712345678', { teraz: T1 })).toBeNull();
  });

  it('dwa wiersze `ext:` z tą samą wartością na koncie → UNIQUE odrzuca; numer zajęty na koncie → odmowa bazy', () => {
    const db = bazaPamieci();
    wstawOferte(db, { kartaId: 501, kanal: 'allegro_polcien', idZewnetrzne: 'ext:QX7P2M-K501' }, { teraz: T0 });
    expect(() => wstawOferte(db, { kartaId: 502, kanal: 'allegro_polcien', idZewnetrzne: 'ext:QX7P2M-K501' }, { teraz: T0 }))
      .toThrow(/UNIQUE/);
    expect(() => wstawOferte(db, { kartaId: 501, kanal: 'allegro_polcien_2', idZewnetrzne: 'ext:QX7P2M-K501' }, { teraz: T0 }))
      .not.toThrow();
    const a = ofertaPoId(db, 1);
    przypiszIdZewnetrzne(db, a.id, '7712345678', { teraz: T1 });
    const b = wstawOferte(db, { kartaId: 502, kanal: 'allegro_polcien', idZewnetrzne: 'ext:QX7P2M-K502' }, { teraz: T0 });
    expect(() => przypiszIdZewnetrzne(db, b.id, '7712345678', { teraz: T1 })).toThrow(/UNIQUE/);
    expect(ofertaPoId(db, b.id).idZewnetrzne).toBe('ext:QX7P2M-K502');
  });
});

describe('zdjęcia wgrane do Allegro (D32)', () => {
  it('zapiszWgraneZdjecie ustawia wyslane_at i mapę; potem ustawZnacznikAi rzuca (galeria blokuje zmianę)', () => {
    const db = bazaPamieci();
    zapiszWgraneZdjecie(db, { zdjecieId: 71, konto: 'allegro_polcien', adres: 'https://a.allegroimg.example/s1/71.jpg',
      ai: 0, wygasaAt: '2026-11-21T10:00:00.000Z' }, { teraz: T0 });
    expect(db.prepare('SELECT wyslane_at FROM zdjecia_kart WHERE id = 71').get()).toEqual({ wyslane_at: T0 });
    expect(() => ustawZnacznikAi(db, { kartaId: 501, zdjecieId: 71, ai: 1, at: T1 })).toThrow(/wysłanego/);
    expect(db.prepare('SELECT ai FROM zdjecia_kart WHERE id = 71').get()).toEqual({ ai: 0 });
    // Drugie zdjęcie nie było wgrane — znacznik wolno zmienić.
    expect(() => ustawZnacznikAi(db, { kartaId: 501, zdjecieId: 72, ai: 0, at: T1 })).not.toThrow();
  });

  it('ponowne wgranie (adres wygasł) zmienia mapę, a pierwsze wyslane_at zostaje', () => {
    const db = bazaPamieci();
    zapiszWgraneZdjecie(db, { zdjecieId: 72, konto: 'allegro_polcien', adres: 'https://a.allegroimg.example/s1/72.jpg', ai: 1, wygasaAt: null }, { teraz: T0 });
    zapiszWgraneZdjecie(db, { zdjecieId: 72, konto: 'allegro_polcien', adres: 'https://a.allegroimg.example/s2/72.jpg', ai: 1, wygasaAt: '2026-11-30T00:00:00.000Z' }, { teraz: T1 });
    zapiszWgraneZdjecie(db, { zdjecieId: 72, konto: 'allegro_polcien_2', adres: 'https://a.allegroimg.example/s9/72.jpg', ai: 1, wygasaAt: null }, { teraz: T1 });
    expect(db.prepare('SELECT wyslane_at FROM zdjecia_kart WHERE id = 72').get()).toEqual({ wyslane_at: T0 });
    expect(wgraneZdjeciaAllegro(db, { kartaId: 501, konto: 'allegro_polcien' })).toEqual([
      { zdjecieId: 72, konto: 'allegro_polcien', adres: 'https://a.allegroimg.example/s2/72.jpg', ai: 1,
        wygasaAt: '2026-11-30T00:00:00.000Z', wgranoAt: T1 },
    ]);
    expect(wgraneZdjeciaAllegro(db, { kartaId: 501, konto: 'allegro_polcien_2' }).map((z) => z.adres))
      .toEqual(['https://a.allegroimg.example/s9/72.jpg']);
    expect(wgraneZdjeciaAllegro(db, { kartaId: 502, konto: 'allegro_polcien' })).toEqual([]);
  });

  it('jedna transakcja: błąd ustawienia wyslane_at cofa zapisany już wiersz mapy', () => {
    const db = bazaPamieci();
    db.exec(`CREATE TEMP TRIGGER e301_awaria BEFORE UPDATE OF wyslane_at ON zdjecia_kart BEGIN SELECT RAISE(ABORT, 'awaria karty'); END`);
    expect(() => zapiszWgraneZdjecie(db, { zdjecieId: 71, konto: 'allegro_polcien', adres: 'https://a.allegroimg.example/71.jpg',
      ai: 0, wygasaAt: null }, { teraz: T0 })).toThrow(/awaria karty/);
    expect(db.prepare('SELECT count(*) n FROM zdjecia_kart_allegro').get().n).toBe(0);
    expect(db.prepare('SELECT wyslane_at FROM zdjecia_kart WHERE id = 71').get()).toEqual({ wyslane_at: null });
    expect(db.isTransaction).toBe(false);
  });

  it('znacznik AI zmieniony na karcie w trakcie wgrywania → odmowa, mapa i wyslane_at puste', () => {
    const db = bazaPamieci();
    // Pętla przeczytała ai = 0 i wgrywa bez isAiCoCreated; w tym czasie człowiek ustawia ai = 1.
    ustawZnacznikAi(db, { kartaId: 501, zdjecieId: 71, ai: 1, at: T0 });
    expect(() => zapiszWgraneZdjecie(db, { zdjecieId: 71, konto: 'allegro_polcien', adres: 'https://a.allegroimg.example/71.jpg',
      ai: 0, wygasaAt: null }, { teraz: T1 })).toThrow(/znacznik AI/i);
    expect(db.prepare('SELECT count(*) n FROM zdjecia_kart_allegro').get().n).toBe(0);
    expect(db.prepare('SELECT ai, wyslane_at FROM zdjecia_kart WHERE id = 71').get()).toEqual({ ai: 1, wyslane_at: null });
    expect(() => ustawZnacznikAi(db, { kartaId: 501, zdjecieId: 71, ai: 0, at: T1 })).not.toThrow();
  });

  it('zdjęcie bez decyzji o AI (ai NULL na karcie) → odmowa, nic nie zapisane', () => {
    const db = bazaPamieci();
    db.prepare('UPDATE zdjecia_kart SET ai = NULL WHERE id = 72').run();
    for (const ai of [0, 1]) {
      expect(() => zapiszWgraneZdjecie(db, { zdjecieId: 72, konto: 'allegro_polcien', adres: 'https://a.allegroimg.example/72.jpg',
        ai, wygasaAt: null }, { teraz: T0 })).toThrow(/znacznik AI/i);
    }
    expect(db.prepare('SELECT count(*) n FROM zdjecia_kart_allegro').get().n).toBe(0);
    expect(db.prepare('SELECT wyslane_at FROM zdjecia_kart WHERE id = 72').get()).toEqual({ wyslane_at: null });
  });

  it('złe wejście → odmowa bez zapisu; usunięte zdjęcie zabiera wiersz mapy', () => {
    const db = bazaPamieci();
    const z = { zdjecieId: 71, konto: 'allegro_polcien', adres: 'https://a.allegroimg.example/71.jpg', ai: 0, wygasaAt: null };
    expect(() => zapiszWgraneZdjecie(db, { ...z, ai: null })).toThrow();
    expect(() => zapiszWgraneZdjecie(db, { ...z, ai: 2 })).toThrow();
    expect(() => zapiszWgraneZdjecie(db, { ...z, konto: '' })).toThrow();
    expect(() => zapiszWgraneZdjecie(db, { ...z, adres: '' })).toThrow();
    expect(() => zapiszWgraneZdjecie(db, { ...z, zdjecieId: 999 })).toThrow();
    expect(db.prepare('SELECT count(*) n FROM zdjecia_kart_allegro').get().n).toBe(0);
    expect(db.prepare('SELECT count(*) n FROM zdjecia_kart WHERE wyslane_at IS NOT NULL').get().n).toBe(0);
    zapiszWgraneZdjecie(db, z, { teraz: T0 });
    db.prepare('DELETE FROM zdjecia_kart WHERE id = 71').run();
    expect(db.prepare('SELECT count(*) n FROM zdjecia_kart_allegro').get().n).toBe(0);
  });
});

describe('ustawienia konta — pola Allegro', () => {
  it('baza bez magazyn/0002: odczyt ustawień daje wartości domyślne nowych pól', () => {
    const db = openOmsDb(':memory:', { moduly: bez0002(modulyDla(ENV_DEMO)), teraz: TERAZ });
    bazy.push(db);
    expect(kolumny(db, 'oferty_ustawienia_kont')).not.toContain('aktywuj_po_sprawdzeniu');
    const domyslne = { zwrotyId: null, reklamacjeId: null, gwarancjaId: null, lokalizacja: null, aktywujPoSprawdzeniu: false,
      bezpieczenstwoDomyslne: null, slowniki: null };
    expect(ustawieniaOfertKonta(db, 'allegro_polcien')).toMatchObject({ zapisane: false, ...domyslne });
    db.prepare(`INSERT INTO oferty_ustawienia_kont (klucz, oferty_czynne, narzut_bp, zmieniono_at)
      VALUES ('allegro_polcien', 1, 1250, ?)`).run(T0);
    expect(ustawieniaOfertKonta(db, 'allegro_polcien')).toMatchObject({ zapisane: true, czynne: true, narzutBp: 1250, ...domyslne });
  });

  it('konto bez zapisu: „aktywuj po sprawdzeniu” = nie, słowniki i warunki puste', () => {
    const db = bazaPamieci();
    expect(ustawieniaOfertKonta(db, 'allegro_polcien')).toMatchObject({ zapisane: false, zwrotyId: null, reklamacjeId: null,
      gwarancjaId: null, lokalizacja: null, aktywujPoSprawdzeniu: false, bezpieczenstwoDomyslne: null, slowniki: null });
  });

  it('zapis i odczyt nowych pól; zapis częściowy nie rusza pozostałych', () => {
    const db = bazaPamieci();
    zapiszUstawieniaOfertKonta(db, 'allegro_polcien', { cennikDostaw: 'cennik-7', zwrotyId: 'zw-1', reklamacjeId: 'rk-2',
      gwarancjaId: 'gw-3', lokalizacja: { city: 'Półcień', postCode: '00-001', countryCode: 'PL' }, aktywujPoSprawdzeniu: true,
      bezpieczenstwoDomyslne: 'Lampę podłączać do gniazda z uziemieniem.', slowniki: { zwroty: { 'zw-1': 'Zwroty 14 dni' } } },
    { teraz: T0, aktor: 'administrator' });
    const u = zapiszUstawieniaOfertKonta(db, 'allegro_polcien', { narzutProcent: 5 }, { teraz: T1 });
    expect(u).toMatchObject({ cennikDostaw: 'cennik-7', zwrotyId: 'zw-1', reklamacjeId: 'rk-2', gwarancjaId: 'gw-3',
      lokalizacja: { city: 'Półcień', postCode: '00-001', countryCode: 'PL' }, aktywujPoSprawdzeniu: true,
      bezpieczenstwoDomyslne: 'Lampę podłączać do gniazda z uziemieniem.', slowniki: { zwroty: { 'zw-1': 'Zwroty 14 dni' } },
      narzutProcent: 5 });
    expect(db.prepare("SELECT aktywuj_po_sprawdzeniu FROM oferty_ustawienia_kont WHERE klucz = 'allegro_polcien'").get())
      .toEqual({ aktywuj_po_sprawdzeniu: 1 });
    expect(zapiszUstawieniaOfertKonta(db, 'allegro_polcien', { aktywujPoSprawdzeniu: false, gwarancjaId: null }, { teraz: T1 }))
      .toMatchObject({ aktywujPoSprawdzeniu: false, gwarancjaId: null, zwrotyId: 'zw-1' });
  });

  it('złe wartości → odmowa, nic nie zapisane', () => {
    const db = bazaPamieci();
    expect(() => zapiszUstawieniaOfertKonta(db, 'allegro_polcien', { aktywujPoSprawdzeniu: 1 })).toThrow();
    expect(() => zapiszUstawieniaOfertKonta(db, 'allegro_polcien', { bezpieczenstwoDomyslne: 'x'.repeat(5001) })).toThrow(/5000/);
    expect(() => zapiszUstawieniaOfertKonta(db, 'allegro_polcien', { lokalizacja: 'Półcień' })).toThrow();
    expect(() => zapiszUstawieniaOfertKonta(db, 'allegro_polcien', { slowniki: 7 })).toThrow();
    expect(ustawieniaOfertKonta(db, 'allegro_polcien').zapisane).toBe(false);
  });

  it('kolumna aktywuj_po_sprawdzeniu: NOT NULL DEFAULT 0, pozostałe nowe kolumny bez wartości domyślnej', () => {
    const db = bazaPamieci();
    const k = Object.fromEntries(db.prepare('PRAGMA table_info(oferty_ustawienia_kont)').all().map((x) => [x.name, x]));
    expect(k.aktywuj_po_sprawdzeniu).toMatchObject({ notnull: 1, dflt_value: '0' });
    for (const n of ['zwroty_id', 'reklamacje_id', 'gwarancja_id', 'lokalizacja_json', 'bezpieczenstwo_domyslne', 'slowniki_json']) {
      expect(k[n]).toMatchObject({ notnull: 0, dflt_value: null });
    }
  });
});

// PRZ-160 E3.06b — wejście E3.06 (`ofertaAllegroZKarty`) z bazy jednym odczytem, jak `tresc-oferty.js` dla ERLI.
// Dane zmyślone: lampy „Pracownia Półcień” z atrapy katalogu (scripts/demo-dane-katalog.mjs). Klient Allegro
// tylko w imporcie (atrapa); sam odczyt nie ma klienta i nie może sięgać do sieci.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { modulyDla } from '../../../src/moduly/lista.ts';
import { ENV_DEMO } from '../../../scripts/demo-dane.mjs';
import { utworzKarte, zapiszProduktSklepowy, powiazProdukt } from '../../../src/oms/db/magazyn.js';
import { ustawieniaOfertKonta, zapiszUstawieniaOfertKonta, wstawOferte } from '../../../src/oms/db/oferty-kanalow.ts';
import { pobierzTrescOfertAllegro } from '../../../src/moduly/magazyn/services/allegro-tresc-kart.js';
import { ofertaAllegroKarty } from '../../../src/moduly/magazyn/services/tresc-oferty-allegro.js';
import { ofertaAllegroZKarty, ZNACZNIK_WGRANIA } from '../../../src/domena/allegro-oferta-z-karty.js';
import { opisKategorii, trescOfertyAllegro } from '../../../src/domena/tresc-oferty-allegro.js';
import {
  ofertyAllegro, ofertaAllegroPelna, kategoriaAllegroDemo, parametryKategoriiAllegroDemo,
} from '../../../scripts/demo-dane-katalog.mjs';

const KANAL = 'allegro';
const DRUGIE = 'allegro_drugie';
const KONTO = { klucz: KANAL, nazwa: 'Półcień Allegro', srodowisko: 'produkcja' };
const T0 = '2026-11-14T08:00:00.000Z';
const TERAZ = '2026-11-14T12:30:00.000Z';
const WZOR = ofertaAllegroPelna(KANAL, ofertyAllegro(KANAL)[0].id);
const PRODUKT_WZORU = WZOR.productSet[0].product.id;
const BEZPIECZENSTWO = JSON.stringify({ typ: 'TEXT', tekst: 'Nie zostawiaj włączonej lampy bez nadzoru.' });

const bazy = [];
const katalogi = [];
afterEach(() => {
  vi.unstubAllGlobals();
  for (const db of bazy.splice(0)) if (db.isOpen) db.close();
  for (const k of katalogi.splice(0)) rmSync(k, { recursive: true, force: true });
});

const klientAtrapa = () => ({
  pobierzOferte: vi.fn(async id => ({ ...WZOR, id: String(id) })),
  pobierzKategorie: vi.fn(async id => kategoriaAllegroDemo(id)),
  pobierzParametryKategorii: vi.fn(async id => parametryKategoriiAllegroDemo(id)),
});

/** Baza demo: karta A z importu oferty Allegro (treść, kategoria 257 w pamięci konta), ustawienia konta. */
async function bazaZImportem() {
  const db = openOmsDb(':memory:', { moduly: modulyDla(ENV_DEMO) });
  bazy.push(db);
  const a = utworzKarte(db, { nazwa: 'Pracownia Półcień — Lampa Sowa 30 cm', cena_gr: 5900, stawka_vat: '23',
    marka: 'Pracownia Półcień' }, { at: T0 });
  db.prepare('UPDATE karty_produktow SET informacja_bezpieczenstwa = ? WHERE id = ?').run(BEZPIECZENSTWO, a);
  const pid = zapiszProduktSklepowy(db, { kanal: KANAL, produkt_id: WZOR.id, wariant_id: '', nazwa: WZOR.name,
    status_publikacji: 'ACTIVE', odczytane_at: T0 });
  powiazProdukt(db, pid, a);
  const katalog = mkdtempSync(join(tmpdir(), 'oms-e306b-'));
  katalogi.push(katalog);
  const adresy = [];
  const wynik = await pobierzTrescOfertAllegro({ db, allegro: { [KANAL]: klientAtrapa() }, kanalyAllegro: [KANAL], katalog,
    teraz: () => new Date(T0), pobierzZdjecie: async adres => adres, czekaj: async () => {},
    zapiszZdjecie: async (adres) => {
      if (!adresy.includes(adres)) adresy.push(adres);
      return { sha256: String(adresy.indexOf(adres) + 1).repeat(64), plik: `z${adresy.indexOf(adres)}.jpg`, typ: 'image/jpeg', rozmiar: 1 };
    } });
  expect(wynik).toMatchObject({ pobrane: 1, bledy: [], blad: null });
  zapiszUstawieniaOfertKonta(db, KANAL, { narzutProcent: 0, stalaIlosc: 5, czasWysylkiDni: 2, cennikDostaw: 'cennik-1',
    stawkaVat: '23', zwrotyId: 'zwrot-1', reklamacjeId: 'rekl-1', producentId: 'prod-konta' }, { teraz: T0 });
  return { db, a };
}

/** Karta B wpisana ręcznie: kategoria z mapy środowiska, reguły, marka, GPSR marki konta, `n` zdjęć. */
function kartaReczna(db, { n = 3, kategoriaAllegro = '257', nazwaKategorii = 'Lampy stołowe' } = {}) {
  const id = utworzKarte(db, { nazwa: `Lampa stołowa Gliwka z kloszem ${n}`, cena_gr: 5900, stawka_vat: '23',
    marka: 'Pracownia Półcień', kategoria_glowna: nazwaKategorii, szerokosc_mm: 255,
    opis_sekcje_json: JSON.stringify({ sekcje: [{ elementy: [{ typ: 'tekst', html: '<p>Lampa z mlecznym kloszem.</p>' }] }] }) },
  { at: T0 });
  db.prepare('UPDATE karty_produktow SET informacja_bezpieczenstwa = ? WHERE id = ?').run(BEZPIECZENSTWO, id);
  const zdj = db.prepare(`INSERT INTO zdjecia_kart (karta_id, kolejnosc, zrodlo, adres_zrodlowy, sha256, typ, ai, ai_reczne, utworzono_at)
    VALUES (?, ?, 'reczne', ?, NULL, 'image/jpeg', 0, 1, ?)`);
  for (let i = 0; i < n; i++) zdj.run(id, i, `https://polcien.example.invalid/gliwka-${id}-${i + 1}.jpg`, T0);
  db.prepare(`INSERT OR IGNORE INTO allegro_mapa_kategorii (kategoria_karty, srodowisko, kategoria_allegro_id) VALUES (?, 'produkcja', ?)`)
    .run(nazwaKategorii, kategoriaAllegro);
  const regula = db.prepare(`INSERT OR IGNORE INTO allegro_reguly_parametrow (srodowisko, kategoria_allegro_id, parametr_id, rodzaj,
    wartosc_json, pole, zmieniono_at) VALUES (?, ?, ?, ?, ?, ?, ?)`);
  regula.run('produkcja', kategoriaAllegro, '11323', 'stala', JSON.stringify({ valuesIds: ['11323_1'] }), null, T0);
  regula.run('produkcja', kategoriaAllegro, '248811', 'pole', null, 'marka', T0);
  regula.run('sandbox', kategoriaAllegro, '224017', 'stala', JSON.stringify({ values: ['Z-SANDBOXA'] }), null, T0);
  db.prepare(`INSERT OR IGNORE INTO allegro_marki (marka, srodowisko, parametr_id, wartosc_id, kategorie_sprawdzone_json, zmieniono_at)
    VALUES ('Pracownia Półcień', 'produkcja', '248811', '248811_9001', ?, ?)`).run(JSON.stringify([kategoriaAllegro]), T0);
  db.prepare(`INSERT OR IGNORE INTO allegro_marki_gpsr (marka, konto, zrodlo, zmieniono_at) VALUES ('Pracownia Półcień', ?, 'konto', ?)`)
    .run(KANAL, T0);
  return id;
}

const zdjeciaKarty = (db, id) => db.prepare('SELECT id, kolejnosc, adres_zrodlowy, sha256, typ, ai, ai_reczne FROM zdjecia_kart WHERE karta_id = ? ORDER BY kolejnosc, id').all(id);
const wgraj = (db, zdjecieId, konto, adres, wygasa = null) => db.prepare(`INSERT INTO zdjecia_kart_allegro (zdjecie_id, konto, adres, ai,
  wygasa_at, wgrano_at) VALUES (?, ?, ?, 0, ?, ?)`).run(zdjecieId, konto, adres, wygasa, T0);
const wynikE306 = w => ({ bledy: w.bledy, ostrzezenia: w.ostrzezenia, zadanie: w.zadanie, droga: w.droga, doWgrania: w.doWgrania });
const kody = lista => lista.map(b => b.kod);

/** Liczy `db.prepare` w czasie `fn`. */
function zapytania(db, fn) {
  const oryginal = db.prepare;
  let n = 0;
  db.prepare = function (...args) { n += 1; return oryginal.apply(this, args); };
  try { fn(); } finally { db.prepare = oryginal; }
  return n;
}

describe('E3.06b — wejście E3.06 z bazy', () => {
  it('karta demo z importu → katalog-id, ten sam wynik co E3.06 z tabeli (bez sieci)', async () => {
    const { db, a } = await bazaZImportem();
    const siec = vi.fn(async () => { throw new Error('sieć zabroniona'); });
    vi.stubGlobal('fetch', siec);
    const w = ofertaAllegroKarty(db, a, KONTO, { teraz: TERAZ });
    expect(siec).not.toHaveBeenCalled();
    expect(w.karta.id).toBe(a);
    expect(w.bledy).toEqual([]);
    expect(w.droga).toBe('katalog-id');
    expect(w.zadanie.productSet[0].product).toEqual({ id: PRODUKT_WZORU });
    expect(w.zadanie.category).toEqual({ id: '257' });
    expect(w.zadanie.name).toBe('Pracownia Półcień — Lampa Sowa 30 cm');
    expect(w.zadanie.parameters.find(p => p.id === '248811')).toBeUndefined();
    expect(w.zadanie.parameters.find(p => p.id === '11323')).toMatchObject({ valuesIds: ['11323_1'] });
    expect(w.zadanie.sellingMode.price).toEqual({ amount: '59.00', currency: 'PLN' });
    expect(w.zadanie.stock).toEqual({ available: 5, unit: 'UNIT' });
    expect(w.zadanie.productSet[0].safetyInformation).toEqual({ type: 'TEXT', description: 'Nie zostawiaj włączonej lampy bez nadzoru.' });

    // To samo wejście złożone ręcznie z tabeli E3.06: import (kategoria, produkt, parametry), opis kategorii v2.
    const karta = db.prepare('SELECT * FROM karty_produktow WHERE id = ?').get(a);
    const sciezka = [kategoriaAllegroDemo('5'), kategoriaAllegroDemo('256'), kategoriaAllegroDemo('257')];
    const opis = opisKategorii(sciezka, parametryKategoriiAllegroDemo('257'));
    const oczekiwane = ofertaAllegroZKarty({
      karta: { ...karta, opis: karta.opis_sekcje_json ? JSON.parse(karta.opis_sekcje_json) : null },
      konto: KONTO,
      znakInstalacji: db.prepare("SELECT wartosc FROM ustawienia WHERE klucz = 'oferty.znak_instalacji'").get().wartosc,
      ustawienia: ustawieniaOfertKonta(db, KANAL),
      zdjecia: zdjeciaKarty(db, a),
      wgraneZdjecia: [],
      daneImportu: { kategoria_id: '257', produkt_id: PRODUKT_WZORU, parametry: trescOfertyAllegro(WZOR, opis).daneKanalu.parametry },
      kartaAllegro: null, mapaKategorii: [], reguly: [], opisyKategorii: { 257: opis }, marki: [], producenciMarek: [],
      ofertyKarty: [{ zrodlo: 'lustro', stan: 'ACTIVE' }],
      teraz: TERAZ,
    });
    expect(wynikE306(w)).toEqual(wynikE306(oczekiwane));
    expect(w.zadanie.external.id).toMatch(new RegExp(`^\\S+-K${a}$`));
  });

  it('karta ręczna: mapa, reguły i marka środowiska konta, GPSR marki konta → nowy produkt', async () => {
    const { db } = await bazaZImportem();
    const b = kartaReczna(db);
    const w = ofertaAllegroKarty(db, b, KONTO, { teraz: TERAZ });
    expect(w.bledy).toEqual([]);
    expect(w.droga).toBe('nowy');
    const produkt = w.zadanie.productSet[0].product;
    expect(produkt.category).toEqual({ id: '257' });
    expect(produkt.parameters).toContainEqual({ id: '248811', valuesIds: ['248811_9001'] });
    // Reguła sandboxa nie przecieka do produkcji.
    expect([...produkt.parameters, ...w.zadanie.parameters].find(p => p.id === '224017')).toBeUndefined();
    expect(w.zadanie.productSet[0].responsibleProducer).toEqual({ type: 'ID', id: 'prod-konta' });
    expect(w.doWgrania.map(z => z.id)).toEqual(zdjeciaKarty(db, b).map(z => z.id));
    expect(w.zadanie.images).toEqual(zdjeciaKarty(db, b).map(z => `${ZNACZNIK_WGRANIA}${z.id}`));
  });

  it('brak opisu kategorii w pamięci (albo tylko wersja 1) → błąd „pobierz opis kategorii”, bez sieci', async () => {
    const { db } = await bazaZImportem();
    const siec = vi.fn(async () => { throw new Error('sieć zabroniona'); });
    vi.stubGlobal('fetch', siec);
    const b = kartaReczna(db, { kategoriaAllegro: '258', nazwaKategorii: 'Kinkiety' });
    const w = ofertaAllegroKarty(db, b, KONTO, { teraz: TERAZ });
    expect(w.zadanie).toBeNull();
    expect(w.bledy).toContainEqual({ kod: 'opis-kategorii', tekst: 'Pobierz opis kategorii Allegro 258 (Magazyn → Kategorie).',
      adres: '/magazyn/kategorie' });

    // Pamięć wersji 1 (lista parametrów albo obiekt z `wersja: 1`) nie wystarcza — brak w niej liścia i parametrów produktu.
    const v1 = db.prepare(`INSERT INTO kanaly_kategorie (polaczenie, kategoria_id, sciezka_json, parametry_json, pobrano_at)
      VALUES (?, ?, ?, ?, ?)`);
    v1.run(DRUGIE, '259', JSON.stringify([{ id: '259', nazwa: 'Plafony' }]), JSON.stringify([]), T0);
    v1.run(KANAL, '259', JSON.stringify([{ id: '259', nazwa: 'Plafony' }]),
      JSON.stringify({ wersja: 1, lisc: true, tworzenieProduktu: true, parametry: [] }), T0);
    const c = kartaReczna(db, { kategoriaAllegro: '259', nazwaKategorii: 'Plafony' });
    expect(kody(ofertaAllegroKarty(db, c, KONTO, { teraz: TERAZ, kontaSrodowiska: [KANAL, DRUGIE] }).bledy)).toContain('opis-kategorii');
    expect(siec).not.toHaveBeenCalled();
  });

  it('opis kategorii z pamięci innego konta tego samego środowiska wystarcza', async () => {
    const { db } = await bazaZImportem();
    const b = kartaReczna(db);
    const w = ofertaAllegroKarty(db, b, { klucz: DRUGIE, nazwa: 'Drugie konto', srodowisko: 'produkcja' },
      { teraz: TERAZ, kontaSrodowiska: [KANAL, DRUGIE] });
    expect(kody(w.bledy)).not.toContain('opis-kategorii');
    // Inne środowisko nie bierze pamięci kont produkcji.
    const s = ofertaAllegroKarty(db, b, { klucz: 'allegro_sandbox', nazwa: 'Sandbox', srodowisko: 'sandbox' },
      { teraz: TERAZ, kontaSrodowiska: ['allegro_sandbox'] });
    expect(kody(s.bledy)).toContain('kategoria');
  });

  it('liczba zapytań do bazy na kartę jest stała (zdjęcia, parametry, oferty)', async () => {
    const { db, a } = await bazaZImportem();
    const b = kartaReczna(db, { n: 7 });
    wgraj(db, zdjeciaKarty(db, b)[0].id, KANAL, 'https://a.allegroimg.com/original/aa/gliwka-1', '2026-11-20T00:00:00.000Z');
    wstawOferte(db, { kartaId: b, kanal: KANAL, idZewnetrzne: 'ext:QX7P2M-B' }, { teraz: T0 });
    db.prepare(`INSERT INTO karty_allegro (karta_id, nazwa, parametry_json, zmieniono_at) VALUES (?, 'Lampa Gliwka', ?, ?)`)
      .run(b, JSON.stringify([{ id: '224017', values: ['GL-1'] }, { id: '17448', values: ['1.2'] }]), T0);
    const c = kartaReczna(db, { n: 1 });
    ofertaAllegroKarty(db, a, KONTO, { teraz: TERAZ }); // pierwszy odczyt może utworzyć znak instalacji
    const na = zapytania(db, () => ofertaAllegroKarty(db, a, KONTO, { teraz: TERAZ }));
    const nb = zapytania(db, () => ofertaAllegroKarty(db, b, KONTO, { teraz: TERAZ }));
    const nc = zapytania(db, () => ofertaAllegroKarty(db, c, KONTO, { teraz: TERAZ }));
    expect(nb).toBe(na);
    expect(nc).toBe(na);
    expect(na).toBeLessThanOrEqual(16);
  });

  it('mapa wgranych zdjęć tylko tego konta: zdjęcie wgrane na inne konto idzie do wgrania', async () => {
    const { db } = await bazaZImportem();
    const b = kartaReczna(db, { n: 2 });
    const [z1, z2] = zdjeciaKarty(db, b);
    wgraj(db, z1.id, DRUGIE, 'https://a.allegroimg.com/original/aa/inne-konto-1', '2026-11-20T00:00:00.000Z');
    wgraj(db, z2.id, KANAL, 'https://a.allegroimg.com/original/aa/to-konto-2', '2026-11-20T00:00:00.000Z');
    const w = ofertaAllegroKarty(db, b, KONTO, { teraz: TERAZ });
    expect(w.zadanie.images).toEqual([`${ZNACZNIK_WGRANIA}${z1.id}`, 'https://a.allegroimg.com/original/aa/to-konto-2']);
    expect(w.doWgrania.map(z => z.id)).toEqual([z1.id]);
  });

  it('wygasa_at z bazy w jednym formacie ISO UTC z „Z” — strefa +01:00 i zapis SQLite bez strefy', async () => {
    const { db } = await bazaZImportem();
    const b = kartaReczna(db, { n: 3 });
    const [z1, z2, z3] = zdjeciaKarty(db, b);
    // 13:00+01:00 = 12:00Z, czyli przed TERAZ (12:30Z) — wygasłe, choć napis „13:00…” jest większy od „12:30…”.
    wgraj(db, z1.id, KANAL, 'https://a.allegroimg.com/original/aa/strefa', '2026-11-14T13:00:00+01:00');
    // Zapis SQLite (UTC, bez strefy) 12:45 — jeszcze ważny, choć jako napis („ ” < „T”) wypada przed TERAZ.
    wgraj(db, z2.id, KANAL, 'https://a.allegroimg.com/original/aa/sqlite', '2026-11-14 12:45:00');
    wgraj(db, z3.id, KANAL, 'https://a.allegroimg.com/original/aa/zepsute', 'jutro');
    const w = ofertaAllegroKarty(db, b, KONTO, { teraz: new Date(TERAZ) });
    expect(w.zadanie.images).toEqual([`${ZNACZNIK_WGRANIA}${z1.id}`, 'https://a.allegroimg.com/original/aa/sqlite',
      `${ZNACZNIK_WGRANIA}${z3.id}`]);
    expect(w.doWgrania.map(z => z.id)).toEqual([z1.id, z3.id]);
  });

  it('oferty karty w rejestrze i lustrze kont środowiska: jedna oferta liczona raz, druga → ostrzeżenie D43', async () => {
    const { db, a } = await bazaZImportem();
    // Rejestr tej samej oferty co w lustrze (id zewnętrzne = id oferty) — nie liczy się podwójnie.
    wstawOferte(db, { kartaId: a, kanal: KANAL, idZewnetrzne: String(WZOR.id), pochodzenie: 'przejeta', stan: 'aktywna' }, { teraz: T0 });
    const opcje = { teraz: TERAZ, kontaSrodowiska: [KANAL, DRUGIE] };
    expect(kody(ofertaAllegroKarty(db, a, KONTO, opcje).ostrzezenia)).not.toContain('dwie-oferty');
    // Oferta na koncie innego środowiska się nie liczy.
    wstawOferte(db, { kartaId: a, kanal: 'allegro_sandbox', idZewnetrzne: 'ext:SBX-1', stan: 'do_wyslania' }, { teraz: T0 });
    expect(kody(ofertaAllegroKarty(db, a, KONTO, opcje).ostrzezenia)).not.toContain('dwie-oferty');
    wstawOferte(db, { kartaId: a, kanal: DRUGIE, idZewnetrzne: 'ext:QX7P2M-A', stan: 'do_wyslania' }, { teraz: T0 });
    expect(kody(ofertaAllegroKarty(db, a, KONTO, opcje).ostrzezenia)).toContain('dwie-oferty');
  });

  it('konto null → wynik „bez konta”: tylko braki karty, bez zadania', async () => {
    const { db } = await bazaZImportem();
    const pusta = utworzKarte(db, { nazwa: 'Kinkiet Półcień bez zdjęć', kategoria_glowna: 'Lampy stołowe' }, { at: T0 });
    const w = ofertaAllegroKarty(db, pusta, null, { teraz: TERAZ });
    expect(w.bezKonta).toBe(true);
    expect(w.zadanie).toBeNull();
    expect(kody(w.bledy)).toEqual(expect.arrayContaining(['zdjecia', 'cena']));
    for (const kod of ['ustawienia', 'narzut', 'ilosc', 'czas-wysylki', 'producent', 'znak-instalacji', 'bezpieczenstwo']) {
      expect(kody(w.bledy)).not.toContain(kod);
    }
    const b = kartaReczna(db);
    const pelna = ofertaAllegroKarty(db, b, null, { teraz: TERAZ });
    expect(pelna.bledy).toEqual([]);
    expect(pelna.zadanie).toBeNull();
    expect(pelna.droga).toBe('nowy');
  });

  it('karty nie ma → karta null i błąd', async () => {
    const { db } = await bazaZImportem();
    const w = ofertaAllegroKarty(db, 999999, KONTO, { teraz: TERAZ });
    expect(w.karta).toBeNull();
    expect(w.zadanie).toBeNull();
    expect(kody(w.bledy)).toEqual(['karta']);
  });
});

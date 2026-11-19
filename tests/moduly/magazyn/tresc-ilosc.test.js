// Treść ofert (podgląd, objęcie) bierze ilość z `iloscDlaKanalu` (D47).
// Dane zmyślone: lampy „Pracownia Półcień”. Bez sieci; klienci kanałów to atrapy, których nikt nie woła.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Szpieg: podgląd ma liczyć migawkę stanów raz na żądanie, nie raz na kartę.
vi.mock('../../../src/oms/db/stany-magazynowe.js', async (importOriginal) => {
  const oryginal = await importOriginal();
  return { ...oryginal, migawkaStanow: vi.fn(oryginal.migawkaStanow) };
});

const { openOmsDb } = await import('../../../src/oms/db/db.ts');
const { modulyDla } = await import('../../../src/moduly/lista.ts');
const { ENV_DEMO } = await import('../../../scripts/demo-dane.mjs');
const { buildOmsServer } = await import('../../pomoc/serwer-testowy-oms.ts');
const { definicjeKanalowHistoryczne } = await import('../../pomoc/przykladowe-definicje-kanalow.js');
const { utworzKarte, zapiszProduktSklepowy, powiazProdukt } = await import('../../../src/oms/db/magazyn.js');
const { zapiszUstawieniaOfertKonta, zapiszZatwierdzenieStanow, wstawOferte } =
  await import('../../../src/oms/db/oferty-kanalow.ts');
const { migawkaStanow, przelaczStany, przelacznikStanow, dodajRuch } =
  await import('../../../src/oms/db/stany-magazynowe.js');
const { ustawCeneReczna } = await import('../../../src/oms/db/ceny-kanalow.js');
const { trescOferty } = await import('../../../src/moduly/magazyn/services/tresc-oferty.js');
const { ofertaAllegroKarty } = await import('../../../src/moduly/magazyn/services/tresc-oferty-allegro.js');
const { pobierzTrescOfertAllegro } = await import('../../../src/moduly/magazyn/services/allegro-tresc-kart.js');
const { ofertyAllegro, ofertaAllegroPelna, kategoriaAllegroDemo, parametryKategoriiAllegroDemo } =
  await import('../../../scripts/demo-dane-katalog.mjs');

const T0 = '2026-11-14T08:00:00.000Z';
const T1 = '2026-11-14T09:00:00.000Z';
const TERAZ = '2026-11-14T12:30:00.000Z';
const ERLI = 'erli-polcien';
const ALLEGRO = 'allegro';
const KONTO_ALLEGRO = { klucz: ALLEGRO, nazwa: 'Półcień Allegro', srodowisko: 'produkcja' };
const USTAWIENIA_ERLI = {
  czynne: false,
  narzutProcent: 10,
  stalaIlosc: 9,
  czasWysylkiDni: 2,
  cennikDostaw: 'Lampy',
  stawkaVat: '23',
  buforSzt: 2,
};

const bazy = [];
const katalogi = [];
afterEach(() => {
  vi.unstubAllGlobals();
  for (const db of bazy.splice(0)) if (db.isOpen) db.close();
  for (const k of katalogi.splice(0)) rmSync(k, { recursive: true, force: true });
});

function lampaErli(db, nazwa = 'Lampa Półcień Sowa', cena = 10000) {
  const id = utworzKarte(
    db,
    {
      nazwa,
      sku: `LMP-${nazwa.length}-${cena}-${Math.random().toString(36).slice(2, 7)}`,
      cena_gr: cena,
      stawka_vat: '23',
    },
    { at: T0 },
  );
  db.prepare(
    "INSERT INTO zdjecia_kart (karta_id, kolejnosc, zrodlo, adres_zrodlowy, utworzono_at) VALUES (?, 0, 'woo', 'https://polcien.example.invalid/lampa.png', ?)",
  ).run(id, T0);
  return id;
}

/** Stany włączone od T0; `zatwierdz` = zapis D51 dla bieżącego włączenia. */
function wlaczStany(db, { zatwierdz }) {
  przelaczStany(db, { wlacz: true, at: T0 });
  if (zatwierdz)
    zapiszZatwierdzenieStanow(
      db,
      { przelaczenieId: przelacznikStanow(db).przelaczenieId, zatwierdzil: 'operator', ofert: 1, skrot: 'skrot-testu' },
      { teraz: T1 },
    );
}
const przyjmij = (db, kartaId, ilosc) =>
  dodajRuch(db, { kartaId, rodzaj: 'przyjecie', ilosc, klucz: `przyjecie-${kartaId}`, at: T1 });

function bazaErli() {
  const db = openOmsDb(':memory:', { moduly: modulyDla(ENV_DEMO) });
  bazy.push(db);
  zapiszUstawieniaOfertKonta(db, ERLI, USTAWIENIA_ERLI);
  return db;
}
const tresc = (db, id) =>
  trescOferty(db, id, { ...USTAWIENIA_ERLI, narzutBp: 1000 }, '', { migawka: migawkaStanow(db) });

describe('E4.06 — ERLI: treść oferty z migawki', () => {
  it('stany wyłączone → stała ilość konta (D14)', () => {
    const db = bazaErli();
    const id = lampaErli(db);
    const w = tresc(db, id);
    expect(w.bledy).toEqual([]);
    expect(w.cialo.stock).toBe(9);
  });

  it('stany włączone i zatwierdzone, stan 7, bufor 2 → stock 5', () => {
    const db = bazaErli();
    const id = lampaErli(db);
    wlaczStany(db, { zatwierdz: true });
    przyjmij(db, id, 7);
    const w = tresc(db, id);
    expect(w.bledy).toEqual([]);
    expect(w.cialo.stock).toBe(5);
  });

  it('niezatwierdzone, zmiana ceny karty → ciało z price, bez stock, bez błędu', () => {
    const db = bazaErli();
    const id = lampaErli(db);
    wlaczStany(db, { zatwierdz: false });
    przyjmij(db, id, 7);
    db.prepare('UPDATE karty_produktow SET cena_gr = 12000 WHERE id = ?').run(id);
    const w = tresc(db, id);
    expect(w.bledy).toEqual([]);
    expect(w.cialo.price).toBe(13200);
    expect(w.cialo).not.toHaveProperty('stock');
  });

  it('brak stałej przy wyłączonych stanach → dzisiejszy błąd', () => {
    const db = bazaErli();
    const id = lampaErli(db);
    const w = trescOferty(db, id, { ...USTAWIENIA_ERLI, narzutBp: 1000, stalaIlosc: null }, '', {
      migawka: migawkaStanow(db),
    });
    expect(w.bledy).toContain('Ustaw stałą liczbę sztuk w konfiguratorze konta ERLI (całkowitą, nieujemną).');
    expect(w.cialo).toBeNull();
  });

  it('ręczna cena karty na tym koncie ERLI wygrywa z narzutem — pętla nie cofa ceny wysłanej z podglądu', () => {
    const db = bazaErli();
    const id = lampaErli(db);
    ustawCeneReczna(db, { kartaId: id, kanal: ERLI, cenaGr: 12345, kto: 'admin', at: T0 });
    const bezKlucza = tresc(db, id);
    const w = trescOferty(db, id, { ...USTAWIENIA_ERLI, klucz: ERLI, narzutBp: 1000 }, '', {
      migawka: migawkaStanow(db),
    });
    expect(w.bledy).toEqual([]);
    expect(w.cialo.price).toBe(12345);
    // Ręczna cena innego konta nie przechodzi na to, które nie ma klucza w ustawieniach.
    expect(bezKlucza.cialo.price).not.toBe(12345);
  });
});

// --- Allegro: karta z importu demo (jak E3.06b), konto z buforem 2 ---
const WZOR = ofertaAllegroPelna(ALLEGRO, ofertyAllegro(ALLEGRO)[0].id);
const klientAtrapa = () => ({
  pobierzOferte: vi.fn(async (id) => ({ ...WZOR, id: String(id) })),
  pobierzKategorie: vi.fn(async (id) => kategoriaAllegroDemo(id)),
  pobierzParametryKategorii: vi.fn(async (id) => parametryKategoriiAllegroDemo(id)),
});
async function bazaAllegro() {
  const db = openOmsDb(':memory:', { moduly: modulyDla(ENV_DEMO) });
  bazy.push(db);
  const a = utworzKarte(
    db,
    { nazwa: 'Pracownia Półcień — Lampa Sowa 30 cm', cena_gr: 5900, stawka_vat: '23', marka: 'Pracownia Półcień' },
    { at: T0 },
  );
  db.prepare('UPDATE karty_produktow SET informacja_bezpieczenstwa = ? WHERE id = ?').run(
    JSON.stringify({ typ: 'TEXT', tekst: 'Nie zostawiaj włączonej lampy bez nadzoru.' }),
    a,
  );
  const pid = zapiszProduktSklepowy(db, {
    kanal: ALLEGRO,
    produkt_id: WZOR.id,
    wariant_id: '',
    nazwa: WZOR.name,
    status_publikacji: 'ACTIVE',
    odczytane_at: T0,
  });
  powiazProdukt(db, pid, a);
  const katalog = mkdtempSync(join(tmpdir(), 'oms-e406-'));
  katalogi.push(katalog);
  const adresy = [];
  const wynik = await pobierzTrescOfertAllegro({
    db,
    allegro: { [ALLEGRO]: klientAtrapa() },
    kanalyAllegro: [ALLEGRO],
    katalog,
    teraz: () => new Date(T0),
    pobierzZdjecie: async (adres) => adres,
    czekaj: async () => {},
    zapiszZdjecie: async (adres) => {
      if (!adresy.includes(adres)) adresy.push(adres);
      return {
        sha256: String(adresy.indexOf(adres) + 1).repeat(64),
        plik: `z${adresy.indexOf(adres)}.jpg`,
        typ: 'image/jpeg',
        rozmiar: 1,
      };
    },
  });
  expect(wynik).toMatchObject({ pobrane: 1, bledy: [], blad: null });
  zapiszUstawieniaOfertKonta(
    db,
    ALLEGRO,
    {
      narzutProcent: 0,
      stalaIlosc: 9,
      czasWysylkiDni: 2,
      cennikDostaw: 'cennik-1',
      stawkaVat: '23',
      zwrotyId: 'zwrot-1',
      reklamacjeId: 'rekl-1',
      producentId: 'prod-konta',
      buforSzt: 2,
    },
    { teraz: T0 },
  );
  return { db, a };
}
const allegroZMigawka = (db, a) =>
  ofertaAllegroKarty(db, a, KONTO_ALLEGRO, { teraz: TERAZ, migawka: migawkaStanow(db) });

describe('E4.06 — Allegro: treść oferty z migawki', () => {
  it('stany wyłączone → stock.available = stała', async () => {
    const { db, a } = await bazaAllegro();
    const w = allegroZMigawka(db, a);
    expect(w.bledy).toEqual([]);
    expect(w.zadanie.stock).toEqual({ available: 9, unit: 'UNIT' });
  });

  it('włączone i zatwierdzone, stan 7, bufor 2 → stock.available 5', async () => {
    const { db, a } = await bazaAllegro();
    wlaczStany(db, { zatwierdz: true });
    przyjmij(db, a, 7);
    const w = allegroZMigawka(db, a);
    expect(w.bledy).toEqual([]);
    expect(w.zadanie.stock).toEqual({ available: 5, unit: 'UNIT' });
  });

  it('niezatwierdzone → cena jest, ilości brak, bez błędu', async () => {
    const { db, a } = await bazaAllegro();
    wlaczStany(db, { zatwierdz: false });
    db.prepare('UPDATE karty_produktow SET cena_gr = 6900 WHERE id = ?').run(a);
    const w = allegroZMigawka(db, a);
    expect(w.bledy).toEqual([]);
    expect(w.zadanie.sellingMode.price).toEqual({ amount: '69.00', currency: 'PLN' });
    expect(w.zadanie).not.toHaveProperty('stock');
  });

  it('karta z wierszami Woo w rejestrze → ostrzeżenia D43 i problemy karty bez zmian (regresja)', async () => {
    const { db, a } = await bazaAllegro();
    for (const n of [1, 2])
      wstawOferte(db, {
        kartaId: a,
        kanal: 'woo-polcien',
        idZewnetrzne: `woo-${n}`,
        stan: 'aktywna',
        pochodzenie: 'przejeta',
        tryb: 'obserwowana',
      });
    const bez = ofertaAllegroKarty(db, a, KONTO_ALLEGRO, { teraz: TERAZ });
    const z = allegroZMigawka(db, a);
    expect(z.ostrzezenia.map((o) => o.kod)).not.toContain('dwie-oferty');
    expect(z.ostrzezenia).toEqual(bez.ostrzezenia);
    expect(z.bledy).toEqual(bez.bledy);
    const kandydat = ofertaAllegroKarty(db, a, null, { srodowisko: 'produkcja' });
    expect(kandydat.bledy).toEqual([]);
  });
});

// --- Ekran „Wystaw oferty” ERLI ---
const auth = {
  authorization: `Basic ${Buffer.from('operator:atrapa').toString('base64')}`,
  origin: 'http://localhost',
};
async function serwer() {
  const db = bazaErli();
  const klient = {
    utworzProdukt: vi.fn(),
    zmienProdukt: vi.fn(),
    szukajProduktow: vi.fn(),
    zmienIlosciCeny: vi.fn(),
    pobierzProdukt: vi.fn(),
  };
  const app = buildOmsServer({
    db,
    config: {
      auth: { user: 'operator', pass: 'atrapa' },
      definicje: [
        ...definicjeKanalowHistoryczne,
        { klucz: ERLI, typ: 'erli', prefiks: 'ERLI_POLCIEN', etykieta: 'ERLI Półcień' },
      ],
    },
    magazyn: { stan: () => ({ trwa: false, kanaly: [] }) },
    nadpisania: {
      'kanaly.klienciKanalow': { [ERLI]: klient },
      'kanaly.repozytoriumKanalow': {
        listaTypu: (typ) => (typ === 'erli' ? [{ klucz: ERLI, nazwa: 'Półcień' }] : []),
        zapisyZablokowane: () => false,
      },
    },
  });
  await app.ready();
  const podglad = (zaznaczone) =>
    app.inject({ method: 'POST', url: '/magazyn/oferty/podglad', payload: { konto: ERLI, zaznaczone }, headers: auth });
  return { db, app, klient, podglad };
}

describe('podgląd „Wystaw oferty”', () => {
  it('stany nigdy niewłączone → bez zdania o ilości z ustawień konta, ilość stała przy karcie', async () => {
    const { db, app, podglad } = await serwer();
    try {
      const r = await podglad([lampaErli(db)]);
      expect(r.statusCode).toBe(200);
      expect(r.body).not.toContain('Ilość w ofertach');
      expect(r.body).toContain('Ilość: 9');
    } finally {
      await app.close();
    }
  });

  it('brak stanu karty → ostrzeżenie, nie odmowa; nagłówek „stan magazynu − bufor 2”', async () => {
    const { db, app, klient, podglad } = await serwer();
    try {
      const znana = lampaErli(db, 'Lampa Półcień znana');
      const nieznana = lampaErli(db, 'Lampa Półcień nieznana');
      wlaczStany(db, { zatwierdz: true });
      przyjmij(db, znana, 7);
      const r = await podglad([znana, nieznana]);
      expect(r.statusCode).toBe(200);
      expect(r.body).not.toContain('Odmowa:');
      expect(r.body).not.toContain('z ustawień konta.');
      expect(r.body).toContain('stan magazynu − bufor 2');
      expect(r.body).toContain('Ilość: 5');
      expect(r.body).toContain('Ilość: czeka na stan magazynu');
      expect(r.body).toMatch(/class="pasek-uwaga">[^<]*czeka na stan magazynu/);
      for (const f of Object.values(klient)) expect(f).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('niezatwierdzone → „zatwierdź podgląd stanów”, bez odmowy', async () => {
    const { db, app, podglad } = await serwer();
    try {
      const id = lampaErli(db);
      wlaczStany(db, { zatwierdz: false });
      const r = await podglad([id]);
      expect(r.body).not.toContain('Odmowa:');
      expect(r.body).toContain('Ilość: zatwierdź podgląd stanów');
    } finally {
      await app.close();
    }
  });

  it('stany wyłączone po włączeniu → „stała 9”', async () => {
    const { db, app, podglad } = await serwer();
    try {
      const id = lampaErli(db);
      wlaczStany(db, { zatwierdz: true });
      przelaczStany(db, { wlacz: false, at: TERAZ });
      const r = await podglad([id]);
      expect(r.body).toContain('stała 9');
      expect(r.body).toContain('Ilość: 9');
    } finally {
      await app.close();
    }
  });

  it('podgląd 50 kart → migawka stanów liczona raz', async () => {
    const { db, app, podglad } = await serwer();
    try {
      wlaczStany(db, { zatwierdz: true });
      const ids = Array.from({ length: 50 }, (_, i) => lampaErli(db, `Lampa Półcień nr ${i + 1}`));
      vi.mocked(migawkaStanow).mockClear();
      const r = await podglad(ids);
      expect(r.statusCode).toBe(200);
      expect(r.body.match(/Ilość: czeka na stan magazynu/g)).toHaveLength(50);
      expect(vi.mocked(migawkaStanow)).toHaveBeenCalledTimes(1);
    } finally {
      await app.close();
    }
  });
});

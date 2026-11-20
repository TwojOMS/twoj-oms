// Hurtowe wystawianie ofert z listy Magazynu: w demo publicznym może go użyć także gość (znacznik `podgladDemo`),
// bo wszystkie kanały demo to atrapy. Inne konto bez admina — w demo i na zwykłej instancji — nadal nie.
//
// Aplikacja złożona jak demo publiczne: baza z `zalozBazeDemo` (administrator, gość `demo`, zespół z ZESPOL_DEMO),
// moduły i nadpisania usług z atrap piaskownicy, konto gościa z OMS_DEMO_LOGIN — tylko wtedy powstaje znacznik.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { ENV_DEMO } from '../../../scripts/demo-dane.mjs';
import { zalozBazeDemo, ZESPOL_DEMO } from '../../../deploy/demo/baza.mjs';
import { modulyPiaskownicy, nadpisaniaPiaskownicy } from '../../../deploy/proba/atrapy/index.mjs';
import { zbudujAplikacje } from '../../../src/core/aplikacja.ts';
import { openOmsDb, otworzBazeStartu } from '../../../src/oms/db/db.ts';
import { zalozKonto } from '../../../src/core/bezpieczenstwo/konta.js';
import { podpisz } from '../../../src/core/bezpieczenstwo/sesja.js';
import { wczytajSekret } from '../../../src/core/bezpieczenstwo/sekret-sesji.js';
import { utworzKarte } from '../../../src/oms/db/magazyn.js';
import { zapiszOtwarcie } from '../../../src/oms/db/stany-magazynowe.js';
import {
  ofertaPoId,
  wstawOferte,
  zmienOferte,
  zapiszUstawieniaOfertKonta,
  ustawieniaOfertKonta,
} from '../../../src/oms/db/oferty-kanalow.ts';

const ADMIN = { login: 'admin-polcien', imie: 'Administrator Półcień', haslo: 'haslo-testu-ofert-1' };
const GOSC = 'demo';
const ANNA = ZESPOL_DEMO[0][0];
const ERLI = 'erli_polcien';
const ALLEGRO = 'allegro';
const TRASY_HURTU = ['/magazyn/oferty/podglad', '/magazyn/oferty/zatwierdz', '/magazyn/oferty/aktywuj'];
const ZRZUT = process.env.OMS_ZRZUT_HTML_OFERT ?? '';

/** Fragment paska „Zaznaczone karty” z formularzem hurtowych ofert (pusty, gdy go nie ma). */
const pasekOfert = (html) => /<section[^>]*id="oferty-pasek"[\s\S]*?<\/section>/.exec(html)?.[0] ?? '';
const kontaWPasku = (html) =>
  [...pasekOfert(html).matchAll(/<input type="radio" name="konto" value="([^"]+)"/g)].map((m) => m[1]);
const tokenPodgladu = (html) => /name="podglad" value="([^"]+)"/.exec(html)?.[1];

function klient(app, db, login, nazwaCiasteczka = 'sesja_oms_proba') {
  const headers = {
    cookie: `${nazwaCiasteczka}=${podpisz(login, wczytajSekret(db), Date.now())}`,
    origin: 'http://localhost',
  };
  return {
    get: (url) => app.inject({ method: 'GET', url, headers }),
    post: (url, payload) => app.inject({ method: 'POST', url, headers, payload }),
  };
}

describe('demo publiczne — gość wystawia oferty hurtem na atrapach', () => {
  let katalog, db, aplikacja, gosc, admin, anna;
  const logi = [];

  beforeAll(async () => {
    katalog = fs.mkdtempSync(path.join(os.tmpdir(), 'oferty-hurt-demo-'));
    const sciezka = path.join(katalog, 'oms.sqlite');
    const env = {
      ...ENV_DEMO,
      OMS_KLUCZ_SEKRETOW: randomBytes(32).toString('base64url'),
      OMS_DB_PATH: sciezka,
      OMS_USER: 'serwis-demo',
      OMS_PASS: randomBytes(12).toString('base64url'),
      OMS_PROFORMY_KATALOG: path.join(katalog, 'proformy'),
      OMS_ETYKIETY_KATALOG: path.join(katalog, 'etykiety'),
      OMS_DEMO_LOGIN: GOSC,
      OMS_DEMO_HASLO: 'demo',
    };
    await zalozBazeDemo({ baza: sciezka, dzis: '2026-11-18', env, kontoAdmina: ADMIN });
    const moduly = modulyPiaskownicy(env, { baza: () => db });
    db = otworzBazeStartu(env, sciezka, { moduly, bezKataloguBazy: true });
    aplikacja = await zbudujAplikacje({
      db,
      moduly,
      env,
      nadpisania: nadpisaniaPiaskownicy({ db, env, log: () => {} }),
      log: (...c) => logi.push(c.join(' ')),
    });
    // Konto ERLI demo nie ma ustawień ofert — administrator uzupełnia je w Konfiguratorze; gość Ustawień nie zapisze.
    zapiszUstawieniaOfertKonta(db, ERLI, {
      czynne: true,
      stalaIlosc: 5,
      czasWysylkiDni: 2,
      cennikDostaw: 'Lampy',
      stawkaVat: '23',
    });
    gosc = klient(aplikacja.app, db, GOSC);
    admin = klient(aplikacja.app, db, ADMIN.login);
    anna = klient(aplikacja.app, db, ANNA);
  }, 120_000);

  afterAll(async () => {
    await aplikacja?.app.close();
    db?.close();
    if (katalog) fs.rmSync(katalog, { recursive: true, force: true });
  });

  // Karta gotowa do oferty: cena, zdjęcie i znany stan (katalog demo bywa bez nich — to nie jest przedmiot tego testu).
  const nowaKarta = (sku) => {
    const id = utworzKarte(db, { nazwa: `Lampa Gliwka ${sku}`, sku, cena_gr: 12900, stawka_vat: '23' });
    db.prepare(
      "INSERT INTO zdjecia_kart (karta_id, kolejnosc, zrodlo, adres_zrodlowy, utworzono_at) VALUES (?, 0, 'woo', 'https://polcien.example/lampa.png', '2026-11-18')",
    ).run(id);
    zapiszOtwarcie(db, { kartaId: id, ilosc: 4, zrodlo: 'reczne' });
    return id;
  };

  it('gość widzi „Wystaw oferty” z tymi samymi kontami co administrator', async () => {
    const [g, a] = [await gosc.get('/magazyn'), await admin.get('/magazyn')];
    expect([g.statusCode, a.statusCode]).toEqual([200, 200]);
    expect(kontaWPasku(a.body)).toContain(ERLI);
    expect(kontaWPasku(g.body)).toEqual(kontaWPasku(a.body));
    expect(pasekOfert(g.body)).toContain('Pokaż podgląd — dla zaznaczonych');
    if (ZRZUT) fs.writeFileSync(path.join(ZRZUT, 'lista-gosc.html'), g.body);
  });

  it('gość: podgląd ERLI → zatwierdzenie → oferta trafia do atrapy kanału', async () => {
    const id = nowaKarta('GOSC-ERLI-1');
    const podglad = await gosc.post('/magazyn/oferty/podglad', { konto: ERLI, zaznaczone: [id] });
    expect(podglad.statusCode).toBe(200);
    if (ZRZUT) fs.writeFileSync(path.join(ZRZUT, 'podglad-gosc.html'), podglad.body);
    const token = tokenPodgladu(podglad.body);
    expect(token).toBeTruthy();
    const zapis = await gosc.post('/magazyn/oferty/zatwierdz', { konto: ERLI, zaznaczone: [id], podglad: token });
    expect(zapis.statusCode).toBe(303);
    // Gość demo ma prawo do ekranu wyniku tak samo jak do zatwierdzenia.
    const wynik = await gosc.get(zapis.headers.location);
    expect(wynik.statusCode).toBe(200);
    expect(wynik.body).toContain('W kolejce do wysłania: 1.');
    if (ZRZUT) fs.writeFileSync(path.join(ZRZUT, 'wynik-gosc.html'), wynik.body);
    const oferta = db.prepare('SELECT * FROM oferty_kanalow WHERE karta_id = ? AND kanal = ?').get(id, ERLI);
    expect(oferta).toMatchObject({ stan: 'do_wyslania', pochodzenie: 'oms' });
    // Pętla ofert wysyła do atrapy ERLI — nic nie wychodzi poza proces.
    await aplikacja.zegary.find((z) => z.nazwa === 'petlaOfert').przebieg();
    expect(logi.filter((l) => l.startsWith('oferty-erli: przebieg:'))).toEqual([]);
    expect(ofertaPoId(db, oferta.id)).toMatchObject({ stan: 'sprawdzana', blad: null, wyslanaCenaGr: 12900 });
  });

  it('gość: „Aktywuj w Allegro” oznacza szkic tak jak u administratora', async () => {
    const id = nowaKarta('GOSC-ALG-1');
    const o = wstawOferte(db, {
      kartaId: id,
      kanal: ALLEGRO,
      idZewnetrzne: '7700000301',
      stan: 'nieaktywna',
      pochodzenie: 'oms',
      tryb: 'zarzadzana',
    });
    zmienOferte(db, o.id, { wyslanePola: { szkic: true } });
    const r = await gosc.post('/magazyn/oferty/aktywuj', { konto: ALLEGRO, zaznaczone: [id] });
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain('Do aktywacji: 1.');
    expect(ofertaPoId(db, o.id).wyslanePola).toMatchObject({ szkic: true, aktywuj: true });
  });

  it('gość przy braku w ustawieniach konta: pasek z prośbą do administratora, bez formularza; zapis 403', async () => {
    const id = nowaKarta('GOSC-BRAK-1');
    const czasPrzed = ustawieniaOfertKonta(db, ERLI).czasWysylkiDni;
    zapiszUstawieniaOfertKonta(db, ERLI, { czasWysylkiDni: null });
    try {
      const r = await gosc.post('/magazyn/oferty/podglad', { konto: ERLI, zaznaczone: [id] });
      expect(r.statusCode).toBe(200);
      expect(r.body).toContain('Uzupełnij ustawienia: czas wysyłki.');
      expect(r.body).toContain('Poproś administratora o uzupełnienie.');
      expect(r.body).not.toContain('Zapisz i odśwież podgląd');
      const zapis = await gosc.post('/magazyn/oferty/ustawienia-konta', {
        konto: ERLI,
        zaznaczone: [id],
        czasWysylkiDni: '3',
      });
      expect(zapis.statusCode).toBe(403);
    } finally {
      zapiszUstawieniaOfertKonta(db, ERLI, { czasWysylkiDni: czasPrzed });
    }
  });

  it('gość dalej nie steruje ceną ani nie oddaje jej kanałowi (pozostałe trasy ofert tylko dla admina)', async () => {
    const id = nowaKarta('GOSC-CENA-1');
    for (const url of ['/magazyn/oferty/steruj-cena/podglad', '/magazyn/oferty/oddaj-cene'])
      expect((await gosc.post(url, { konto: ERLI, zaznaczone: [id] })).statusCode, url).toBe(403);
  });

  it(`konto z zespołu demo bez admina („${ANNA}”, Sprzedaż): brak paska ofert i 403 na trzech trasach`, async () => {
    const lista = await anna.get('/magazyn');
    expect(lista.statusCode).toBe(200);
    expect(pasekOfert(lista.body)).toBe('');
    const id = nowaKarta('ANNA-1');
    for (const url of TRASY_HURTU)
      expect((await anna.post(url, { konto: ERLI, zaznaczone: [id] })).statusCode, url).toBe(403);
  });

  it('administrator demo bez zmian: podgląd 200', async () => {
    const id = nowaKarta('ADMIN-ERLI-1');
    expect((await admin.post('/magazyn/oferty/podglad', { konto: ERLI, zaznaczone: [id] })).statusCode).toBe(200);
  });
});

describe('zwykła instancja (bez konta gościa demo)', () => {
  let db, aplikacja;
  beforeAll(async () => {
    const env = {
      ...ENV_DEMO,
      OMS_USER: 'serwis',
      OMS_PASS: 'fixture',
      OMS_PROFORMY_KATALOG: path.join(os.tmpdir(), 'oferty-hurt-proformy'),
      OMS_ETYKIETY_KATALOG: path.join(os.tmpdir(), 'oferty-hurt-etykiety'),
    };
    db = openOmsDb(':memory:');
    aplikacja = await zbudujAplikacje({ db, moduly: modulyPiaskownicy(env), env, log: () => {} });
    zalozKonto(db, { login: 'admin', imie: 'Administrator', haslo: 'fixture', rola: 'administrator', admin: true });
    // Ten sam login co gość demo — bez OMS_DEMO_LOGIN to zwykłe konto Sprzedaż, bez znacznika podglądu.
    zalozKonto(db, { login: GOSC, imie: 'Sprzedawca', haslo: 'fixture', rola: 'sprzedaz' });
  });
  afterAll(async () => {
    await aplikacja?.app.close();
    db?.close();
  });

  it('konto Sprzedaż: brak paska ofert i 403 na trzech trasach; administrator widzi pasek', async () => {
    const id = utworzKarte(db, { nazwa: 'Lampa Gliwka', sku: 'ZWYKLA-1' });
    const sprzedaz = klient(aplikacja.app, db, GOSC);
    const lista = await sprzedaz.get('/magazyn');
    expect(lista.statusCode).toBe(200);
    expect(pasekOfert(lista.body)).toBe('');
    for (const url of TRASY_HURTU)
      expect((await sprzedaz.post(url, { konto: ERLI, zaznaczone: [id] })).statusCode, url).toBe(403);
    expect(pasekOfert((await klient(aplikacja.app, db, 'admin').get('/magazyn')).body)).not.toBe('');
  });
});

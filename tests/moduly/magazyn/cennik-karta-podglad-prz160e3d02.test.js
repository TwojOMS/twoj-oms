// PRZ-160 E3d.02-03 — wyjątek cennika dostaw na karcie (per konto Allegro i ERLI), podgląd „Wystaw na…” z linią
// „Cennik: <nazwa> — <powód>”, odmowa karty bez wymiarów/wagi przy regułach rozmiaru, zapis wyjątku Allegro tylko
// z listy cenników konta. Decyzja kierownika: wyjątek z karty wystarcza także na koncie bez reguł (Allegro jak ERLI).
// Klienci Allegro i ERLI to atrapy; dane zmyślone („Pracownia Półcień”, lampy).
import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { buildOmsServer } from '../../pomoc/serwer-parytetu.ts';
import { definicjeKanalowHistoryczne } from '../../pomoc/kanaly-historyczne-fixture.js';
import { szyfrTestowy } from '../../pomoc/sejf-testowy.ts';
import { utworzKarte } from '../../../src/oms/db/magazyn.js';
import { ofertyKarty, wstawOferte, zmienOferte, zapiszUstawieniaOfertKonta, ustawieniaOfertKonta } from '../../../src/oms/db/oferty-kanalow.ts';
import { wyjatekCennika, zapiszWyjatekCennika, usunWyjatekCennika } from '../../../src/oms/db/cenniki-kart.ts';
import { migracjaCennikowDostaw } from '../../../src/moduly/magazyn/migracje/0003-cenniki-dostaw.ts';
import { ofertaAllegroKarty } from '../../../src/moduly/magazyn/services/tresc-oferty-allegro.js';
import { trescOferty } from '../../../src/moduly/magazyn/services/tresc-oferty.js';
import { opisKategorii } from '../../../src/domena/tresc-oferty-allegro.js';
import { kategoriaAllegroDemo, parametryKategoriiAllegroDemo } from '../../../scripts/demo-dane-katalog.mjs';
import { zalozKonto, ustawUprawnienia } from '../../../src/core/bezpieczenstwo/konta.js';
import { podpisz, NAZWA_CIASTECZKA_OMS } from '../../../src/core/bezpieczenstwo/sesja.js';
import { wczytajSekret } from '../../../src/core/bezpieczenstwo/sekret-sesji.js';
import slowniki from '../../fixtures/allegro/e3-dok-slowniki.json' with { type: 'json' };

const KONTO = 'allegro_polcien';
const ERLI = 'erli-polcien';
const T0 = '2026-11-14T08:00:00.000Z';
const OFERTY = ['allegro:api:sale:offers:write', 'allegro:api:sale:settings:read'];
const ODMOWA_WYMIAROW = 'Odmowa: Brak wymiarów/wagi — OMS nie wie, czy produkt zmieści się w paczkomacie. '
  + 'Uzupełnij wymiary albo ustaw cennik na karcie.';
const jwt = scope => ['e30', Buffer.from(JSON.stringify({ scope })).toString('base64url'), 'podpis'].join('.');
const auth = { authorization: `Basic ${Buffer.from('operator:atrapa').toString('base64')}`, origin: 'http://localhost' };

// Reguły z planu §1: paczkomat A, paczkomat C, dla większych. Allegro: identyfikatory z listy konta; ERLI: nazwy.
const REGULY_ALLEGRO = [
  { doMm: [80, 380, 640], doG: 25000, cennik: 'cen-a' },
  { doMm: [410, 380, 640], doG: 25000, cennik: 'cen-c' },
  { cennik: 'cen-gabaryt' },
];
const REGULY_ERLI = [
  { doMm: [80, 380, 640], doG: 25000, cennik: 'Paczkomat A' },
  { doMm: [410, 380, 640], doG: 25000, cennik: 'Paczkomat C' },
  { cennik: 'Kurier gabaryt' },
];
const CENNIKI_KONTA = [
  { id: 'cen-a', nazwa: 'Pracownia Półcień — paczkomat A' },
  { id: 'cen-c', nazwa: 'Pracownia Półcień — paczkomat C' },
  { id: 'cen-gabaryt', nazwa: 'Pracownia Półcień — kurier gabaryt' },
  { id: 'cennik-1', nazwa: 'Pracownia Półcień — standard' },
];
// Wymiary w mm i waga w g; `null` = brak na karcie.
const MALA = { szerokosc_mm: 630, wysokosc_mm: 370, glebokosc_mm: 60, waga_g: 2000 };
const SREDNIA = { szerokosc_mm: 640, wysokosc_mm: 380, glebokosc_mm: 300, waga_g: 4000 };
const DUZA = { szerokosc_mm: 900, wysokosc_mm: 500, glebokosc_mm: 500, waga_g: 12000 };
const BEZ_WAGI = { szerokosc_mm: 300, wysokosc_mm: 300, glebokosc_mm: 300 };

let db, app, klienci;
const post = (url, payload, headers = auth) => app.inject({ method: 'POST', url, payload, headers });
const get = (url, headers = auth) => app.inject({ method: 'GET', url, headers });
const podglad = (zaznaczone, konto = KONTO) => post('/magazyn/oferty/podglad', { konto, zaznaczone });
const zatwierdz = (r, zaznaczone, konto = KONTO) => post('/magazyn/oferty/zatwierdz',
  { konto, zaznaczone, podglad: /name="podglad" value="([^"]+)"/.exec(r.body)?.[1] });
const zapiszCennik = (id, pola, headers) => post(`/magazyn/${id}/cenniki`, pola, headers);
const sekcja = body => body.match(/<section[^>]*id="cenniki-karty"[\s\S]*?<\/section>/)?.[0] ?? '';
/** Sekcja podglądu jednej karty (nagłówek z odnośnikiem do karty). */
const wierszPodgladu = (body, id) => body.match(new RegExp(`<a href="/magazyn/${id}">[\\s\\S]*?</section>`))?.[0] ?? '';
const atrapa = () => ({
  podgladOplat: vi.fn(async () => structuredClone(slowniki.podgladOplat)),
  utworzOferte: vi.fn(), zmienOferte: vi.fn(), zmienStatusOferty: vi.fn(), komendaIlosci: vi.fn(), komendaCeny: vi.fn(),
  pobierzOferte: vi.fn(), wgrajZdjecie: vi.fn(),
});

/** Karta gotowa do wystawienia na Allegro i ERLI (kategoria z mapy, marka, GPSR konta, 3 zdjęcia) z podanym rozmiarem. */
function karta(n, rozmiar) {
  const id = utworzKarte(db, { nazwa: `Lampa stołowa Gliwka ${n}`, sku: `GLW-${n}`, cena_gr: 5900, stawka_vat: '23',
    marka: 'Pracownia Półcień', kategoria_glowna: 'Lampy stołowe', ...rozmiar,
    opis_sekcje_json: JSON.stringify({ sekcje: [{ elementy: [{ typ: 'tekst', html: '<p>Lampa z mlecznym kloszem.</p>' }] }] }) },
  { at: T0 });
  db.prepare('UPDATE karty_produktow SET informacja_bezpieczenstwa = ? WHERE id = ?')
    .run(JSON.stringify({ typ: 'TEXT', tekst: 'Nie zostawiaj włączonej lampy bez nadzoru.' }), id);
  const zdj = db.prepare(`INSERT INTO zdjecia_kart (karta_id, kolejnosc, zrodlo, adres_zrodlowy, sha256, typ, ai, ai_reczne, utworzono_at)
    VALUES (?, ?, 'reczne', ?, NULL, 'image/jpeg', 0, 1, ?)`);
  for (let i = 0; i < 3; i++) zdj.run(id, i, `https://polcien.example.invalid/gliwka-${id}-${i + 1}.jpg`, T0);
  return id;
}

beforeEach(async () => {
  db = openOmsDb(':memory:');
  klienci = { [KONTO]: atrapa(), [ERLI]: { utworzProdukt: vi.fn(), zmienProdukt: vi.fn() } };
  app = buildOmsServer({ db, config: { auth: { user: 'operator', pass: 'atrapa' },
    definicje: [...definicjeKanalowHistoryczne, { klucz: ERLI, typ: 'erli', prefiks: 'ERLI_POLCIEN', etykieta: 'ERLI Półcień' }] },
    magazyn: { stan: () => ({ trwa: false, kanaly: [] }) },
    nadpisania: { 'kanaly.klienciKanalow': klienci, 'kanaly.repozytoriumKanalow': {
      listaTypu: typ => (typ === 'allegro' ? [{ klucz: KONTO, nazwa: 'Półcień', autoryzacja: 'polaczone', srodowisko: 'produkcja' }]
        : typ === 'erli' ? [{ klucz: ERLI, nazwa: 'Półcień' }] : []),
      zapisyZablokowane: () => false, konfliktKlucza: () => false,
    } },
  });
  await app.ready();
  db.prepare(`INSERT OR REPLACE INTO tokeny_kanalu (kanal, access_token, refresh_token, wygasa_at, refresh_wygasa_at, zaktualizowane_at)
    VALUES (?, ?, ?, '2026-11-14T11:00:00Z', '2027-01-01T00:00:00Z', '2026-11-14T10:00:00Z')`)
    .run(KONTO, szyfrTestowy(db, 'tokeny_kanalu', 'access_token', KONTO, jwt(['allegro:api:orders:read', ...OFERTY])),
      szyfrTestowy(db, 'tokeny_kanalu', 'refresh_token', KONTO, 'REFRESH-ATRAPA'));
  db.prepare(`INSERT INTO allegro_mapa_kategorii (kategoria_karty, srodowisko, kategoria_allegro_id) VALUES ('Lampy stołowe', 'produkcja', '257')`).run();
  const regula = db.prepare(`INSERT INTO allegro_reguly_parametrow (srodowisko, kategoria_allegro_id, parametr_id, rodzaj,
    wartosc_json, pole, zmieniono_at) VALUES ('produkcja', '257', ?, ?, ?, ?, ?)`);
  regula.run('11323', 'stala', JSON.stringify({ valuesIds: ['11323_1'] }), null, T0);
  regula.run('248811', 'pole', null, 'marka', T0);
  db.prepare(`INSERT INTO allegro_marki (marka, srodowisko, parametr_id, wartosc_id, kategorie_sprawdzone_json, zmieniono_at)
    VALUES ('Pracownia Półcień', 'produkcja', '248811', '248811_9001', '["257"]', ?)`).run(T0);
  const opis = opisKategorii(['5', '256', '257'].map(kategoriaAllegroDemo), parametryKategoriiAllegroDemo('257'));
  db.prepare(`INSERT INTO allegro_marki_gpsr (marka, konto, zrodlo, zmieniono_at) VALUES ('Pracownia Półcień', ?, 'konto', ?)`).run(KONTO, T0);
  db.prepare(`INSERT INTO kanaly_kategorie (polaczenie, kategoria_id, sciezka_json, parametry_json, pobrano_at) VALUES (?, '257', ?, ?, ?)`)
    .run(KONTO, JSON.stringify(opis.sciezka), JSON.stringify({ wersja: opis.wersja, lisc: opis.lisc, tworzenieProduktu: opis.tworzenieProduktu, parametry: opis.parametry }), T0);
  zapiszUstawieniaOfertKonta(db, KONTO, { narzutProcent: 0, stalaIlosc: 5, czasWysylkiDni: 2, cennikDostaw: 'cennik-1',
    stawkaVat: '23', zwrotyId: 'zwrot-1', reklamacjeId: 'rekl-1', producentId: 'prod-konta',
    slowniki: { pobranoAt: T0, cenniki: CENNIKI_KONTA, zwroty: [], reklamacje: [], gwarancje: [], producenci: [], osoby: [] } }, { teraz: T0 });
  zapiszUstawieniaOfertKonta(db, ERLI, { narzutProcent: 0, stalaIlosc: 5, czasWysylkiDni: 2, cennikDostaw: 'Lampy', stawkaVat: '23' }, { teraz: T0 });
});
afterEach(async () => { await app.close(); db.close(); });

const regulyRozmiaru = () => {
  zapiszUstawieniaOfertKonta(db, KONTO, { cenniki: REGULY_ALLEGRO }, { teraz: T0 });
  zapiszUstawieniaOfertKonta(db, ERLI, { cenniki: REGULY_ERLI }, { teraz: T0 });
};

describe('podgląd Allegro — cennik i powód', () => {
  it('reguła 1, reguła 2 i „dla większych” z nazwą ze słownika konta; karta bez wagi → odmowa, Zatwierdź ją pomija', async () => {
    regulyRozmiaru();
    const [a, b, c, d] = [karta(1, MALA), karta(2, SREDNIA), karta(3, DUZA), karta(4, BEZ_WAGI)];
    const r = await podglad([a, b, c, d]);
    expect(r.statusCode).toBe(200);
    expect(wierszPodgladu(r.body, a)).toContain('Cennik: Pracownia Półcień — paczkomat A — reguła 1: do 8×38×64 cm, 25 kg');
    expect(wierszPodgladu(r.body, b)).toContain('Cennik: Pracownia Półcień — paczkomat C — reguła 2: do 41×38×64 cm, 25 kg');
    expect(wierszPodgladu(r.body, c)).toContain('Cennik: Pracownia Półcień — kurier gabaryt — dla większych');
    expect(wierszPodgladu(r.body, d)).toContain(ODMOWA_WYMIAROW);
    expect(wierszPodgladu(r.body, d)).not.toContain('Cennik:');
    for (const id of [a, b, c]) expect(wierszPodgladu(r.body, id)).not.toContain('Odmowa:');
    const w = await zatwierdz(r, [a, b, c, d]);
    expect(w.body).toContain('W kolejce: 3. Odmówiono: 1.');
    expect(ofertyKarty(db, d)).toHaveLength(0);
    expect(ofertyKarty(db, a)).toHaveLength(1);
  });

  it('jedno pole konta (po migracji) → „jeden cennik konta”, karta bez wagi przechodzi', async () => {
    const d = karta(4, BEZ_WAGI);
    const r = await podglad([d]);
    expect(wierszPodgladu(r.body, d)).toContain('Cennik: Pracownia Półcień — standard — jeden cennik konta');
    expect(r.body).not.toContain('Odmowa:');
  });

  it('wyjątek zapisany na karcie usuwa odmowę: „wyjątek na karcie”, treść wysyłki ma ten cennik', async () => {
    regulyRozmiaru();
    const d = karta(4, BEZ_WAGI);
    const z = await zapiszCennik(d, { [`cennik:${KONTO}`]: 'cen-gabaryt' });
    expect(z.statusCode).toBe(303);
    expect(z.headers.location).toBe(`/magazyn/${d}#cenniki-karty`);
    expect(wyjatekCennika(db, { kartaId: d, konto: KONTO })).toBe('cen-gabaryt');
    const r = await podglad([d]);
    expect(r.body).not.toContain('Odmowa:');
    expect(wierszPodgladu(r.body, d)).toContain('Cennik: Pracownia Półcień — kurier gabaryt — wyjątek na karcie');
    // Ten sam wyjątek czyta budowniczy dla pętli (odczyt z bazy, nie z formularza).
    const w = ofertaAllegroKarty(db, d, { klucz: KONTO, srodowisko: 'produkcja' });
    expect(w.bledy).toEqual([]);
    expect(w.zadanie.delivery.shippingRates).toEqual({ id: 'cen-gabaryt' });
    expect((await zatwierdz(r, [d])).body).toContain('W kolejce: 1. Odmówiono: 0.');
  });
});

describe('podgląd ERLI — cennik i powód', () => {
  it('reguły, „dla większych”, odmowa bez wagi, wyjątek z karty i „jeden cennik konta”', async () => {
    regulyRozmiaru();
    const [a, b, c, d] = [karta(1, MALA), karta(2, SREDNIA), karta(3, DUZA), karta(4, BEZ_WAGI)];
    let r = await podglad([a, b, c, d], ERLI);
    expect(r.statusCode).toBe(200);
    expect(wierszPodgladu(r.body, a)).toContain('Cennik: Paczkomat A — reguła 1: do 8×38×64 cm, 25 kg');
    expect(wierszPodgladu(r.body, b)).toContain('Cennik: Paczkomat C — reguła 2: do 41×38×64 cm, 25 kg');
    expect(wierszPodgladu(r.body, c)).toContain('Cennik: Kurier gabaryt — dla większych');
    expect(wierszPodgladu(r.body, d)).toContain(ODMOWA_WYMIAROW);
    const w = await zatwierdz(r, [a, b, c, d], ERLI);
    expect(w.body).toContain('Odmówiono: 1');
    expect(ofertyKarty(db, d)).toHaveLength(0);

    expect((await zapiszCennik(d, { [`cennik:${ERLI}`]: '  Kurier gabaryt  ' })).statusCode).toBe(303);
    expect(wyjatekCennika(db, { kartaId: d, konto: ERLI })).toBe('Kurier gabaryt');
    r = await podglad([d], ERLI);
    expect(r.body).not.toContain('Odmowa:');
    expect(wierszPodgladu(r.body, d)).toContain('Cennik: Kurier gabaryt — wyjątek na karcie');
    expect(trescOferty(db, d, ustawieniaOfertKonta(db, ERLI)).cialo.deliveryPriceList).toBe('Kurier gabaryt');

    zapiszUstawieniaOfertKonta(db, ERLI, { cennikDostaw: 'Lampy' }, { teraz: T0 });
    r = await podglad([a], ERLI);
    expect(wierszPodgladu(r.body, a)).toContain('Cennik: Lampy — jeden cennik konta');
  });
});

describe('decyzja kierownika: wyjątek z karty wystarcza na koncie bez reguł (Allegro jak ERLI)', () => {
  it('Allegro: konto bez cennika nie blokuje podglądu, gdy wybrana karta ma wyjątek; karta bez wyjątku dostaje odmowę', async () => {
    zapiszUstawieniaOfertKonta(db, KONTO, { cenniki: [] }, { teraz: T0 });
    const [a, b] = [karta(1, MALA), karta(2, MALA)];
    let r = await podglad([a, b]);
    expect(r.body).toContain('Uzupełnij ustawienia: cennik dostaw');
    zapiszWyjatekCennika(db, { kartaId: a, konto: KONTO, cennik: 'cen-a' }, { teraz: T0 });
    const w = ofertaAllegroKarty(db, a, { klucz: KONTO, srodowisko: 'produkcja' });
    expect(w.bledy.map(x => x.kod)).not.toContain('ustawienia');
    expect(w.zadanie.delivery.shippingRates).toEqual({ id: 'cen-a' });
    r = await podglad([a, b]);
    expect(r.body).not.toContain('Uzupełnij ustawienia: cennik dostaw');
    expect(wierszPodgladu(r.body, a)).toContain('Cennik: Pracownia Półcień — paczkomat A — wyjątek na karcie');
    expect(wierszPodgladu(r.body, a)).not.toContain('Odmowa:');
    expect(wierszPodgladu(r.body, b)).toContain('Odmowa:');
    expect(wierszPodgladu(r.body, b)).toContain('cennik dostaw');
    expect((await zatwierdz(r, [a, b])).body).toContain('W kolejce: 1. Odmówiono: 1.');
    expect(ofertyKarty(db, b)).toHaveLength(0);
  });

  it('ERLI: to samo — konto bez cennika, karta z wyjątkiem przechodzi, karta bez wyjątku odmowa', async () => {
    zapiszUstawieniaOfertKonta(db, ERLI, { cennikDostaw: null }, { teraz: T0 });
    const [a, b] = [karta(1, MALA), karta(2, MALA)];
    let r = await podglad([a, b], ERLI);
    expect(r.body).toContain('Uzupełnij ustawienia: cennik dostaw');
    zapiszWyjatekCennika(db, { kartaId: a, konto: ERLI, cennik: 'Paczkomat A' }, { teraz: T0 });
    r = await podglad([a, b], ERLI);
    expect(r.body).not.toContain('Uzupełnij ustawienia: cennik dostaw');
    expect(wierszPodgladu(r.body, a)).toContain('Cennik: Paczkomat A — wyjątek na karcie');
    expect(wierszPodgladu(r.body, b)).toContain('Odmowa: Ustaw cennik dostaw w konfiguratorze konta ERLI.');
    expect((await zatwierdz(r, [a, b], ERLI)).body).toContain('Odmówiono: 1');
    expect(ofertyKarty(db, a)).toHaveLength(1);
  });
});

describe('karta — sekcja „Cennik dostaw” i zapis wyjątku', () => {
  it('wiersz na każde konto: lista cenników Allegro, pole tekstowe ERLI, cennik teraz albo odmowa; etykiety powiązane z polami', async () => {
    regulyRozmiaru();
    const d = karta(4, BEZ_WAGI);
    zapiszWyjatekCennika(db, { kartaId: d, konto: ERLI, cennik: 'Kurier gabaryt' }, { teraz: T0 });
    const r = await get(`/magazyn/${d}`);
    expect(r.statusCode).toBe(200);
    const s = sekcja(r.body);
    expect(s).toContain('Cennik dostaw');
    expect(s).toContain(`action="/magazyn/${d}/cenniki"`);
    expect(s).toContain(`name="cennik:${KONTO}"`);
    expect(s).toContain(`name="cennik:${ERLI}"`);
    expect(s).toContain('<option value="cen-gabaryt">Pracownia Półcień — kurier gabaryt</option>');
    expect(s).toContain('<option value="">— reguły konta —</option>');
    expect(s).toMatch(new RegExp(`<input[^>]*name="cennik:${ERLI}"[^>]*value="Kurier gabaryt"`));
    // Allegro: bez wyjątku i bez wagi → odmowa; ERLI: wyjątek wygrywa.
    expect(s).toContain(ODMOWA_WYMIAROW);
    expect(s).toContain('Teraz: Kurier gabaryt — wyjątek na karcie');
    expect(s.match(/Cennik dostaw — wyjątek/g)).toHaveLength(2);
    for (const [, dla] of s.matchAll(/<label for="([^"]+)"/g)) expect(s).toContain(`id="${dla}"`);
  });

  it('zapis wyjątku Allegro spoza listy cenników konta → odmowa, nic nie zapisane (także ERLI w tym samym formularzu)', async () => {
    const id = karta(1, MALA);
    const r = await zapiszCennik(id, { [`cennik:${KONTO}`]: 'cennik-z-innego-konta', [`cennik:${ERLI}`]: 'Paczkomat A' });
    expect(r.statusCode).toBe(400);
    expect(r.body).toContain('nie jest na liście cenników konta');
    expect(wyjatekCennika(db, { kartaId: id, konto: KONTO })).toBeNull();
    expect(wyjatekCennika(db, { kartaId: id, konto: ERLI })).toBeNull();
  });

  it('puste pole usuwa wyjątek; pole nieprzysłane zostawia go bez zmian', async () => {
    const id = karta(1, MALA);
    zapiszWyjatekCennika(db, { kartaId: id, konto: KONTO, cennik: 'cen-a' }, { teraz: T0 });
    zapiszWyjatekCennika(db, { kartaId: id, konto: ERLI, cennik: 'Paczkomat A' }, { teraz: T0 });
    expect((await zapiszCennik(id, { [`cennik:${ERLI}`]: '   ' })).statusCode).toBe(303);
    expect(wyjatekCennika(db, { kartaId: id, konto: ERLI })).toBeNull();
    expect(wyjatekCennika(db, { kartaId: id, konto: KONTO })).toBe('cen-a');
  });

  it('nie-administrator i obcy CSRF → 403, wyjątek niezapisany; nie-administrator widzi sekcję bez formularza', async () => {
    const id = karta(1, MALA);
    const pola = { [`cennik:${KONTO}`]: 'cen-a' };
    expect((await zapiszCennik(id, pola, { ...auth, origin: 'https://obcy.example' })).statusCode).toBe(403);
    zalozKonto(db, { login: 'admin', imie: 'Admin', haslo: 'test', rola: 'admin', admin: true });
    const user = zalozKonto(db, { login: 'czytelnik', imie: 'Czytelnik', haslo: 'test', rola: 'operator' });
    ustawUprawnienia(db, user, ['magazyn']);
    const headers = { origin: 'http://localhost', cookie: `${NAZWA_CIASTECZKA_OMS}=${podpisz('czytelnik', wczytajSekret(db), Date.now(), 0)}` };
    expect((await zapiszCennik(id, pola, headers)).statusCode).toBe(403);
    expect(wyjatekCennika(db, { kartaId: id, konto: KONTO })).toBeNull();
    const s = sekcja((await get(`/magazyn/${id}`, headers)).body);
    expect(s).toContain('Cennik dostaw');
    expect(s).not.toContain('<form');
  });

  it('nieistniejąca karta → 404', async () => {
    expect((await zapiszCennik(999999, { [`cennik:${ERLI}`]: 'Paczkomat A' })).statusCode).toBe(404);
  });
});

describe('poprawki po recenzji E3d.02-03', () => {
  it('objęcie ERLI bez reguł wymaga wyjątku; po jego zapisaniu przechodzi', async () => {
    zapiszUstawieniaOfertKonta(db, ERLI, { cenniki: [] }, { teraz: T0 });
    const id = karta(1, MALA);
    const oferta = wstawOferte(db, { kartaId: id, kanal: ERLI, idZewnetrzne: 'reczna-1',
      tryb: 'obserwowana', pochodzenie: 'przejeta', stan: 'aktywna' });
    zmienOferte(db, oferta.id, { odczytCenaGr: 5900, odczytIlosc: 5 });
    const url = `/magazyn/${id}/oferty/${oferta.id}/objecie`;
    let r = await post(`${url}/podglad`);
    expect(r.body).toContain('Uzupełnij ustawienia: cennik dostaw');
    const token = r => /name="podglad" value="([^"]+)"/.exec(r.body)?.[1];
    expect(token(r)).toBeUndefined();
    // Prawdziwy token: podgląd z wyjątkiem, potem wyjątek znika, zatwierdzenie tym tokenem.
    zapiszWyjatekCennika(db, { kartaId: id, konto: ERLI, cennik: 'Paczkomat A' }, { teraz: T0 });
    const zWyjatkiem = await post(`${url}/podglad`);
    const prawdziwy = token(zWyjatkiem);
    expect(prawdziwy).toBeTruthy();
    usunWyjatekCennika(db, { kartaId: id, konto: ERLI });
    const odmowa = await post(`${url}/zatwierdz`, { podglad: prawdziwy });
    expect(odmowa.statusCode).toBe(409);
    expect(odmowa.body).toContain('cennik dostaw');
    expect(ofertyKarty(db, id)[0].tryb).toBe('obserwowana');
    zapiszWyjatekCennika(db, { kartaId: id, konto: ERLI, cennik: 'Paczkomat A' }, { teraz: T0 });
    r = await post(`${url}/podglad`);
    expect(r.body).not.toContain('Uzupełnij ustawienia: cennik dostaw');
    expect((await post(`${url}/zatwierdz`, { podglad: token(r) })).statusCode).toBe(303);
    expect(ofertyKarty(db, id)[0].tryb).toBe('zarzadzana');
    expect(klienci[ERLI].zmienProdukt).not.toHaveBeenCalled();
  });

  it('wszystko albo nic: poprawne Allegro i za długie ERLI jako drugie konto nie zapisują żadnego wyjątku', async () => {
    const id = karta(1, MALA);
    const r = await zapiszCennik(id, { [`cennik:${KONTO}`]: 'cen-a', [`cennik:${ERLI}`]: 'a'.repeat(201) });
    expect(r.statusCode).toBe(400);
    expect(r.body).toContain('najwyżej 200 znaków');
    expect(wyjatekCennika(db, { kartaId: id, konto: KONTO })).toBeNull();
    expect(wyjatekCennika(db, { kartaId: id, konto: ERLI })).toBeNull();
  });

  it('zapisany wyjątek Allegro spoza listy jest zaznaczony i nie blokuje zmiany ERLI', async () => {
    const id = karta(1, MALA);
    zapiszWyjatekCennika(db, { kartaId: id, konto: KONTO, cennik: 'cen-old' }, { teraz: T0 });
    const sekcjaKarty = sekcja((await get(`/magazyn/${id}`)).body);
    expect(sekcjaKarty).toContain('<option value="cen-old" selected>cen-old (spoza listy konta)</option>');
    expect(sekcjaKarty).toContain('Odmowa: Cennik z karty nie istnieje już na koncie Allegro — wybierz inny');
    expect((await zapiszCennik(id, { [`cennik:${KONTO}`]: 'cen-old', [`cennik:${ERLI}`]: 'Nowy kurier' })).statusCode).toBe(303);
    expect(wyjatekCennika(db, { kartaId: id, konto: KONTO })).toBe('cen-old');
    expect(wyjatekCennika(db, { kartaId: id, konto: ERLI })).toBe('Nowy kurier');
  });

  it('wyjątek Allegro spoza bieżącej listy daje odmowę przed kolejką', async () => {
    const id = karta(1, MALA);
    zapiszWyjatekCennika(db, { kartaId: id, konto: KONTO, cennik: 'cen-old' }, { teraz: T0 });
    const r = await podglad([id]);
    expect(wierszPodgladu(r.body, id)).toContain('Odmowa: Cennik z karty nie istnieje już na koncie Allegro — wybierz inny');
    // Odmowa pochodzi z budowniczego, ale tylko przy tworzeniu oferty (E3d.02-03p3, recenzja VM B1): pętla
    // (synchronizacja ceny/ilości, wznowienie) woła go bez `tworzenie` i dostaje treść z cennikiem z karty.
    const w = ofertaAllegroKarty(db, id, { klucz: KONTO, srodowisko: 'produkcja' }, { tworzenie: true });
    expect(w.bledy.map(x => x.kod)).toContain('cennik');
    expect(w.zadanie).toBeNull();
    const wPetli = ofertaAllegroKarty(db, id, { klucz: KONTO, srodowisko: 'produkcja' });
    expect(wPetli.bledy.map(x => x.kod)).not.toContain('cennik');
    expect((await zatwierdz(r, [id])).body).toContain('W kolejce: 0. Odmówiono: 1.');
    expect(ofertyKarty(db, id)).toHaveLength(0);
    expect(klienci[KONTO].utworzOferte).not.toHaveBeenCalled();
  });

  it.each([
    [MALA, 'cen-gabaryt', 'Kurier gabaryt', 'Pracownia Półcień — paczkomat A — reguła 1: do 8×38×64 cm, 25 kg', 'Paczkomat A — reguła 1: do 8×38×64 cm, 25 kg'],
    [DUZA, 'cen-a', 'Paczkomat A', 'Pracownia Półcień — kurier gabaryt — dla większych', 'Kurier gabaryt — dla większych'],
    [BEZ_WAGI, 'cen-a', 'Paczkomat A', ODMOWA_WYMIAROW.slice('Odmowa: '.length), ODMOWA_WYMIAROW.slice('Odmowa: '.length)],
  ])('podgląd i karta pokazują inny dobór reguł z nazwą i powodem (%j)', async (rozmiar, allegro, erli, opisAllegro, opisErli) => {
    regulyRozmiaru();
    const id = karta(1, rozmiar);
    for (const [konto, cennik, opis] of [[KONTO, allegro, opisAllegro], [ERLI, erli, opisErli]]) {
      zapiszWyjatekCennika(db, { kartaId: id, konto, cennik }, { teraz: T0 });
      const dopisek = `(reguły dałyby: ${opis})`;
      expect(wierszPodgladu((await podglad([id], konto)).body, id)).toContain(`wyjątek na karcie ${dopisek}`);
      expect(sekcja((await get(`/magazyn/${id}`)).body)).toContain(`wyjątek na karcie ${dopisek}`);
    }
  });

  it.each([true, false])('bez dopisku, gdy reguły dają to samo lub ich brak (reguły: %s)', async saReguly => {
    regulyRozmiaru();
    const id = karta(1, MALA);
    for (const [konto, cennik] of [[KONTO, 'cen-a'], [ERLI, 'Paczkomat A']]) {
      if (!saReguly) zapiszUstawieniaOfertKonta(db, konto, { cenniki: [] }, { teraz: T0 });
      zapiszWyjatekCennika(db, { kartaId: id, konto, cennik }, { teraz: T0 });
      const wiersz = wierszPodgladu((await podglad([id], konto)).body, id);
      expect(wiersz).toContain('wyjątek na karcie');
      expect(wiersz).not.toContain('reguły dałyby:');
    }
    const kartaHtml = sekcja((await get(`/magazyn/${id}`)).body);
    expect(kartaHtml).toContain('wyjątek na karcie');
    expect(kartaHtml).not.toContain('reguły dałyby:');
  });
});

describe('migracja magazyn/0003 — warunek pustej wartości (length(trim(...)) > 0)', () => {
  it('pusty albo z samych spacji cennik_dostaw nie staje się regułą; niepusty — tak', () => {
    const wstaw = db.prepare(`INSERT OR REPLACE INTO oferty_ustawienia_kont
      (klucz, oferty_czynne, narzut_bp, stala_ilosc, cennik_dostaw, cenniki_json, zmieniono_at) VALUES (?, 1, 0, 5, ?, NULL, ?)`);
    wstaw.run('konto_spacje', '   ', T0);
    wstaw.run('konto_puste', '', T0);
    wstaw.run('konto_null', null, T0);
    wstaw.run('konto_pelne', ' cennik-7 ', T0);
    migracjaCennikowDostaw.wykonaj(db);
    const json = k => db.prepare('SELECT cenniki_json j FROM oferty_ustawienia_kont WHERE klucz = ?').get(k).j;
    expect(json('konto_spacje')).toBeNull();
    expect(json('konto_puste')).toBeNull();
    expect(json('konto_null')).toBeNull();
    expect(JSON.parse(json('konto_pelne'))).toEqual([{ cennik: 'cennik-7' }]);
    expect(ustawieniaOfertKonta(db, 'konto_spacje').cenniki).toEqual([]);
  });
});

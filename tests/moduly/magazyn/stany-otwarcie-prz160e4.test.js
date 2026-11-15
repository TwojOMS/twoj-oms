import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { buildOmsServer } from '../../pomoc/serwer-parytetu.ts';
import { utworzKarte, zapiszProduktSklepowy, powiazProdukt } from '../../../src/oms/db/magazyn.js';
import { wstawOferte, zapiszUstawieniaOfertKonta } from '../../../src/oms/db/oferty-kanalow.ts';
import { przelaczStany, migawkaStanow, zapiszOtwarcie, dodajRuch } from '../../../src/oms/db/stany-magazynowe.js';
import { zapiszZamowienie } from '../../../src/oms/db/zamowienia.js';
import { zalozKonto, ustawUprawnienia } from '../../../src/core/bezpieczenstwo/konta.js';
import { jako } from '../../pomoc/konta-prz068.js';
import { iloscDlaKanalu } from '../../../src/domena/ilosc-kanalu.js';

const T0 = '2026-11-14T08:00:00.000Z';
const T1 = '2026-11-14T09:00:00.000Z';
const auth = { authorization: `Basic ${Buffer.from('operator:atrapa').toString('base64')}`, origin: 'http://localhost' };
const definicje = [
  { klucz: 'woo_polcien', typ: 'woo', prefiks: 'WOO_POLCIEN', etykieta: 'Sklep Półcień' },
  { klucz: 'allegro_polcien', typ: 'allegro', prefiks: 'ALLEGRO_POLCIEN', etykieta: 'Allegro Półcień' },
  { klucz: 'erli_polcien', typ: 'erli', prefiks: 'ERLI_POLCIEN', etykieta: 'ERLI Półcień' },
];
let db, app, karta, woo, allegro, erli, numer;
const get = url => app.inject({ method: 'GET', url, headers: auth });
const post = (url, payload = {}, headers = auth) => app.inject({ method: 'POST', url, payload, headers });
const liczniki = (body, konto) => {
  const sekcja = new RegExp(`<h3>${konto}</h3>\\s*<dl>([\\s\\S]*?)</dl>`).exec(body)?.[1] ?? '';
  return Object.fromEntries([...sekcja.matchAll(/<dt>([^<]+)<\/dt><dd>(\d+)<\/dd>/g)].map(m => [m[1], Number(m[2])]));
};
const token = r => /name="podglad" value="([^"]+)"/.exec(r.body)?.[1];
const wlacz = () => przelaczStany(db, { wlacz: true, at: T0 });
const odczyt = () => post('/magazyn/stany/otwarcie/odczytaj');
const zapisz = (r, ilosc = '5', kartaId = karta) => post('/magazyn/stany/otwarcie/zapisz', { podglad: token(r), [`ilosc_${kartaId}`]: ilosc });
function zakup({ sklep = 'woo_polcien', at = T1, produkt = '10', oferta = null, status = 'processing', ilosc = 1 } = {}) {
  return zapiszZamowienie(db, sklep, { zrodlo_id: String(++numer), numer: `PC-${numer}`, klient: {}, dostawa: {},
    utworzone_at: at, kwota_brutto: '10.00', metoda_wysylki: 'dpd', kwota_pobrania: null, chce_fakture: 0,
    nip: null, oplacone_at: null, anulowane: 0, status_woo: status,
    pozycje: [{ zrodlo_id: 'p1', produkt_id: produkt, oferta_id: oferta, wariant_id: null, sku: null,
      zdjecie_url: null, nazwa: 'Lampa Półcień', ilosc, cena_brutto: '10.00', vat: '23' }] }, {});
}
function powiaz(kanal, produkt, kartaId = karta, wariant = '') {
  const id = zapiszProduktSklepowy(db, { kanal, produkt_id: produkt, wariant_id: wariant,
    nazwa: 'Lampa Półcień', odczytane_at: T0 });
  powiazProdukt(db, id, kartaId);
  return id;
}
beforeEach(async () => {
  numer = 0;
  db = openOmsDb(':memory:');
  woo = { pobierzStany: vi.fn(async () => [{ id: 10, status: 'publish', manage_stock: true, stock_quantity: 4 }]),
    pobierzStanyWariantow: vi.fn(async () => [{ id: 11, status: 'publish', manage_stock: true, stock_quantity: 3 }]), zapiszStanyHurtem: vi.fn() };
  allegro = { ofertyKonta: vi.fn(async () => ({ oferty: [{ id: '20', publication: { status: 'ACTIVE' }, stock: { available: 490 } }], razem: 1 })), komendaIlosci: vi.fn() };
  erli = { szukajProduktow: vi.fn(async () => [{ externalId: '30', stock: 6 }]), zmienProdukty: vi.fn() };
  app = buildOmsServer({ db, config: { auth: { user: 'operator', pass: 'atrapa' }, definicje },
    magazyn: { stan: () => ({ trwa: false, kanaly: [] }) },
    nadpisania: { 'kanaly.klienciSklepow': { woo_polcien: woo },
      'kanaly.klienciKanalow': { allegro_polcien: allegro, erli_polcien: erli },
      'kanaly.repozytoriumKanalow': { listaTypu: typ => typ === 'allegro'
        ? [{ klucz: 'allegro_polcien', autoryzacja: 'polaczone' }] : typ === 'erli' ? [{ klucz: 'erli_polcien' }] : [],
      zapisyZablokowane: () => false, konfliktKlucza: () => false } } });
  await app.ready();
  karta = utworzKarte(db, { nazwa: 'Lampa Półcień', sku: 'PP-LAMPA-01' });
  for (const [kanal, id] of [['woo_polcien', '10'], ['allegro_polcien', '20'], ['erli_polcien', '30']]) {
    powiaz(kanal, id);
    wstawOferte(db, { kanal, kartaId: karta, idZewnetrzne: id, tryb: 'zarzadzana' });
    zapiszUstawieniaOfertKonta(db, kanal, { stalaIlosc: 7, czynne: true });
  }
});
afterEach(async () => { vi.restoreAllMocks(); await app.close(); db.close(); });

it('D56: świeży odczyt Woo 4 + 1, Allegro 490, ERLI 6 → minimum 5 i różnica; lustro bez zmiany karty', async () => {
  wlacz(); zakup();
  const r = await odczyt();
  expect(r.statusCode, r.body).toBe(200);
  expect(r.body).toContain('4 + 1 sprzedane od włączenia = 5');
  expect(r.body).toContain('różnica');
  expect(r.body).toContain(`name="ilosc_${karta}" value="5"`);
  expect(woo.pobierzStany).toHaveBeenCalledWith([10]);
  expect(allegro.ofertyKonta).toHaveBeenCalledTimes(1);
  expect(erli.szukajProduktow).toHaveBeenCalledTimes(1);
  const lustro = db.prepare('SELECT karta_id, ilosc_kanalu, stan_prowadzony FROM produkty_sklepowe WHERE kanal = ?').get('woo_polcien');
  expect(lustro).toMatchObject({ karta_id: karta, ilosc_kanalu: 4, stan_prowadzony: 'tak' });
  expect((await zapisz(r, '8')).statusCode).toBe(303);
  expect((await zapisz(r, '8')).statusCode).toBe(303);
  expect(db.prepare('SELECT COUNT(*) n FROM stany_otwarcia').get().n).toBe(1);
  expect(db.prepare('SELECT COUNT(*) n FROM ruchy_magazynowe').get().n).toBe(1);
  expect(migawkaStanow(db).stany.get(karta).stan).toBe(7);
  expect(woo.zapiszStanyHurtem).not.toHaveBeenCalled();
  expect(allegro.komendaIlosci).not.toHaveBeenCalled();
  expect(erli.zmienProdukty).not.toHaveBeenCalled();
});

it('Woo bez stanów i pending nie zawyżają propozycji; wariant czytany osobno', async () => {
  wlacz(); zakup({ status: 'pending', ilosc: 100 });
  woo.pobierzStany.mockResolvedValue([{ id: 10, status: 'publish', manage_stock: false, stock_quantity: 0 }]);
  const r = await odczyt();
  expect(r.body).toContain(`name="ilosc_${karta}" value="6"`);
  woo.pobierzStany.mockResolvedValue([{ id: 10, status: 'publish', manage_stock: true, stock_quantity: 4 }]);
  powiaz('woo_polcien', '10', karta, '11');
  const drugi = await odczyt();
  expect(woo.pobierzStanyWariantow).toHaveBeenCalledWith(10, [11]);
  expect(drugi.body).toContain(`name="ilosc_${karta}" value="3"`);
});

it('odczyt starszy niż 30 minut i podmieniony podpis → 409 bez otwarcia', async () => {
  wlacz(); const r = await odczyt();
  const teraz = Date.now(); vi.spyOn(Date, 'now').mockReturnValue(teraz + 31 * 60_000);
  expect((await zapisz(r)).statusCode).toBe(409);
  vi.restoreAllMocks();
  expect((await zapisz({ body: r.body.replace(token(r), 'obcy') })).statusCode).toBe(409);
  expect(db.prepare('SELECT COUNT(*) n FROM stany_otwarcia').get().n).toBe(0);
});

it('podgląd liczy obniżki względem świeżego lustra, nie wymaga dodatkowego odczytu', async () => {
  wlacz(); await odczyt();
  zapiszOtwarcie(db, { kartaId: karta, ilosc: 5, zrodlo: 'test' });
  const r = await get('/magazyn/stany/kanaly/podglad');
  expect(liczniki(r.body, 'woo_polcien')).toEqual({ Obniżki: 0, Podwyżki: 1, 'Bez zmian': 0, 'Do zera': 0, Blokady: 0 });
  expect(liczniki(r.body, 'allegro_polcien')).toEqual({ Obniżki: 1, Podwyżki: 0, 'Bez zmian': 0, 'Do zera': 0, Blokady: 0 });
  expect(liczniki(r.body, 'erli_polcien')).toEqual({ Obniżki: 1, Podwyżki: 0, 'Bez zmian': 0, 'Do zera': 0, Blokady: 0 });
  expect(allegro.ofertyKonta).toHaveBeenCalledTimes(1);
});

it('błąd jednego kanału nie daje propozycji z częściowego odczytu; można wpisać własny stan', async () => {
  wlacz(); allegro.ofertyKonta.mockRejectedValue(new Error('atrapa: błąd odczytu'));
  const r = await odczyt();
  expect(r.statusCode).toBe(200);
  expect(r.body).toContain('Nie udało się odczytać konta allegro_polcien');
  expect(r.body).toContain(`name="ilosc_${karta}" value=""`);
  expect((await zapisz(r, '-1')).statusCode).toBe(400);
  expect((await zapisz(r, '0')).statusCode).toBe(303);
  expect(migawkaStanow(db).znane.has(karta)).toBe(true);
});

it('podpis otwarcia nie przechodzi po przepięciu ani na kolejne włączenie z tą samą datą', async () => {
  wlacz(); const r = await odczyt();
  przelaczStany(db, { wlacz: false }); przelaczStany(db, { wlacz: true, at: T0 });
  expect((await zapisz(r)).statusCode).toBe(409);
  const drugi = await odczyt();
  db.prepare('UPDATE produkty_sklepowe SET karta_id = NULL').run();
  expect((await zapisz(drugi)).statusCode).toBe(409);
});

it('przepięcie podczas oczekiwania na kanał unieważnia cały odczyt', async () => {
  wlacz();
  woo.pobierzStany.mockImplementation(async () => {
    db.prepare("UPDATE produkty_sklepowe SET karta_id = NULL WHERE kanal = 'woo_polcien'").run();
    return [{ id: 10, status: 'publish', manage_stock: true, stock_quantity: 4 }];
  });
  expect((await odczyt()).statusCode).toBe(409);
  expect(db.prepare('SELECT COUNT(*) n FROM stany_otwarcia').get().n).toBe(0);
});

it('starsze otwarcie bez wiersza E4 nie daje 500 ani nie dubluje zapasu', async () => {
  wlacz(); dodajRuch(db, { kartaId: karta, rodzaj: 'otwarcie', ilosc: 9, klucz: 'e412-stare-otwarcie', at: T1 });
  const r = await odczyt();
  expect((await zapisz(r, '5')).statusCode).toBe(303);
  expect(migawkaStanow(db).stany.get(karta).stan).toBe(9);
  expect(db.prepare('SELECT COUNT(*) n FROM ruchy_magazynowe').get().n).toBe(1);
});

it('pięć ofert: w trzech wyliczeniach do zatwierdzenia ilość jest zablokowana', async () => {
  for (const n of [4, 5]) {
    const kartaId = utworzKarte(db, { nazwa: `Lampa Półcień ${n}`, sku: `PP-LAMPA-${n}` });
    wstawOferte(db, { kanal: 'erli_polcien', kartaId, idZewnetrzne: String(n), tryb: 'zarzadzana' });
  }
  wlacz(); zapiszOtwarcie(db, { kartaId: karta, ilosc: 12, zrodlo: 'test' });
  for (let przebieg = 0; przebieg < 3; przebieg++) {
    const migawka = migawkaStanow(db);
    const cele = db.prepare('SELECT * FROM oferty_kanalow').all().map(o => iloscDlaKanalu({ migawka,
      kartaId: o.karta_id, tryb: o.tryb, iloscZOms: o.ilosc_z_oms, stalaIlosc: 7 }));
    expect(cele).toHaveLength(5);
    expect(cele.every(c => c.ilosc === null && c.powod === 'stany-niezatwierdzone')).toBe(true);
  }
});

it('podgląd: nowe zamówienie przyjęte, zatwierdzenie raz i przez przelaczenie_id', async () => {
  wlacz(); zapiszOtwarcie(db, { kartaId: karta, ilosc: 5, zrodlo: 'test' });
  const r = await get('/magazyn/stany/kanaly/podglad');
  expect(r.statusCode, r.body).toBe(200); expect(token(r)).toBeTruthy();
  zakup();
  expect((await post('/magazyn/stany/kanaly/zatwierdz', { podglad: token(r) })).statusCode).toBe(303);
  expect((await post('/magazyn/stany/kanaly/zatwierdz', { podglad: token(r) })).statusCode).toBe(303);
  const w = db.prepare('SELECT * FROM stany_zatwierdzenia').all();
  expect(w).toHaveLength(1);
  expect(w[0]).toMatchObject({ przelaczenie_id: migawkaStanow(db).przelaczenieId, ofert: 3, zatwierdzil: 'operator' });
  expect(migawkaStanow(db).zatwierdzenie).not.toBeNull();
});

it.each(['ruch', 'bufor', 'oferta', 'podpis', 'czas', 'przelaczenie'])('zatwierdzenie odmawia po zmianie: %s', async zmiana => {
  wlacz(); zapiszOtwarcie(db, { kartaId: karta, ilosc: 5, zrodlo: 'test' }); const r = await get('/magazyn/stany/kanaly/podglad');
  let podpis = token(r);
  if (zmiana === 'ruch') dodajRuch(db, { kartaId: karta, rodzaj: 'przyjecie', ilosc: 2, klucz: 'e412-nowy-ruch-0001' });
  if (zmiana === 'bufor') db.prepare('UPDATE oferty_ustawienia_kont SET bufor_szt = 1').run();
  if (zmiana === 'oferta') db.prepare("UPDATE oferty_kanalow SET tryb = 'obserwowana'").run();
  if (zmiana === 'podpis') podpis = 'obcy';
  if (zmiana === 'czas') { const t = Date.now(); vi.spyOn(Date, 'now').mockReturnValue(t + 31 * 60_000); }
  if (zmiana === 'przelaczenie') { przelaczStany(db, { wlacz: false }); przelaczStany(db, { wlacz: true, at: T0 }); }
  expect((await post('/magazyn/stany/kanaly/zatwierdz', { podglad: podpis })).statusCode).toBe(409);
  expect(db.prepare('SELECT COUNT(*) n FROM stany_zatwierdzenia').get().n).toBe(0);
});

it('kontynuacja odejmuje sprzedaż z przerwy i zapisuje także znane zero', async () => {
  wlacz(); zapiszOtwarcie(db, { kartaId: karta, ilosc: 8, zrodlo: 'test', at: T0 });
  const zero = utworzKarte(db, { nazwa: 'Lampa bez zapasu', sku: 'PP-ZERO' });
  zapiszOtwarcie(db, { kartaId: zero, ilosc: 0, zrodlo: 'test', at: T0 });
  przelaczStany(db, { wlacz: false, at: '2026-11-14T08:30:00Z' }); zakup({ ilosc: 2 });
  przelaczStany(db, { wlacz: true, at: '2026-11-14T10:00:00Z' });
  const r = await post('/magazyn/stany/otwarcie/kontynuuj');
  expect(r.statusCode, r.body).toBe(200);
  expect(r.body).toContain(`name="ilosc_${karta}" value="6"`);
  expect((await post('/magazyn/stany/otwarcie/zapisz', { podglad: token(r), [`ilosc_${karta}`]: '6', [`ilosc_${zero}`]: '0' })).statusCode).toBe(303);
  expect(migawkaStanow(db).stany.get(karta).stan).toBe(6);
  expect(migawkaStanow(db).znane.has(zero)).toBe(true);
});

it('wyłączenie z licznikami 2/1 wymaga Rozumiem, bez objętych ofert nie wymaga', async () => {
  wlacz(); db.prepare("UPDATE oferty_kanalow SET tryb = 'obserwowana', ilosc_z_oms = 1 WHERE kanal = 'woo_polcien'").run();
  const ekran = await get('/ustawienia/magazyn');
  expect(ekran.body).toContain('2 ofert wróci do stałej ilości, 1 przejętych przestanie być synchronizowanych');
  expect(ekran.body).toContain('name="rozumiem"');
  expect((await post('/ustawienia/magazyn/stany', { wlacz: '0' })).statusCode).toBe(400);
  expect(migawkaStanow(db).wlaczone).toBe(true);
  expect((await post('/ustawienia/magazyn/stany', { wlacz: '0', rozumiem: '1' })).statusCode).toBe(303);
  expect(migawkaStanow(db).wlaczone).toBe(false);
  expect(iloscDlaKanalu({ migawka: migawkaStanow(db), kartaId: karta, tryb: 'zarzadzana', stalaIlosc: 7 }).ilosc).toBe(7);
  wlacz(); db.prepare("UPDATE oferty_kanalow SET tryb = 'obserwowana', ilosc_z_oms = 0").run();
  expect((await get('/ustawienia/magazyn')).body).not.toContain('name="rozumiem"');
  expect((await post('/ustawienia/magazyn/stany', { wlacz: '0' })).statusCode).toBe(303);
});

it('włączenie daje odnośnik, podgląd pokazuje bezKarty i liczniki na konto', async () => {
  const r = await post('/ustawienia/magazyn/stany', { wlacz: '1' });
  expect((await get(r.headers.location)).body).toContain('href="/magazyn/stany/otwarcie"');
  zakup({ at: new Date().toISOString(), produkt: 'nieznany' });
  const p = await get('/magazyn/stany/kanaly/podglad');
  expect(p.body).toContain('Pozycje bez karty: 1');
  expect(p.body).toContain('href="/magazyn/stany/bez-karty"');
  for (const tekst of ['Obniżki', 'Podwyżki', 'Bez zmian', 'Do zera', 'Blokady']) expect(p.body).toContain(tekst);
});

it('nie-admin i POST bez CSRF → 403, bez wywołania klienta', async () => {
  for (const url of ['/magazyn/stany/otwarcie/odczytaj', '/magazyn/stany/otwarcie/kontynuuj', '/magazyn/stany/otwarcie/zapisz', '/magazyn/stany/kanaly/zatwierdz', '/ustawienia/magazyn/stany'])
    expect((await post(url, {}, { authorization: auth.authorization })).statusCode).toBe(403);
  wlacz(); const id = zalozKonto(db, { login: 'sprzedawca', imie: 'Jan', haslo: 'atrapa', rola: 'sprzedaz' });
  ustawUprawnienia(db, id, ['magazyn', 'ustawienia']);
  const naglowki = { ...jako(db, 'sprzedawca'), origin: 'http://localhost' };
  for (const url of ['/magazyn/stany/otwarcie', '/magazyn/stany/kanaly/podglad'])
    expect((await app.inject({ method: 'GET', url, headers: naglowki })).statusCode).toBe(403);
  for (const url of ['/magazyn/stany/otwarcie/odczytaj', '/magazyn/stany/otwarcie/kontynuuj', '/magazyn/stany/otwarcie/zapisz', '/magazyn/stany/kanaly/zatwierdz', '/ustawienia/magazyn/stany']) {
    expect((await post(url, { wlacz: '0' }, naglowki)).statusCode).toBe(403);
    expect((await post(url, {}, { ...jako(db, 'sprzedawca') })).statusCode).toBe(403);
  }
  expect(woo.pobierzStany).not.toHaveBeenCalled();
});

it.each([0, 1, 2])('D14: wyłączone stany, wariant %i, ekran bazowy i brak odczytów', async wariant => {
  const bazoweUstawienia = (await get('/ustawienia/magazyn')).body;
  const bazowyMagazyn = (await get('/magazyn')).body;
  if (wariant) {
    wlacz();
    if (wariant === 2) { zapiszOtwarcie(db, { kartaId: karta, ilosc: 5, zrodlo: 'test' }); const p = await get('/magazyn/stany/kanaly/podglad'); await post('/magazyn/stany/kanaly/zatwierdz', { podglad: token(p) }); }
    przelaczStany(db, { wlacz: false });
  }
  for (const url of ['/magazyn/stany/otwarcie', '/magazyn/stany/kanaly/podglad']) expect((await get(url)).statusCode).toBe(303);
  expect((await post('/magazyn/stany/otwarcie/odczytaj')).statusCode).toBe(303);
  if (!wariant) expect((await get('/ustawienia/magazyn')).body).toBe(bazoweUstawienia);
  expect((await get('/magazyn')).body).toBe(bazowyMagazyn);
  expect(woo.pobierzStany).not.toHaveBeenCalled(); expect(allegro.ofertyKonta).not.toHaveBeenCalled();
  expect(erli.szukajProduktow).not.toHaveBeenCalled();
});

// ---- E4.12p: poprawki po recenzji ----
const marker = (kanal, id) => db.prepare('UPDATE oferty_kanalow SET wyslane_pola_json = ? WHERE kanal = ? AND id_zewnetrzne = ?')
  .run(JSON.stringify({ zakonczonaPrzezOms: { at: T0 } }), kanal, id);

it('B1: Allegro ACTIVE 10 + ENDED 0 jednej karty, ERLI 10, Woo 10 → propozycja 10, zakończona pokazana jako nie-źródło', async () => {
  wlacz();
  powiaz('allegro_polcien', '21');
  woo.pobierzStany.mockResolvedValue([{ id: 10, status: 'publish', manage_stock: true, stock_quantity: 10 }]);
  erli.szukajProduktow.mockResolvedValue([{ externalId: '30', stock: 10 }]);
  allegro.ofertyKonta.mockResolvedValue({ razem: 2, oferty: [
    { id: '20', publication: { status: 'ACTIVE' }, stock: { available: 10 } },
    { id: '21', publication: { status: 'ENDED' }, stock: { available: 0 } }] });
  const r = await odczyt();
  expect(r.statusCode, r.body).toBe(200);
  expect(r.body).toContain(`name="ilosc_${karta}" value="10"`);
  expect(r.body).toContain('nie jest źródłem');
});

it('B1: ENDED ze znacznikiem OMS jest źródłem; szkic Allegro, archiwalny ERLI i szkic Woo nie są', async () => {
  wlacz(); marker('allegro_polcien', '20');
  allegro.ofertyKonta.mockResolvedValue({ razem: 1, oferty: [{ id: '20', publication: { status: 'ENDED' }, stock: { available: 3 } }] });
  expect(await odczyt().then(r => r.body)).toContain(`name="ilosc_${karta}" value="3"`);
  db.prepare('UPDATE oferty_kanalow SET wyslane_pola_json = NULL').run();
  allegro.ofertyKonta.mockResolvedValue({ razem: 1, oferty: [{ id: '20', publication: { status: 'INACTIVE' }, stock: { available: 0 } }] });
  erli.szukajProduktow.mockResolvedValue([{ externalId: '30', archived: true, stock: 0 }]);
  woo.pobierzStany.mockResolvedValue([{ id: 10, status: 'draft', manage_stock: true, stock_quantity: 0 }]);
  const r = await odczyt();
  expect(r.body).toContain(`name="ilosc_${karta}" value=""`);
  expect(r.body.match(/nie jest źródłem/g)).toHaveLength(3);
});

it('B2: podgląd i zatwierdzenie bez stanu otwarcia → 409 i 0 wierszy; po otwarciu 303', async () => {
  wlacz();
  const p = await get('/magazyn/stany/kanaly/podglad');
  const r = await post('/magazyn/stany/kanaly/zatwierdz', { podglad: token(p) });
  expect(r.statusCode).toBe(409);
  expect(r.body).toContain('Najpierw ustal stan otwarcia: 3 ofert');
  expect(db.prepare('SELECT COUNT(*) n FROM stany_zatwierdzenia').get().n).toBe(0);
  zapiszOtwarcie(db, { kartaId: karta, ilosc: 5, zrodlo: 'test' });
  const p2 = await get('/magazyn/stany/kanaly/podglad');
  expect((await post('/magazyn/stany/kanaly/zatwierdz', { podglad: token(p2) })).statusCode).toBe(303);
});

it('N4: podpis otwarcia nie rośnie z liczbą kart, a dane z podpisu nie wystarczą bez pamięci procesu', async () => {
  wlacz();
  for (let n = 0; n < 60; n++) utworzKarte(db, { nazwa: `Lampa Półcień ${n}`, sku: `PP-N4-${n}` });
  const r = await odczyt();
  expect(token(r).length).toBeLessThan(600);
  const [tekst, podpis] = token(r).split('.');
  expect(Buffer.from(tekst, 'base64url').toString()).not.toContain('Lampa');
  expect((await zapisz(r)).statusCode).toBe(303);
  expect(podpis).toMatch(/^[a-f0-9]{64}$/);
});

it('N5: zamówienie sprzed odczytu doszło po nim → 409 z nową propozycją, potem zapis', async () => {
  wlacz();
  const r = await odczyt();
  expect(r.body).toContain(`name="ilosc_${karta}" value="4"`);
  zakup();
  const druga = await zapisz(r);
  expect(druga.statusCode).toBe(409);
  expect(druga.body).toContain(`name="ilosc_${karta}" value="5"`);
  expect(db.prepare('SELECT COUNT(*) n FROM stany_otwarcia').get().n).toBe(0);
  expect((await zapisz(druga, '5')).statusCode).toBe(303);
  expect(db.prepare('SELECT ilosc FROM stany_otwarcia WHERE karta_id = ?').get(karta).ilosc).toBe(5);
});

it('N6: ruch ręczny po włączeniu daje ostrzeżenie przy karcie', async () => {
  wlacz(); dodajRuch(db, { kartaId: karta, rodzaj: 'przyjecie', ilosc: 10, klucz: 'e412-ruch-po-wlaczeniu', at: T1 });
  const r = await odczyt();
  expect(r.body).toContain('ruchy po włączeniu: +10');
  dodajRuch(db, { kartaId: karta, rodzaj: 'korekta', ilosc: -12, klucz: 'e412-ruch-ujemny-0001', at: T1 });
  expect(await odczyt().then(x => x.body)).toContain('ruchy po włączeniu: -2');
});

it('N8: wszystkie karty z otwarciem → brak „Zapisano”; błąd w środku nie zostawia części zapisu', async () => {
  wlacz();
  const r = await odczyt();
  expect((await zapisz(r)).statusCode).toBe(303);
  const ponowny = await zapisz(r);
  expect(ponowny.statusCode).toBe(303);
  const ekran = (await get(ponowny.headers.location)).body;
  expect(ekran).not.toContain('Zapisano stan otwarcia');
  expect(ekran).toContain('Nic nie zapisano');
  db.prepare('DELETE FROM stany_otwarcia').run(); db.prepare('DELETE FROM ruchy_magazynowe').run();
  const druga = utworzKarte(db, { nazwa: 'Lampa do usunięcia', sku: 'PP-N8' });
  const o = await odczyt();
  db.prepare('DELETE FROM karty_produktow WHERE id = ?').run(druga);
  const zly = await post('/magazyn/stany/otwarcie/zapisz', { podglad: token(o), [`ilosc_${karta}`]: '5', [`ilosc_${druga}`]: '3' });
  expect(zly.statusCode).toBe(409);
  expect(db.prepare('SELECT COUNT(*) n FROM stany_otwarcia').get().n).toBe(0);
});

it('N9: sprzedaż do propozycji jednym zapytaniem o pozycje, nie jednym na zamówienie', async () => {
  wlacz(); zakup(); zakup(); zakup();
  const oryg = db.prepare.bind(db); let n = 0;
  vi.spyOn(db, 'prepare').mockImplementation(sql => {
    const s = oryg(sql);
    if (/FROM pozycje/.test(sql)) { const all = s.all.bind(s); s.all = (...a) => { n++; return all(...a); }; }
    return s;
  });
  await odczyt();
  expect(n).toBeLessThanOrEqual(1);
});

// ---- E4.12p2: poprawki po recenzji VM ----
it('B1p2: Allegro ENDED przy 0 bez znacznika zostaje źródłem (Woo 4, ERLI 6 → 0); ENDED przy 2 bez znacznika nie jest', async () => {
  wlacz();
  allegro.ofertyKonta.mockResolvedValue({ razem: 1, oferty: [{ id: '20', publication: { status: 'ENDED' }, stock: { available: 0 } }] });
  const r = await odczyt();
  expect(r.statusCode, r.body).toBe(200);
  expect(r.body).toContain(`name="ilosc_${karta}" value="0"`);
  expect(r.body).not.toContain('nie jest źródłem');
  allegro.ofertyKonta.mockResolvedValue({ razem: 1, oferty: [{ id: '20', publication: { status: 'ENDED' }, stock: { available: 2 } }] });
  const r2 = await odczyt();
  expect(r2.body).toContain(`name="ilosc_${karta}" value="4"`);
  expect(r2.body).toContain('allegro_polcien: nie jest źródłem');
});

it('B1p2: ta sama karta ma na tym koncie ofertę ACTIVE → ENDED przy 0 nie jest źródłem', async () => {
  wlacz();
  powiaz('allegro_polcien', '21');
  allegro.ofertyKonta.mockResolvedValue({ razem: 2, oferty: [
    { id: '20', publication: { status: 'ENDED' }, stock: { available: 0 } },
    { id: '21', publication: { status: 'ACTIVE' }, stock: { available: 10 } }] });
  const r = await odczyt();
  expect(r.statusCode, r.body).toBe(200);
  expect(r.body).toContain(`name="ilosc_${karta}" value="4"`);
  expect(r.body.match(/nie jest źródłem/g)).toHaveLength(1);
});

// Recenzja r3 N1: wyjątek ACTIVE dotyczy tylko tej samej karty, nie dowolnej oferty ACTIVE na koncie.
it('B1p2: ACTIVE innej karty na tym koncie → ENDED przy 0 tej karty zostaje źródłem', async () => {
  wlacz();
  const inna = utworzKarte(db, { nazwa: 'Lampa Półcień druga', sku: 'PP-LAMPA-02' });
  powiaz('allegro_polcien', '21', inna);
  allegro.ofertyKonta.mockResolvedValue({ razem: 2, oferty: [
    { id: '20', publication: { status: 'ENDED' }, stock: { available: 0 } },
    { id: '21', publication: { status: 'ACTIVE' }, stock: { available: 10 } }] });
  const r = await odczyt();
  expect(r.statusCode, r.body).toBe(200);
  expect(r.body).toContain(`name="ilosc_${karta}" value="0"`);
});

it('N2: źródło zapisu i powód ruchu tylko z kont będących źródłem', async () => {
  wlacz();
  allegro.ofertyKonta.mockResolvedValue({ razem: 1, oferty: [{ id: '20', publication: { status: 'INACTIVE' }, stock: { available: 0 } }] });
  const r = await odczyt();
  expect(r.body).toContain('allegro_polcien: nie jest źródłem');
  expect((await zapisz(r, '4')).statusCode).toBe(303);
  expect(db.prepare('SELECT zrodlo FROM stany_otwarcia WHERE karta_id = ?').get(karta).zrodlo).toBe('woo_polcien, erli_polcien');
  expect(db.prepare("SELECT powod FROM ruchy_magazynowe WHERE rodzaj = 'otwarcie'").get().powod).toBe('otwarcie z woo_polcien, erli_polcien');
});

it('N1: podgląd bez stanu otwarcia pokazuje liczbę i odnośnik, przycisk nieaktywny; po otwarciu aktywny', async () => {
  wlacz();
  const p = (await get('/magazyn/stany/kanaly/podglad')).body;
  expect(p).toContain('Oferty bez stanu otwarcia: 3.');
  expect(p).toMatch(/href="\/magazyn\/stany\/otwarcie"[^>]*>[^<]*krok 1/);
  expect(p).toMatch(/<button[^>]*disabled[^>]*>Zatwierdź<\/button>/);
  expect(p).not.toContain('Karta bez znanego stanu pozostaje z ilością kanału');
  zapiszOtwarcie(db, { kartaId: karta, ilosc: 5, zrodlo: 'test' });
  const p2 = (await get('/magazyn/stany/kanaly/podglad')).body;
  expect(p2).not.toContain('bez stanu otwarcia');
  expect(p2).toMatch(/<button type="submit" class="btn btn--glowny">Zatwierdź<\/button>/);
});

it('N4: w pamięci najwyżej 5 podglądów otwarcia — szósty wypiera najstarszy', async () => {
  wlacz();
  const pierwszy = await odczyt();
  for (let n = 0; n < 4; n++) await odczyt();
  const piaty = await odczyt();
  expect((await zapisz(pierwszy)).statusCode).toBe(409);
  expect((await zapisz(piaty)).statusCode).toBe(303);
});

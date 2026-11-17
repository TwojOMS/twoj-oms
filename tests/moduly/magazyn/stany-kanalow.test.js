import { it, expect, beforeEach, afterEach, vi } from 'vitest';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { modulyDla } from '../../../src/moduly/lista.ts';
import { ENV_DEMO } from '../../../scripts/demo-dane.mjs';
import { utworzKarte, zapiszProduktSklepowy, powiazProdukt } from '../../../src/oms/db/magazyn.js';
import { podgladPrzejecia, przejmijStany, obejmijStany, odczytajOstrzezenia, roznicaStanuErli } from '../../../src/moduly/magazyn/services/przejecie-stanow.js';
import { buildOmsServer } from '../../pomoc/serwer-testowy-oms.ts';
import { przelaczStany, dodajRuch, stanKarty } from '../../../src/oms/db/stany-magazynowe.js';
import { zapiszZamowienie } from '../../../src/oms/db/zamowienia.js';
import { zmienOferte } from '../../../src/oms/db/oferty-kanalow.ts';
import { readFileSync } from 'node:fs';
import { zalozKonto, ustawUprawnienia } from '../../../src/core/bezpieczenstwo/konta.js';
import { podpisz, NAZWA_CIASTECZKA_OMS } from '../../../src/core/bezpieczenstwo/sesja.js';
import { wczytajSekret } from '../../../src/core/bezpieczenstwo/sekret-sesji.js';

let db, karta;
beforeEach(() => {
  db = openOmsDb(':memory:', { moduly: modulyDla(ENV_DEMO) });
  karta = utworzKarte(db, { nazwa: 'Lampa Półcień', sku: 'LMP-01' });
});
afterEach(() => { vi.restoreAllMocks(); db.close(); });
function lustro(id, kartaId = karta, kanal = 'allegro_polcien', wariant = '', prowadzi = 'tak') {
  const p = zapiszProduktSklepowy(db, { kanal, produkt_id: id, wariant_id: wariant, nazwa: 'Lampa', odczytane_at: new Date().toISOString() });
  if (kartaId) powiazProdukt(db, p, kartaId);
  db.prepare('UPDATE produkty_sklepowe SET stan_prowadzony = ?, ilosc_kanalu = 7 WHERE id = ?').run(prowadzi, p);
}
it('przejmuje 3 jednoznaczne oferty, pomija brak karty, ponownie 0 nowych', () => {
  ['1', '2', '3'].forEach(id => lustro(id)); lustro('4', null);
  expect(przejmijStany(db, 'allegro_polcien', 'allegro').przejeto).toBe(3);
  expect(przejmijStany(db, 'allegro_polcien', 'allegro').przejeto).toBe(0);
  expect(db.prepare('SELECT tryb, pochodzenie FROM oferty_kanalow').all()).toEqual(Array(3).fill({ tryb: 'obserwowana', pochodzenie: 'przejeta' }));
});
it('Woo wariant 12/34; false i parent pominięte i policzone', () => {
  lustro('12', karta, 'sklep_polcien', '34');
  lustro('13', karta, 'sklep_polcien', '', 'nie');
  lustro('14', karta, 'sklep_polcien', '', 'rodzic');
  expect(podgladPrzejecia(db, 'sklep_polcien', 'woo').bezStanow).toBe(2);
  expect(przejmijStany(db, 'sklep_polcien', 'woo').przejeto).toBe(1);
  expect(db.prepare('SELECT id_zewnetrzne FROM oferty_kanalow').get().id_zewnetrzne).toBe('12/34');
});
it('obejmuje 2 z 3 wyłącznie flagą ilości, bez zarządzania treścią i bez zatwierdzenia stanów', () => {
  ['1', '2', '3'].forEach(id => lustro(id)); przejmijStany(db, 'allegro_polcien', 'allegro');
  const ids = db.prepare('SELECT id FROM oferty_kanalow ORDER BY id').all().map(w => w.id);
  expect(obejmijStany(db, 'allegro_polcien', ids.slice(0, 2))).toBe(2);
  expect(db.prepare('SELECT ilosc_z_oms, tryb FROM oferty_kanalow ORDER BY id').all()).toEqual([1, 1, 0].map(ilosc_z_oms => ({ ilosc_z_oms, tryb: 'obserwowana' })));
});
it('Woo po przejęciu traci prowadzenie stanu — odmowa objęcia', () => {
  lustro('12', karta, 'sklep_polcien', '34'); przejmijStany(db, 'sklep_polcien', 'woo');
  const o = db.prepare('SELECT id FROM oferty_kanalow').get();
  db.prepare("UPDATE produkty_sklepowe SET stan_prowadzony = 'nie'").run();
  expect(() => obejmijStany(db, 'sklep_polcien', [o.id], 'woo')).toThrow(/prowadzi/);
});
it('zamrożony stock ERLI odmawia objęcia całego wyboru', () => {
  przejmijStany(db, 'erli_polcien', 'erli', [{ externalId: 'LMP-01', sku: 'LMP-01', stock: 7, status: 'active', frozen: ['stock'] }]);
  const o = db.prepare('SELECT id FROM oferty_kanalow').get();
  expect(() => obejmijStany(db, 'erli_polcien', [o.id])).toThrow(/zamroż/);
  expect(db.prepare('SELECT ilosc_z_oms FROM oferty_kanalow').get().ilosc_z_oms).toBe(0);
});
it('odczyt ostrzeżeń liczy fulfillment oraz Woo backorders na produkcie i wariancie', async () => {
  lustro('12', karta, 'sklep_polcien', '34'); lustro('15', karta, 'sklep_polcien');
  const widziane = [];
  const klient = {
    pobierzStany: async ids => { widziane.push(ids); return [{ id: 15, backorders: 'no' }]; },
    pobierzStanyWariantow: async (rodzic, ids) => { widziane.push([rodzic, ...ids]); return [{ id: 34, backorders: 'notify' }]; },
  };
  expect((await odczytajOstrzezenia(db, { klucz: 'sklep_polcien', typ: 'woo' }, { sklepy: { sklep_polcien: klient } })).backorders).toBe(1);
  expect(widziane).toEqual([['12', '34'], ['15']]);
  expect((await odczytajOstrzezenia(db, { klucz: 'allegro', typ: 'allegro' }, {
    kontaAllegro: () => [{ klucz: 'allegro', klient: { pobierzOferty: async () => [{ isFulfillment: true }, { isFulfillment: false }] } }],
  })).fulfillment).toBe(1);
});

const auth = { authorization: `Basic ${Buffer.from('operator:atrapa').toString('base64')}`, origin: 'http://localhost' };
async function serwer(wlacz = true) {
  const app = buildOmsServer({ db, config: { auth: { user: 'operator', pass: 'atrapa' },
    definicje: [{ klucz: 'allegro', typ: 'allegro', etykieta: 'Konto lamp' }, { klucz: 'erli_polcien', typ: 'erli', etykieta: 'ERLI lamp' }], sklepy: {}, kanaly: {} },
    magazyn: { gotowy: () => true, stan: () => ({ trwa: false, kanaly: [] }) } });
  await app.ready();
  if (wlacz) przelaczStany(db, { wlacz: true, konto: { login: 'operator' } });
  return app;
}
it('ekran i objęcie: podpis, 2 z 3, konto wstrzymane i ostrzeżenie D58', async () => {
  const app = await serwer();
  try {
    ['1', '2', '3'].forEach(id => lustro(id, karta, 'allegro'));
    przejmijStany(db, 'allegro', 'allegro');
    const ids = db.prepare('SELECT id FROM oferty_kanalow ORDER BY id').all().map(w => String(w.id));
    const url = '/magazyn/stany/kanaly/objecie';
    dodajRuch(db, { kartaId: karta, rodzaj: 'przyjecie', ilosc: 7, klucz: 'e411-przyjecie-xxxx', at: new Date(Date.now() + 1000).toISOString() });
    const payload = { konto: 'allegro', zaznaczone: ids.slice(0, 2) };
    expect((await app.inject({ method: 'POST', url, headers: auth, payload: { ...payload, zatwierdz: '1' } })).statusCode).toBe(409);
    const r = await app.inject({ method: 'POST', url, headers: auth, payload });
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain('Oferty czynne'); expect(r.body).toContain('karta ma 3 ofert');
    expect(r.body).toMatch(/<td>7<\/td>\s*<td>7<\/td>/);
    const podglad = /name="podglad" value="([^"]+)"/.exec(r.body)?.[1];
    expect(podglad).toBeTruthy();
    expect((await app.inject({ method: 'POST', url, headers: auth, payload: { ...payload, zatwierdz: '1', podglad } })).statusCode).toBe(303);
    expect(db.prepare('SELECT COUNT(*) n FROM oferty_kanalow WHERE ilosc_z_oms = 1').get().n).toBe(2);
  } finally { await app.close(); }
});
it('D14: bez przełącznika, po wyłączeniu bez i z zatwierdzeniem — link ukryty i trasy 404', async () => {
  const app = await serwer(false);
  try {
    let bazowy;
    for (const wariant of [0, 1, 2]) {
      if (wariant) {
        const p = przelaczStany(db, { wlacz: true, konto: { login: 'operator' } });
        if (wariant === 2) db.prepare("INSERT INTO stany_zatwierdzenia (przelaczenie_id, zatwierdzono_at, ofert, skrot) VALUES (?, ?, 0, 'test')").run(p.id ?? db.prepare('SELECT MAX(id) id FROM magazyn_przelaczenia').get().id, new Date().toISOString());
        przelaczStany(db, { wlacz: false, konto: { login: 'operator' } });
      }
      const r = await app.inject({ url: '/magazyn', headers: auth });
      bazowy ??= r.body;
      expect(r.body).toBe(bazowy);
      expect(r.body).not.toContain('Stany w kanałach');
      for (const [method, url] of [['GET', '/magazyn/stany/kanaly'], ['POST', '/magazyn/stany/kanaly/przejecie'], ['POST', '/magazyn/stany/kanaly/objecie']]) {
        expect((await app.inject({ method, url, headers: auth })).statusCode).toBe(404);
      }
    }
  } finally { await app.close(); }
});
it('nie-admin i brak CSRF → 403', async () => {
  const app = await serwer();
  try {
    zalozKonto(db, { login: 'admin', imie: 'Admin', haslo: 'test', rola: 'admin', admin: true });
    const u = zalozKonto(db, { login: 'czytelnik', imie: 'Czytelnik', haslo: 'test', rola: 'operator' });
    ustawUprawnienia(db, u, ['magazyn']);
    const cookie = `${NAZWA_CIASTECZKA_OMS}=${podpisz('czytelnik', wczytajSekret(db), Date.now(), 0)}`;
    for (const akcja of ['przejecie', 'objecie']) {
      const url = `/magazyn/stany/kanaly/${akcja}`;
      expect((await app.inject({ method: 'POST', url, headers: { origin: 'http://localhost', cookie } })).statusCode).toBe(403);
      expect((await app.inject({ method: 'POST', url, headers: { authorization: auth.authorization } })).statusCode).toBe(403);
    }
  } finally { await app.close(); }
});
it('zamrożony stock odrzuca już podgląd objęcia ERLI', async () => {
  const app = await serwer();
  try {
    przejmijStany(db, 'erli_polcien', 'erli', [{ externalId: 'LMP-01', sku: 'LMP-01', stock: 7, status: 'active', frozen: ['stock'] }]);
    const o = db.prepare('SELECT id FROM oferty_kanalow').get();
    const r = await app.inject({ method: 'POST', url: '/magazyn/stany/kanaly/objecie', headers: auth,
      payload: { konto: 'erli_polcien', zaznaczone: String(o.id) } });
    expect(r.statusCode).toBe(409); expect(r.body).toContain('zamrożony stock');
  } finally { await app.close(); }
});
it('podpis przejęcia: ważny 30 minut, związany z kontem, wyborem i aktualnym lustrem', async () => {
  const app = await serwer();
  try {
    lustro('1', karta, 'allegro');
    const url = '/magazyn/stany/kanaly/przejecie';
    const pokaz = () => app.inject({ method: 'POST', url, headers: auth, payload: { konto: 'allegro' } });
    const zapisz = podglad => app.inject({ method: 'POST', url, headers: auth, payload: { konto: 'allegro', zatwierdz: '1', podglad } });
    const token = r => /name="podglad" value="([^"]+)"/.exec(r.body)?.[1];
    const pierwszy = token(await pokaz());
    expect(pierwszy).toBeTruthy();
    const teraz = Date.now(); vi.spyOn(Date, 'now').mockReturnValue(teraz + 31 * 60_000);
    expect((await zapisz(pierwszy)).statusCode).toBe(409);
    vi.restoreAllMocks();
    const drugi = token(await pokaz()); lustro('2', karta, 'allegro');
    expect((await zapisz(drugi)).statusCode).toBe(409);
    expect(db.prepare('SELECT COUNT(*) n FROM oferty_kanalow').get().n).toBe(0);
    const trzeci = token(await pokaz());
    expect((await zapisz(trzeci)).statusCode).toBe(303);
    expect(db.prepare('SELECT COUNT(*) n FROM oferty_kanalow').get().n).toBe(2);
  } finally { await app.close(); }
});

const ERLI = 'erli_polcien';
const produktErli = (nadpisz = {}) => ({ externalId: 'LMP-01', sku: 'LMP-01', stock: 7, status: 'active', ...nadpisz });
it.each([[true, 'true'], [['*'], "['*']"], [{ stock: 1 }, '{stock:1}'], [{ stock: 'manual' }, 'obiekt tekst']])(
  'e411-zamrozony: frozen %s odmawia objęcia, a rejestr trzyma jedną postać', (frozen) => {
    przejmijStany(db, ERLI, 'erli', [produktErli({ frozen })]);
    const o = db.prepare('SELECT id, odczyt_zamrozone_json j FROM oferty_kanalow').get();
    expect(Array.isArray(JSON.parse(o.j))).toBe(true);
    expect(() => obejmijStany(db, ERLI, [o.id])).toThrow(/zamroż/);
    expect(db.prepare('SELECT ilosc_z_oms FROM oferty_kanalow').get().ilosc_z_oms).toBe(0);
  });
it('e411-zamrozony: zapis pętli [\'*\'] też odmawia, a inne pole niż stock nie', () => {
  przejmijStany(db, ERLI, 'erli', [produktErli()]);
  const o = db.prepare('SELECT id FROM oferty_kanalow').get();
  zmienOferte(db, o.id, { odczytZamrozone: ['*'] });
  expect(() => obejmijStany(db, ERLI, [o.id])).toThrow(/zamroż/);
  zmienOferte(db, o.id, { odczytZamrozone: ['price'] });
  expect(obejmijStany(db, ERLI, [o.id])).toBe(1);
});
it('e411-ostrzezenia-filtr: Woo odpytuje tylko oferty z własnym stanem i kartą', async () => {
  lustro('12', karta, 'sklep_polcien', '34'); lustro('13', karta, 'sklep_polcien', '', 'nie'); lustro('14', null, 'sklep_polcien');
  const widziane = [];
  const klient = { pobierzStany: async ids => { widziane.push(ids); return []; },
    pobierzStanyWariantow: async (rodzic, ids) => { widziane.push([rodzic, ...ids]); return []; } };
  await odczytajOstrzezenia(db, { klucz: 'sklep_polcien', typ: 'woo' }, { sklepy: { sklep_polcien: klient } });
  expect(widziane).toEqual([['12', '34']]);
});
it('e411-fulfillment: kształt P20d (pomiar 14.11) — isFulfillment na elemencie listy; szczegóły bez pola = brak odczytu', async () => {
  const fx = n => JSON.parse(readFileSync(new URL(`../../fixtures/allegro/${n}`, import.meta.url), 'utf8'));
  const { offers } = fx('e4-zmyslona-lista-ofert-fulfillment.json');
  const opcje = oferty => ({ kontaAllegro: () => [{ klucz: 'allegro', klient: { pobierzOferty: async () => oferty } }] });
  const ostrzezenia = async oferty => odczytajOstrzezenia(db, { klucz: 'allegro', typ: 'allegro' }, opcje(oferty));
  // Oferta z true to założenie z dokumentacji (pomiar: 446 ofert, same false).
  const w = await ostrzezenia(offers);
  expect(w.fulfillment).toBe(1); expect([...w.fulfillmentIds]).toEqual(['9000000011']);
  // Zmierzony przypadek: pole w każdej ofercie, wszędzie false → 0, nie „nieznane”.
  expect((await ostrzezenia(offers.slice(1))).fulfillment).toBe(0);
  // Szczegóły oferty nie mają pola fulfillment — brak pola to „nie wiem”, nie false.
  const w2 = await ostrzezenia([fx('e4-zmyslona-szczegoly-oferty.json')]);
  expect(w2.fulfillment).toBeNull(); expect(w2.fulfillmentIds.size).toBe(0);
});
it('e411-skutek: objęcie pokazuje status w kanale i skutek (wznowienie, zakończenie, fulfillment)', async () => {
  const app = await serwer();
  try {
    ['1', '2', '3'].forEach(id => lustro(id, karta, 'allegro'));
    db.prepare("UPDATE produkty_sklepowe SET status_publikacji = ? WHERE produkt_id = '1'").run('ENDED');
    db.prepare("UPDATE produkty_sklepowe SET status_publikacji = ? WHERE produkt_id = '2'").run('ACTIVE');
    przejmijStany(db, 'allegro', 'allegro');
    dodajRuch(db, { kartaId: karta, rodzaj: 'przyjecie', ilosc: 7, klucz: 'e411-skutek-xxxx', at: new Date(Date.now() + 1000).toISOString() });
    const ids = db.prepare('SELECT id FROM oferty_kanalow ORDER BY id').all().map(x => String(x.id));
    const r = await app.inject({ method: 'POST', url: '/magazyn/stany/kanaly/objecie', headers: auth, payload: { konto: 'allegro', zaznaczone: ids.slice(0, 2) } });
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain('Status w kanale'); expect(r.body).toContain('<td>ENDED</td>'); expect(r.body).toContain('<td>ACTIVE</td>');
    expect(r.body).toContain('Zostanie wznowiona');
  } finally { await app.close(); }
});
it('e411-skutek: czysta funkcja — zakończenie przy 0 i fulfillment', async () => {
  const { skutekObjecia } = await import('../../../src/moduly/magazyn/services/przejecie-stanow.js');
  const o = { idZewnetrzne: '9', odczytStatus: 'ACTIVE' };
  expect(skutekObjecia('allegro', o, 0)).toMatch(/zakończona/);
  expect(skutekObjecia('allegro', o, 3, new Set(['9']))).toMatch(/Fulfillment/);
  expect(skutekObjecia('allegro', o, 3)).toBe('');
  expect(skutekObjecia('woo', { ...o, odczytStatus: 'ENDED' }, 3)).toBe('');
});
it('e411-podpis-pola: odczyt pętli (znacznik czasu i ilość) nie unieważnia podpisu objęcia', async () => {
  const app = await serwer();
  try {
    ['1', '2'].forEach(id => lustro(id, karta, 'allegro')); przejmijStany(db, 'allegro', 'allegro');
    const ids = db.prepare('SELECT id FROM oferty_kanalow ORDER BY id').all().map(x => String(x.id));
    const url = '/magazyn/stany/kanaly/objecie'; const payload = { konto: 'allegro', zaznaczone: ids };
    const r = await app.inject({ method: 'POST', url, headers: auth, payload });
    const podglad = /name="podglad" value="([^"]+)"/.exec(r.body)?.[1];
    zmienOferte(db, Number(ids[0]), { odczytanoAt: new Date(Date.now() + 5000).toISOString(), odczytIlosc: 3, odczytIloscKanalu: 3 });
    db.prepare('UPDATE produkty_sklepowe SET ilosc_kanalu = 2, odczytane_at = ?').run(new Date().toISOString());
    expect((await app.inject({ method: 'POST', url, headers: auth, payload: { ...payload, zatwierdz: '1', podglad } })).statusCode).toBe(303);
    // ...ale zmiana decyzji (tryb) już tak
    const r2 = await app.inject({ method: 'POST', url, headers: auth, payload: { konto: 'allegro', zaznaczone: [ids[0]] } });
    const p2 = /name="podglad" value="([^"]+)"/.exec(r2.body)?.[1];
    zmienOferte(db, Number(ids[0]), { tryb: 'zarzadzana' });
    expect((await app.inject({ method: 'POST', url, headers: auth, payload: { konto: 'allegro', zaznaczone: [ids[0]], zatwierdz: '1', podglad: p2 } })).statusCode).toBe(409);
    // ...i zmiana statusu oferty (ACTIVE → ENDED zmienia skutek: wznowienie z opłatą)
    const r3 = await app.inject({ method: 'POST', url, headers: auth, payload: { konto: 'allegro', zaznaczone: [ids[1]] } });
    const p3 = /name="podglad" value="([^"]+)"/.exec(r3.body)?.[1];
    zmienOferte(db, Number(ids[1]), { odczytStatus: 'ENDED' });
    expect((await app.inject({ method: 'POST', url, headers: auth, payload: { konto: 'allegro', zaznaczone: [ids[1]], zatwierdz: '1', podglad: p3 } })).statusCode).toBe(409);
  } finally { await app.close(); }
});
it('e411-roznica-erli: różnica stanu karty z zamówień ERLI od granicy (D59)', async () => {
  przelaczStany(db, { wlacz: true, konto: { login: 'operator' } });
  dodajRuch(db, { kartaId: karta, rodzaj: 'przyjecie', ilosc: 12, klucz: 'e411-roznica-xxxx', at: new Date(Date.now() + 1000).toISOString() });
  zapiszZamowienie(db, ERLI, { zrodlo_id: 'e-1', numer: 'E-1', klient: { first_name: 'Anna' }, dostawa: { city: 'Pęki' },
    metoda_wysylki: 'erli_dpd', kwota_pobrania: null, chce_fakture: 0, nip: null, kwota_brutto: '50.00', status_woo: null,
    oplacone_at: null, anulowane: 0, utworzone_at: new Date(Date.now() + 2000).toISOString(),
    pozycje: [{ nazwa: 'Lampa', sku: null, ilosc: 7, cena_brutto: '50.00', vat: '23', zdjecie_url: null, zrodlo_id: 1, produkt_id: null, oferta_id: 'LMP-01' }] }, {});
  expect(stanKarty(db, karta).stan).toBe(12);
  const wiersze = podgladPrzejecia(db, ERLI, 'erli', [produktErli()]).wiersze;
  expect(roznicaStanuErli(db, ERLI, wiersze)).toEqual([{ kartaId: karta, przed: 12, po: 5 }]);
  przejmijStany(db, ERLI, 'erli', [produktErli()]);
  expect(stanKarty(db, karta).stan).toBe(5);
});
async function serwerErli(klient) {
  const app = buildOmsServer({ db, config: { auth: { user: 'operator', pass: 'atrapa' },
    definicje: [{ klucz: ERLI, typ: 'erli', prefiks: 'ERLI_POLCIEN', etykieta: 'ERLI lamp' }], sklepy: {}, kanaly: {} },
    magazyn: { gotowy: () => true, stan: () => ({ trwa: false, kanaly: [] }) },
    nadpisania: { 'kanaly.klienciKanalow': klient ? { [ERLI]: klient } : {}, 'kanaly.repozytoriumKanalow': {
      listaTypu: typ => typ === 'erli' ? [{ klucz: ERLI, nazwa: 'Lampy' }] : [], zapisyZablokowane: () => false } } });
  await app.ready();
  przelaczStany(db, { wlacz: true, konto: { login: 'operator' } });
  return app;
}
const tokenZ = r => /name="podglad" value="([^"]+)"/.exec(r.body)?.[1];
const urlPrzejecia = '/magazyn/stany/kanaly/przejecie';
it('e411-erli-limit: lista ERLI częściowa → 409 i zero wierszy; konto bez klienta → 400', async () => {
  let licznik = 0;
  const klient = { szukajProduktow: async () => Array.from({ length: 100 }, () => produktErli({ externalId: `P-${licznik++}`, sku: null })) };
  const app = await serwerErli(klient);
  try {
    const r = await app.inject({ method: 'POST', url: urlPrzejecia, headers: auth, payload: { konto: ERLI } });
    expect(r.statusCode).toBe(409); expect(r.body).toContain('częściowa');
    expect(db.prepare('SELECT COUNT(*) n FROM oferty_kanalow').get().n).toBe(0);
  } finally { await app.close(); }
  const bez = await serwerErli(null);
  try { expect((await bez.inject({ method: 'POST', url: urlPrzejecia, headers: auth, payload: { konto: ERLI } })).statusCode).toBe(400); }
  finally { await bez.close(); }
});
it('e411-erli-trasa: dwie karty z tym samym SKU nie są przejmowane, a czas odczytu to chwila odczytu', async () => {
  utworzKarte(db, { nazwa: 'Lampa bliźniacza', sku: 'LMP-03', ean: '5900000000011' });
  utworzKarte(db, { nazwa: 'Lampa druga', sku: 'LMP-04', ean: '5900000000011' });
  utworzKarte(db, { nazwa: 'Kinkiet', sku: 'LMP-02' });
  const klient = { szukajProduktow: async () => [produktErli({ externalId: 'LMP-03', sku: 'LMP-03', ean: '5900000000011' }), produktErli({ externalId: 'LMP-02', sku: 'LMP-02' })] };
  const app = await serwerErli(klient);
  try {
    const odczytano = Date.parse('2026-11-10T10:00:00.000Z');
    const spy = vi.spyOn(Date, 'now').mockReturnValue(odczytano);
    const r = await app.inject({ method: 'POST', url: urlPrzejecia, headers: auth, payload: { konto: ERLI } });
    expect(r.statusCode).toBe(200);
    spy.mockReturnValue(odczytano + 10 * 60_000);
    expect((await app.inject({ method: 'POST', url: urlPrzejecia, headers: auth, payload: { konto: ERLI, zatwierdz: '1', podglad: tokenZ(r) } })).statusCode).toBe(303);
    expect(db.prepare('SELECT id_zewnetrzne FROM oferty_kanalow').all()).toEqual([{ id_zewnetrzne: 'LMP-02' }]);
    expect(db.prepare('SELECT odczytano_at FROM oferty_kanalow').get().odczytano_at).toBe('2026-11-10T10:00:00.000Z');
  } finally { await app.close(); }
});
it('e411-link-admin: link „Stany w kanałach” widzi admin, nie widzi rola z prawem do Magazynu', async () => {
  const app = await serwer();
  try {
    expect((await app.inject({ url: '/magazyn', headers: auth })).body).toContain('href="/magazyn/stany/kanaly"');
    const u = zalozKonto(db, { login: 'magazynier', imie: 'Magazynier', haslo: 'test', rola: 'operator' });
    ustawUprawnienia(db, u, ['magazyn']);
    const cookie = `${NAZWA_CIASTECZKA_OMS}=${podpisz('magazynier', wczytajSekret(db), Date.now(), 0)}`;
    const r = await app.inject({ url: '/magazyn', headers: { cookie } });
    expect(r.statusCode).toBe(200);
    expect(r.body).not.toContain('href="/magazyn/stany/kanaly"');
  } finally { await app.close(); }
});

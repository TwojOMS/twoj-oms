// PRZ-160.E4.16 — symulator zakupu w piaskownicy: atrapy kanałów zdejmują sztuki, zamówienie trafia do bazy OMS.
import { afterEach, describe, expect, it } from 'vitest';
import { openOmsDb } from '../../src/oms/db/db.ts';
import { MODULY } from '../../src/moduly/lista.ts';
import { kolejnoscBudowy } from '../../src/core/sprawdz-moduly.ts';
import { pobierzZamowienie } from '../../src/oms/db/zamowienia.js';
import { powiazProdukt, utworzKarte, zapiszProduktSklepowy } from '../../src/oms/db/magazyn.js';
import { wstawOferte } from '../../src/oms/db/oferty-kanalow.ts';
import { createAtrapaWoo } from '../../deploy/proba/atrapy/kanaly.mjs';
import { createSerwerOfertAllegro } from '../../deploy/proba/atrapy/allegro-oferty.mjs';
import { createAtrapaErli } from '../../deploy/proba/atrapy/erli.mjs';
import { createZakup, main } from '../../deploy/proba/zakup.mjs';
import { KANALY } from '../../scripts/demo-dane-firma.mjs';
import { katalogWoo, ofertyAllegro } from '../../scripts/demo-dane-katalog.mjs';

const PROBA = { OMS_TRYB: 'proba' };
const cicho = () => {};
const WOO = KANALY.find(k => k.typ === 'woo').klucz;
const ALLEGRO = KANALY.find(k => k.typ === 'allegro').klucz;
const ERLI = 'erli-polcien-test';
let db;
afterEach(() => { db?.close(); db = null; });

function baza() {
  db = openOmsDb(':memory:', { moduly: kolejnoscBudowy(MODULY) });
  return db;
}
function karta(sku) {
  return utworzKarte(db, { nazwa: `Lampa ${sku}`, sku });
}
function kartaWoo() {
  const produkt = katalogWoo(WOO).produkty.find(p => p.type === 'simple' && p.manage_stock === true);
  const id = karta('LMP-SYM-WOO');
  powiazProdukt(db, zapiszProduktSklepowy(db, { kanal: WOO, produkt_id: produkt.id, nazwa: produkt.name, odczytane_at: '2026-11-14T10:00:00.000Z' }), id);
  return { kartaId: id, produkt };
}
function kartaAllegro() {
  const oferta = ofertyAllegro(ALLEGRO).find(o => o.stock.available >= 3);
  const id = karta('LMP-SYM-ALG');
  powiazProdukt(db, zapiszProduktSklepowy(db, { kanal: ALLEGRO, produkt_id: oferta.id, nazwa: oferta.name, odczytane_at: '2026-11-14T10:00:00.000Z' }), id);
  return { kartaId: id, oferta };
}
async function kartaErli(stock = 5) {
  db.prepare(`INSERT INTO konfiguracja_integracji (integracja, ustawienia_json, sekrety_json, zmieniono_at)
    VALUES (?, '{}', '{}', '2026-11-14T10:00:00.000Z')`).run(`erli:${ERLI}`);
  const erli = createAtrapaErli({ db, kanal: ERLI, env: PROBA });
  await erli.utworzProdukt('PC-SYM-1', { name: 'Lampa testowa', sku: 'LMP-SYM-ERL', price: 2500, stock, status: 'active',
    images: [], externalCategories: [], frozen: {}, currency: 'PLN' });
  const id = karta('LMP-SYM-ERL');
  wstawOferte(db, { kartaId: id, kanal: ERLI, idZewnetrzne: 'PC-SYM-1', stan: 'aktywna' });
  return { kartaId: id };
}
const stanErli = () => JSON.parse(db.prepare("SELECT dane_json FROM atrapa_erli_stan WHERE kanal=? AND rodzaj='produkt' AND id='PC-SYM-1'")
  .get(ERLI).dane_json).stock;
const stanWoo = async (id) => (await createAtrapaWoo({ db, kanal: WOO, env: PROBA, log: cicho }).pobierzStany([id]))[0].stock_quantity;
const serwerAllegro = (env = PROBA) => createSerwerOfertAllegro({ db, kanal: ALLEGRO, env });
const pozycje = (id) => db.prepare('SELECT ilosc, produkt_id, oferta_id, wariant_id FROM pozycje WHERE zamowienie_id = ?').all(id)
  .map(p => ({ ...p }));
const liczbaZamowien = () => db.prepare('SELECT COUNT(*) AS n FROM zamowienia').get().n;

describe('E4.16 — symulator zakupu', () => {
  it('poza próbą odmawia, zanim cokolwiek zapisze (fabryka i CLI)', async () => {
    baza();
    const { kartaId } = kartaWoo();
    expect(() => createZakup({ db, env: { OMS_TRYB: 'produkcja' }, log: cicho })).toThrow(/symulator zakupu/);
    expect(() => createZakup({ db, env: {}, log: cicho })).toThrow(/symulator zakupu/);
    await expect(main(['kup', '--kanal', WOO, '--karta', String(kartaId), '--ilosc', '1'], { OMS_TRYB: 'produkcja' }))
      .rejects.toThrow(/symulator zakupu/);
    expect(liczbaZamowien()).toBe(0);
  });

  it('kup 2 w Allegro: atrapa −2, zamówienie z pozycją oferty', async () => {
    baza();
    const { kartaId, oferta } = kartaAllegro();
    const przed = serwerAllegro().oferta(oferta.id).stock.available;
    const zakup = createZakup({ db, env: PROBA, log: cicho });
    const { zamowienieId } = await zakup.kup({ kanal: ALLEGRO, karta: kartaId, ilosc: 2 });
    expect(serwerAllegro().oferta(oferta.id).stock.available).toBe(przed - 2);
    const z = pobierzZamowienie(db, zamowienieId);
    expect(z).toMatchObject({ sklep: ALLEGRO, anulowane: 0 });
    expect(pozycje(zamowienieId)).toEqual([{ ilosc: 2, produkt_id: null, oferta_id: oferta.id, wariant_id: null }]);
    // Anulowanie oddaje sztuki (ATRAPA_ALLEGRO_ODDAJE domyślnie tak).
    await zakup.anuluj({ zamowienie: zamowienieId });
    expect(serwerAllegro().oferta(oferta.id).stock.available).toBe(przed);
    expect(pobierzZamowienie(db, zamowienieId).anulowane).toBe(1);
    await expect(zakup.anuluj({ zamowienie: zamowienieId })).rejects.toThrow(/anulowane/);
    expect(serwerAllegro().oferta(oferta.id).stock.available).toBe(przed);
  });

  it('atrapa Allegro: zakup do zera kończy ofertę, flagi ATRAPA_ALLEGRO_* wyłączają koniec i zwrot', async () => {
    baza();
    const { oferta } = kartaAllegro();
    const s = serwerAllegro();
    const ile = s.oferta(oferta.id).stock.available;
    s.kup(oferta.id, ile);
    expect([s.oferta(oferta.id).stock.available, s.oferta(oferta.id).publication.status]).toEqual([0, 'ENDED']);
    s.oddaj(oferta.id, 1);
    expect(s.oferta(oferta.id).stock.available).toBe(1);

    const bez = serwerAllegro({ ...PROBA, ATRAPA_ALLEGRO_KONCZY: 'nie', ATRAPA_ALLEGRO_ODDAJE: 'nie' });
    bez.kup(oferta.id, 1);
    expect([bez.oferta(oferta.id).stock.available, bez.oferta(oferta.id).publication.status]).toEqual([0, 'ENDED']);
    const druga = ofertyAllegro(ALLEGRO).filter(o => o.id !== oferta.id).find(o => o.stock.available >= 2);
    bez.kup(druga.id, druga.stock.available);
    expect([bez.oferta(druga.id).stock.available, bez.oferta(druga.id).publication.status]).toEqual([0, 'ACTIVE']);
    bez.oddaj(druga.id, 2);
    expect(bez.oferta(druga.id).stock.available).toBe(0);
    expect(() => s.kup(oferta.id, 0)).toThrow(/ilość/i);
  });

  it('ERLI: zakup zdejmuje także poniżej zera, anulowanie nic nie oddaje', async () => {
    baza();
    const { kartaId } = await kartaErli(5);
    const zakup = createZakup({ db, env: PROBA, log: cicho });
    const { zamowienieId } = await zakup.kup({ kanal: ERLI, karta: kartaId, ilosc: 7 });
    expect(stanErli()).toBe(-2);
    expect(pozycje(zamowienieId)).toEqual([{ ilosc: 7, produkt_id: null, oferta_id: 'PC-SYM-1', wariant_id: null }]);
    await zakup.anuluj({ zamowienie: zamowienieId });
    expect(stanErli()).toBe(-2);
    expect(pobierzZamowienie(db, zamowienieId).anulowane).toBe(1);
  });

  it('Woo processing: zdejmuje od razu, anulowanie oddaje', async () => {
    baza();
    const { kartaId, produkt } = kartaWoo();
    const przed = await stanWoo(produkt.id);
    const zakup = createZakup({ db, env: PROBA, log: cicho });
    const { zamowienieId } = await zakup.kup({ kanal: WOO, karta: kartaId, ilosc: 2 });
    expect(await stanWoo(produkt.id)).toBe(przed - 2);
    expect(pobierzZamowienie(db, zamowienieId)).toMatchObject({ sklep: WOO, status_woo: 'processing' });
    expect(pozycje(zamowienieId)).toEqual([{ ilosc: 2, produkt_id: Number(produkt.id), oferta_id: null, wariant_id: null }]);
    await zakup.anuluj({ zamowienie: zamowienieId });
    expect(await stanWoo(produkt.id)).toBe(przed);
    expect(pobierzZamowienie(db, zamowienieId).anulowane).toBe(1);
  });

  it('Woo pending: atrapa bez zdjęcia, opłata zdejmuje (W3), drugi raz odmawia', async () => {
    baza();
    const { kartaId, produkt } = kartaWoo();
    const przed = await stanWoo(produkt.id);
    const zakup = createZakup({ db, env: PROBA, log: cicho });
    const { zamowienieId } = await zakup.kup({ kanal: WOO, karta: kartaId, ilosc: 3, status: 'pending' });
    expect(await stanWoo(produkt.id)).toBe(przed);
    expect(pobierzZamowienie(db, zamowienieId).status_woo).toBe('pending');
    await zakup.oplac({ zamowienie: zamowienieId });
    expect(await stanWoo(produkt.id)).toBe(przed - 3);
    expect(pobierzZamowienie(db, zamowienieId).status_woo).toBe('processing');
    await expect(zakup.oplac({ zamowienie: zamowienieId })).rejects.toThrow(/pending/);
    expect(await stanWoo(produkt.id)).toBe(przed - 3);
  });

  it('Woo pending anulowane przed opłatą nic nie oddaje', async () => {
    baza();
    const { kartaId, produkt } = kartaWoo();
    const przed = await stanWoo(produkt.id);
    const zakup = createZakup({ db, env: PROBA, log: cicho });
    const { zamowienieId } = await zakup.kup({ kanal: WOO, karta: kartaId, ilosc: 1, status: 'pending' });
    await zakup.anuluj({ zamowienie: zamowienieId });
    expect(await stanWoo(produkt.id)).toBe(przed);
  });

  it('odmawia: zła ilość, karta bez oferty w kanale, nieznany kanał, status pending poza Woo', async () => {
    baza();
    const { kartaId } = kartaWoo();
    const zakup = createZakup({ db, env: PROBA, log: cicho });
    await expect(zakup.kup({ kanal: WOO, karta: kartaId, ilosc: 0 })).rejects.toThrow(/ilość/i);
    await expect(zakup.kup({ kanal: ALLEGRO, karta: kartaId, ilosc: 1 })).rejects.toThrow(/oferty/);
    await expect(zakup.kup({ kanal: 'nie-ma-takiego', karta: kartaId, ilosc: 1 })).rejects.toThrow(/kanał/i);
    const { kartaId: allegroKarta } = kartaAllegro();
    await expect(zakup.kup({ kanal: ALLEGRO, karta: allegroKarta, ilosc: 1, status: 'pending' })).rejects.toThrow(/Woo/);
    expect(liczbaZamowien()).toBe(0);
  });
});

// Przebieg „Pobierz treść i zdjęcia ofert" (Allegro → karty). Dane: katalog lamp Pracowni Półcień
// z atrapy (`scripts/demo-dane-katalog.mjs`); klient Allegro i pobieranie zdjęć wstrzyknięte — żadnej sieci.
import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { utworzKarte, zapiszKarte, zapiszProduktSklepowy, powiazProdukt, odepnijOferte } from '../../../src/oms/db/magazyn.js';
import { pobierzTrescOfertAllegro, createTrescAllegroPrzebieg } from '../../../src/moduly/magazyn/services/allegro-tresc-kart.js';
import { odswiezMagazyn } from '../../../src/moduly/magazyn/services/magazyn-sync.js';
import { ofertyAllegro, ofertaAllegroPelna, kategoriaAllegroDemo, parametryKategoriiAllegroDemo } from '../../../scripts/demo-dane-katalog.mjs';

const KANAL = 'allegro';
const ZRODLO = `allegro:${KANAL}`;
const AT = '2026-11-13T08:00:00.000Z';
const PO = '2026-11-13T09:00:00.000Z';
const OFERTY = ofertyAllegro(KANAL).slice(0, 3);
const ID = OFERTY.map(o => o.id);

const bazy = [];
const katalogi = [];
afterEach(() => {
  for (const db of bazy.splice(0)) db.close();
  for (const k of katalogi.splice(0)) rmSync(k, { recursive: true, force: true });
});

// Najmniejszy PNG, który przechodzi przez `zapiszZdjecie`; szerokość różni treść (a więc sha).
function png(szerokosc) {
  const b = Buffer.alloc(33);
  Buffer.from('89504e470d0a1a0a', 'hex').copy(b, 0);
  b.writeUInt32BE(13, 8); b.write('IHDR', 12, 'ascii');
  b.writeUInt32BE(szerokosc, 16); b.writeUInt32BE(10, 20);
  return b;
}
const numerZdjecia = adres => 1 + [...adres].reduce((s, c) => (s * 31 + c.charCodeAt(0)) % 997, 7);

function baza() {
  const db = openOmsDb(':memory:'); bazy.push(db);
  const karty = OFERTY.map((o, i) => {
    const karta = utworzKarte(db, { nazwa: `Karta lampy ${i + 1}` }, { at: AT });
    const pid = zapiszProduktSklepowy(db, { kanal: KANAL, produkt_id: o.id, wariant_id: '', nazwa: o.name, odczytane_at: AT });
    powiazProdukt(db, pid, karta);
    return karta;
  });
  return { db, karty };
}

function klient(nadpisania = {}) {
  return {
    pobierzOferte: vi.fn(async id => (nadpisania[id] ? nadpisania[id]() : ofertaAllegroPelna(KANAL, id))),
    pobierzKategorie: vi.fn(async id => kategoriaAllegroDemo(id)),
    pobierzParametryKategorii: vi.fn(async id => parametryKategoriiAllegroDemo(id)),
  };
}

function przebieg(db, k = klient(), { at = AT, pobierz } = {}) {
  const katalog = mkdtempSync(join(tmpdir(), 'oms-04b-')); katalogi.push(katalog);
  const pobieranie = pobierz ?? vi.fn(async adres => png(numerZdjecia(adres)));
  return pobierzTrescOfertAllegro({ db, allegro: { [KANAL]: k }, kanalyAllegro: [KANAL], katalog,
    teraz: () => new Date(at), pobierzZdjecie: pobieranie });
}

const karta = (db, id) => db.prepare('SELECT * FROM karty_produktow WHERE id = ?').get(id);
const zdjecia = (db, id) => db.prepare('SELECT * FROM zdjecia_kart WHERE karta_id = ? ORDER BY kolejnosc, id').all(id);
const lustro = (db, ofertaId) => db.prepare('SELECT * FROM produkty_sklepowe WHERE kanal = ? AND produkt_id = ?').get(KANAL, ofertaId);
const zapomnijPobranie = db => db.prepare('UPDATE produkty_sklepowe SET tresc_pobrana_at = NULL').run();
const zdjeciaOferty = (n, przedrostek = 'lampa') =>
  Array.from({ length: n }, (_, i) => `https://polcien.example.invalid/${przedrostek}-${i + 1}.jpg`);

it('komplet pól, zdjęcia i dane kanału trafiają na kartę; bez producenta (D28)', async () => {
  const { db, karty } = baza();
  // Karta założona z tej oferty: nazwa ma źródło Allegro, więc import może ją odświeżyć (D4).
  db.prepare(`INSERT INTO karty_zrodla_pol (karta_id, pole, zrodlo, reczne, zmieniono_at) VALUES (?, 'nazwa', ?, 0, ?)`)
    .run(karty[0], ZRODLO, AT);
  const adresy = zdjeciaOferty(5);
  let naraz = 0; let najwiecej = 0;
  const pobierz = vi.fn(async adres => {
    naraz += 1; najwiecej = Math.max(najwiecej, naraz);
    await new Promise(r => setTimeout(r, 5));
    naraz -= 1;
    return png(numerZdjecia(adres));
  });
  const pelna = ofertaAllegroPelna(KANAL, ID[0]);
  const k = klient({ [ID[0]]: () => ({ ...pelna, images: adresy }) });

  const wynik = await przebieg(db, k, { pobierz });

  expect(wynik).toMatchObject({ razem: 3, pobrane: 3, bledy: [], blad: null });
  expect(k.pobierzOferte.mock.calls.map(c => c[0])).toEqual(ID);
  const k1 = karta(db, karty[0]);
  expect(k1).toMatchObject({ nazwa: pelna.name, cena_gr: Math.round(Number(pelna.sellingMode.price.amount) * 100),
    stawka_vat: '23', ai_wspoltworzone: null, zmieniony_at: AT });
  expect(k1.ean).toMatch(/^200\d{10}$/);
  expect(JSON.parse(k1.opis_sekcje_json).sekcje.length).toBeGreaterThan(0);
  // Druga karta ma nazwę zastaną (bez wiersza źródła) — zostaje.
  expect(karta(db, karty[1]).nazwa).toBe('Karta lampy 2');

  const galeria = zdjecia(db, karty[0]);
  expect(galeria.map(z => z.adres_zrodlowy)).toEqual(adresy);
  expect(galeria.map(z => z.kolejnosc)).toEqual([0, 1, 2, 3, 4]);
  for (const z of galeria) {
    expect(z).toMatchObject({ zrodlo: ZRODLO, typ: 'image/png' });
    expect(z.plik).toBe(`${z.sha256}.png`);
  }
  expect(najwiecej).toBe(2);

  const kanal = db.prepare("SELECT * FROM karty_dane_kanalu WHERE karta_id = ? AND typ_kanalu = 'allegro'").get(karty[0]);
  expect(kanal).toMatchObject({ polaczenie: KANAL, oferta_id: ID[0], kategoria_id: '257', ai_wspoltworzone: 0,
    oferta_zmieniona_at: pelna.updatedAt, pobrano_at: AT });
  expect(JSON.parse(kanal.kategoria_sciezka_json).map(s => s.nazwa)).toEqual(['Dom i Ogród', 'Oświetlenie', 'Lampy']);
  const parametry = JSON.parse(kanal.parametry_json);
  expect(parametry.produkt.map(p => p.id)).toContain('225693');
  expect(parametry.oferta.map(p => p.id)).toEqual(['11323']);

  expect(lustro(db, ID[0])).toMatchObject({ tresc_pobrana_at: AT, tresc_zmieniona_at: pelna.updatedAt });
  const zrodla = db.prepare('SELECT pole, zrodlo, reczne FROM karty_zrodla_pol WHERE karta_id = ? ORDER BY pole').all(karty[0]);
  expect(zrodla).toEqual(['cena_gr', 'ean', 'marka', 'nazwa', 'opis_sekcje_json', 'stawka_vat', 'zdjecia']
    .map(pole => ({ pole, zrodlo: ZRODLO, reczne: 0 })));
});

it('pole ręczne i zastane nie zmieniają się ani przy pierwszym, ani przy ponownym przebiegu', async () => {
  const { db, karty } = baza();
  zapiszKarte(db, karty[0], { ean: '2000000000992' }, { at: AT });
  db.prepare('UPDATE karty_produktow SET cena_gr = 4321, stawka_vat = ? WHERE id = ?').run('8', karty[0]);
  const przed = karta(db, karty[0]);

  await przebieg(db);
  zapomnijPobranie(db);
  await przebieg(db, klient(), { at: PO });

  expect(karta(db, karty[0])).toMatchObject({ ean: '2000000000992', cena_gr: 4321, stawka_vat: '8', nazwa: przed.nazwa });
  expect(db.prepare("SELECT reczne FROM karty_zrodla_pol WHERE karta_id = ? AND pole = 'ean'").get(karty[0]).reczne).toBe(1);
  expect(db.prepare("SELECT * FROM karty_zrodla_pol WHERE karta_id = ? AND pole IN ('cena_gr', 'stawka_vat')").all(karty[0])).toEqual([]);
});

it('przerwany przebieg: drugi czyta tylko oferty niepobrane', async () => {
  const { db } = baza();
  const pierwszy = klient({ [ID[1]]: () => { throw Object.assign(new Error(`Allegro: HTTP 504 przy /sale/product-offers/${ID[1]}`), { status: 504 }); } });
  const w1 = await przebieg(db, pierwszy);
  expect(w1).toMatchObject({ razem: 3, pobrane: 2, blad: null });
  expect(w1.bledy).toEqual([expect.objectContaining({ kanal: KANAL, oferta_id: ID[1], blad: expect.stringContaining('504') })]);
  expect(lustro(db, ID[1]).tresc_pobrana_at).toBeNull();

  const drugi = klient();
  const w2 = await przebieg(db, drugi, { at: PO });
  expect(drugi.pobierzOferte.mock.calls.map(c => c[0])).toEqual([ID[1]]);
  expect(w2).toMatchObject({ razem: 1, pobrane: 1, bledy: [], blad: null });
  expect(lustro(db, ID[0]).tresc_pobrana_at).toBe(AT);
  expect(lustro(db, ID[1]).tresc_pobrana_at).toBe(PO);
});

it('oferta bez opisu i bez zdjęć nie wywraca przebiegu', async () => {
  const { db, karty } = baza();
  const k = klient({ [ID[0]]: () => ({ ...ofertaAllegroPelna(KANAL, ID[0]), description: null, images: [] }) });
  const pobierz = vi.fn(async adres => png(numerZdjecia(adres)));
  const wynik = await przebieg(db, k, { pobierz });
  expect(wynik).toMatchObject({ razem: 3, pobrane: 3, bledy: [], blad: null });
  expect(karta(db, karty[0]).opis_sekcje_json).toBeNull();
  expect(zdjecia(db, karty[0])).toEqual([]);
  expect(lustro(db, ID[0]).tresc_pobrana_at).toBe(AT);
});

it('oferta w EUR to wpis błędu, reszta pobrana', async () => {
  const { db, karty } = baza();
  const pelna = ofertaAllegroPelna(KANAL, ID[0]);
  const k = klient({ [ID[0]]: () => ({ ...pelna, sellingMode: { ...pelna.sellingMode, price: { amount: '20.00', currency: 'EUR' } } }) });
  // Błąd jednej oferty nie wywraca przebiegu: obietnica się spełnia, a nie odrzuca.
  const obietnica = przebieg(db, k);
  await expect(obietnica).resolves.toMatchObject({ razem: 3, pobrane: 2, blad: null });
  const wynik = await obietnica;
  expect(wynik.bledy).toEqual([expect.objectContaining({ oferta_id: ID[0], blad: expect.stringMatching(/EUR/) })]);
  expect(karta(db, karty[0]).cena_gr).toBeNull();
  expect(zdjecia(db, karty[0])).toEqual([]);
  expect(lustro(db, ID[0]).tresc_pobrana_at).toBeNull();
  expect(lustro(db, ID[2]).tresc_pobrana_at).toBe(AT);
});

it('odrzucone zdjęcie jest pomijane z wpisem, reszta galerii i oferta zapisane', async () => {
  const { db, karty } = baza();
  const adresy = zdjeciaOferty(3);
  const k = klient({ [ID[0]]: () => ({ ...ofertaAllegroPelna(KANAL, ID[0]), images: adresy }) });
  const pobierz = vi.fn(async adres => (adres === adresy[1] ? Buffer.from('to nie jest obraz') : png(numerZdjecia(adres))));
  const wynik = await przebieg(db, k, { pobierz });
  expect(wynik).toMatchObject({ pobrane: 3, blad: null });
  expect(wynik.bledy).toEqual([expect.objectContaining({ oferta_id: ID[0], zdjecie: adresy[1] })]);
  expect(zdjecia(db, karty[0]).map(z => z.adres_zrodlowy)).toEqual([adresy[0], adresy[2]]);
  expect(lustro(db, ID[0]).tresc_pobrana_at).toBe(AT);
});

it('najwyżej 20 zdjęć; to samo zdjęcie pod dwoma adresami to jeden wiersz', async () => {
  const { db, karty } = baza();
  const adresy = zdjeciaOferty(23);
  const k = klient({ [ID[0]]: () => ({ ...ofertaAllegroPelna(KANAL, ID[0]), images: adresy }) });
  const pobierz = vi.fn(async adres => png(adres === adresy[1] ? numerZdjecia(adresy[0]) : numerZdjecia(adres)));
  await przebieg(db, k, { pobierz });
  const galeria = zdjecia(db, karty[0]);
  expect(galeria).toHaveLength(19);
  expect(new Set(galeria.map(z => z.sha256)).size).toBe(19);
  expect(galeria.map(z => z.adres_zrodlowy)).not.toContain(adresy[1]);
  expect(pobierz.mock.calls.map(c => c[0])).not.toContain(adresy[20]);
});

it('403 kończy przebieg jednym komunikatem', async () => {
  const { db } = baza();
  const k = klient({ [ID[1]]: () => { throw Object.assign(new Error(`Allegro: HTTP 403 przy /sale/product-offers/${ID[1]}`), { status: 403 }); } });
  const wynik = await przebieg(db, k);
  expect(k.pobierzOferte).toHaveBeenCalledTimes(2);
  expect(wynik.pobrane).toBe(1);
  expect(wynik.bledy).toEqual([]);
  expect(wynik.blad).toMatch(/Allegro odmówiło dostępu/);
  expect(wynik.blad).toContain(KANAL);
  expect(lustro(db, ID[2]).tresc_pobrana_at).toBeNull();
});

it('dwa przebiegi tych samych danych: zmieniony_at karty i id zdjęć bez zmian', async () => {
  const { db, karty } = baza();
  const adresy = zdjeciaOferty(4);
  const k = () => klient({ [ID[0]]: () => ({ ...ofertaAllegroPelna(KANAL, ID[0]), images: adresy }) });
  await przebieg(db, k());
  const przedKarty = karty.map(id => karta(db, id));
  const przedZdjec = zdjecia(db, karty[0]);
  const przedZrodel = db.prepare('SELECT * FROM karty_zrodla_pol ORDER BY karta_id, pole').all();
  expect(przedZdjec).toHaveLength(4);

  zapomnijPobranie(db);
  const wynik = await przebieg(db, k(), { at: PO });
  expect(wynik).toMatchObject({ pobrane: 3, bledy: [] });
  expect(karty.map(id => karta(db, id))).toEqual(przedKarty);
  expect(zdjecia(db, karty[0])).toEqual(przedZdjec);
  expect(db.prepare('SELECT * FROM karty_zrodla_pol ORDER BY karta_id, pole').all()).toEqual(przedZrodel);
});

it('odnośniki Woo na karcie zostają — galeria cudza i galeria własna', async () => {
  const { db, karty } = baza();
  const woo = (kartaId, n) => db.prepare(`INSERT INTO zdjecia_kart (karta_id, kolejnosc, zrodlo, adres_zrodlowy, utworzono_at)
    VALUES (?, ?, 'woo:polcien', ?, ?)`).run(kartaId, n, `https://sklep-polcien.example.invalid/lampa-${n}.jpg`, AT);
  // Karta 1: galeria należy do sklepu — Allegro jej nie rusza.
  woo(karty[0], 0); woo(karty[0], 1);
  db.prepare(`INSERT INTO karty_zrodla_pol (karta_id, pole, zrodlo, reczne, zmieniono_at) VALUES (?, 'zdjecia', 'woo:polcien', 0, ?)`)
    .run(karty[0], AT);
  const sklepowe = zdjecia(db, karty[0]);
  // Karta 2: galeria Allegro; odnośnik sklepu dopisany później ma przetrwać zmianę zdjęć oferty.
  let adresy = zdjeciaOferty(2);
  const k = () => klient({ [ID[0]]: () => ({ ...ofertaAllegroPelna(KANAL, ID[0]), images: zdjeciaOferty(2, 'inna') }),
    [ID[1]]: () => ({ ...ofertaAllegroPelna(KANAL, ID[1]), images: adresy }) });
  await przebieg(db, k());
  woo(karty[1], 10);
  adresy = zdjeciaOferty(3, 'nowa');
  zapomnijPobranie(db);
  await przebieg(db, k(), { at: PO });

  expect(zdjecia(db, karty[0])).toEqual(sklepowe);
  const druga = zdjecia(db, karty[1]);
  expect(druga.filter(z => z.zrodlo === ZRODLO).map(z => z.adres_zrodlowy)).toEqual(adresy);
  expect(druga.filter(z => z.zrodlo === 'woo:polcien').map(z => z.adres_zrodlowy))
    .toEqual(['https://sklep-polcien.example.invalid/lampa-10.jpg']);
});

it('odczyt listy ze zmienionym updatedAt wraca ofertę do kolejki; ten sam zostawia ją pobraną', async () => {
  const { db } = baza();
  await przebieg(db);
  const pelna = ofertaAllegroPelna(KANAL, ID[0]);
  const lista = OFERTY.map((o, i) => ({ ...o, updatedAt: i === 0 ? '2026-11-12T10:00:00.000Z' : pelna.updatedAt }));
  const wynik = await odswiezMagazyn({ db, sklepy: {}, allegro: { [KANAL]: { pobierzOferty: async () => lista } },
    kanalySklepow: [], kanalyAllegro: [KANAL], teraz: () => PO, log: () => {} });
  expect(wynik.kanaly[0].blad).toBeNull();
  expect(lustro(db, ID[0]).tresc_pobrana_at).toBeNull();
  expect(lustro(db, ID[1]).tresc_pobrana_at).toBe(AT);
  // Lista bez updatedAt (tak oddaje /sale/offers) nie rusza pobranych.
  await odswiezMagazyn({ db, sklepy: {}, allegro: { [KANAL]: { pobierzOferty: async () => OFERTY } },
    kanalySklepow: [], kanalyAllegro: [KANAL], teraz: () => PO, log: () => {} });
  expect(lustro(db, ID[2]).tresc_pobrana_at).toBe(AT);
});

it('przepięta oferta (odpięcie i powiązanie z inną kartą) wraca do kolejki; powiązanie z tą samą kartą nie', async () => {
  const { db, karty } = baza();
  await przebieg(db);
  const pid = lustro(db, ID[0]).id;
  powiazProdukt(db, pid, karty[0]);
  expect(lustro(db, ID[0]).tresc_pobrana_at).not.toBeNull();
  const nowa = utworzKarte(db, { nazwa: 'Karta lampy po przepięciu' }, { at: AT });
  powiazProdukt(db, pid, nowa);
  expect(lustro(db, ID[0]).tresc_pobrana_at).toBeNull();
  const k = klient();
  await przebieg(db, k, { at: PO });
  expect(k.pobierzOferte).toHaveBeenCalledTimes(1);
  expect(karta(db, nowa).ean).not.toBeNull();
  expect(zdjecia(db, nowa).length).toBeGreaterThan(0);
  expect(db.prepare("SELECT count(*) n FROM karty_dane_kanalu WHERE karta_id = ? AND typ_kanalu = 'allegro'").get(nowa).n).toBe(1);
  db.prepare('UPDATE produkty_sklepowe SET tresc_pobrana_at = ? WHERE id = ?').run(PO, pid);
  expect(odepnijOferte(db, pid, [KANAL])).toBe(true);
  expect(lustro(db, ID[0]).tresc_pobrana_at).toBeNull();
});

it('przebieg w tle: start wraca od razu, postęp „N z M", drugi start odmawia', async () => {
  const { db } = baza();
  let zwolnij;
  const blokada = new Promise(r => { zwolnij = r; });
  const k = klient({ [ID[0]]: async () => { await blokada; return ofertaAllegroPelna(KANAL, ID[0]); } });
  const katalog = mkdtempSync(join(tmpdir(), 'oms-04b-')); katalogi.push(katalog);
  const tresc = createTrescAllegroPrzebieg({ db, allegro: { [KANAL]: k }, kanalyAllegro: [KANAL], katalog,
    pobierzZdjecie: async adres => png(numerZdjecia(adres)) });
  expect(tresc.gotowy()).toBe(true);
  expect(tresc.start()).toEqual({ wystartowal: true });
  expect(tresc.start()).toEqual({ wystartowal: false });
  await vi.waitFor(() => expect(tresc.stan().postep).toEqual({ zrobione: 0, zTego: 3 }));
  expect(tresc.stan().trwa).toBe(true);
  zwolnij();
  await vi.waitFor(() => expect(tresc.stan().trwa).toBe(false));
  expect(tresc.stan()).toMatchObject({ pobrane: 3, razem: 3, bledy: [], blad: null, postep: null });
  expect(tresc.stan().skonczony_at).toEqual(expect.any(String));
  expect(createTrescAllegroPrzebieg({ db, allegro: {}, kanalyAllegro: [] }).gotowy()).toBe(false);
});

import { afterEach, expect, it } from 'vitest';
import { openOmsDb } from '../../src/oms/db/db.ts';
import { modulRdzen } from '../../src/moduly/rdzen/modul.ts';
import { migracjaOfertKanalow } from '../../src/moduly/magazyn/migracje/0001-oferty-kanalow.ts';
import { wstawOferte, ofertaPoId, zapiszUstawieniaOfertKonta } from '../../src/oms/db/oferty-kanalow.ts';
import { createAtrapaErli } from '../../deploy/proba/atrapy/erli.mjs';
import { createErliClient } from '../../src/oms/erli/client.js';
import { katalogErli } from '../../src/integracje/kanal-modul.ts';
import { createPetlaOfert, zamrozonePola } from '../../src/moduly/magazyn/services/petla-ofert.js';

const bazy = [];
afterEach(() => { for (const db of bazy.splice(0)) db.close(); });
function stanowisko(opcje = {}) {
  const db = openOmsDb(':memory:', { moduly: [modulRdzen,
    { nazwa: 'magazyn', migracje: [migracjaOfertKanalow] }] });
  bazy.push(db);
  const atrapa = createAtrapaErli({ db, kanal: 'erli-polcien', env: { OMS_TRYB: 'proba' }, ...opcje });
  const zadania = [];
  let zgubOdpowiedz = false;
  const klient = createErliClient({ adresApi: 'https://sklep.polcien.example', kluczApi: 'atrapa-polcien',
    fetchImpl: async (url, init) => {
      const sciezka = new URL(url).pathname;
      zadania.push({ metoda: init.method, sciezka, cialo: init.body ? JSON.parse(init.body) : null });
      const wynik = await atrapa.fetchImpl(url, init);
      if (zgubOdpowiedz && init.method === 'POST' && sciezka === '/products/PC-K1') {
        zgubOdpowiedz = false;
        throw new TypeError('Utracona odpowiedź po zapisie w atrapie');
      }
      return wynik;
    } });
  return { db, atrapa, klient, zadania, utracOdpowiedz: () => { zgubOdpowiedz = true; } };
}
const produkt = (id = '999-test') => ({ name: 'Lampa Pracownia Półcień', sku: 'LMP-TEST', status: 'inactive',
  price: 12000, stock: 5, externalCategories: [{ source: 'shop', breadcrumb: [{ id, name: 'Lampy' }] }] });

it('wynik POST i PATCH pojawia się dopiero po dwóch odczytach GET / _search, także po odtworzeniu atrapy', async () => {
  const { db, klient } = stanowisko();
  await klient.utworzProdukt('PC-TEST', produkt());
  expect(await klient.pobierzProdukt('PC-TEST')).toMatchObject({ buyableProblems: [], categories: [], status: 'inactive' });
  const odtworzona = createAtrapaErli({ db, kanal: 'erli-polcien', env: { OMS_TRYB: 'proba' } });
  expect((await odtworzona.szukajProduktow())[0].buyableProblems).toEqual([]);
  expect((await klient.pobierzProdukt('PC-TEST')).buyableProblems).toEqual(['category']);
  await klient.zmienProdukt('PC-TEST', produkt());
  expect((await klient.szukajProduktow())[0].buyableProblems).toEqual([]);
  expect((await klient.pobierzProdukt('PC-TEST')).buyableProblems).toEqual([]);
  expect((await klient.szukajProduktow())[0].buyableProblems).toEqual(['category']);
});

it('filtr i strony nie gubią produktów; opóźnienie jest ustawialne, frozen ma kształt P6', async () => {
  const { klient } = stanowisko({ opoznienieProduktuOdczyty: 1, frozenProduktow: { 'PC-B': { stock: true, name: true } } });
  for (const id of ['PC-C', 'PC-A', 'PC-B']) await klient.utworzProdukt(id, produkt());
  const szukaj = after => klient.szukajProduktow({ filter: { field: 'externalId', operator: 'in', value: ['PC-A', 'PC-B'] },
    pagination: { sortField: 'externalId', order: 'ASC', limit: 1, ...(after ? { after } : {}) } });
  const a = await szukaj(); const b = await szukaj(a[0].externalId);
  expect(a.map(p => p.externalId)).toEqual(['PC-A']);
  expect(b.map(p => p.externalId)).toEqual(['PC-B']);
  expect(await szukaj(b[0].externalId)).toEqual([]);
  expect(b[0].buyableProblems).toEqual([]);
  expect(zamrozonePola(b[0].frozen)).toEqual(['stock', 'name']);
  expect((await klient.pobierzProdukt('PC-B')).buyableProblems).toEqual(['category']);
  await klient.zmienProdukt('PC-B', { stock: 99, name: 'Inna lampa' });
  expect(await klient.pobierzProdukt('PC-B')).toMatchObject({ stock: 5, name: produkt().name });
  const desc = await klient.szukajProduktow({ pagination: { sortField: 'externalId', order: 'DESC', after: 'PC-C', limit: 1 } });
  expect(desc.map(p => p.externalId)).toEqual(['PC-B']);
});

it('dowód 10 lamp: restart po wysłaniu, 9 produktów, 10 końcowych wierszy, zero duplikatów i zgubionych', async () => {
  const s = stanowisko();
  const { db, klient, zadania } = s;
  const teraz = () => new Date('2026-11-13T10:00:00Z');
  zapiszUstawieniaOfertKonta(db, 'erli-polcien', { czynne: true, narzutProcent: 0, progPotwierdzeniaProcent: 20,
    stalaIlosc: 5, czasWysylkiDni: 2, cennikDostaw: 'Dostawy Półcień', stawkaVat: '23' });
  const oferty = [];
  for (let i = 1; i <= 10; i++) {
    db.prepare(`INSERT INTO karty_produktow (id, sku, nazwa, ean, cena_gr, kategoria_glowna, utworzony_at, zmieniony_at)
      VALUES (?, ?, ?, ?, 12000, ?, ?, ?)`).run(i, `LMP-${i}`, `Pracownia Półcień — lampa ${i}`,
      `20000000000${String(i).padStart(2, '0')}`, i === 9 ? '999-lampy' : 'lampy', teraz().toISOString(), teraz().toISOString());
    db.prepare(`INSERT INTO zdjecia_kart (karta_id, kolejnosc, zrodlo, adres_zrodlowy, utworzono_at)
      VALUES (?, 0, 'woo', ?, ?)`).run(i, `https://polcien.example/lmp-${i}.png`, teraz().toISOString());
    oferty.push(wstawOferte(db, { kartaId: i, kanal: 'erli-polcien', idZewnetrzne: `PC-K${i}${i === 10 ? '-BLAD' : ''}`, stan: 'do_wyslania' }));
  }
  const nowaPetla = () => createPetlaOfert({ db, teraz,
    konta: () => [{ klucz: 'erli-polcien', katalog: katalogErli(klient), tylkoOdczyt: () => false }] });
  s.utracOdpowiedz();
  let petla = nowaPetla();
  await petla.przebieg();
  expect(ofertaPoId(db, oferty[0].id).stan).toBe('wyslana');
  expect(ofertaPoId(db, oferty[9].id)).toMatchObject({ stan: 'blad', blad: expect.stringContaining('Nie można zapisać produktu') });
  // Stara instancja zakończyła przebieg; usuwamy ją i wznawiamy na tej samej bazie i atrapie.
  petla = null;
  const wznowiona = nowaPetla();
  for (let i = 0; i < 5; i++) await wznowiona.przebieg();
  const produkty = await klient.szukajProduktow();
  expect(produkty).toHaveLength(9); // Dziesiąta karta została odrzucona kodem 400.
  expect(new Set(produkty.map(p => p.externalId)).size).toBe(9);
  const zapisy = zadania.filter(z => z.metoda === 'POST' && z.sciezka !== '/products/_search');
  expect(zapisy).toHaveLength(10);
  for (const o of oferty) expect(zapisy.filter(z => z.sciezka === `/products/${o.idZewnetrzne}`)).toHaveLength(1);
  const wynik = oferty.map(o => ofertaPoId(db, o.id));
  expect(db.prepare('SELECT count(*) AS n FROM oferty_kanalow').get().n).toBe(10);
  expect(wynik.map(o => o.stan)).toEqual([...Array(8).fill('nieaktywna'), 'problem', 'blad']);
  expect(wynik[8].problemy).toContainEqual({ kod: 'category', tekst: 'ERLI nie rozpoznało kategorii — przypisz ją w panelu ERLI.' });
  expect(JSON.stringify(zadania.map(z => z.cialo))).not.toContain('archived');
  await expect(klient.utworzProdukt('PC-K1', produkt())).rejects.toMatchObject({ status: 409 });
  expect(await klient.szukajProduktow()).toHaveLength(9);
});

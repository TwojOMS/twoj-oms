import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { buildOmsServer } from '../../pomoc/serwer-testowy-oms.ts';
import { zapiszProduktSklepowy, utworzKarte, powiazProdukt } from '../../../src/oms/db/magazyn.js';
import { wstawOferte } from '../../../src/oms/db/oferty-kanalow.ts';
import { listaNaZadanie } from '../../../src/moduly/kanaly/kolekcje-na-zadanie.ts';

// W działającym panelu definicje kanałów i listy kluczy sklepów to „żywe” kolekcje: każdy odczyt
// pyta bazę i odszyfrowuje tokeny. Lista Magazynu ma je czytać stałą liczbę razy na żądanie —
// odczyt w każdym wierszu dawał sekundy przy tysiącu kart. Licznik zamiast zegara, żeby test był
// pewny na każdej maszynie; zegar pilnuje osobny pomiar w tests/wydajnosc.

const auth = {
  authorization: `Basic ${Buffer.from('operator:atrapa').toString('base64')}`,
  origin: 'http://localhost',
};
const DEFINICJE = [
  { klucz: 'sklep_polcien', typ: 'woo', prefiks: 'SKLEP_POLCIEN', etykieta: 'Sklep Półcień' },
  { klucz: 'allegro_polcien', typ: 'allegro', prefiks: 'ALLEGRO_POLCIEN', etykieta: 'Allegro Półcień' },
  { klucz: 'erli_polcien', typ: 'erli', prefiks: 'ERLI_POLCIEN', etykieta: 'ERLI Pracownia' },
];

const odczyty = { definicje: 0, sklepy: 0, kanaly: 0 };
// Obiekt kluczy, który liczy wyliczenia kluczy — tak czyta go moduł Magazynu (`Object.keys`).
const liczoneKlucze = (klucze, licznik) =>
  new Proxy(Object.fromEntries(klucze.map((k) => [k, {}])), {
    ownKeys: (t) => {
      odczyty[licznik]++;
      return Reflect.ownKeys(t);
    },
  });

let db, app;
beforeEach(async () => {
  for (const k of Object.keys(odczyty)) odczyty[k] = 0;
  db = openOmsDb(':memory:');
  app = buildOmsServer({
    db,
    config: {
      auth: { user: 'operator', pass: 'atrapa' },
      definicje: listaNaZadanie(() => {
        odczyty.definicje++;
        return DEFINICJE;
      }),
      sklepy: liczoneKlucze(['sklep_polcien'], 'sklepy'),
      kanaly: liczoneKlucze(['allegro_polcien'], 'kanaly'),
    },
    magazyn: { start: () => ({ wystartowal: true }), stan: () => ({ trwa: false, kanaly: [] }) },
  });
  await app.ready();
});
afterEach(async () => {
  await app?.close();
  db.close();
});

let nr = 0;
function kartaWKanalach(nazwa) {
  const karta = utworzKarte(db, { nazwa });
  for (const [kanal, zmiany] of [
    ['sklep_polcien', { miniatura: 'https://sklep.example.invalid/m.jpg' }],
    ['allegro_polcien', { status_publikacji: 'ACTIVE' }],
  ]) {
    const id = zapiszProduktSklepowy(db, {
      kanal,
      produkt_id: `P-${++nr}`,
      wariant_id: '',
      nazwa,
      cena_gr: 4990,
      odczytane_at: '2026-11-13T06:00:00.000Z',
      ...zmiany,
    });
    powiazProdukt(db, id, karta);
  }
  wstawOferte(db, { kartaId: karta, kanal: 'erli_polcien', idZewnetrzne: `E-${nr}`, stan: 'aktywna' });
}

async function odczytyNaZadanie(url) {
  for (const k of Object.keys(odczyty)) odczyty[k] = 0;
  const r = await app.inject({ url, headers: auth });
  expect(r.statusCode).toBe(200);
  // Produkty pokazują kanały plakietkami, Ceny w kanałach — kwotą w kolumnie sklepu.
  expect(r.body).toContain(url.includes('widok=katalog') ? '49,90 zł' : 'plakietka--erli');
  return { ...odczyty };
}

describe('lista Magazynu czyta kanały raz na żądanie, nie raz na wiersz', () => {
  it.each(['/magazyn', '/magazyn?widok=katalog'])('%s: 1 karta i 40 kart — tyle samo odczytów kanałów', async (url) => {
    kartaWKanalach('Lampa Półcień 01');
    const przyJednej = await odczytyNaZadanie(url);
    for (let i = 2; i <= 40; i++) kartaWKanalach(`Lampa Półcień ${String(i).padStart(2, '0')}`);
    const przyCzterdziestu = await odczytyNaZadanie(url);
    expect(przyCzterdziestu).toEqual(przyJednej);
  });
});

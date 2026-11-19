import { afterEach, beforeEach, expect, it } from 'vitest';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { powiazProdukt, utworzKarte, zapiszProduktSklepowy } from '../../../src/oms/db/magazyn.js';
import { wstawOferte } from '../../../src/oms/db/oferty-kanalow.ts';
import { zapiszZamowienie } from '../../../src/oms/db/zamowienia.js';
import { buildOmsServer } from '../../pomoc/serwer-testowy-oms.ts';

const DOBA = 24 * 60 * 60 * 1000;
const definicje = [
  { klucz: 'sklep_polcien', typ: 'woo', prefiks: 'SKLEP_POLCIEN', etykieta: 'Sklep Półcień' },
  { klucz: 'allegro_polcien', typ: 'allegro', prefiks: 'ALLEGRO_POLCIEN', etykieta: 'Allegro Półcień' },
  { klucz: 'erli_polcien', typ: 'erli', prefiks: 'ERLI_POLCIEN', etykieta: 'ERLI Półcień' },
];
let db, app, karta, teraz, numer;

beforeEach(async () => {
  teraz = Date.now();
  numer = 0;
  db = openOmsDb(':memory:');
  app = buildOmsServer({
    db,
    config: {
      auth: { user: 'operator', pass: 'atrapa' },
      definicje,
      sklepy: { sklep_polcien: {} },
      kanaly: { allegro_polcien: {} },
    },
    magazyn: { start: () => ({ wystartowal: true }), stan: () => ({ trwa: false, kanaly: [] }) },
  });
  await app.ready();
  karta = utworzKarte(db, { nazwa: 'Lampa Półcień' });
});

afterEach(async () => {
  await app.close();
  db.close();
});

function lustro(kanal, id, pola = {}) {
  const produkt = zapiszProduktSklepowy(db, {
    kanal,
    produkt_id: id,
    wariant_id: '',
    nazwa: 'Lampa Półcień',
    odczytane_at: new Date(teraz).toISOString(),
    ...pola,
  });
  powiazProdukt(db, produkt, karta);
  return produkt;
}

function zamowienie(sklep, pozycja, { dni = 1, anulowane = 0, status = null } = {}) {
  const nr = String(++numer);
  return zapiszZamowienie(db, sklep, {
    zrodlo_id: nr,
    numer: nr,
    klient: {},
    dostawa: {},
    metoda_wysylki: 'dpd',
    kwota_pobrania: null,
    chce_fakture: 0,
    nip: null,
    kwota_brutto: '50.00',
    status_woo: status,
    oplacone_at: null,
    anulowane,
    utworzone_at: new Date(teraz - dni * DOBA).toISOString(),
    pozycje: [{ nazwa: 'Lampa Półcień', cena_brutto: '50.00', sku: null, vat: '23', ...pozycja }],
  });
}

async function otworzKarte() {
  const odpowiedz = await app.inject({
    url: `/magazyn/${karta}`,
    headers: { authorization: `Basic ${Buffer.from('operator:atrapa').toString('base64')}` },
  });
  expect(odpowiedz.statusCode).toBe(200);
  return odpowiedz.body;
}

const sekcja = (html) => html.match(/<section[^>]*id="sprzedaz-kanalow"[\s\S]*?<\/section>/)?.[0] ?? '';
const tekst = (html) =>
  html
    ?.replace(/<[^>]*>/g, '')
    .replace(/\s+/g, ' ')
    .trim();

it('pokazuje tylko powiązane kanały i pomija zamówienia, które nie zdejmują towaru', async () => {
  lustro('allegro_polcien', '4200', {
    status_publikacji: 'ACTIVE',
    cena_gr: 3900,
    adres: 'https://example.test/oferty/4200',
  });
  lustro('sklep_polcien', '42', { adres: 'javascript:void(0)' });
  zamowienie('allegro_polcien', { oferta_id: '4200', ilosc: 2 });
  zamowienie('allegro_polcien', { oferta_id: '4200', ilosc: 3 }, { dni: 40 });
  zamowienie('allegro_polcien', { oferta_id: '4200', ilosc: 9 }, { anulowane: 1 });
  zamowienie('sklep_polcien', { produkt_id: 42, ilosc: 4 });
  zamowienie('sklep_polcien', { produkt_id: 42, ilosc: 8 }, { status: 'failed' });
  zamowienie('erli_polcien', { produkt_id: 42, ilosc: 6 });

  const html = await otworzKarte();
  const sprzedaz = sekcja(html);
  expect(html).toContain('id="naglowek-karty"');
  expect(html.indexOf(sprzedaz)).toBeGreaterThan(html.indexOf('id="naglowek-karty"'));
  expect(html.indexOf(sprzedaz)).toBeLessThan(html.indexOf('id="dane-karty"'));
  expect(sprzedaz.match(/<article\b/g)).toHaveLength(2);
  expect(tekst(sprzedaz)).toMatch(/Allegro Półcień aktywna łącznie 5 szt\. 30 dni: 2 szt\./);
  expect(tekst(sprzedaz)).toMatch(/Sklep Półcień w sklepie łącznie 4 szt\. 30 dni: 4 szt\./);
  expect(sprzedaz).toContain('href="https://example.test/oferty/4200" target="_blank" rel="noopener noreferrer"');
  expect(sprzedaz).not.toMatch(/ERLI Półcień|javascript:/);
});

it('scala stan i ceny kilku ofert w kanale oraz rozpoznaje ten sam wpis w lustrze i rejestrze', async () => {
  lustro('allegro_polcien', '4200', { status_publikacji: 'ACTIVE', cena_gr: 3900 });
  lustro('allegro_polcien', '4201', { status_publikacji: 'ENDED', cena_gr: 4500 });
  wstawOferte(db, { kartaId: karta, kanal: 'allegro_polcien', idZewnetrzne: '4200', stan: 'aktywna' });
  wstawOferte(db, { kartaId: karta, kanal: 'erli_polcien', idZewnetrzne: 'LMP-42', stan: 'szkic' });

  const sprzedaz = sekcja(await otworzKarte());
  expect(sprzedaz.match(/<article\b/g)).toHaveLength(2);
  expect(sprzedaz).toContain('2 oferty: 1 aktywna, 1 zakończona');
  expect(sprzedaz).toContain('39,00–45,00 zł');
  // Kanał bez wpisu w lustrze nie ma czego odczytać — brak wiersza zamiast mylącego „bez ceny”.
  expect(tekst(sprzedaz)).toMatch(/ERLI Półcień szkic łącznie 0 szt\. 30 dni: 0 szt\. Cena w kanale: nieustalona/);
});

it('liczy ostatnie 30 dób z dokładnością do chwili zamówienia', async () => {
  lustro('sklep_polcien', '42');
  zamowienie('sklep_polcien', { produkt_id: 42, ilosc: 2 }, { dni: 29.99 });
  zamowienie('sklep_polcien', { produkt_id: 42, ilosc: 3 }, { dni: 30.01 });
  expect(tekst(sekcja(await otworzKarte()))).toMatch(/łącznie 5 szt\. 30 dni: 2 szt\./);
});

it('liczy poprawione ilości i pomija pozycje niejednoznaczne między wariantami', async () => {
  lustro('sklep_polcien', '42', { wariant_id: '421' });
  zapiszProduktSklepowy(db, {
    kanal: 'sklep_polcien',
    produkt_id: '42',
    wariant_id: '422',
    nazwa: 'Inny wariant',
    odczytane_at: new Date(teraz).toISOString(),
  });
  zamowienie('sklep_polcien', { produkt_id: 42, ilosc: 7 });
  const id = zamowienie('sklep_polcien', { produkt_id: 42, wariant_id: '421', ilosc: 2 });
  db.prepare('UPDATE zamowienia SET pozycje_reczne_json = ? WHERE id = ?').run('{"p0":{"ilosc":3}}', id);
  expect(tekst(sekcja(await otworzKarte()))).toMatch(/łącznie 3 szt\. 30 dni: 3 szt\./);
});

it('przy karcie bez kanałów ukrywa sekcję, a po sprzedaży ręcznej pokazuje same liczby', async () => {
  expect(sekcja(await otworzKarte())).toBe('');
  const produkt = lustro('sklep_polcien', '42');
  db.prepare('UPDATE produkty_sklepowe SET zniknal_at = ? WHERE id = ?').run(new Date(teraz).toISOString(), produkt);
  const id = zamowienie('reczne', { produkt_id: 42, ilosc: 3 });
  db.prepare("UPDATE pozycje SET zrodlo = 'reczna' WHERE zamowienie_id = ?").run(id);

  const sprzedaz = sekcja(await otworzKarte());
  expect(sprzedaz).toContain('usunięty ze sklepu');
  const reczne = /<article[^>]*>(?:(?!<\/article>)[\s\S])*Zamówienia ręczne[\s\S]*?<\/article>/.exec(sprzedaz)?.[0];
  expect(tekst(reczne)).toMatch(/łącznie 3 szt\. 30 dni: 3 szt\./);
  expect(reczne).not.toMatch(/bez ceny|<a\b/);
});

it('link okienka kanału wskazuje ofertę aktywną, a nie zakończoną o niższym id', async () => {
  lustro('allegro_polcien', '4200', { status_publikacji: 'ENDED', adres: 'https://example.test/oferty/zakonczona' });
  lustro('allegro_polcien', '4201', { status_publikacji: 'ACTIVE', adres: 'https://example.test/oferty/aktywna' });
  const stary = lustro('sklep_polcien', '42', { wariant_id: '1', adres: 'https://example.test/stary' });
  db.prepare('UPDATE produkty_sklepowe SET zniknal_at = ? WHERE id = ?').run(new Date(teraz).toISOString(), stary);
  lustro('sklep_polcien', '42', { wariant_id: '2', adres: 'https://example.test/biezacy' });

  const sprzedaz = sekcja(await otworzKarte());
  expect(sprzedaz).toContain('href="https://example.test/oferty/aktywna"');
  expect(sprzedaz).toContain('href="https://example.test/biezacy"');
  expect(sprzedaz).not.toMatch(/oferty\/zakonczona|example\.test\/stary/);
});

it('zamówienie z datą w przyszłości liczy się do sumy, ale nie do ostatnich 30 dni', async () => {
  lustro('sklep_polcien', '42');
  zamowienie('sklep_polcien', { produkt_id: 42, ilosc: 2 });
  zamowienie('sklep_polcien', { produkt_id: 42, ilosc: 5 }, { dni: -2 });
  expect(tekst(sekcja(await otworzKarte()))).toMatch(/łącznie 7 szt\. 30 dni: 2 szt\./);
});

it('warianty jednego produktu Woo opisuje jako warianty, a oferty Allegro nadal jako oferty', async () => {
  lustro('sklep_polcien', '42', { wariant_id: '1' });
  lustro('sklep_polcien', '42', { wariant_id: '2' });
  lustro('allegro_polcien', '4200', { status_publikacji: 'ACTIVE' });
  lustro('allegro_polcien', '4201', { status_publikacji: 'ACTIVE' });

  const sprzedaz = tekst(sekcja(await otworzKarte()));
  expect(sprzedaz).toContain('2 warianty w sklepie');
  expect(sprzedaz).toContain('2 oferty: 2 aktywna');
});

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { buildOmsServer } from '../../pomoc/serwer-testowy-oms.ts';
import { zapiszProduktSklepowy, utworzKarte, powiazProdukt } from '../../../src/oms/db/magazyn.js';
import { wstawOferte } from '../../../src/oms/db/oferty-kanalow.ts';

// „Ceny w kanałach” (`?widok=katalog`): ERLI nie ma lustra produktów, więc kolumna konta ERLI
// i filtr „Kanał” czytają rejestr ofert. Dane zmyślone („Pracownia Półcień”).

const auth = {
  authorization: `Basic ${Buffer.from('operator:atrapa').toString('base64')}`,
  origin: 'http://localhost',
};
const DEFINICJE = [
  { klucz: 'sklep_polcien', typ: 'woo', prefiks: 'SKLEP_POLCIEN', etykieta: 'Sklep Półcień' },
  { klucz: 'erli_polcien', typ: 'erli', prefiks: 'ERLI_POLCIEN', etykieta: 'ERLI Półcień' },
];

let db, app;
function serwer({ zErli = true } = {}) {
  const definicje = zErli ? DEFINICJE : DEFINICJE.filter((d) => d.typ !== 'erli');
  app = buildOmsServer({
    db,
    config: { auth: { user: 'operator', pass: 'atrapa' }, definicje, sklepy: { sklep_polcien: {} } },
    magazyn: { start: () => ({ wystartowal: true }), stan: () => ({ trwa: false, kanaly: [] }) },
    nadpisania: {
      'kanaly.klienciKanalow': zErli ? { erli_polcien: {} } : {},
      'kanaly.repozytoriumKanalow': {
        listaTypu: (typ) => (zErli && typ === 'erli' ? [{ klucz: 'erli_polcien', nazwa: 'ERLI Półcień' }] : []),
        zapisyZablokowane: () => false,
      },
    },
  });
  return app;
}
afterEach(async () => {
  await app?.close();
  app = null;
  db.close();
});

let nr = 0;
function produktSklepu(kartaId, cenaGr) {
  const id = zapiszProduktSklepowy(db, {
    kanal: 'sklep_polcien',
    produkt_id: `P-${++nr}`,
    wariant_id: '',
    nazwa: 'Produkt',
    cena_gr: cenaGr,
    odczytane_at: '2026-11-13T06:00:00.000Z',
  });
  powiazProdukt(db, id, kartaId);
}
function ofertaErli(kartaId, { stan, odczyt = null, wyslana = null, pochodzenie = 'oms' }) {
  const { id } = wstawOferte(db, {
    kartaId,
    kanal: 'erli_polcien',
    idZewnetrzne: `E-${++nr}`,
    pochodzenie,
    stan,
  });
  db.prepare('UPDATE oferty_kanalow SET odczyt_cena_gr = ?, wyslana_cena_gr = ? WHERE id = ?').run(odczyt, wyslana, id);
}

const get = async (url) => {
  const r = await app.inject({ url, headers: auth });
  expect(r.statusCode).toBe(200);
  return r.body;
};
const tabela = (html) => /<tbody>([\s\S]*?)<\/tbody>/.exec(html)[1];
const nazwyKart = (html) =>
  [...tabela(html).matchAll(/<td class="komorka-karta">\s*<div><a [^>]*>([^<]*)<\/a>/g)].map((m) => m[1]).sort();
const wierszKarty = (html, nazwa) => {
  const w = tabela(html)
    .split(/<tr>/)
    .find((t) => t.includes(`>${nazwa}</a>`));
  if (!w) throw new Error(`Brak wiersza „${nazwa}”`);
  return w;
};
const komorkiKanalow = (wiersz) =>
  [...wiersz.matchAll(/<td class="magazyn-kanal">([\s\S]*?)<\/td>/g)].map((m) => m[1].replace(/\s+/g, ' ').trim());
const naglowkiKanalow = (html) =>
  [...html.matchAll(/<th class="magazyn-kanal">([^<]*)<\/th>/g)].map((m) => m[1].trim());

describe('ceny w kanałach: kolumna konta ERLI', () => {
  beforeEach(async () => {
    db = openOmsDb(':memory:');
    await serwer().ready();
    const a = utworzKarte(db, { nazwa: 'Kinkiet Odczytany' });
    // Przejęty wpis w błędzie wstawiony PRZED aktywną: wygrywa aktywna, jak w plakietkach, a nie pierwszy wiersz.
    ofertaErli(a, { stan: 'blad', wyslana: 9900, pochodzenie: 'przejeta' });
    ofertaErli(a, { stan: 'aktywna', odczyt: 12900, wyslana: 11900 });
    const b = utworzKarte(db, { nazwa: 'Kinkiet Wysłany' });
    ofertaErli(b, { stan: 'aktywna', wyslana: 11900 });
    const c = utworzKarte(db, { nazwa: 'Kinkiet Czekający' });
    ofertaErli(c, { stan: 'do_wyslania', wyslana: 15000 });
    const d = utworzKarte(db, { nazwa: 'Lampa Sklepowa' });
    produktSklepu(d, 14000);
    const e = utworzKarte(db, { nazwa: 'Lampa Tania' });
    produktSklepu(e, 5000);
  });

  it('nagłówek konta ERLI po kanałach sklepu, cena aktywnej oferty, stan innej', async () => {
    const html = await get('/magazyn?widok=katalog');
    const naglowki = naglowkiKanalow(html);
    expect(naglowki[0]).toBe('Sklep Półcień');
    expect(naglowki.at(-1)).toBe('ERLI Półcień');
    expect(komorkiKanalow(wierszKarty(html, 'Kinkiet Odczytany')).at(-1)).toBe('129,00 zł');
    expect(komorkiKanalow(wierszKarty(html, 'Kinkiet Wysłany')).at(-1)).toBe('119,00 zł');
    const czeka = komorkiKanalow(wierszKarty(html, 'Kinkiet Czekający')).at(-1);
    expect(czeka).toContain('do wysłania');
    expect(czeka).not.toMatch(/\d+,\d\d zł/);
    expect(komorkiKanalow(wierszKarty(html, 'Lampa Sklepowa')).at(-1)).toBe('<span class="magazyn-brak">—</span>');
  });

  it('pusty wynik zawężenia sięga przez kolumnę ERLI (colspan)', async () => {
    const zErli = /<td colspan="(\d+)" class="pusto">/.exec(await get('/magazyn?widok=katalog&fraza=nic-takiego'));
    await app.close();
    db.close();
    db = openOmsDb(':memory:');
    await serwer({ zErli: false }).ready();
    const bez = /<td colspan="(\d+)" class="pusto">/.exec(await get('/magazyn?widok=katalog&fraza=nic-takiego'));
    expect(Number(zErli[1])).toBe(Number(bez[1]) + 1);
  });

  it('filtr „Kanał” ma konto ERLI i zawęża do aktywnych ofert', async () => {
    const html = await get('/magazyn?widok=katalog&kanal=erli_polcien');
    expect(html).toMatch(/<option value="erli_polcien" selected>ERLI Półcień<\/option>/);
    expect(nazwyKart(html)).toEqual(['Kinkiet Odczytany', 'Kinkiet Wysłany']);
  });

  it('cena od z kontem ERLI liczy cenę oferty (odczyt przed wysłaną)', async () => {
    expect(nazwyKart(await get('/magazyn?widok=katalog&kanal=erli_polcien&cenaOd=125'))).toEqual(['Kinkiet Odczytany']);
  });

  it('cena do z kontem ERLI też liczy cenę oferty', async () => {
    expect(nazwyKart(await get('/magazyn?widok=katalog&kanal=erli_polcien&cenaDo=125'))).toEqual(['Kinkiet Wysłany']);
  });

  it('cena od bez kanału łapie lustro sklepu i aktywne oferty ERLI', async () => {
    expect(nazwyKart(await get('/magazyn?widok=katalog&cenaOd=125'))).toEqual(['Kinkiet Odczytany', 'Lampa Sklepowa']);
  });

  it('nieznane konto w filtrze nie zawęża', async () => {
    expect(nazwyKart(await get('/magazyn?widok=katalog&kanal=erli_obce'))).toHaveLength(5);
  });
});

describe('ceny w kanałach: aktywna oferta ERLI bez ceny i ekran bez ERLI', () => {
  it('aktywna bez obu cen → kreska z podpowiedzią „cena nieznana”', async () => {
    db = openOmsDb(':memory:');
    await serwer().ready();
    ofertaErli(utworzKarte(db, { nazwa: 'Kinkiet Bez Ceny' }), { stan: 'aktywna' });
    const html = await get('/magazyn?widok=katalog');
    expect(komorkiKanalow(wierszKarty(html, 'Kinkiet Bez Ceny')).at(-1)).toBe(
      '<span class="magazyn-brak" title="cena nieznana">—</span>',
    );
  });

  it('bez kont ERLI ani kolumny, ani opcji filtra', async () => {
    db = openOmsDb(':memory:');
    await serwer({ zErli: false }).ready();
    const html = await get('/magazyn?widok=katalog');
    expect(naglowkiKanalow(html)).not.toContain('ERLI Półcień');
    expect(html).not.toContain('erli_polcien');
  });
});

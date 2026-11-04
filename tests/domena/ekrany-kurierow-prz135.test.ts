// PRZ-135.07a — ekrany konfiguracji kurierów z rejestru: tytuł, trasa i bez martwej sekcji „Kurierzy”.
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { MODULY_KURIEROW } from '../../src/domena/moduly-kurierow.ts';
import { tytulEkranuDlaAdresu } from '../../src/domena/ekrany.js';
import { zbudujOms } from '../../src/oms/bootstrap.ts';

// ejs nie ma deklaracji typów w repo — ładowany przez require z jawnym typem.
const ejs = createRequire(import.meta.url)('ejs') as { renderFile: (plik: string, dane: object) => Promise<string> };

const env = { OMS_SPRZEDAWCA_NIP: '1234563218', OMS_RACHUNEK: '34109010140000000000000000',
  OMS_USER: 'operator', OMS_PASS: 'test', OMS_PROFORMY_KATALOG: tmpdir(), OMS_ETYKIETY_KATALOG: tmpdir() };
const headers = { authorization: 'Basic ' + Buffer.from('operator:test').toString('base64'), origin: 'http://localhost' };

const opisy = Object.values(MODULY_KURIEROW);
const sciezki = [...new Set(opisy.map((opis) => opis.konfigurator.sciezka))];
const wlasne = opisy.filter((opis) => opis.umowa === 'wlasna' && opis.metody.length > 0);

describe('ekrany kurierów z rejestru', () => {
  it('każdy konfigurator.sciezka ma własny tytuł w ekrany.js (nie zapasowy)', () => {
    for (const sciezka of sciezki) {
      expect(['Ustawienia', 'Zamówienia'], sciezka).not.toContain(tytulEkranuDlaAdresu(sciezka));
    }
    for (const opis of wlasne) expect(tytulEkranuDlaAdresu(opis.konfigurator.sciezka)).toContain(opis.nazwa);
  });

  it('każdy konfigurator.sciezka odpowiada 200', async () => {
    const a = await zbudujOms({ env });
    try {
      for (const sciezka of sciezki) {
        const r = await a.app.inject({ method: 'GET', url: sciezka, headers });
        expect(r.statusCode, sciezka).toBe(200);
      }
    } finally { await a.app.close(); a.db.close(); }
  });
});

// PRZ-138.02: sekcja „Kurierzy” w ustawienia-integracje.ejs była martwa (nikt nie przekazywał listy) — usunięta.
// Widok służy już tylko ekranowi reklam; kurierzy są w „Moje połączenia” i katalogu.
describe('szablon ustawienia-integracje — bez martwej sekcji „Kurierzy”', () => {
  it('ekran reklam renderuje się bez nagłówka „Kurierzy”', async () => {
    const html = await ejs.renderFile('src/moduly/ustawienia/widoki/ustawienia-integracje.ejs', {
      title: 'Integracje', tylkoReklamy: false, zapisano: null, testOdczytu: null, blad: null, zgodaTf: false,
      wbudowany: false, zdanieTokenKosztow: '', mozeKonfigurowacReklamy: false, kanaly: [], zrodlaReklam: [],
    });
    expect(html).not.toContain('<h2>Kurierzy</h2>');
    expect(html).toContain('<h2>Reklamy</h2>');
  });
});

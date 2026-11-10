// PRZ-155 (audyt MWG 10.11.2026): na wąskim ekranie tabela dokumentów zamienia się w karty, a podpis
// każdej komórki bierze się z `td:nth-child(n)::before` w tabele-prz065.css — nie z <th>. Kolumny Netto
// (29.10) i KSeF (03.11) doszły bez podpisów i na telefonie netto stało pod „Brutto”, brutto pod „KSeF”.
// Ten test porównuje podpisy z CSS z nagłówkami wyrenderowanej tabeli, więc nowa kolumna bez podpisu
// zapala go od razu.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { nowyPanel, jako, get } from '../../pomoc/konta-prz068.js';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { zalozKonto, kontoPoLoginie, ustawUprawnienia } from '../../../src/core/bezpieczenstwo/konta.js';
import { createFakturyWidok } from '../../../src/moduly/faktury/services/faktury-widok.js';

const otwarte = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const p of otwarte.splice(0)) { await p.app.close(); p.db.close(); }
});

const CSS = readFileSync(new URL('../../../src/public/tabele-prz065.css', import.meta.url), 'utf8');
/** Podpisy kart z CSS: numer kolumny → tekst. */
function podpisyZCss(klasa) {
  const wzor = new RegExp(`\\.${klasa} td:nth-child\\((\\d+)\\)::before \\{ content: '([^']*)'; \\}`, 'gu');
  return new Map([...CSS.matchAll(wzor)].map((m) => [Number(m[1]), m[2]]));
}
const bezZnacznikow = (s) => s.replace(/<%[\s\S]*?%>/gu, '').replace(/<[^>]+>/gu, '').replace(/\s+/gu, ' ').trim();

describe('PRZ-155 podpisy kolumn faktur na telefonie', () => {
  it('każda kolumna tabeli dokumentów ma podpis i jest to tekst jej nagłówka', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('Sieć zabroniona'));
    const db = openOmsDb(':memory:');
    const wiersz = { uuid: 'fv', number: 'FV/1', rodzaj: 'vat', invoice_date: '2026-10-14', net_price: 10000,
      tax_price: 2300, gross_price: 12300, left_to_pay: 0, status: 'paid', ksef_number: null,
      client_company_name: 'Lampy Testowe', client_tax_code: '1234500011' };
    const infakt = { listaFaktur: async () => [wiersz], listaKorekt: async () => [], listaNieoplaconych: async () => [] };
    const p = nowyPanel({ db, fakturyWidok: createFakturyWidok({ db, infakt }) });
    otwarte.push(p);
    zalozKonto(p.db, { login: 'test', imie: 'Test', haslo: 'h', rola: 'sprzedaz' });
    ustawUprawnienia(p.db, kontoPoLoginie(p.db, 'test').id, ['faktury']);
    const r = await get(p.app, '/faktury?miesiac=2026-10', jako(p.db, 'test'));
    expect(r.statusCode).toBe(200);

    const tabela = r.body.match(/<table[^>]*prz065-tabela--dokumenty[^>]*>[\s\S]*?<\/table>/u)[0];
    const naglowki = [...tabela.match(/<thead>[\s\S]*?<\/thead>/u)[0].matchAll(/<th[^>]*>([\s\S]*?)<\/th>/gu)]
      .map((m) => bezZnacznikow(m[1]));
    const komorki = tabela.match(/<tbody>[\s\S]*?<tr[^>]*>([\s\S]*?)<\/tr>/u)[1].match(/<td[\s>]/gu).length;
    const podpisy = podpisyZCss('prz065-tabela--dokumenty');

    expect(komorki).toBe(naglowki.length);
    expect([...podpisy.keys()].sort((a, b) => a - b)).toEqual(naglowki.map((_, i) => i + 1));
    // Kolumna wyboru („zaznacz”) i akcji (pusty <th>) mają podpis opisowy; reszta zaczyna się od tekstu
    // nagłówka — karta może powiedzieć więcej („Numer dokumentu” pod „Numer”), ale nie co innego.
    naglowki.forEach((tekst, i) => {
      if (i === 0 || tekst === '') return;
      expect(podpisy.get(i + 1)?.startsWith(tekst), `kolumna ${i + 1}: podpis „${podpisy.get(i + 1)}”, nagłówek „${tekst}”`).toBe(true);
    });
  });
});

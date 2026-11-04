import { afterEach, describe, expect, it, vi } from 'vitest';
import { nowyPanel, jako, get, post } from '../../pomoc/konta-prz068.js';
import { zalozKonto, kontoPoLoginie, ustawUprawnienia } from '../../../src/core/bezpieczenstwo/konta.js';

let p;
afterEach(async () => { if (p) { await p.app.close(); p.db.close(); p = null; } vi.restoreAllMocks(); });
function panel() {
  vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('Sieć zabroniona'));
  const odmowa = Object.assign(new Error('Brak dokumentów'), { dlaOperatora: true });
  p = nowyPanel({
    wysylkaKsef: { podglad: async () => ({ doWyslania: [{ uuid: 'u1', number: 'FV/1' }], pominiete: [], dokumenty: [] }),
      wyslij: async () => ({ wyslane: [], pominiete: [], niepewne: [] }) },
    paczkaDlaBiura: { zbuduj: async () => { throw odmowa; }, zbudujZaznaczone: vi.fn() },
  });
  zalozKonto(p.db, { login: 'test', imie: 'Test', haslo: 'h', rola: 'sprzedaz' });
  ustawUprawnienia(p.db, kontoPoLoginie(p.db, 'test').id, ['faktury']);
  p.headers = jako(p.db, 'test');
  return p;
}
const baza = { miesiac: '2026-10', pole: 'invoice_date' };

describe('filtry po powrocie z faktur', () => {
  it('podgląd niesie filtry w formularzu i odnośniku, wynik także je zachowuje', async () => {
    const { app, headers } = panel();
    const dane = { ...baza, uuid: 'u1', typ: 'korekta', platnosc: 'niezaplacona' };
    const r = await post(app, '/faktury/ksef/podglad', headers, dane);
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain('name="typ" value="korekta"');
    expect(r.body).toContain('name="platnosc" value="niezaplacona"');
    expect(r.body).toContain('&amp;typ=korekta&amp;platnosc=niezaplacona');
    const bez = await post(app, '/faktury/ksef/podglad', headers, { ...baza, uuid: 'u1' });
    expect(bez.body).not.toContain('name="typ"');
    const zly = await post(app, '/faktury/ksef/podglad', headers, { ...baza, uuid: 'u1', typ: 'zle"><x', platnosc: 'tak' });
    expect(zly.body).not.toContain('name="typ"');
    expect(zly.body).not.toContain('name="platnosc"');
    const wynik = await post(app, '/faktury/ksef/wyslij', headers, dane);
    expect(wynik.statusCode).toBe(200);
    expect(wynik.body).toContain('&amp;typ=korekta&amp;platnosc=niezaplacona');
  });
  it('odmowy CSV i PDF zachowują dozwolone filtry, paczka pozostaje bez filtrów', async () => {
    const { app, headers } = panel();
    for (const url of ['/faktury/lista-zaznaczonych.csv', '/faktury/zestawienie-zaznaczonych']) {
      const r = await post(app, url, headers, { ...baza, typ: 'vat', platnosc: 'zaplacona' });
      expect(r.statusCode).toBe(400);
      expect(r.body).toContain('/faktury?miesiac=2026-10&amp;pole=invoice_date&amp;typ=vat&amp;platnosc=zaplacona');
      const zly = await post(app, url, headers, { ...baza, typ: 'zle"><x', platnosc: 'zle' });
      expect(zly.body).toContain('/faktury?miesiac=2026-10&amp;pole=invoice_date');
      expect(zly.body).not.toContain('&amp;typ=');
      expect(zly.body).not.toContain('&amp;platnosc=');
    }
    const paczka = await get(app, '/faktury/paczka?miesiac=2026-10&czesc=sprzedaz', headers);
    expect(paczka.statusCode).toBe(400);
    expect(paczka.body).toContain('href="/faktury?miesiac=2026-10"');
  });
});

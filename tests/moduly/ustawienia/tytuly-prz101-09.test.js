import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { zalozKonto } from '../../../src/core/bezpieczenstwo/konta.js';
import { POZYCJE_USTAWIEN } from '../../../src/domena/podmenu-ustawien.js';
import { nowyPanel, jako, get, post } from '../../pomoc/konta-prz068.js';

let p, admin;
beforeAll(() => {
  p = nowyPanel();
  zalozKonto(p.db, { login: 'operator-testowy', imie: 'Operator', haslo: 'h', rola: 'administrator', admin: true });
  admin = jako(p.db, 'operator-testowy');
});
afterAll(async () => { await p.app.close(); p.db.close(); });

const integracje = [
  ['/ustawienia/integracje/dpd', 'Kurier DPD Polska'],
  ['/ustawienia/integracje/inpost', 'Kurier InPost'],
  ['/ustawienia/integracje/infakt', 'inFakt'],
  ['/ustawienia/integracje/poczta', 'Poczta wychodząca'],
  ['/ustawienia/integracje/reklamy', 'Integracje reklam'],
];
function sprawdz(html, etykieta) {
  const h1 = /<h1[^>]*>([^<]*)<\/h1>/u.exec(html)?.[1];
  expect(h1).toBeDefined();
  expect(h1.startsWith(etykieta), `H1 „${h1}” zaczyna się od „${etykieta}”`).toBe(true);
  expect(html).toContain(`<title>${h1}</title>`);
  expect(html).toMatch(new RegExp(`class="oms-breadcrumb">[\\s\\S]*?<strong>${h1}</strong>`));
}
describe('PRZ-101.09 tytuły Ustawień zgodne z menu', () => {
  it.each(POZYCJE_USTAWIEN)('$href: H1, okruszek i title zgodne z etykietą menu', async ({ href, etykieta }) => {
    const r = await get(p.app, `${href}?test=tytul`, admin);
    expect(r.statusCode).toBe(200);
    sprawdz(r.body, etykieta);
  });
  it.each(integracje)('%s: zachowana nazwa integracji we wszystkich tytułach', async (href, etykieta) => {
    const r = await get(p.app, href, admin);
    expect(r.statusCode).toBe(200);
    sprawdz(r.body, etykieta);
  });
  it.each(['/ustawienia/paczka', '/ustawienia/paczka/szablon', '/ustawienia/paczka/szablon/brak/domyslny', '/ustawienia/paczka/szablon/brak/usun'])('%s: błąd formularza paczki zachowuje tytuł ekranu z menu', async (href) => {
    const r = await post(p.app, href, admin, {});
    expect(r.statusCode).toBe(400);
    sprawdz(r.body, 'Paczki i koszty dostawy');
  });
});

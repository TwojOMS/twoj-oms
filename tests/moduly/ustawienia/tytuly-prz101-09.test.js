import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { zalozKonto } from '../../../src/core/bezpieczenstwo/konta.js';
import { POZYCJE_USTAWIEN, modelNawigacjiUstawien } from '../../../src/domena/podmenu-ustawien.js';
import { KATALOG_INTEGRACJI } from '../../../src/domena/katalog-integracji.ts';
import { nowyPanel, jako, get, post } from '../../pomoc/konta-prz068.js';

let p, admin;
beforeAll(() => {
  p = nowyPanel();
  zalozKonto(p.db, { login: 'operator-testowy', imie: 'Operator', haslo: 'h', rola: 'administrator', admin: true });
  admin = jako(p.db, 'operator-testowy');
});
afterAll(async () => { await p.app.close(); p.db.close(); });

const integracje = [
  ['/ustawienia/integracje/dpd', 'DPD'],
  ['/ustawienia/integracje/ksef', 'KSeF'],
  ['/ustawienia/integracje/gus', 'GUS'],
  ['/ustawienia/integracje/inpost', 'InPost'],
  ['/ustawienia/integracje/infakt', 'inFakt'],
  ['/ustawienia/integracje/poczta', 'Poczta wychodząca'],
  ['/ustawienia/integracje/reklamy', 'Integracje reklam'],
];
function sprawdz(html, etykieta, href) {
  // PRZ-154 E2.3: okruszki nazywają dział, aktywna zakładka zastępuje h2 formularza.
  const tytul = /<title>([^<]*)<\/title>/u.exec(html)?.[1];
  expect(tytul).toBeDefined();
  expect(tytul.startsWith(etykieta)).toBe(true);
  const dzial = modelNawigacjiUstawien(href, {admin: true}).dzialy?.find(d => d.aktywna);
  expect(html.match(/<h1\b/g)).toHaveLength(1);
  expect(html).toContain(`<h1>${dzial?.etykieta ?? tytul}</h1>`);
  const zakladka = modelNawigacjiUstawien(href, {admin: true}).zakladki.find(z => z.aktywna);
  if (dzial && tytul !== dzial.etykieta && tytul !== zakladka?.etykieta) expect(html).toContain(`<h2 class="naglowek-formularza">${tytul}</h2>`);
  if (dzial) {
    const pasek = html.match(/<div class="oms-breadcrumb">[\s\S]*?<\/div>/)?.[0];
    expect(pasek).toContain(`href="${dzial.href}">${dzial.etykieta}</a>`);
  }
}
describe('PRZ-101.09 tytuły Ustawień zgodne z menu', () => {
  it.each(POZYCJE_USTAWIEN)('$href: H1, okruszek i title zgodne z etykietą menu', async ({ href, etykieta }) => {
    const r = await get(p.app, `${href}?test=tytul`, admin);
    expect(r.statusCode).toBe(200);
    sprawdz(r.body, modelNawigacjiUstawien(href, {admin:true}).zakladki.find(z=>z.aktywna && z.href === href && z.klucz !== 'reguly' && href !== '/ustawienia/kopie')?.etykieta ?? etykieta, href);
  });
  it.each(integracje)('%s: zachowana nazwa integracji we wszystkich tytułach', async (href, etykieta) => {
    const r = await get(p.app, href, admin);
    expect(r.statusCode).toBe(200);
    sprawdz(r.body, etykieta, href);
  });
  it.each(['/ustawienia/paczka', '/ustawienia/paczka/szablon', '/ustawienia/paczka/szablon/brak/domyslny', '/ustawienia/paczka/szablon/brak/usun'])('%s: błąd formularza paczki zachowuje tytuł ekranu z menu', async (href) => {
    const r = await post(p.app, href, admin, {});
    expect(r.statusCode).toBe(400);
    sprawdz(r.body, 'Szablony paczek', href);
  });
});

// PRZ-154 E2.1: nazwa integracji jest h2 formularza w dziale Integracje.
describe('PRZ-138.02 nagłówek formularza = nazwa z katalogu integracji', () => {
  it.each([['dpd', '/ustawienia/integracje/dpd'], ['ksef', '/ustawienia/integracje/ksef'], ['gus', '/ustawienia/integracje/gus']])(
    '%s', async (id, href) => {
      const wpis = KATALOG_INTEGRACJI.find((w) => w.id === id);
      const r = await get(p.app, href, admin);
      expect(r.body).toContain('<h1>Integracje</h1>');
      expect(r.body).toContain(`<h2 class="naglowek-formularza">${wpis.nazwa}</h2>`);
    });
});

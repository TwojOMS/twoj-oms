// PRZ-101.01: strony „wkrótce” w Ustawieniach — jedna trasa, treść z jednej tablicy (domena/ustawienia-wkrotce.js).
import { describe, it, expect } from 'vitest';
import { zalozKonto, kontoPoLoginie, ustawUprawnienia } from '../../../src/core/bezpieczenstwo/konta.js';
import { STRONY_WKROTCE } from '../../../src/domena/ustawienia-wkrotce.js';
import { podmenuUstawien } from '../../../src/domena/podmenu-ustawien.js';
import { nowyPanel, jako, get, post } from '../../pomoc/konta-prz068.js';

function panel() {
  const p = nowyPanel();
  zalozKonto(p.db, { login: 'adam', imie: 'Adam', haslo: 'h', rola: 'administrator', admin: true });
  zalozKonto(p.db, { login: 'ewa', imie: 'Ewa', haslo: 'h', rola: 'sprzedaz' });
  ustawUprawnienia(p.db, kontoPoLoginie(p.db, 'ewa').id, ['zamowienia']);
  return { ...p, admin: jako(p.db, 'adam'), ewa: jako(p.db, 'ewa') };
}
const tresc = (html) => /<main class="kolumna-glowna">([\s\S]*)<\/main>/u.exec(html)?.[1] ?? '';
const strona = (html) => /<section class="ust-sekcja ust-wkrotce">[\s\S]*?<\/section>/u.exec(html)?.[0] ?? '';

describe('PRZ-101.01 Ustawienia — strony „wkrótce”', () => {
  it('każda pozycja „wkrótce” w menu ma stronę i każda strona ma pozycję w menu', () => {
    const wMenu = podmenuUstawien('/ustawienia', { admin: true }).filter((p) => p.wkrotce).map((p) => p.href).sort();
    expect(STRONY_WKROTCE.map((s) => s.href).sort()).toEqual(wMenu);
  });

  it.each(STRONY_WKROTCE.map((s) => [s.href, s]))('%s: 200, tytuł, opis, punkty, podświetlona pozycja menu', async (href, s) => {
    const { app, admin } = panel();
    const r = await get(app, href, admin);
    expect(r.statusCode, r.body).toBe(200);
    expect(r.body).toContain(`<title>${s.tytul}</title>`);
    const t = tresc(r.body);
    expect(t).toContain(`<h1>${s.tytul}</h1>`);
    const sekcja = strona(r.body);
    expect(sekcja).toContain(s.opis);
    for (const punkt of s.punkty) expect(sekcja).toContain(`<li>${punkt}</li>`);
    if (s.dzis) expect(sekcja).toContain(s.dzis);
    expect(r.body).toMatch(new RegExp(`<li class="aktywna wkrotce">\\s*<a href="${href}">`, 'u'));
    expect(r.body).toContain('class="menu-ustawien-wkrotce">wkrótce</span>');
  });

  it('treść jest konkretna: 2–4 punkty, bez dat i obietnic', () => {
    expect(STRONY_WKROTCE).toHaveLength(5);
    for (const s of STRONY_WKROTCE) {
      expect(s.punkty.length).toBeGreaterThanOrEqual(2);
      expect(s.punkty.length).toBeLessThanOrEqual(4);
      const calosc = [s.opis, ...s.punkty, s.dzis ?? ''].join(' ');
      expect(calosc).not.toMatch(/\b20\d\d\b|wkrótce|niedługo|już niebawem|obiecujemy/iu);
    }
  });

  it('nieznany adres pod /ustawienia daje 404, nie stronę „wkrótce”', async () => {
    const { app, admin } = panel();
    expect((await get(app, '/ustawienia/nieznane', admin)).statusCode).toBe(404);
    expect((await get(app, '/ustawienia/druk/cos', admin)).statusCode).toBe(404);
  });

  it('strona jest tylko do oglądania — POST nie ma trasy', async () => {
    const { app, admin } = panel();
    expect((await post(app, '/ustawienia/kopie', admin)).statusCode).toBe(404);
  });

  it('konto bez uprawnienia „ustawienia” nie wchodzi', async () => {
    const { app, ewa } = panel();
    expect((await get(app, '/ustawienia/kopie', ewa)).statusCode).toBe(403);
  });
});

// PRZ-108.11 — poprawki wyglądu po przeglądzie właściciela (22.10): kolejność sekcji Szablonów wiadomości, plakietka BETA
// przy Automatyzacjach, stan automatu KSeF na górze kafla. „Wkrótce” przy NIP/BDO/rachunku z pliku sprawdzają
// nip-bdo-firmy-prz108-10 i rachunek-firmy-prz102-20. Prawdziwy serwer, inFakt niepodłączony, nic nie wychodzi.
import { describe, it, expect, afterEach } from 'vitest';
import { zalozKonto } from '../../../src/core/bezpieczenstwo/konta.js';
import { nowyPanel, jako, get } from '../../pomoc/konta-prz068.js';

const otwarte = [];
function panel() {
  const p = nowyPanel();
  zalozKonto(p.db, { login: 'adam', imie: 'Adam', haslo: 'h', rola: 'administrator', admin: true });
  const w = { ...p, admin: jako(p.db, 'adam') };
  otwarte.push(w);
  return w;
}
afterEach(async () => { for (const p of otwarte.splice(0)) { await p.app.close(); p.db.close(); } });

const sekcja = (html, id) => new RegExp(`<section class="ust-sekcja[^"]*" id="${id}">[\\s\\S]*?<\\/section>`, 'u').exec(html)?.[0] ?? '';

describe('PRZ-108.11 Szablony wiadomości — „Szablony własne” pierwsze', () => {
  it('kafel „Szablony własne” stoi przed mailami z karty zamówienia, zdaniami o płatności i mailami do zespołu', async () => {
    const p = panel();
    const r = await get(p.app, '/ustawienia/szablony-wiadomosci', p.admin);
    expect(r.statusCode).toBe(200);
    const miejsce = (id) => r.body.indexOf(`id="${id}"`);
    expect(miejsce('szablony-wlasne')).toBeGreaterThan(0);
    expect(miejsce('szablony-wlasne')).toBeLessThan(miejsce('szablony-wbudowane'));
    expect(miejsce('szablony-wlasne')).toBeLessThan(miejsce('zdania-platnosci'));
    expect(miejsce('szablony-wlasne')).toBeLessThan(miejsce('szablony-zespol'));
    expect(sekcja(r.body, 'szablony-wlasne')).toMatch(/Szablony własne <span class="szw-licznik">0 z 30<\/span>/u);
  });
});

describe('PRZ-108.11 plakietka BETA przy Automatyzacjach', () => {
  it('jest w menu Ustawień przy pozycji „Automatyzacje” i przy tytule ekranu; nigdzie więcej', async () => {
    const p = panel();
    const r = await get(p.app, '/ustawienia/automatyzacje', p.admin);
    expect(r.statusCode).toBe(200);
    expect(r.body).toMatch(/<a href="\/ustawienia\/automatyzacje"><span>Automatyzacje<\/span><span class="menu-ustawien-beta">BETA<\/span><\/a>/u);
    expect(r.body).toContain('<div class="tytul-z-plakietka"><h1>Automatyzacje</h1><span class="menu-ustawien-beta">BETA</span></div>');
    // Menu stoi w układzie dwa razy (lista na komputerze i rozwijana na telefonie) + tytuł ekranu.
    expect(r.body.match(/menu-ustawien-beta">BETA/gu)).toHaveLength(3);
  });
});

describe('PRZ-108.11 kafel „Automatyczna wysyłka do KSeF”', () => {
  it('stan jest zaraz pod tytułem; usunięte akapit, zdanie o podglądzie i pomoc pod polem; pomoc pod godziną zostaje', async () => {
    const p = panel();
    const r = await get(p.app, '/ustawienia/automatyzacje', p.admin);
    const k = sekcja(r.body, 'ksef-automat');
    expect(k.indexOf('id="ksef-automat-stan"')).toBeGreaterThan(k.indexOf('<h2>Automatyczna wysyłka do KSeF</h2>'));
    expect(k.indexOf('id="ksef-automat-stan"')).toBeLessThan(k.indexOf('<form'));
    expect(k).toContain('<strong>Wyłączony.</strong>');
    expect(k).not.toContain('Raz dziennie o wybranej godzinie');
    expect(k).not.toContain('bez ekranu podglądu');
    expect(k).not.toContain('Domyślnie wyłączone');
    expect(k).not.toContain('Wyłączenie działa od razu');
    expect(k).toContain('Wysłanej do KSeF faktury nie da się cofnąć ani skasować — zostaje tylko korekta.');
    expect(k).toContain('Czas polski, najpóźniej 23:45.');
  });
});

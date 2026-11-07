// Kopia publiczna: wspólne zakładki muszą działać bez modułu TF, dla Brak i inFaktu.
import { describe, it, expect } from 'vitest';
import { zalozKonto } from '../../../src/core/bezpieczenstwo/konta.js';
import { nowyPanel, jako, get, post } from '../../pomoc/konta-prz068.js';
const PROGRAM = '/ustawienia/integracje/program-fakturowy';
const URLS = ['/ustawienia/firma/rejestrowe', '/ustawienia/firma/rachunek', '/ustawienia/faktury/zasady',
  '/ustawienia/faktury/vat', '/ustawienia/faktury/numeracja', '/ustawienia/faktury/ksef',
  '/ustawienia/wysylka/dostawa', '/ustawienia/komunikacja/podpis', '/ustawienia/automatyzacje/systemowe', '/ustawienia/zespol/logowania'];
async function wPanelu(program, test) {
  const p = nowyPanel({ env: { OMS_PROGRAM_FAKTUROWY: program } });
  zalozKonto(p.db, { login: 'wlasciciel', haslo: 'h', rola: 'administrator', admin: true });
  zalozKonto(p.db, { login: 'sprzedawca', haslo: 'h', rola: 'sprzedaz' });
  try { await test({ ...p, admin: jako(p.db, 'wlasciciel'), sprzedaz: jako(p.db, 'sprzedawca') }); }
  finally { await p.app.close(); p.db.close(); }
}
describe('publiczne zakładki faktur bez opcjonalnego modułu', () => {
  it.each(['brak', 'infakt'])('nowe adresy GET przy %s i odmowa dla Sprzedaży', async program => {
    await wPanelu(program, async ({ app, admin, sprzedaz }) => {
      for (const url of URLS) {
        const r = await get(app, url, admin);
        expect([200, 302, 303], url).toContain(r.statusCode);
        expect((await get(app, url, sprzedaz)).statusCode, url).toBe(403);
      }
      const wybor = await get(app, PROGRAM, admin);
      expect(wybor.statusCode).toBe(200);
      expect(wybor.body).toMatch(/value="twojefaktury" disabled>[\s\S]*?wkrótce/);
    });
  });
  it('program i rachunek mają osobne formularze; konto firmy nie miesza ustawień', async () => {
    await wPanelu('infakt', async ({ app, admin }) => {
      const program = await get(app, PROGRAM, admin);
      expect(program.body).toContain('id="modul-faktur-formularz"');
      expect(program.body).not.toContain('id="faktury-dla-kazdego"');
      const firma = await get(app, '/ustawienia/firma', admin);
      expect(firma.body).not.toContain('id="stawka-vat"');
      expect(firma.body).not.toContain('id="rachunek-stan"');
      const rachunek = await get(app, '/ustawienia/firma/rachunek', admin);
      expect(rachunek.body).toContain('id="rachunek-stan"');
      expect(rachunek.body).not.toContain('id="logo"');
    });
  });
  it('przy Brak odbiór kosztów KSeF pozostaje dostępny', async () => {
    await wPanelu('brak', async ({ app, admin }) => {
      const r = await get(app, '/ustawienia/faktury/ksef', admin);
      expect(r.statusCode).toBe(200);
      expect(r.body).toContain('Odbiór faktur kosztowych');
      expect(r.body).toContain('href="/ustawienia/integracje/ksef"');
      expect(r.body).not.toContain('action="/ustawienia/integracje/program-fakturowy/ksef"');
    });
  });
  // 07.11 (PRZ-154 E1.5/E2): oba przypadki jak w twoj-oms main — wspólny nagłówek ekranu, kolumna działów zamiast menu aplikacji.
  it('podpis ma własny nagłówek w Komunikacji i nie pokazuje formularza SMTP', async () => {
    await wPanelu('brak', async ({ app, admin }) => {
      const r = await get(app, '/ustawienia/komunikacja/podpis', admin);
      expect(r.body).not.toContain('<h2 class="naglowek-formularza">Podpis i stopka</h2>');
      expect(r.body).not.toContain('<h2>Serwer poczty</h2>');
      expect(r.body).not.toContain('← Integracje');
    });
  });
  it('rama Ustawień ma kolumnę działów zamiast menu aplikacji i dostępny znacznik aktywnego działu', async () => {
    await wPanelu('brak', async ({ app, admin }) => {
      const r = await get(app, '/ustawienia/firma', admin);
      expect(r.body).toContain('class="oms-shell oms-shell--ustawienia"');
      expect(r.body).not.toContain('id="ust-menu-aplikacji"');
      expect(r.body).toContain('class="oms-settings-column');
      expect(r.body).toMatch(/<li class="aktywna">\s*<a href="\/ustawienia\/firma" aria-current="page">/u);
    });
  });
});

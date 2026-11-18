// Ekran Szablony wiadomości widzi każde konto z prawem „ustawienia", a ekran Użytkownicy tylko administrator.
// Wzór jak A8: wskazówka „Ustawienia → Zespół i dostęp → Użytkownicy” tylko dla administratora, reszta dostaje prośbę.
import { describe, it, expect } from 'vitest';
import Fastify from 'fastify';
import { zalozKonto, kontoPoLoginie, ustawUprawnienia } from '../../../src/core/bezpieczenstwo/konta.js';
import { nowyPanel, jako, get } from '../../pomoc/panel-konta-testowe.js';
import { registerSzablonyWiadomosciRoutes } from '../../../src/moduly/wiadomosci/trasy/szablony.js';

const ADRES = '/ustawienia/szablony-wiadomosci';
const SCIEZKA = 'Ustawienia → Zespół i dostęp → Użytkownicy';

function panel() {
  const p = nowyPanel({});
  zalozKonto(p.db, { login: 'adam', imie: 'Adam', haslo: 'h', rola: 'administrator', admin: true });
  zalozKonto(p.db, { login: 'ewa', imie: 'Ewa', haslo: 'h', rola: 'sprzedaz' });
  ustawUprawnienia(p.db, kontoPoLoginie(p.db, 'ewa').id, ['zamowienia', 'ustawienia']);
  return { ...p, admin: jako(p.db, 'adam'), ewa: jako(p.db, 'ewa') };
}

describe('B4a: sekcja „Maile do zespołu” w szablonach wiadomości', () => {
  it('administrator dostaje ścieżkę do ekranu Użytkownicy, pracownik z prawem ustawień — prośbę do administratora', async () => {
    const p = panel();
    const admin = await get(p.app, ADRES, p.admin);
    const ewa = await get(p.app, ADRES, p.ewa);
    expect(admin.statusCode).toBe(200);
    expect(ewa.statusCode).toBe(200);
    // Całe zdanie po znormalizowaniu spacji — także kropka po nawiasie u administratora.
    const zdanie = (body) => body.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ');
    expect(zdanie(admin.body)).toContain(`hasła (${SCIEZKA}). Link wstawia panel`);
    expect(zdanie(ewa.body)).toContain('hasła. Poproś administratora o dodanie pracownika. Link wstawia panel');
    expect(ewa.body).not.toContain(SCIEZKA);
    expect(admin.body).not.toContain('Poproś administratora o dodanie pracownika.');
  });

  it('gość podglądu demo widzi Użytkowników w menu, więc dostaje ścieżkę, nie prośbę do administratora', async () => {
    const p = panel();
    // Symulacja migawki gościa po strażniku (wzór z klucze-api.test.js): model widoku zamiast HTML.
    const demo = Fastify();
    demo.decorateReply('view', function (_plik, model) {
      return this.send(model);
    });
    demo.addHook('preHandler', async (req) => {
      req.konto = { podgladDemo: true };
    });
    registerSzablonyWiadomosciRoutes(demo, { db: p.db });
    try {
      const r = await demo.inject({ method: 'GET', url: ADRES });
      expect(r.statusCode).toBe(200);
      expect(r.json().admin).toBe(true);
    } finally {
      await demo.close();
    }
  });
});

// PRZ-175 p0 (0.7) — ekran edycji maila do zespołu (zaproszenie): ścieżka „Ustawienia → Zespół i dostęp → Użytkownicy”
// tylko dla tych, którzy ten ekran widzą (administrator i gość podglądu demo, jak B4a na liście szablonów);
// pracownik z samym prawem „ustawienia” dostaje prośbę do administratora. Sprawdzamy całe zdania na ekranie.
import { describe, it, expect } from 'vitest';
import { zalozKonto, kontoPoLoginie, ustawUprawnienia } from '../../../src/core/bezpieczenstwo/konta.js';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { buildOmsServer } from '../../pomoc/serwer-parytetu.ts';
import { CONFIG, POLLER, jako, get } from '../../pomoc/konta-prz068.js';

const ADRES = '/ustawienia/szablony-wiadomosci/zaproszenie';
const PODGLAD = `${ADRES}?podglad=1&temat=${encodeURIComponent('Zaproszenie do panelu')}&tresc=${encodeURIComponent('Cześć {imie}, ustaw hasło: {link}')}`;
const SCIEZKA = 'Ustawienia → Zespół i dostęp → Użytkownicy';

const ZDANIA_ADMINA = [
  `Wpisz nazwę pola w klamrach, np. {imie}. Link i jego ważność wstawia panel przy wysyłce z Ustawień → Zespół i dostęp → Użytkownicy.`,
  `Imię pracownika z jego konta (${SCIEZKA}).`,
];
const ZDANIA_PRACOWNIKA = [
  'Wpisz nazwę pola w klamrach, np. {imie}. Link i jego ważność wstawia panel przy wysyłce. Poproś administratora o dodanie pracownika.',
  '{imie} Imię pracownika z jego konta. {link}',
];
const PODGLAD_ADMINA = 'Pracownica Anna, link zmyślony — prawdziwy, jednorazowy link panel wstawia dopiero przy wysyłce z Ustawień → Zespół i dostęp → Użytkownicy. Nic nie zostało zapisane.';
const PODGLAD_PRACOWNIKA = 'Pracownica Anna, link zmyślony — prawdziwy, jednorazowy link panel wstawia dopiero przy wysyłce. Poproś administratora o dodanie pracownika. Nic nie zostało zapisane.';

const tekst = (body) => body.replace(/<[^>]*>/g, ' ').replace(/&#123;/g, '{').replace(/&#125;/g, '}').replace(/\s+/g, ' ').replace(/ ([.,])/g, '$1');

function panel() {
  const db = openOmsDb(':memory:');
  const app = buildOmsServer({ poller: POLLER, db, config: { auth: { ...CONFIG.auth }, demo: { login: 'demo' } } });
  zalozKonto(db, { login: 'adam', imie: 'Adam', haslo: 'h', rola: 'administrator', admin: true });
  zalozKonto(db, { login: 'ewa', imie: 'Ewa', haslo: 'h', rola: 'sprzedaz' });
  ustawUprawnienia(db, kontoPoLoginie(db, 'ewa').id, ['zamowienia', 'ustawienia']);
  // Gość demo ma te same prawa co pracownik — ścieżkę dostaje tylko dzięki znacznikowi podglądu demo.
  zalozKonto(db, { login: 'demo', imie: 'Gość', haslo: 'demo', rola: 'sprzedaz' });
  ustawUprawnienia(db, kontoPoLoginie(db, 'demo').id, ['zamowienia', 'ustawienia']);
  return { db, app, admin: jako(db, 'adam'), ewa: jako(db, 'ewa'), demo: jako(db, 'demo') };
}

async function ekrany(p, kto) {
  const edycja = await get(p.app, ADRES, p[kto]);
  const podglad = await get(p.app, PODGLAD, p[kto]);
  expect(edycja.statusCode, kto).toBe(200);
  expect(podglad.statusCode, kto).toBe(200);
  return { edycja: tekst(edycja.body), podglad: tekst(podglad.body) };
}

describe('0.7: ścieżka do ekranu Użytkownicy na ekranie maila do zespołu', () => {
  it('administrator i gość demo dostają ścieżkę, pracownik z prawem ustawień — prośbę do administratora', async () => {
    const p = panel();
    try {
      for (const kto of ['admin', 'demo']) {
        const { edycja, podglad } = await ekrany(p, kto);
        for (const z of ZDANIA_ADMINA) expect(edycja, kto).toContain(z);
        expect(podglad, kto).toContain(PODGLAD_ADMINA);
        expect(edycja + podglad, kto).not.toContain('Poproś administratora o dodanie pracownika.');
      }
      const { edycja, podglad } = await ekrany(p, 'ewa');
      for (const z of ZDANIA_PRACOWNIKA) expect(edycja).toContain(z);
      expect(podglad).toContain(PODGLAD_PRACOWNIKA);
      expect(edycja + podglad).not.toContain('Zespół i dostęp → Użytkownicy');
    } finally { await p.app.close(); p.db.close(); }
  });
});

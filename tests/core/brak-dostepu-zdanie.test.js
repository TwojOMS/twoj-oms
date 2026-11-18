// Ekran odmowy wskazuje miejsce, w którym naprawdę zmienia się dostęp: rola konta
// (Ustawienia → Zespół i dostęp → Role i uprawnienia). Na „Użytkownikach” jest tylko „Zmień rolę”, ptaszków tam nie ma.
import { describe, it, expect } from 'vitest';
import { zalozKonto } from '../../src/core/bezpieczenstwo/konta.js';
import { nowyPanel, jako, get } from '../pomoc/panel-konta-testowe.js';

const tekst = (html) => html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ');

describe('ekran odmowy — gdzie administrator nadaje dostęp', () => {
  it('konto bez uprawnienia do /faktury dostaje 403 ze zdaniem o roli konta', async () => {
    const { db, app } = nowyPanel();
    zalozKonto(db, { login: 'adam', imie: 'Adam', haslo: 'h', rola: 'administrator', admin: true });
    zalozKonto(db, { login: 'jan', imie: 'Jan', haslo: 'h', rola: 'produkcja' });
    const r = await get(app, '/faktury', jako(db, 'jan'));
    expect(r.statusCode).toBe(403);
    const t = tekst(r.body);
    expect(t).toContain('Brak dostępu');
    expect(t).toContain(
      'poproś administratora o zaznaczenie go w roli Twojego konta: ' +
        'Ustawienia → Zespół i dostęp → Role i uprawnienia .',
    );
    expect(t).not.toContain('Zespół i dostęp → Użytkownicy');
  });
});

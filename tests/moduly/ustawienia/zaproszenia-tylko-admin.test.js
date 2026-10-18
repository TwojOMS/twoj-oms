// PRZ-069, recenzja końcowa Fable 5.1, P3-1: dowód, że `tylkoAdmin` stoi NA TRASACH zaproszeń i resetu,
// a nie tylko strażnik globalny. Konto bez flagi `admin`, ale Z ptaszkiem Ustawień, przechodzi strażnika
// (ekranDlaAdresu('/ustawienia/…') = 'ustawienia') — zatrzymać je może wyłącznie `tylkoAdmin` w trasie.
// Wzór: role-recenzja-d8.test.js („strażnik admina w /rola”) i web-konta.test.js K2.
import { describe, it, expect, vi } from 'vitest';
import { zalozKonto, kontoPoLoginie, ustawUprawnienia } from '../../../src/core/bezpieczenstwo/konta.js';
import { emailKonta } from '../../../src/moduly/ustawienia/konta-dostep.js';
import { nowyPanel, jako, post, get } from '../../pomoc/konta-prz068.js';

const ADRES = 'https://panel.example.test';
const atrapa = () => ({ sendMail: vi.fn(async () => ({ messageId: 'atrapa' })) });

function panel() {
  const mailer = atrapa();
  const p = nowyPanel({ env: { OMS_ADRES_PANELU: ADRES }, nadpisania: { 'wiadomosci.mailer': mailer } });
  zalozKonto(p.db, { login: 'adam', imie: 'Adam', haslo: 'h', rola: 'administrator', admin: true });
  const idEwa = zalozKonto(p.db, { login: 'ewa', imie: 'Barbara', haslo: 'h', rola: 'sprzedaz' });
  const idOla = zalozKonto(p.db, { login: 'ola', imie: 'Ola', haslo: 'h', rola: 'sprzedaz' });
  // Ptaszek Ustawień bez flagi admin: strażnik globalny przepuszcza, `tylkoAdmin` ma odmówić.
  ustawUprawnienia(p.db, idEwa, ['ustawienia']);
  return { ...p, mailer, idEwa, idOla, ktos: jako(p.db, 'ewa') };
}
const liczbaLinkow = (db) => db.prepare('SELECT count(*) AS n FROM linki_hasla').get().n;

describe('PRZ-069 (P3-4) — uwaga o źródle adresu pod linkiem „Pokaż link”', () => {
  const UWAGA = 'Adres wzięty z Twojej przeglądarki. Jeśli pracownik otwiera panel pod innym adresem, wpisz go w Ustawienia → Integracje → Poczta wychodząca.'; // PRZ-094.10: adres wpisuje się też na ekranie
  const zaloz = (env) => {
    const p = nowyPanel({ env });
    zalozKonto(p.db, { login: 'adam', imie: 'Adam', haslo: 'h', rola: 'administrator', admin: true });
    const id = zalozKonto(p.db, { login: 'ola', imie: 'Ola', haslo: 'h', rola: 'sprzedaz' });
    return { ...p, id, admin: jako(p.db, 'adam') };
  };

  it('bez OMS_ADRES_PANELU: link z adresu przeglądarki i uwaga pod nim (reset i nowe konto)', async () => {
    const { app, id, admin } = zaloz({});
    const reset = await post(app, `/ustawienia/konta/${id}/link`, admin, { sposob: 'pokaz' });
    expect(reset.statusCode).toBe(200);
    expect(reset.body).toMatch(/\/haslo\/[A-Za-z0-9_-]{43}/);
    expect(reset.body).toContain(UWAGA);
    const nowe = await post(app, '/ustawienia/konta/nowe', admin, { imie: 'Nowy', login: 'nowy', email: '', rola: 'produkcja', sposob: 'pokaz' });
    expect(nowe.statusCode).toBe(200);
    expect(nowe.body).toContain(UWAGA);
  });

  it('z OMS_ADRES_PANELU: link z tej zmiennej i bez uwagi', async () => {
    const { app, id, admin } = zaloz({ OMS_ADRES_PANELU: ADRES });
    const r = await post(app, `/ustawienia/konta/${id}/link`, admin, { sposob: 'pokaz' });
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain(`${ADRES}/haslo/`);
    expect(r.body).not.toContain('Adres wzięty z Twojej przeglądarki');
  });

  it('zwykła strona konta (bez linku) nie ma uwagi', async () => {
    const { app, id, admin } = zaloz({});
    const r = await get(app, `/ustawienia/konta/${id}`, admin);
    expect(r.statusCode).toBe(200);
    expect(r.body).not.toContain('Adres wzięty z Twojej przeglądarki');
  });
});

describe('PRZ-069 (P3-1) — trasy zaproszeń i resetu: konto z ptaszkiem Ustawień, ale bez admina, dostaje 403', () => {
  it('sanity: to konto naprawdę przechodzi strażnika globalnego (inaczej dowód byłby pusty)', async () => {
    const { db, app, ktos } = panel();
    expect(kontoPoLoginie(db, 'ewa')).toMatchObject({ admin: false });
    expect(kontoPoLoginie(db, 'ewa').uprawnienia.has('ustawienia')).toBe(true);
    // Ekran Ustawień bez własnego strażnika admina w trasie: 200 dowodzi, że 403 niżej NIE pochodzi ze strażnika globalnego.
    expect((await get(app, '/ustawienia/zamowienia-i-wysylka', ktos)).statusCode).toBe(200);
  });

  it('GET /ustawienia/konta/:id — 403, bez strony konta', async () => {
    const { app, idOla, ktos } = panel();
    const r = await get(app, `/ustawienia/konta/${idOla}`, ktos);
    expect(r.statusCode).toBe(403);
    expect(r.body).toContain('Brak dostępu');
    expect(r.body).not.toContain('ola');
  });

  it('POST /ustawienia/konta/:id/email — 403, e-mail bez zmian', async () => {
    const { db, app, idOla, ktos } = panel();
    const przed = emailKonta(db, idOla);
    const r = await post(app, `/ustawienia/konta/${idOla}/email`, ktos, { email: 'przejete@example.test' });
    expect(r.statusCode).toBe(403);
    expect(r.body).toContain('Brak dostępu');
    expect(emailKonta(db, idOla)).toBe(przed);
  });

  it('POST /ustawienia/konta/:id/link („Pokaż link”) — 403, żaden link nie powstaje, token nie wycieka', async () => {
    const { db, app, idOla, ktos } = panel();
    const r = await post(app, `/ustawienia/konta/${idOla}/link`, ktos, { sposob: 'pokaz' });
    expect(r.statusCode).toBe(403);
    expect(r.body).not.toMatch(/\/haslo\/[A-Za-z0-9_-]{43}/);
    expect(liczbaLinkow(db)).toBe(0);
  });

  it('POST /ustawienia/konta/:id/link (mail) — 403, żaden link, mailer niewołany', async () => {
    const { db, app, mailer, idOla, ktos } = panel();
    const r = await post(app, `/ustawienia/konta/${idOla}/link`, ktos, { sposob: 'mail' });
    expect(r.statusCode).toBe(403);
    expect(liczbaLinkow(db)).toBe(0);
    expect(mailer.sendMail).not.toHaveBeenCalled();
  });

  it('POST /ustawienia/konta/nowe ze `sposob` — 403, konta nie ma, linku nie ma, mailer niewołany', async () => {
    const { db, app, mailer, ktos } = panel();
    for (const sposob of ['pokaz', 'mail']) {
      const r = await post(app, '/ustawienia/konta/nowe', ktos, { imie: 'Nowy', login: 'nowy', email: 'nowy@example.test', rola: 'administrator', sposob });
      expect(r.statusCode).toBe(403);
      expect(r.body).not.toMatch(/\/haslo\/[A-Za-z0-9_-]{43}/);
    }
    expect(kontoPoLoginie(db, 'nowy')).toBeNull();
    expect(liczbaLinkow(db)).toBe(0);
    expect(mailer.sendMail).not.toHaveBeenCalled();
  });
});

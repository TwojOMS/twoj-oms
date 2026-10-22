import { describe, it, expect, vi } from 'vitest';
import { zalozKonto, kontoPoLoginie } from '../../../src/core/bezpieczenstwo/konta.js';
import { trescMaila } from '../../../src/moduly/ustawienia/poczta-kont.js';
import { ustawEmail } from '../../../src/moduly/ustawienia/konta-dostep.js';
import { DOMYSLNE } from '../../../src/domena/szablony-wiadomosci.js';
import { nowyPanel, jako, get, post } from '../../pomoc/konta-prz068.js';

// PRZ-101.06: zaproszenie i reset hasła pracownika jako szablony wbudowane rodzaju „konto".
// ⛔ Żadnego prawdziwego SMTP: mailer to atrapa podana nadpisaniem usługi `wiadomosci.mailer`.

const ADRES = 'https://panel.example.test';
const atrapa = () => ({ sendMail: vi.fn(async () => ({ messageId: 'atrapa' })) });
function panel() {
  const mailer = atrapa();
  const p = nowyPanel({ env: { OMS_ADRES_PANELU: ADRES }, nadpisania: { 'wiadomosci.mailer': mailer } });
  zalozKonto(p.db, { login: 'adam', imie: 'Adam', haslo: 'h', rola: 'administrator', admin: true });
  return { ...p, mailer, admin: jako(p.db, 'adam') };
}

describe('domyślny szablon = dzisiejszy mail co do znaku', () => {
  for (const cel of ['zaproszenie', 'reset']) {
    for (const imie of ['Ola', 'Anna Maria', 'Jan <b>&']) {
      it(`${cel}, imię „${imie}"`, () => {
        const link = 'https://oms.example/haslo/AbC-123_xyz';
        const dzis = trescMaila({ cel, imie, link });
        const zSzablonu = trescMaila({ cel, imie, link, szablon: DOMYSLNE[cel] });
        expect(zSzablonu.subject).toBe(dzis.subject);
        expect(zSzablonu.text).toBe(dzis.text);
        expect(zSzablonu.html).toBe(dzis.html);
      });
    }
  }
});

// PRZ-108.01: pracownik bez imienia — domyślne „Dzień dobry, {imie}!" dawało „Dzień dobry,!".
describe('pracownik bez imienia', () => {
  for (const cel of ['zaproszenie', 'reset']) {
    for (const imie of ['', '   ', undefined]) {
      it(`${cel}, imię ${JSON.stringify(imie) ?? 'brak'}: pozdrowienie bez wykrzyknika`, () => {
        const m = trescMaila({ cel, imie, link: 'https://oms.example/haslo/AbC', szablon: DOMYSLNE[cel] });
        expect(m.text).toMatch(/^Dzień dobry,\n\nAdministrator /);
        expect(m.text).not.toMatch(/,!/);
      });
    }
  }
});

describe('zapisany szablon w prawdziwej wysyłce', () => {
  it('zaproszenie z nowym tematem i treścią, link podstawiony; „Przywróć domyślny" wraca do dzisiejszego', async () => {
    const { db, app, admin, mailer } = panel();
    const zapis = await post(app, '/ustawienia/szablony-wiadomosci/zaproszenie', admin, {
      temat: 'Witaj w zespole, {imie}',
      tresc: 'Cześć {imie},\n\nzałóż hasło tutaj: {link}\n\nLink jest ważny {waznosc}.',
    });
    expect(zapis.statusCode).toBe(303);

    const r = await post(app, '/ustawienia/konta/nowe', admin, { imie: 'Nowa Osoba', login: 'nowa', email: 'nowa@example.test', rola: 'produkcja', sposob: 'mail' });
    expect(r.statusCode, r.body).toBe(302);
    const m = mailer.sendMail.mock.calls[0][0];
    expect(m.subject).toBe('Witaj w zespole, Nowa Osoba');
    expect(m.text).toMatch(new RegExp(`^Cześć Nowa Osoba,\\n\\nzałóż hasło tutaj: ${ADRES}/haslo/[A-Za-z0-9_-]{43}\\n\\nLink jest ważny 48 h\\.$`));
    expect(m.html).toContain(`${ADRES}/haslo/`);
    expect(m.text + m.subject).not.toMatch(/[{}]/);

    expect((await post(app, '/ustawienia/szablony-wiadomosci/zaproszenie/usun', admin)).statusCode).toBe(303);
    const id = kontoPoLoginie(db, 'nowa').id;
    await post(app, `/ustawienia/konta/${id}/link`, admin, { sposob: 'mail' });
    const m2 = mailer.sendMail.mock.calls[1][0];
    // Konto jeszcze bez hasła — „wyślij link” to ponowne zaproszenie (cel zaproszenie), już z treścią domyślną.
    expect(m2.subject).toBe('Zaproszenie do panelu');
    expect(m2.text).toMatch(/^Dzień dobry, Nowa Osoba!\n\nAdministrator zaprosił Cię/);
  });

  it('reset: zapisany szablon resetu nie zmienia zaproszenia', async () => {
    const { db, app, admin, mailer } = panel();
    await post(app, '/ustawienia/szablony-wiadomosci/reset', admin, { temat: 'Nowe hasło', tresc: 'Hasło ustawisz tu: {link}' });
    const id = zalozKonto(db, { login: 'ewa', imie: 'Ewa', haslo: 'stare-haslo-123', rola: 'sprzedaz' });
    ustawEmail(db, id, 'ewa@example.test', () => new Date());
    await post(app, `/ustawienia/konta/${id}/link`, admin, { sposob: 'mail' });
    expect(mailer.sendMail.mock.calls[0][0]).toMatchObject({ subject: 'Nowe hasło' });
    await post(app, '/ustawienia/konta/nowe', admin, { imie: 'Nowa', login: 'nowa', email: 'nowa@example.test', rola: 'produkcja', sposob: 'mail' });
    expect(mailer.sendMail.mock.calls[1][0].subject).toBe('Zaproszenie do panelu');
  });
});

describe('ekran Szablony wiadomości — maile do zespołu', () => {
  it('osobna sekcja „Maile do zespołu" z oboma szablonami', async () => {
    const { app, admin } = panel();
    const r = await get(app, '/ustawienia/szablony-wiadomosci', admin);
    expect(r.statusCode).toBe(200);
    const sekcja = r.body.slice(r.body.indexOf('id="szablony-zespol"'));
    expect(sekcja).toContain('Maile do zespołu');
    expect(sekcja).toContain('<td>Zaproszenie pracownika</td>');
    expect(sekcja).toContain('<td>Reset hasła pracownika</td>');
    // Sekcja klienta nie zawiera maili do zespołu.
    const klient = r.body.slice(r.body.indexOf('id="szablony-wbudowane"'), r.body.indexOf('id="szablony-wlasne"'));
    expect(klient).not.toContain('Zaproszenie pracownika');
  });

  it('odmowa zapisu bez {link} — z powodem, nic nie zapisane', async () => {
    const { app, admin, mailer } = panel();
    const r = await post(app, '/ustawienia/szablony-wiadomosci/zaproszenie', admin, { temat: 'Witaj', tresc: 'Cześć {imie}, zaloguj się w panelu.' });
    expect(r.statusCode).toBe(400);
    expect(r.body).toContain('{link}');
    await post(app, '/ustawienia/konta/nowe', admin, { imie: 'Nowa', login: 'nowa', email: 'nowa@example.test', rola: 'produkcja', sposob: 'mail' });
    expect(mailer.sendMail.mock.calls[0][0].subject).toBe('Zaproszenie do panelu');
  });

  it('edytor: pola {imie}, {link} (obowiązkowe), {waznosc}; bez pól zamówienia', async () => {
    const { app, admin } = panel();
    const r = await get(app, '/ustawienia/szablony-wiadomosci/reset', admin);
    expect(r.body).toMatch(/<code>\{link\}<\/code> <span class="szw-znacznik szw-znacznik--wymagane">obowiązkowe<\/span>/);
    expect(r.body).toContain('<code>{waznosc}</code>');
    expect(r.body).toContain('<code>{imie}</code>');
    expect(r.body).not.toContain('<code>{kwota}</code>');
    expect(r.body).not.toContain('Załącznik PDF');
  });

  it('podgląd na zmyślonym linku — żadnego prawdziwego tokenu, żaden link nie powstaje w bazie', async () => {
    const { db, app, admin } = panel();
    const q = new URLSearchParams({ podglad: '1', temat: 'Witaj {imie}', tresc: 'Hasło: {link} ({waznosc})' });
    const r = await get(app, `/ustawienia/szablony-wiadomosci/zaproszenie?${q}`, admin);
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain('Hasło: https://panel.example/haslo/przykladowy-link (48 h)');
    expect(r.body).not.toMatch(/\/haslo\/[A-Za-z0-9_-]{43}/);
    expect(db.prepare('SELECT count(*) AS n FROM linki_hasla').get().n).toBe(0);
  });
});

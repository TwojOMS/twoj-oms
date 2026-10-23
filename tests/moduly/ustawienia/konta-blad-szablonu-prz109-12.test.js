// PRZ-109.12 (recenzja Astra, poz. 03): w Kontach `catch` obejmował też odczyt szablonu maila. Błąd bazy z kodem
// (np. ERR_SQLITE_ERROR) był oznaczany jak odmowa serwera poczty i operator czytał „Serwer poczty nie przyjął…”,
// choć `sendMail` nie został wywołany. Znacznik błędu poczty stawia teraz tylko błąd samego `sendMail`.
import { it, expect, vi } from 'vitest';

const stan = vi.hoisted(() => ({ zepsuj: false }));
vi.mock('../../../src/oms/db/szablony-wiadomosci.js', async (oryginal) => {
  const m = await oryginal();
  return {
    ...m,
    wczytajSzablonyWiadomosci: (...a) => {
      if (stan.zepsuj) throw Object.assign(new Error('no such table: ustawienia'), { code: 'ERR_SQLITE_ERROR' });
      return m.wczytajSzablonyWiadomosci(...a);
    },
  };
});

const { zalozKonto } = await import('../../../src/core/bezpieczenstwo/konta.js');
const { nowyPanel, jako, post } = await import('../../pomoc/konta-prz068.js');

it('błąd odczytu szablonu z kodem: dawne zdanie, bez „Serwer poczty”, mail nie wysłany', async () => {
  let wyslane = 0;
  const p = nowyPanel({ env: { OMS_ADRES_PANELU: 'https://panel.przyklad.invalid' },
    nadpisania: { 'wiadomosci.mailer': { sendMail: async () => { wyslane += 1; } } } });
  zalozKonto(p.db, { login: 'admin1', imie: 'Admin', haslo: 'h', rola: 'administrator', admin: true });
  stan.zepsuj = true;
  const r = await post(p.app, '/ustawienia/konta/nowe', jako(p.db, 'admin1'),
    { imie: 'Nowa Osoba', login: 'nowa', email: 'nowa@przyklad.invalid', rola: 'produkcja', sposob: 'mail' });
  stan.zepsuj = false;
  expect(wyslane).toBe(0);
  expect(r.statusCode).toBe(502);
  expect(r.body).toContain('Nie udało się wysłać maila — użyj „Pokaż link”. Poprzedni link, jeśli był, nadal działa.');
  expect(r.body).not.toContain('Serwer poczty');
});

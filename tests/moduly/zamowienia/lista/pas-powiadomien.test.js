import { afterEach, expect, it, vi } from 'vitest';
import { zalozKonto, kontoPoLoginie } from '../../../../src/core/bezpieczenstwo/konta.js';
import { odrzuc } from '../../../../src/oms/db/ostrzezenia.js';
import { zapiszUkryteTypy } from '../../../../src/oms/db/powiadomienia.js';
import { createMigawkaPowiadomien } from '../../../../src/moduly/zamowienia/services/migawka-powiadomien.js';
import { get, jako, nowyPanel } from '../../../pomoc/panel-konta-testowe.js';

const start = '2026-10-28T10:00:00.000Z';
const kanal = {
  klucz: 'kanal:allegro_polcien:pilne',
  typ: 'kanal',
  tekst: 'Kanał nie działa: połączenie wygasło. Naprawa: połączenie kanału z Allegro na nowo.',
  pilne: true,
  przycisk: { href: '/ustawienia/integracje', etykieta: 'Połączenia' },
};
const integracja = {
  klucz: 'integracja:poller:polcien',
  typ: 'integracja',
  tekst: 'Pobieranie zamówień z Pracowni Półcień nie działa.',
  pilne: true,
  przycisk: { href: '/ustawienia/lacznosc', etykieta: 'Łączność' },
};
let panel;

afterEach(async () => {
  vi.useRealTimers();
  await panel?.app.close();
  panel?.db.close();
  panel = undefined;
});

async function lista(wiersze) {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(start));
  const stanyKanalow = vi.fn(() => []);
  const zdrowie = vi.fn(() => null);
  panel = nowyPanel({ stanyKanalow, zdrowie });
  const { app, db } = panel;
  zalozKonto(db, { login: 'admin-test', imie: 'Administrator', haslo: 'h', rola: 'administrator', admin: true });
  await app.ready();
  const migawka = createMigawkaPowiadomien({ db, zbierz: () => wiersze });
  expect(await migawka.przeliczTeraz()).toMatchObject({ nowych: wiersze.length });
  return {
    db,
    stanyKanalow,
    zdrowie,
    html: async () => {
      const r = await get(app, '/', jako(db, 'admin-test'));
      expect(r.statusCode).toBe(200);
      return r.body;
    },
  };
}

const pasy = (html) => html.match(/<p class="pas-awaria">[\s\S]*?<\/p>/gu) ?? [];

it('na liście są tylko pilne sprawy z migawki, każda z odnośnikiem do powiadomień', async () => {
  const uprzedzenie = {
    ...kanal,
    klucz: 'kanal:allegro_cien:uprzedzenie',
    tekst: 'Kanał wkrótce przestanie działać: połączenie wygasa.',
    pilne: false,
  };
  const { html, stanyKanalow, zdrowie } = await lista([kanal, uprzedzenie, integracja]);
  const strona = await html();
  const [, trescListy] = strona.match(/<main\b[^>]*>([\s\S]*?)<\/main>/u);

  expect(stanyKanalow).not.toHaveBeenCalled();
  expect(zdrowie).not.toHaveBeenCalled();
  expect(strona).not.toContain('class="ostrzezenia"');
  expect(strona).not.toContain('class="pas-uprzedzenie"');
  expect(trescListy).not.toContain(uprzedzenie.tekst);
  expect(pasy(strona)).toHaveLength(2);
  for (const [i, pas] of pasy(strona).entries()) {
    const wiersz = [kanal, integracja][i];
    expect(pas).toContain(wiersz.tekst);
    expect(pas).toContain('<a href="/powiadomienia">Szczegóły</a>');
  }
});

it('pas uwzględnia rodzaje ukryte przez konto', async () => {
  const { db, html } = await lista([kanal, integracja]);
  zapiszUkryteTypy(db, kontoPoLoginie(db, 'admin-test').id, ['integracja']);
  expect(pasy(await html())).toEqual([expect.stringContaining(kanal.tekst)]);
});

it('wyciszona integracja wraca na pas po upływie doby', async () => {
  const { db, html } = await lista([integracja]);
  odrzuc(db, integracja.klucz, { kto: 'admin-test', kiedy: start });

  vi.setSystemTime(new Date(Date.parse(start) + 24 * 60 * 60 * 1000 - 1));
  expect(pasy(await html())).toEqual([]);
  vi.setSystemTime(new Date(Date.parse(start) + 24 * 60 * 60 * 1000));
  expect(pasy(await html())).toEqual([expect.stringContaining(integracja.tekst)]);
});

it('tekst sprawy w pasie jest zwykłym tekstem, nie znacznikami', async () => {
  const { html } = await lista([{ ...integracja, tekst: 'Sklep <b>Półcień</b> nie odpowiada.' }]);
  const [pas] = pasy(await html());
  expect(pas).toContain('Sklep &lt;b&gt;Półcień&lt;/b&gt; nie odpowiada.');
  expect(pas).not.toContain('<b>');
});

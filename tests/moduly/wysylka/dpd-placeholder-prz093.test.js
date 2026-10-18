// PRZ-093.10 (przy okazji) — ekran DPD po zapisie: atrybut placeholder pól hasła i kanału wstawiany przez <%= %>
// wychodził z &#34; zamiast cudzysłowów i atrybut się rozsypywał (to samo poprawiono w InPost, PRZ-093.09).
import { describe, it, expect, vi } from 'vitest';
import { zalozKonto } from '../../../src/core/bezpieczenstwo/konta.js';
import { nowyPanel, jako, get, post } from '../../pomoc/konta-prz068.js';
import { modulRdzen } from '../../../src/moduly/rdzen/modul.ts';
import { modulWeb } from '../../../src/core/web/modul.ts';
import { modulKanaly } from '../../../src/moduly/kanaly/modul.ts';
import { modulFaktury } from '../../../src/moduly/faktury/modul.ts';
import { modulWiadomosci } from '../../../src/moduly/wiadomosci/modul.ts';
import { createModulZamowienia } from '../../../src/moduly/zamowienia/modul.ts';
import { createModulWysylka } from '../../../src/moduly/wysylka/modul.ts';
import { modulMagazyn } from '../../../src/moduly/magazyn/modul.ts';
import { modulUstawienia } from '../../../src/moduly/ustawienia/modul.ts';
import { modulMarketing } from '../../../src/moduly/marketing/modul.ts';
import { modulZdrowie } from '../../../src/moduly/zdrowie/modul.ts';

const NADAWCA = { DPD_NADAWCA_NAZWA: 'Pracownia Testowa', DPD_NADAWCA_ULICA: 'Zmyślona 1', DPD_NADAWCA_KOD: '00-950', DPD_NADAWCA_MIASTO: 'Warszawa' };
const formularz = (html) => /<form id="dpd-formularz"[\s\S]*?<\/form>/u.exec(html)?.[0] ?? '';

describe('PRZ-093.10 ekran DPD: placeholder pól sekretów', () => {
  it('po zapisie hasła i kanału: placeholder w prawdziwych cudzysłowach, bez &#34;, pola bez required', async () => {
    const createDpd = vi.fn(() => ({ nadaj: vi.fn(), statusPrzesylki: vi.fn(), sprawdzPolaczenie: vi.fn(async () => ({ ok: true })) }));
    const moduly = [modulRdzen, modulWeb, modulKanaly, modulFaktury, modulWiadomosci, createModulZamowienia({ zWiadomosciami: true }),
      createModulWysylka({ fabryki: { createDpd } }), modulMagazyn, modulUstawienia, modulMarketing, modulZdrowie];
    const { app, db } = nowyPanel({ moduly, env: NADAWCA });
    zalozKonto(db, { login: 'adam', imie: 'Adam', haslo: 'h', rola: 'administrator', admin: true });
    const admin = jako(db, 'adam');
    const zapis = await post(app, '/ustawienia/integracje/dpd', admin,
      { nazwa: 'DPD', login: '11112222', fid: '333444', haslo: 'Zmyslone-Haslo-1', typEtykiety: 'A4', kanal: 'zmyslony-kanal' });
    expect(zapis.statusCode, zapis.body).toBe(303);
    const f = formularz((await get(app, '/ustawienia/integracje/dpd', admin)).body);
    expect(f).not.toContain('&#34;');
    expect(f).toMatch(/<input id="dpd-haslo"[^>]* placeholder="zapisane — zostaw puste, żeby nie zmieniać">/u);
    expect(f).toMatch(/<input id="dpd-kanal"[^>]* placeholder="zapisany — zostaw puste, żeby nie zmieniać">/u);
    expect(f).not.toMatch(/<input id="dpd-haslo"[^>]*required/u);
  });

  it('pusty ekran: hasło wymagane, kanał bez placeholdera', async () => {
    const moduly = [modulRdzen, modulWeb, modulKanaly, modulFaktury, modulWiadomosci, createModulZamowienia({ zWiadomosciami: true }),
      createModulWysylka(), modulMagazyn, modulUstawienia, modulMarketing, modulZdrowie];
    const { app, db } = nowyPanel({ moduly, env: NADAWCA });
    zalozKonto(db, { login: 'adam', imie: 'Adam', haslo: 'h', rola: 'administrator', admin: true });
    const f = formularz((await get(app, '/ustawienia/integracje/dpd', jako(db, 'adam'))).body);
    expect(f).toMatch(/<input id="dpd-haslo"[^>]* required>/u);
    expect(f).toMatch(/<input id="dpd-kanal" name="kanal" value="" maxlength="64" autocomplete="off">/u);
  });
});

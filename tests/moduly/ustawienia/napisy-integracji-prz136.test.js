// PRZ-136.02 i PRZ-136.12 — napisy, pomoc administratora i etykiety ekranów integracji. Tylko treść widoków:
// bez zmiany zapisu tokenów i wysyłki. Dane zmyślone.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { ZDANIE_UPRAWNIENIA_KSEF } from '../../../src/domena/konfiguracja-ksef-kosztow.js';
import { zalozKonto } from '../../../src/core/bezpieczenstwo/konta.js';
import { nowyPanel, jako, get } from '../../pomoc/konta-prz068.js';
import { modulRdzen } from '../../../src/moduly/rdzen/modul.ts';
import { modulWeb } from '../../../src/core/web/modul.ts';
import { modulKanaly } from '../../../src/moduly/kanaly/modul.ts';
import { createModulFaktury } from '../../../src/moduly/faktury/modul.ts';
import { modulWiadomosci } from '../../../src/moduly/wiadomosci/modul.ts';
import { createModulZamowienia } from '../../../src/moduly/zamowienia/modul.ts';
import { createModulWysylka } from '../../../src/moduly/wysylka/modul.ts';
import { modulMagazyn } from '../../../src/moduly/magazyn/modul.ts';
import { modulUstawienia } from '../../../src/moduly/ustawienia/modul.ts';
import { modulMarketing } from '../../../src/moduly/marketing/modul.ts';
import { modulZdrowie } from '../../../src/moduly/zdrowie/modul.ts';

const WIDOK_KSEF = new URL('../../../src/moduly/koszty/widoki/ustawienia-ksef.ejs', import.meta.url);
const { renderFile } = createRequire(import.meta.url)('ejs');
const renderuj = (widok, dane = {}) => renderFile(`src/moduly/${widok}.ejs`, {
  zapisano: null, test: null, bledy: [], zEnv: false, stan: null, pola: {},
  adresFirmy: { zrodlo: 'plik', adres: null }, ekranAdresu: '/ustawienia/firma', typy: [],
  pobranie: { wlaczone: false }, adresApi: 'https://example.test/api',
  wybranyBrak: false, odlaczonyDoRestartu: false, adresWPliku: true, archiwumWPliku: true,
  admin: true, konsumenckie: false, automatStan: { wlaczony: false }, ...dane,
});
// Adres firmy w pliku konfiguracji, bez telefonu i e-maila nadawcy — ekran InPost podpowiada, czego brakuje.
const NADAWCA_BEZ_KONTAKTU = { DPD_NADAWCA_NAZWA: 'Pracownia Półcień', DPD_NADAWCA_ULICA: 'Zmyślona 1', DPD_NADAWCA_KOD: '00-950',
  DPD_NADAWCA_MIASTO: 'Warszawa' };

async function ekran(adres, env = {}) {
  const moduly = [modulRdzen, modulWeb, modulKanaly, createModulFaktury(), modulWiadomosci, createModulZamowienia({ zWiadomosciami: true }),
    createModulWysylka(), modulMagazyn, modulUstawienia, modulMarketing, modulZdrowie];
  const p = nowyPanel({ moduly, env });
  zalozKonto(p.db, { login: 'adam', imie: 'Adam', haslo: 'h', rola: 'administrator', admin: true });
  const r = await get(p.app, adres, jako(p.db, 'adam'));
  expect(r.statusCode, r.body).toBe(200);
  return r.body;
}

describe('PRZ-136.02 napisy integracji', () => {
  it('B10: InPost nie pokazuje nazwy zmiennej DPD, tylko „telefon nadawcy z ustawień firmy”', async () => {
    const html = await ekran('/ustawienia/integracje/inpost', NADAWCA_BEZ_KONTAKTU);
    expect(html).toContain('InPost wymaga telefonu i e-maila nadawcy');
    expect(html).toContain('Poproś administratora o uzupełnienie telefonu i e-maila w Ustawienia → Firma.');
    expect(html).not.toContain('telefon nadawcy z ustawień firmy');
    expect(html).not.toContain('DPD_NADAWCA_TELEFON');
    expect(html).not.toContain('DPD_NADAWCA_EMAIL');
  });

  it('wspólny powrót „← Moje połączenia” na InPost, inFakt i KSeF (źródło KSeF niżej)', async () => {
    for (const adres of ['/ustawienia/integracje/inpost', '/ustawienia/integracje/infakt']) {
      const html = await ekran(adres);
      expect(html, adres).toContain('<a href="/ustawienia/integracje">← Moje połączenia</a>');
      expect(html, adres).not.toContain('← Integracje<');
    }
  });

  it('U45: widok KSeF mówi „OMS”, nie „panel” (powrót też wspólny)', () => {
    const zrodlo = readFileSync(WIDOK_KSEF, 'utf8');
    expect(zrodlo).not.toMatch(/\bpanel/iu);
    expect(zrodlo).toContain('OMS nie pobiera faktur kosztowych, nawet z zapisanym tokenem');
    expect(zrodlo).toContain('Bez tokenu OMS nie pobiera faktur kosztowych z KSeF');
    expect(zrodlo).toContain('<a href="/ustawienia/integracje">← Moje połączenia</a>');
  });

  it('U46: każde pole (poza ukrytym) i każda wartość w widoku inFaktu ma etykietę <label for>; checkbox B2C nie jest rozciągnięty', async () => {
    const calosc = await ekran('/ustawienia/integracje/infakt');
    const html = calosc.slice(calosc.indexOf('<h1>inFakt</h1>')); // sama treść ekranu, bez wspólnego układu strony
    expect(html.length).toBeLessThan(calosc.length);
    const polaId = [...html.matchAll(/<(input|output)\b[^>]*>/gu)]
      .filter((m) => !/type="hidden"/u.test(m[0]))
      .map((m) => /\bid="([^"]+)"/u.exec(m[0])?.[1] ?? null);
    expect(polaId.length).toBeGreaterThanOrEqual(4);
    const etykiety = new Set([...html.matchAll(/<label\b[^>]*\bfor="([^"]+)"/gu)].map((m) => m[1]));
    for (const id of polaId) {
      expect(id, 'pole bez id').not.toBeNull();
      expect(etykiety.has(id), `pole #${id} bez <label for>`).toBe(true);
    }
    expect(html).not.toMatch(/<label>[^<]*<\/label>/u); // żadna etykieta bez `for`
    // Checkbox B2C w kontenerze o klasie z oms-design.css (width:auto), nie style inline.
    expect(html).toMatch(/<div class="aut-wybor"><input type="hidden" name="wlaczony" value="0"><input id="ksef-konsumenckie-wlaczone" type="checkbox"/u);
  });
});

describe('PRZ-136.12 powroty, pomoc administratora i etykiety', () => {
  it.each(['dpd', 'gus', 'poczta', 'reklamy'])('powrót z ekranu %s prowadzi do Moich połączeń', async (ekranId) => {
    const html = await ekran(`/ustawienia/integracje/${ekranId}`);
    expect(html).toContain('<a href="/ustawienia/integracje">← Moje połączenia</a>');
    expect(html).not.toContain('← Integracje');
  });

  it('powrót z aplikacji Allegro prowadzi do Moich połączeń', async () => {
    const html = await renderuj('kanaly/widoki/allegro-aplikacja', {
      krokiKreatora: [], blad: null, cel: '', srodowisko: 'sandbox', root: '/ustawienia/kanaly',
      stan: 'env', uaBlad: null, uaZapisano: false, naglowekUserAgent: '', userAgentZEnv: true,
    });
    expect(html).toContain('<a href="/ustawienia/integracje">← Moje połączenia</a>');
    expect(html).not.toContain('← Integracje');
  });

  it.each([false, true])('nazwy zmiennych są tylko w zwiniętej pomocy (zEnv=%s)', async (zEnv) => {
    for (const [widok, zmienne] of [
      ['wysylka/widoki/ustawienia-inpost', ['INPOST_URL']],
      ['faktury/widoki/ustawienia-infakt', ['INFAKT_API_URL', 'INFAKT_API_KEY', 'INFAKT_ARCHIWUM']],
    ]) {
      const html = await renderuj(widok, { zEnv });
      const pomoc = [...html.matchAll(/<details class="ust-pomoc">([\s\S]*?)<\/details>/gu)];
      expect(pomoc.length, widok).toBeGreaterThan(0);
      for (const m of pomoc) expect(m[1]).toContain('<summary>Dla administratora serwera</summary>');
      const glowny = html.replace(/<details\b[^>]*>[\s\S]*?<\/details>/gu, '');
      expect(glowny).not.toMatch(/INPOST_|INFAKT_|oms\.env|pliku konfiguracji/u);
      for (const zmienna of zmienne) expect(pomoc.map((m) => m[1]).join('')).toContain(zmienna);
    }
  });

  it.each(['dpd', 'inpost'])('każde pole i wyświetlana wartość %s ma powiązaną etykietę', async (kurier) => {
    const html = await renderuj(`wysylka/widoki/ustawienia-${kurier}`);
    const etykiety = new Set([...html.matchAll(/<label\b[^>]*\bfor="([^"]+)"/gu)].map((m) => m[1]));
    const pola = [...html.matchAll(/<(?:input|select|output)\b[^>]*>/gu)].filter((m) => !/type="hidden"/u.test(m[0]));
    expect(pola.length).toBeGreaterThan(0);
    for (const [pole] of pola) {
      const id = /\bid="([^"]+)"/u.exec(pole)?.[1];
      expect(etykiety.has(id) || /aria-label="[^"]+"/u.test(pole), pole).toBe(true);
    }
    expect(html).not.toMatch(/<label>[^<]*<\/label>/u);
  });

  it('PRZ-141.01 N7: wstęp o uprawnieniu KSeF ma klasę ust-wstep, a styl zdejmuje pogrubienie', () => {
    expect(readFileSync(WIDOK_KSEF, 'utf8')).toContain('<p id="ksef-uprawnienie" class="ust-wstep"><strong>');
    expect(readFileSync('src/public/oms-design.css', 'utf8')).toContain('.ust-sekcja .ust-wstep strong{font-weight:400}');
  });

  it('zdanie o uprawnieniu KSeF używa nazwy OMS', () => {
    expect(ZDANIE_UPRAWNIENIA_KSEF).toContain('OMS niczego przez KSeF nie wysyła');
  });
});

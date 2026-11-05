import { describe, it, expect, vi } from 'vitest';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { zapiszZamowienie } from '../../../src/oms/db/zamowienia.js';
import { zajmijWysylkeKsef } from '../../../src/moduly/faktury/db/wysylki-ksef.js';
import { POWOD_KOREKTA, POWOD_KOREKTA_CZEKA } from '../../../src/domena/wysylka-ksef.js';
import { zalozKonto } from '../../../src/core/bezpieczenstwo/konta.js';
import { jako, get } from '../../pomoc/konta-prz068.js';
import { buildOmsServer } from '../../pomoc/serwer-parytetu.ts';
import { programInfakt } from '../../../src/integracje/programy/infakt.ts';

async function karta(o = {}) {
  const db = openOmsDb(':memory:');
  const id = zapiszZamowienie(db, 'pro', {
    zrodlo_id: 'PC-1', numer: 'PC-1', kwota_brutto: '100.00', chce_fakture: 1, pozycje: [],
    klient: { first_name: 'Jan', company: 'Pracownia Półcień', email: 'jan@example.test' },
    dostawa: {}, metoda_wysylki: 'dpd', kwota_pobrania: null, nip: '1234563218',
    status_woo: null, oplacone_at: null, anulowane: 0, utworzone_at: '2026-10-20T08:00:00',
  }, {});
  db.prepare(`INSERT INTO faktury (zamowienie_id, infakt_uuid, numer, ksef_numer, utworzona_at)
    VALUES (?, 'f1', 'FV/1', ?, '2026-10-20T08:00:00Z')`).run(id, o.pierwotna === false ? null : 'KSEF-FV-1');
  db.prepare(`INSERT INTO zwroty (zamowienie_id, data, kwota, korekta_uuid, korekta_numer, korekta_zlecona_at, utworzony_at)
    VALUES (?, '2026-09-20', '10.00', ?, '1/KOR/11/2026', ?, '2026-09-20T08:00:00Z')`)
    .run(id, o.reczna ? null : 'k1', Object.hasOwn(o, 'zlecona') ? o.zlecona : '2026-10-31T23:30:00Z');
  if (o.rezerwacja) zajmijWysylkeKsef(db, 'k1', { numer: '1/KOR/11/2026', kiedy: '2026-11-02T10:00:00Z' });
  const pobierzKorekte = vi.fn(async () => {
    if (o.blad) throw new Error('Awaria atrapy');
    return { invoice_date: '2026-11-02', ksef_number: '', ...o.dokument };
  });
  const infakt = o.surowy ? { pobierzKorekte } : {
    opis: { ...programInfakt({}).opis, id: 'program-testowy', wbudowany: false, nazwa: { dopelniacz: 'Programu Półcień', miejscownik: 'Programie Półcień' },
      zdolnosci: o.bezWysylki ? ['odczytKorekty'] : ['odczytKorekty', 'wyslijDoKsef'] },
    przygotujNabywce: vi.fn(), pobierzKorekte,
  };
  const app = buildOmsServer({ db, infakt, wysylkaKsef: { korekty: !o.bezWysylki }, config: { auth: { user: 'operator', pass: 'test' } } });
  try {
    let r;
    if (o.produkcja) {
      zalozKonto(db, { login: 'administrator', imie: 'Administrator', haslo: 'h', rola: 'administrator', admin: true });
      zalozKonto(db, { login: 'produkcja', imie: 'Produkcja', haslo: 'h', rola: 'produkcja' });
      r = await get(app, `/zamowienia/${id}`, jako(db, 'produkcja'));
    } else {
      r = await app.inject({ method: 'GET', url: `/zamowienia/${id}`,
        headers: { authorization: 'Basic ' + Buffer.from('operator:test').toString('base64') } });
    }
    expect(r.statusCode).toBe(200);
    expect(r.body).not.toContain('Korekty wysyła się w inFakcie');
    const wiersz = r.body.match(/<tr>\s*<td>Korekta<\/td>[\s\S]*?<\/tr>/)?.[0];
    expect(wiersz).toBeTruthy();
    expect(pobierzKorekte).toHaveBeenCalledTimes(o.reczna || o.bezWysylki ? 0 : 1);
    if (!o.reczna && !o.bezWysylki) expect(pobierzKorekte).toHaveBeenCalledWith('k1');
    return { html: wiersz.replace(/\s+/g, ' '), id };
  } finally { await app.close(); db.close(); }
}

describe('PRZ-151.C04 korekta na karcie zamówienia', () => {
  it('surowy klient inFaktu bez opisu daje stan KSeF, PDF i formularz', async () => {
    const { html, id } = await karta({ surowy: true });
    expect(html).toContain('jeszcze nie wysłana do KSeF');
    expect(html).toContain('action="/faktury/ksef/podglad"');
    expect(html).toContain('name="uuid" value="k1"');
    expect(html).toContain(`name="powrot" value="/zamowienia/${id}"`);
    expect(html).toContain('Wyślij do KSeF');
    expect(html).toContain('href="/faktury/k1/pdf?rodzaj=korekta&amp;numer=1%2FKOR%2F11%2F2026"');
    expect(html).toContain('>PDF</a>');
  });
  it('inny numer faktury korygowanej blokuje użycie numeru KSeF faktury zamówienia', async () => {
    const { html } = await karta({ dokument: { corrected_invoice_number: 'FV/INNA' } });
    expect(html).toContain(POWOD_KOREKTA_CZEKA);
    expect(html).not.toContain('action="/faktury/ksef/podglad"');
    expect(html).not.toContain('Wyślij do KSeF');
  });
  it('zgodny numer faktury korygowanej pozwala użyć numeru KSeF faktury zamówienia', async () => {
    const { html } = await karta({ dokument: { corrected_invoice_number: 'FV/1' } });
    expect(html).not.toContain(POWOD_KOREKTA_CZEKA);
    expect(html).toContain('action="/faktury/ksef/podglad"');
    expect(html).toContain('Wyślij do KSeF');
  });
  it('numer KSeF korekty wygrywa także z rezerwacją', async () => {
    const { html } = await karta({ dokument: { ksef_number: '1/KOR/KSEF' }, rezerwacja: true });
    expect(html).toContain('<summary class="waga waga--ok" title="1/KOR/KSEF">KSeF przyjęty</summary>');
    expect(html).toContain('<input readonly class="ksef-numer" value="1/KOR/KSEF" size="40">');
    expect(html).not.toContain('Wyślij do KSeF');
  });
  it('rezerwacja blokuje kolejne wysłanie', async () => {
    const { html } = await karta({ rezerwacja: true });
    // PRZ-152.G15: plakietka „Zlecono do KSeF …” zamiast „zlecona z panelu…”; przycisku dalej nie ma.
    expect(html).toContain('Zlecono do KSeF ');
    // PRZ-152.G15 (kierownik 05.11): klasa plakietki stanu, nie `waga` (wersaliki).
    expect(html).toMatch(/<span class="znacznik znacznik--cichy">Zlecono do KSeF /);
    expect(html).not.toContain('Wyślij do KSeF');
  });
  it('pierwotna bez numeru KSeF blokuje korektę', async () => {
    const { html } = await karta({ pierwotna: false });
    expect(html).toContain(POWOD_KOREKTA_CZEKA);
    expect(html).not.toContain('Wyślij do KSeF');
  });
  it('pusty numer KSeF daje formularz z miesiącem korekty i PDF', async () => {
    const { html, id } = await karta();
    expect(html).toContain('jeszcze nie wysłana do KSeF');
    expect(html).toContain('action="/faktury/ksef/podglad"');
    for (const [nazwa, wartosc] of Object.entries({ uuid: 'k1', miesiac: '2026-11', pole: 'invoice_date', powrot: `/zamowienia/${id}` })) {
      expect(html).toContain(`name="${nazwa}" value="${wartosc}"`);
    }
    expect(html).toContain('Wyślij do KSeF');
    expect(html).toContain('href="/faktury/k1/pdf?rodzaj=korekta&amp;numer=1%2FKOR%2F11%2F2026"');
    expect(html).toContain('>PDF</a>');
  });
  it('bez invoice_date bierze warszawski dzień zlecenia, a nie datę zwrotu', async () => {
    expect((await karta({ dokument: { invoice_date: null } })).html).toContain('name="miesiac" value="2026-11"');
  });
  it('bez obu dat wyjaśnia brak przycisku', async () => {
    const { html } = await karta({ dokument: { invoice_date: null }, zlecona: null });
    expect(html).toContain('Panel nie zna daty wystawienia tej korekty — wyślij ją z zakładki Faktury.');
    expect(html).not.toContain('Wyślij do KSeF');
  });
  it('awaria odczytu nie zatrzymuje karty', async () => {
    const { html } = await karta({ blad: true });
    expect(html).toContain('Panel nie odczytał tej korekty z Programu Półcień — stan KSeF sprawdzisz w zakładce Faktury.');
    expect(html).not.toContain('Wyślij do KSeF');
  });
  it('program bez wysyłki pokazuje powód z domeny', async () => {
    const { html } = await karta({ bezWysylki: true });
    expect(html).toContain(POWOD_KOREKTA);
    expect(html).not.toContain('Wyślij do KSeF');
  });
  it('korekta ręczna ma puste komórki stanu i akcji', async () => {
    // PRZ-152.G10e: komórka akcji ma klasę kol-akcje (PDF do prawej), treść dalej pusta.
    expect((await karta({ reczna: true })).html).toMatch(/<td>\s*<\/td>\s*<td class="kol-akcje">\s*<\/td>/);
  });
  it('produkcja nie ma formularza ani PDF bez prawa do Faktur', async () => {
    const { html } = await karta({ produkcja: true });
    expect(html).not.toContain('action="/faktury/ksef/podglad"');
    expect(html).not.toContain('/faktury/k1/pdf');
  });
});

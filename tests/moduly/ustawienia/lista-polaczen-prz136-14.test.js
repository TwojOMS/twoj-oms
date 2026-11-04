// PRZ-136.14: poprawki listy „Moje połączenia”, katalogu i ekranu programu do faktur po audycie.
//  U13 — DPD, InPost, KSeF i GUS w piaskownicy liczą się jak atrapy (wiersz z linkiem do ich ekranu);
//  #8  — nazwa i stan poczty na liście = katalog = ekran poczty;
//  #11 — na liście dokładnie jeden <h1>;
//  #1  — logo reklam w katalogu bez leniwego ładowania (puste przy zrzucie całej strony);
//  #5  — „Wysyłam z Allegro → Konfiguruj” prowadzi do grupy kont Allegro, nie na górę tej samej listy;
//  #12 — „Fakturownia” i „wkrótce” rozdzielone odstępem (innerText bez sklejenia).
import { it, expect, vi, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import { createWidokIntegracji } from '../../../src/moduly/ustawienia/integracje.js';
import { KATALOG_INTEGRACJI } from '../../../src/domena/katalog-integracji.ts';
import { fmtKiedy } from '../../../src/domena/format-daty.js';
import { zalozKonto } from '../../../src/core/bezpieczenstwo/konta.js';
import { nowyPanel, jako, get } from '../../pomoc/konta-prz068.js';

const { renderFile } = createRequire(import.meta.url)('ejs');
// Tak jak modul.ts: kurierzy, KSeF i GUS bez flagi atrapy w usłudze; poczta i inFakt ją mają.
const NIEZAPISANE = [
  { id: 'dpd', skonfigurowana: false, atrapa: false, zrodlo: 'panel' },
  { id: 'inpost', skonfigurowana: false, atrapa: false, zrodlo: 'panel' },
  { id: 'ksef', skonfigurowana: false, atrapa: false, zrodlo: 'panel' },
  { id: 'gus', skonfigurowana: false, atrapa: false, zrodlo: 'panel' },
  { id: 'smtp', skonfigurowana: false, atrapa: true, zrodlo: 'panel' },
];

async function strona(url, { proba = true, integracje = NIEZAPISANE } = {}) {
  const { app, db } = nowyPanel();
  try {
    let dane;
    createWidokIntegracji({ db, proba, integracje: () => integracje })({ url, query: {} }, { view: (_n, d) => { dane = d; } });
    const html = await renderFile('src/moduly/ustawienia/widoki/ustawienia-polaczenia.ejs',
      { ...dane, fmtDataCzas: (d) => d, fmtKiedy: (d) => fmtKiedy(d, new Date()) });
    return { dane, html };
  } finally { await app.close(); db.close(); }
}
const wiersz = (html, usluga) => (html.match(/<li class="pol-wiersz[\s\S]*?<\/li>/g) ?? []).find((w) => w.includes(`data-usluga="${usluga}"`)) ?? '';
const karta = (html, usluga) => html.split('<article').find((a) => a.includes(`data-usluga="${usluga}"`)) ?? '';
const tekst = (html) => html.replace(/<[^>]+>/g, '');

it('U13: w piaskownicy DPD, InPost, KSeF i GUS mają wiersze z odnośnikiem do własnego ekranu', async () => {
  const { html } = await strona('/ustawienia/integracje');
  for (const [usluga, ekran] of [['dpd', '/ustawienia/integracje/dpd'], ['inpost', '/ustawienia/integracje/inpost'],
    ['ksef', '/ustawienia/integracje/ksef'], ['gus', '/ustawienia/integracje/gus']]) {
    const w = wiersz(html, usluga);
    expect(w, usluga).not.toBe('');
    expect(w, usluga).toContain(`href="${ekran}"`);
    expect(w, usluga).toContain('Niepodłączony');
  }
});

it('U13: poza piaskownicą niezapisane DPD, InPost, KSeF i GUS nie udają połączenia', async () => {
  const { html } = await strona('/ustawienia/integracje', { proba: false, integracje: NIEZAPISANE.slice(0, 4) });
  for (const usluga of ['dpd', 'inpost', 'ksef', 'gus']) expect(wiersz(html, usluga), usluga).toBe('');
});

it('#11: lista ma dokładnie jeden <h1> „Moje połączenia”', async () => {
  const { html } = await strona('/ustawienia/integracje');
  expect(html.match(/<h1[\s>]/g) ?? []).toHaveLength(1);
  expect(html).toMatch(/<h1>Moje połączenia<\/h1>/);
});

it('#8: poczta ma tę samą nazwę w wierszu, w katalogu i w <h1> ekranu oraz stan jak ekran („Nieustawiona”)', async () => {
  const { html } = await strona('/ustawienia/integracje');
  const smtp = KATALOG_INTEGRACJI.find((u) => u.id === 'smtp');
  expect(smtp.nazwa).toBe('Poczta wychodząca'); // = title/h1 ekranu, trasy/poczta.js
  const w = wiersz(html, 'smtp');
  expect(w).toContain(`>${smtp.nazwa}</a>`);
  expect(w).toContain('Nieustawiona');
  expect(w).not.toContain('Dane przykładowe');
});

it('#1 i #5: katalog — logo reklam bez leniwego ładowania, „Wysyłam z Allegro” prowadzi do grupy kont Allegro', async () => {
  const { html } = await strona('/ustawienia/integracje/katalog');
  for (const usluga of ['meta', 'ga4', 'google_ads']) {
    const k = karta(html, usluga);
    expect(k, usluga).toMatch(/<img src="\/public\/integracje\/[^"]+"/);
    expect(k, usluga).not.toContain('loading="lazy"');
  }
  expect(karta(html, 'wza')).toMatch(/<a class="btn btn--drugi btn--maly" href="\/ustawienia\/integracje#grupa-sprzedaz">Konfiguruj<\/a>/);
});

it('PRZ-136.17: integracja ustawiana na serwerze ma znacznik „Ustawia administrator serwera”, nie „Przez konfigurację”', async () => {
  const { html } = await strona('/ustawienia/integracje/katalog');
  for (const usluga of ['meta', 'ga4']) {
    expect(karta(html, usluga), usluga).toContain('<span class="ust-znacznik">Ustawia administrator serwera</span>');
  }
  expect(html).not.toContain('Przez konfigurację');
});

afterEach(() => { vi.unstubAllGlobals(); });
it('#12: na ekranie programu do faktur „Fakturownia” nie skleja się z „wkrótce”', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })));
  const { app, db } = nowyPanel();
  try {
    zalozKonto(db, { login: 'ola', imie: 'Ola', haslo: 'h', rola: 'administrator', admin: true });
    const r = await get(app, '/ustawienia/integracje/program-fakturowy', jako(db, 'ola'));
    expect(r.statusCode).toBe(200);
    const t = tekst(r.body);
    expect(t).toContain('Fakturownia');
    expect(t).not.toMatch(/Fakturowniawkrótce|TwojeFakturywkrótce/);
  } finally { await app.close(); db.close(); }
});

import { it, expect } from 'vitest';
import { createRequire } from 'node:module';
import { nowyPanel, BASIC, get } from '../../pomoc/konta-prz068.js';
import { createWidokIntegracji } from '../../../src/moduly/ustawienia/integracje.js';
import { polaczeniaIntegracji } from '../../../src/moduly/ustawienia/services/polaczenia-integracji.ts';
import { zapiszPolaczenie, zapiszStan } from '../../../src/oms/db/reklamy.js';

const { renderFile } = createRequire(import.meta.url)('ejs');
const integracje = ['dpd', 'inpost', 'infakt', 'ksef', 'gus', 'smtp'].map(id =>
  ({ id, skonfigurowana: false, atrapa: true, zrodlo: 'panel' }));
async function lista(url) {
  const { app, db } = nowyPanel();
  try {
    let model;
    createWidokIntegracji({ db, proba: true, integracje: () => [...integracje,
      { id: 'ga4', skonfigurowana: true, zrodlo: 'serwer' }] })(
      { url, query: {} }, { view: (_n, dane) => { model = dane; } });
    return await renderFile('src/moduly/ustawienia/widoki/ustawienia-polaczenia.ejs',
      { ...model, fmtKiedy: () => '', fmtDataCzas: d => d });
  } finally { await app.close(); db.close(); }
}

it('N1: licznik listy liczy tylko podłączone połączenia i ich dane przykładowe', async () => {
  const html = await lista('/ustawienia/integracje');
  const licznik = html.match(/aria-label="Podsumowanie połączeń"[\s\S]*?<\/p>/)?.[0];
  expect(licznik).toMatch(/<strong>1<\/strong> połączenie/);
  expect(licznik).toMatch(/<strong>1<\/strong> na danych przykładowych/);
  expect(html).toContain('Niepodłączony');
  expect(html).toContain('Nieustawiona');
});

it('N2: katalog nie liczy niepodłączonych usług, zachowuje liczbę podłączonych', async () => {
  const html = await lista('/ustawienia/integracje/katalog');
  for (const id of ['dpd', 'inpost', 'ksef', 'gus', 'smtp', 'infakt', 'ga4']) {
    const karta = html.match(new RegExp(`<article[^>]*data-usluga="${id}"[\\s\\S]*?</article>`))?.[0];
    expect(karta).toBeTruthy();
    if (id === 'ga4') expect(karta).toContain('Połączenia: 1');
    else expect(karta).not.toContain('Połączenia:');
  }
});

it.each(['ga4', 'meta'])('N3: %s na Reklamach ma neutralną etykietę z usługi listy', async typ => {
  const { app, db } = nowyPanel({ env: { OMS_TRYB: 'proba' } });
  try {
    const p = zapiszPolaczenie(db, { typ, kontoId: `konto-test-${typ}` });
    zapiszStan(db, { polaczenieId: p.id, ostatniaProbaAt: '2026-11-04T10:00:00Z', ostatniSukcesAt: '2026-11-04T10:00:00Z' });
    const stan = polaczeniaIntegracji({ db, proba: true }).find(w => w.id === `reklamy:${p.id}`);
    expect(stan.etykietaStanu).toBe('Dane przykładowe');
    const r = await get(app, `/kampania?widok=${typ === 'ga4' ? 'google' : 'meta'}`, BASIC);
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain(`<span class="reklamy-stan">${stan.etykietaStanu}</span>`);
    expect(r.body).not.toContain('<span class="reklamy-stan">Działa</span>');
    const podsumowanie = await get(app, '/kampania', BASIC);
    expect(podsumowanie.body).toContain(`<strong>${stan.etykietaStanu}</strong>`);
  } finally { await app.close(); db.close(); }
});

it.each([
  [{ OMS_TRYB: 'proba', OMS_PROGRAM_FAKTUROWY: 'infakt' }, 'Niepodłączony'],
  [{ INFAKT_API_KEY: 'fikcyjny-klucz-testowy' }, 'Niesprawdzone'],
  [{ OMS_PROGRAM_FAKTUROWY: 'infakt' }, 'Niepodłączony'],
])('N4: dopisek inFaktu odpowiada liście (%j)', async (env, etykieta) => {
  const { app, db } = nowyPanel({ env });
  try {
    const r = await get(app, '/ustawienia/integracje/program-fakturowy', BASIC);
    expect(r.statusCode).toBe(200);
    const sekcja = r.body.match(/id="modul-faktur-stan"[\s\S]*?<\/section>/)?.[0];
    expect(sekcja).toContain(`inFakt — ${etykieta}`);
    if (etykieta === 'Niepodłączony') expect(sekcja).not.toContain('bo jest podłączony');
  } finally { await app.close(); db.close(); }
});

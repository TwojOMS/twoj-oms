import { it, expect, vi } from 'vitest';
import { tmpdir } from 'node:os';
import { zbudujOms } from '../../../src/oms/bootstrap.ts';
import { zalozKonto, ustawUprawnienia } from '../../../src/core/bezpieczenstwo/konta.js';
import * as miesieczne from '../../../src/oms/db/dane-miesieczne.js';
import { bladOperatora } from '../../../src/domena/bledy.js';
import { dzienWarszawa } from '../../../src/domena/format-daty.js';

const env = { OMS_USER: 'operator', OMS_PASS: 'fixture', OMS_PROFORMY_KATALOG: tmpdir(), OMS_ETYKIETY_KATALOG: tmpdir() };
const headers = { authorization: `Basic ${Buffer.from('operator:fixture').toString('base64')}`, origin: 'http://localhost' };
const zlyMiesiac = 'Niepoprawny miesiąc: oczekiwane RRRR-MM (np. 2026-06).';
const zlaData = 'Niepoprawna data: parametry od i do muszą być istniejącymi dniami w formacie RRRR-MM-DD.';
const zlyZakres = 'Niepoprawny zakres: parametr od nie może być późniejszy niż do.';
const biezacy = () => dzienWarszawa(new Date().toISOString()).slice(0, 7);

function ekran(odp: any, kod: number, zdanie: string) {
  expect(odp.statusCode).toBe(kod);
  expect(odp.headers['content-type']).toContain('text/html');
  expect(odp.body).toContain('aria-label="Analizy i finanse"');
  expect(odp.body).toContain(zdanie);
}

it.each([
  ['/finanse?miesiac=2026-13', 'GET', zlyMiesiac, '/finanse'],
  ['/finanse?od=2026-02-30&do=2026-03-31', 'GET', zlaData, '/finanse'],
  ['/finanse?od=2026-09-10&do=2026-09-01', 'GET', zlyZakres, '/finanse'],
  ['/finanse?skrot=zly', 'GET', 'Nieznany skrót okresu: zly.', '/finanse'],
  ['/finanse/dane/zly', 'GET', 'Niepoprawny miesiąc w adresie (oczekiwane RRRR-MM).', 'dane'],
  ['/finanse/dane', 'POST', 'Niepoprawny miesiąc (oczekiwane RRRR-MM).', 'dane'],
  ['/raporty/eksport.csv?od=2026-09-10&do=2026-09-01', 'GET', zlyZakres, '/raporty'],
  ['/raporty?od=2026-09-10&do=2026-09-01', 'GET', zlyZakres, '/raporty'],
])('%s: odmowa zachowuje menu i drogę powrotu', async (url, method, zdanie, powrot) => {
  const z = await zbudujOms({ env });
  try {
    const odp = await z.app.inject({ url, method: method as 'GET' | 'POST', headers, ...(method === 'POST' ? { payload: { miesiac: 'zly' } } : {}) });
    ekran(odp, 400, zdanie);
    expect(odp.body).toContain(`href="${powrot === 'dane' ? '/finanse/dane/' + biezacy() : powrot}">Wróć`);
    if (zdanie.includes('parametr')) expect(odp.body).toContain('Wybierz ponownie daty początku i końca okresu.');
  } finally { await z.app.close(); z.db.close(); }
});

it('nieadministrator: odmowa zapisu kompletności to ekran panelu z kodem 403', async () => {
  const z = await zbudujOms({ env });
  try {
    const id = zalozKonto(z.db, { login: 'sprzedawca', imie: 'Operator', haslo: 'fixture', rola: 'sprzedaz' });
    ustawUprawnienia(z.db, id, ['finanse']);
    const login = await z.app.inject({ method: 'POST', url: '/login', headers: { origin: 'http://localhost' }, payload: { uzytkownik: 'sprzedawca', haslo: 'fixture' } });
    const odp = await z.app.inject({ method: 'POST', url: '/finanse/pokrycie', headers: { origin: 'http://localhost', cookie: String(login.headers['set-cookie']).split(';')[0] }, payload: { klucz: 'podlogaKosztow', wartosc: '2026-01' } });
    ekran(odp, 403, 'Daty kompletności danych zapisuje administrator. Poproś go o ustawienie.');
    expect(odp.body).toContain('href="/finanse">Wróć');
    expect(z.db.prepare("SELECT COUNT(*) AS n FROM ustawienia WHERE klucz LIKE 'raporty.%'").get()?.n).toBe(0);
  } finally { await z.app.close(); z.db.close(); }
});

it('odmowa zapisu miesiąca zachowuje wszystkie wpisy w formularzu i nie zapisuje ich w bazie', async () => {
  const z = await zbudujOms({ env });
  // Dla poprawnego miesiąca obecny zapis nie odmawia kwot. Wymuszamy błąd operatora na granicy zapisu,
  // aby przetestować istniejącą gałąź catch bez zmiany walidacji ani db.
  const zapis = vi.spyOn(miesieczne, 'zapiszDaneMiesiaca').mockImplementationOnce(() => { throw bladOperatora('Nie można zapisać danych miesiąca.'); });
  const payload = { miesiac: '2026-09', zusSpoleczne: '1 234,50', zusZdrowotna: '432.10', zusFunduszPracy: '', zusRazem: '1666,60', pit5: '123', vat7: '789.00', kpirPrzychod: '12345', kpirKoszty: '5432', zwroty: '20', uwagi: 'Sprawdź <wpis> & kwoty' };
  try {
    const odp = await z.app.inject({ method: 'POST', url: '/finanse/dane', headers, payload });
    ekran(odp, 400, 'Nie można zapisać danych miesiąca.');
    expect(odp.body).toContain('action="/finanse/dane"');
    for (const [pole, wartosc] of Object.entries(payload)) {
      if (pole !== 'uwagi') expect(odp.body, pole).toContain(`name="${pole}" value="${wartosc}"`);
    }
    expect(odp.body).toContain('Sprawdź &lt;wpis&gt; &amp; kwoty</textarea>');
    expect(miesieczne.daneMiesiaca(z.db, payload.miesiac)).toBeNull();
  } finally { zapis.mockRestore(); await z.app.close(); z.db.close(); }
});

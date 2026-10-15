import { describe, it, expect, beforeEach } from 'vitest';
import { openOmsDb } from '../../pomoc/dane-miesieczne-parytetu.js';
import { buildOmsServer } from '../../pomoc/serwer-parytetu.ts';
import { daneMiesiaca } from '../../../src/oms/db/dane-miesieczne.js';

const naglowek = { authorization: 'Basic ' + Buffer.from('adam:x').toString('base64') };
const config = { auth: { user: 'adam', pass: 'x' }, klienciZbiorczy: [] };
let db;
beforeEach(() => { db = openOmsDb(':memory:'); });

const zapisz = async (payload) => {
  const app = buildOmsServer({ db, config });
  // ⚠️ ORIGIN BEZ PORTU. `app.inject()` domyslnie ustawia naglowek Host na `localhost:80`,
  // a ochrona CSRF (security/csrf.js) sciera z niego wylacznie porty 80/443 — Origin
  // z INNYM portem (np. ':3001') nie zgadza sie z Host-em i dostaje odmowe 403 zamiast
  // przejsc dalej do trasy. Ta sama konwencja, co we WSZYSTKICH innych testach POST w tym
  // katalogu (`origin: 'http://localhost'`).
  const odp = await app.inject({
    method: 'POST', url: '/finanse/dane', payload,
    headers: { ...naglowek, origin: 'http://localhost' },
  });
  await app.close();
  return odp;
};

describe('ekran danych recznych', () => {
  it('zapisuje skladki i wraca na ten sam miesiac', async () => {
    const odp = await zapisz({
      miesiac: '2026-07', zusSpoleczne: '1788.29', zusZdrowotna: '500.00',
      zusFunduszPracy: '138.47', zusRazem: '2426.76', pit5: '300.00', vat7: '1200.00',
    });
    expect(odp.statusCode).toBe(302);
    expect(odp.headers.location).toContain('2026-07');
    expect(daneMiesiaca(db, '2026-07').zus_razem).toBe('2426.76');
  });

  it('PUSTE POLE ZAPISUJE SIE JAKO BRAK, a nie jako zero', async () => {
    await zapisz({ miesiac: '2026-07', zusRazem: '2426.76', pit5: '' });
    expect(daneMiesiaca(db, '2026-07').pit5_zaplacony).toBeNull();
  });

  it('ZLY MIESIAC ODMAWIA, zamiast zakladac wiersz o bezsensownym kluczu', async () => {
    const odp = await zapisz({ miesiac: 'lipiec', zusRazem: '100.00' });
    expect(odp.statusCode).toBe(400);
  });

  it('ekran pokazuje ROZJAZD skladnikow i przelewu', async () => {
    await zapisz({
      miesiac: '2026-01', zusSpoleczne: '1432.08', zusZdrowotna: '314.96',
      zusFunduszPracy: '127.49', zusRazem: '2088.92',
    });
    const app = buildOmsServer({ db, config });
    const odp = await app.inject({ method: 'GET', url: '/finanse/dane/2026-01', headers: naglowek });
    await app.close();
    expect(odp.body).toContain('214,39');
  });
});

// ——— PASEK MIESIECY (przebudowa 17.08.2026) ————————————————————————————————————————
// Brak wpisu za JEDEN miesiac wylacza „zostaje" w calym rachunku zarzadczym, a do tego dnia
// nie bylo jak zobaczyc, ktorego miesiaca brakuje — trzeba bylo wchodzic w kazdy po kolei.
describe('pasek miesiecy roku', () => {
  const wejdz = async (url) => {
    const app = buildOmsServer({ db, config });
    const odp = await app.inject({ method: 'GET', url, headers: naglowek });
    await app.close();
    return odp;
  };
  // Sama tresc, bez arkusza stylow — ten niesie nazwy klas i test mierzylby CSS.
  const tresc = (odp) => odp.body.slice(odp.body.indexOf('<div class="tresc">'));

  it('miesiac Z DANYMI i miesiac BEZ danych roznia sie na pasku', async () => {
    // Migracja startowa wgrywa 2026-01…2026-06; lipca i sierpnia nikt jeszcze nie wpisal.
    const t = tresc(await wejdz('/finanse/dane/2026-07'));
    expect(t).toMatch(/miesiac-chip--ok[^>]*>[^<]*sty/);
    expect(t).toMatch(/miesiac-chip--brak[^>]*>[^<]*lip/);
  });

  it('chip miniony prowadzi WPROST do swojego miesiaca', async () => {
    const t = tresc(await wejdz('/finanse/dane/2026-07'));
    expect(t).toContain('href="/finanse/dane/2026-03"');
    expect(t).toContain('href="/finanse/dane/2026-07"');
  });

  // ⚠️⚠️ TRZY STANY, NIE DWA. Miesiac z PRZYSZLOSCI nie jest zalegly — skladki za grudzien
  // nie da sie wpisac w sierpniu, wiec barwa ostrzegawcza przy nim uczylaby operatora
  // ignorowac ostrzezenia. Przyszly chip jest wygaszony i NIE JEST odnosnikiem: klikniecie
  // prowadzilo by do pustego formularza, ktorego i tak nie ma czym wypelnic.
  it('miesiac PRZYSZLY nie jest ani zalegly, ani klikalny', async () => {
    const t = tresc(await wejdz('/finanse/dane/2026-07'));
    expect(t).toContain('miesiac-chip--przyszly');
    expect(t).not.toContain('href="/finanse/dane/2026-12"');
    expect(t).not.toMatch(/miesiac-chip--brak[^>]*>[^<]*gru/);
  });

  it('oglądany miesiac jest oznaczony', async () => {
    const t = tresc(await wejdz('/finanse/dane/2026-04'));
    expect(t).toMatch(/miesiac-chip--aktywny/);
  });

  it('strzalki prowadza do poprzedniego i nastepnego miesiaca, TAKZE przez granice roku', async () => {
    const styczen = tresc(await wejdz('/finanse/dane/2026-01'));
    expect(styczen).toContain('href="/finanse/dane/2025-12"');
    expect(styczen).toContain('href="/finanse/dane/2026-02"');
    const grudzien = tresc(await wejdz('/finanse/dane/2026-12'));
    expect(grudzien).toContain('href="/finanse/dane/2027-01"');
  });

  it('pasek pokazuje rok OGLADANEGO miesiaca, nie biezacy', async () => {
    const t = tresc(await wejdz('/finanse/dane/2025-03'));
    expect(t).toContain('href="/finanse/dane/2025-11"');
    expect(t).not.toContain('href="/finanse/dane/2026-11"');
  });
});

import { expect, it, vi } from 'vitest';
import { openOmsDb } from '../../../src/oms/db/db.ts';
import { buildOmsServer } from '../../pomoc/serwer-parytetu.ts';

const auth = { authorization: `Basic ${Buffer.from('adam:x').toString('base64')}` };

it('ekran podjazdu pokazuje adres i przekazuje do serwisu tylko zaznaczone ID', async () => {
  const db = openOmsDb();
  db.prepare(`INSERT INTO zamowienia (sklep,zrodlo_id,numer,utworzone_at,kwota_brutto)
    VALUES ('allegro_szkicownia',1,'A1','2026-09-22T08:00:00Z','0')`).run();
  const zid = db.prepare('SELECT id FROM zamowienia').get().id;
  db.prepare(`INSERT INTO przesylki (zamowienie_id,kurier,status,numer_listu,utworzona_at)
    VALUES (?,'allegro_wza','nadana','AD-1','2026-09-22T08:00:00Z')`).run(zid);
  const pid = db.prepare('SELECT id FROM przesylki').get().id;
  db.prepare('UPDATE przesylki SET id_przesylki_kuriera=?, etykieta_sciezka=? WHERE id=?')
    .run('shipment-1', '/tmp/etykieta.pdf', pid);
  const podjazdy = { przygotuj: vi.fn(async () => ({ id: 'preview', data: '2026-09-23',
    adres: { name: 'Firma', street: 'Polna 1', postalCode: '32-600', city: 'Oświęcim', countryCode: 'PL', email: 'f@example.com', phone: '500600700' },
    grupy: [], wygasaAt: '2026-09-23T12:00:00Z' })) };
  const app = buildOmsServer({ db, config: { auth: { user: 'adam', pass: 'x' },
    nadawca: { nazwa: 'Firma', ulica: 'Polna 1', kod: '32-600', miasto: 'Oświęcim', kraj: 'PL', email: 'f@example.com', phone: '500600700' } }, podjazdy });
  const lista = await app.inject({ method: 'GET', url: '/przesylki?pokaz=utworzone', headers: auth });
  expect(lista.statusCode).toBe(200);
  expect(lista.body).toContain(`name="ids" value="${pid}" form="podjazdy-wybor"`);
  expect(lista.body).toContain('Zaznacz wszystkie widoczne');
  const ekran = await app.inject({ method: 'GET', url: `/przesylki/podjazdy?ids=${pid}`, headers: auth });
  expect(ekran.statusCode).toBe(200);
  expect(ekran.body).toContain('Polna 1');
  const podglad = await app.inject({ method: 'POST', url: '/przesylki/podjazdy/podglad',
    headers: { ...auth, origin: 'http://localhost' },
    payload: { ids: String(pid), data: '2026-09-23', name: 'Firma', street: 'Polna 1',
      postalCode: '32-600', city: 'Oświęcim', countryCode: 'PL', email: 'f@example.com', phone: '500600700' } });
  expect(podglad.statusCode).toBe(200);
  expect(podjazdy.przygotuj).toHaveBeenCalledWith(expect.objectContaining({ ids: [pid] }));
});

it('podgląd ma osobny formularz tylko dla potwierdzonego kuriera, bez mieszania grup', async () => {
  const db = openOmsDb();
  const adres = { name: 'Firma', street: 'Polna 1', postalCode: '32-600', city: 'Pęki',
    countryCode: 'PL', email: 'f@example.com', phone: '500600700' };
  const podjazdy = { przygotuj: vi.fn(async () => ({ id: 'podglad-1', data: '2026-09-23', adres,
    wygasaAt: '2026-09-23T12:00:00Z', grupy: [
      { id: 'dpd', kanal: 'allegro_szkicownia', etykieta: 'Allegro Kurier DPD',
        kurierOdbierajacy: 'DPD', moznaZlecac: true,
        przesylki: [{ numerListu: 'AD-1' }],
        terminy: [{ date: '2026-09-23', minTime: '13:00', maxTime: '17:00' }] },
      { id: 'one', kanal: 'allegro_amarka', etykieta: 'Allegro One Kurier',
        kurierOdbierajacy: null, moznaZlecac: false,
        przesylki: [{ numerListu: 'AO-1' }],
        terminy: [{ date: '2026-09-23', minTime: '13:00', maxTime: '17:00' }] },
    ] })) };
  const app = buildOmsServer({ db, config: { auth: { user: 'adam', pass: 'x' },
    nadawca: { nazwa: 'Firma', ulica: 'Polna 1', kod: '32-600', miasto: 'Pęki', kraj: 'PL',
      email: 'f@example.com', phone: '500600700' } }, podjazdy });
  const response = await app.inject({ method: 'POST', url: '/przesylki/podjazdy/podglad',
    headers: { ...auth, origin: 'http://localhost' }, payload: { ids: '1', data: '2026-09-23', ...adres } });
  expect(response.statusCode).toBe(200);
  expect(response.body).toContain('Allegro Kurier DPD');
  expect(response.body).toContain('Allegro One Kurier');
  expect(response.body).toContain('Przesyłki odbierze: <strong>DPD</strong>');
  expect(response.body.match(/action="\/przesylki\/podjazdy\/zlec"/g)).toHaveLength(1);
  expect(response.body).toContain('OMS jeszcze nie zamawia podjazdu dla tej usługi — zamów go w Allegro, w „Wysyłam z Allegro”.');
  expect(response.body).not.toContain('wstrzymane do potwierdzenia przewoźnika');
  await app.close();
});

it('po zleceniu jednej grupy wraca do podglądu z wynikiem i pozostałym formularzem', async () => {
  const db = openOmsDb();
  const adres = { name: 'Firma', street: 'Polna 1', postalCode: '32-600', city: 'Pęki',
    countryCode: 'PL', email: 'f@example.com', phone: '500600700' };
  const pozostala = { id: 'one', kanal: 'allegro_szkicownia', etykieta: 'Allegro One Kurier',
    kurierOdbierajacy: 'ALLEGRO_ONE_KURIER', moznaZlecac: true,
    przesylki: [{ numerListu: 'AO-2' }],
    terminy: [{ date: '2026-09-23', minTime: '13:00', maxTime: '17:00' }] };
  const podjazdy = {
    zlec: vi.fn(async () => ({ id: 7, podglad_id: 'podglad-1' })),
    pobierzPodglad: vi.fn(() => ({ id: 'podglad-1', data: '2026-09-23', adres,
      wygasaAt: '2026-09-23T12:00:00Z', wygasl: false,
      grupy: [{ ...pozostala, id: 'dpd', etykieta: 'Allegro Kurier DPD',
        wynik: { id: 7, stan: 'oczekuje' }, moznaZlecac: false },
      { ...pozostala, wynik: null }] })),
  };
  const app = buildOmsServer({ db, config: { auth: { user: 'adam', pass: 'x' } }, podjazdy });
  const zlec = await app.inject({ method: 'POST', url: '/przesylki/podjazdy/zlec',
    headers: { ...auth, origin: 'http://localhost' },
    payload: { podgladId: 'podglad-1', grupaId: 'dpd',
      termin: JSON.stringify({ date: '2026-09-23', minTime: '13:00', maxTime: '17:00' }) } });
  expect(zlec.statusCode).toBe(302);
  expect(zlec.headers.location).toBe('/przesylki/podjazdy/podglad/podglad-1');
  const ekran = await app.inject({ method: 'GET', url: zlec.headers.location, headers: auth });
  expect(ekran.statusCode).toBe(200);
  expect(ekran.body).toContain('Allegro Kurier DPD');
  expect(ekran.body).toContain('Podjazd: oczekuje');
  expect(ekran.body).toContain('Allegro One Kurier');
  expect(ekran.body.match(/action="\/przesylki\/podjazdy\/zlec"/g)).toHaveLength(1);
  await app.close();
});

it('historia pokazuje także stare aktywne i odrzucone podjazdy poza 60 dniami listy', async () => {
  const db = openOmsDb();
  const z = db.prepare(`INSERT INTO zamowienia (sklep,zrodlo_id,numer,utworzone_at,kwota_brutto)
    VALUES ('allegro_szkicownia',1,'A1','2026-01-01T08:00:00Z','0')`).run();
  db.prepare('UPDATE zamowienia SET metoda_wysylki_nazwa=? WHERE id=?')
    .run('Allegro Kurier DPD', Number(z.lastInsertRowid));
  const p = db.prepare(`INSERT INTO przesylki
    (zamowienie_id,kurier,status,numer_listu,utworzona_at)
    VALUES (?,'allegro_wza','nadana','AD-STARY','2026-01-01T08:00:00Z')`).run(Number(z.lastInsertRowid));
  const pid = Number(p.lastInsertRowid);
  for (const [nr, stan, aktywna] of [[1, 'potwierdzony', 1], [2, 'odrzucony', 0]]) {
    db.prepare('INSERT INTO podjazdy_podglady (id,snapshot_json,wygasa_at,utworzony_at) VALUES (?,?,?,?)')
      .run(`preview-${nr}`, '{}', '2026-01-01T10:00:00Z', '2026-01-01T08:00:00Z');
    const info = db.prepare(`INSERT INTO podjazdy
      (podglad_id,grupa_id,command_id,kanal,przewoznik,adres_json,termin_json,stan,pickup_id,utworzony_at)
      VALUES (?,? ,?,'allegro_szkicownia','DPD','{}',?, ?,?,'2026-01-01T08:00:00Z')`)
      .run(`preview-${nr}`, 'dpd', `command-${nr}`,
        JSON.stringify({ date: '2026-01-02', minTime: '13:00', maxTime: '17:00' }), stan,
        nr === 1 ? 'pickup-1' : null);
    db.prepare(`INSERT INTO podjazdy_przesylki
      (podjazd_id,przesylka_id,shipment_id,numer_listu,aktywna_rezerwacja)
      VALUES (?,?,?,?,?)`).run(Number(info.lastInsertRowid), pid, 'shipment-1', 'AD-STARY', aktywna);
  }
  const app = buildOmsServer({ db, config: { auth: { user: 'adam', pass: 'x' } } });
  const lista = await app.inject({ method: 'GET', url: '/przesylki?pokaz=utworzone', headers: auth });
  expect(lista.body).toContain('/przesylki/podjazdy/historia');
  const historia = await app.inject({ method: 'GET', url: '/przesylki/podjazdy/historia', headers: auth });
  expect(historia.statusCode).toBe(200);
  expect(historia.body).toContain('command-1');
  expect(historia.body).toContain('Allegro Kurier DPD');
  expect(historia.body).not.toContain('>DPD</td>');
  expect(historia.body).toContain('pickup-1');
  expect(historia.body).toContain('command-2');
  expect(historia.body).toContain('odrzucony');
  await app.close();
});

it.each([
  ['paczka-bez-terminu', 'Allegro nie podało terminu dla części paczek'],
  ['niezgodny-adres', 'Adres lub kontakt w propozycjach Allegro różni się'],
  ['niezgodny-zestaw', 'Odpowiedź Allegro nie potwierdza dokładnego zestawu paczek'],
  ['rozdzielone', 'To starszy podgląd. Wybierz paczki ponownie'],
])('brak terminu pokazuje diagnozę %s i terminy każdej paczki', async (przyczyna, komunikat) => {
  const db = openOmsDb();
  const adres = { name: 'Firma', street: 'Polna 1', postalCode: '32-600', city: 'Pęki',
    countryCode: 'PL', email: 'f@example.com', phone: '500600700' };
  const okno = { date: '2026-09-30', minTime: '10:00', maxTime: '14:00' };
  const podjazdy = { przygotuj: vi.fn(async () => ({ id: 'podglad-d', data: '2026-09-30', adres,
    wygasaAt: '2026-09-30T12:00:00Z', grupy: [
      { id: 'dpd', kanal: 'allegro_szkicownia', etykieta: 'Allegro Kurier DPD',
        kurierOdbierajacy: 'DPD', moznaZlecac: true,
        przesylki: [{ numerListu: 'AD-1' }, { numerListu: 'AD-2' }], terminy: [],
        diagnoza: { przyczyna, grupAllegro: 2, paczki: [
          { shipmentId: 's1', numerListu: 'AD-1', grupaAllegro: 1, terminy: [okno] },
          { shipmentId: 's2', numerListu: 'AD-2', grupaAllegro: 2, terminy: [] },
        ] } },
    ] })) };
  const app = buildOmsServer({ db, config: { auth: { user: 'adam', pass: 'x' },
    nadawca: { nazwa: 'Firma', ulica: 'Polna 1', kod: '32-600', miasto: 'Pęki', kraj: 'PL',
      email: 'f@example.com', phone: '500600700' } }, podjazdy });
  const response = await app.inject({ method: 'POST', url: '/przesylki/podjazdy/podglad',
    headers: { ...auth, origin: 'http://localhost' }, payload: { ids: '1', data: '2026-09-30', ...adres } });
  expect(response.statusCode).toBe(200);
  expect(response.body).toContain(komunikat);
  expect(response.body).not.toContain('OMS nie skleja takich grup');
  expect(response.body).toMatch(/AD-1<\/strong> · element odpowiedzi Allegro 1: 2026-09-30 10:00–14:00/);
  expect(response.body).toMatch(/AD-2<\/strong> · element odpowiedzi Allegro 2: brak terminu/);
  expect(response.body).not.toContain('name="termin"');
  await app.close();
});

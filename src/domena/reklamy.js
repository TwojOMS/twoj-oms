// Czyste liczenie bieżących reklam. Kwoty pozostają w 1/10000 waluty aż do formatowania;
// przychód przypisany przez GA4 i potwierdzony w OMS nigdy nie są dodawane do siebie.

const grosze = (wartosc) => {
  const match = /^(-?)(\d+)(?:\.(\d{1,4}))?$/.exec(String(wartosc ?? ''));
  if (!match) throw new Error('Niepoprawna kwota w raporcie reklam');
  const [, znak, cale, ulamek = ''] = match;
  const wynik = BigInt(cale) * 10000n + BigInt(ulamek.padEnd(4, '0'));
  return znak === '-' ? -wynik : wynik;
};

const kwota = (value) => {
  const dodatnia = value < 0n ? -value : value;
  const zaokragloneGrosze = (dodatnia + 50n) / 100n;
  return `${value < 0n ? '-' : ''}${zaokragloneGrosze / 100n}.${String(zaokragloneGrosze % 100n).padStart(2, '0')}`;
};

const liczba = (value) => {
  const n = Number(value ?? 0);
  if (!Number.isSafeInteger(n) || n < 0) throw new Error('Niepoprawna liczba w raporcie reklam');
  return n;
};

const wOkresie = (row, od, doDnia) => !row.dzien || (row.dzien >= od && row.dzien <= doDnia);
const stanZrodla = (stan, maDane) => (typeof stan === 'string' ? stan : stan?.stan) ?? (maDane ? 'działa' : 'niepodłączone');
const kodPowodu = (stan) => stan === 'niepodłączone' ? 'NIEPODLACZONE' : 'BRAK_DANYCH';
const zaokraglij = (licznik, mianownik) => Number((licznik / mianownik).toFixed(4));

function podsumujZrodlo(rows, { od, do: doDnia, dzis, stan, preferowanaWaluta, nazwaZrodla }) {
  const wybrane = rows.filter((row) => wOkresie(row, od, doDnia));
  const waluty = new Set(wybrane.map((row) => row.waluta).filter(Boolean));
  if (preferowanaWaluta && waluty.size === 0) waluty.add(preferowanaWaluta);
  const mieszane = waluty.size > 1;
  const waluta = mieszane ? null : ([...waluty][0] ?? preferowanaWaluta ?? null);
  const obecnyStan = stanZrodla(stan, wybrane.length > 0);
  const powodKosztu = mieszane ? 'ROZNE_WALUTY' : kodPowodu(obecnyStan);
  const maDane = wybrane.length > 0 && !mieszane;
  const dzienMap = new Map();
  const kampaniaMap = new Map();
  let sumaKosztu = 0n;
  let sumaKlikniec = 0;
  let sumaWyswietlen = 0;
  const dzienWczoraj = new Date(`${dzis}T00:00:00Z`);
  dzienWczoraj.setUTCDate(dzienWczoraj.getUTCDate() - 1);
  const granicaEmisji = dzienWczoraj.toISOString().slice(0, 10);
  const dzienDwaWstecz = new Date(`${dzis}T00:00:00Z`);
  dzienDwaWstecz.setUTCDate(dzienDwaWstecz.getUTCDate() - 2);
  const granicaWstepnych = dzienDwaWstecz.toISOString().slice(0, 10);

  for (const row of wybrane) {
    const koszt = grosze(nazwaZrodla === 'meta' ? (row.wydatek ?? row.koszt ?? '0') : (row.koszt ?? '0'));
    const klikniecia = liczba(row.klikniecia);
    const wyswietlenia = liczba(row.wyswietlenia);
    sumaKosztu += koszt;
    sumaKlikniec += klikniecia;
    sumaWyswietlen += wyswietlenia;
    if (row.dzien) {
      const klucz = `${row.dzien}|${row.polaczenieId ?? ''}|${row.waluta ?? waluta ?? ''}`;
      const dzien = dzienMap.get(klucz) ?? { dzien: row.dzien, polaczenieId: row.polaczenieId ?? null,
        waluta: row.waluta ?? waluta, koszt: 0n, klikniecia: 0, wyswietlenia: 0 };
      dzien.koszt += koszt;
      dzien.klikniecia += klikniecia;
      dzien.wyswietlenia += wyswietlenia;
      dzienMap.set(klucz, dzien);
    }
    if (row.kampaniaId) {
      const klucz = `${row.polaczenieId ?? ''}|${row.kampaniaId}|${row.waluta ?? waluta ?? ''}`;
      const k = kampaniaMap.get(klucz) ?? {
        polaczenieId: row.polaczenieId ?? null, kampaniaId: row.kampaniaId,
        nazwa: row.nazwa ?? row.kampaniaId, waluta: row.waluta ?? waluta,
        koszt: 0n, klikniecia: 0, wyswietlenia: 0, emituje: false,
      };
      k.koszt += koszt;
      k.klikniecia += klikniecia;
      k.wyswietlenia += wyswietlenia;
      if (nazwaZrodla === 'meta' && row.dzien >= granicaEmisji && row.dzien <= dzis
        && (koszt > 0n || wyswietlenia > 0)) k.emituje = true;
      kampaniaMap.set(klucz, k);
    }
  }

  const dni = [...dzienMap.values()].sort((a, b) => a.dzien.localeCompare(b.dzien)).map((d) => ({
    ...d, koszt: kwota(d.koszt), wstepny: d.dzien >= granicaWstepnych && d.dzien <= dzis,
  }));
  const kampanie = [...kampaniaMap.values()].map((k) => ({ ...k, koszt: kwota(k.koszt) }));
  return {
    stan: obecnyStan, stanDanych: wybrane.length ? 'dane' : 'brak danych',
    waluta, koszt: maDane ? kwota(sumaKosztu) : null,
    klikniecia: maDane ? sumaKlikniec : null, wyswietlenia: maDane ? sumaWyswietlen : null,
    ctr: maDane && sumaWyswietlen ? sumaKlikniec / sumaWyswietlen : null,
    cpc: maDane && sumaKlikniec ? kwota((sumaKosztu + BigInt(Math.floor(sumaKlikniec / 2))) / BigInt(sumaKlikniec)) : null,
    powody: {
      koszt: maDane ? null : powodKosztu,
      ctr: !maDane ? powodKosztu : (sumaWyswietlen ? null : 'BRAK_MIANOWNIKA'),
      cpc: !maDane ? powodKosztu : (sumaKlikniec ? null : 'BRAK_MIANOWNIKA'),
    },
    dni, kampanie, emitujace: kampanie.filter((k) => k.emituje).length,
    _kosztGrosze: maDane ? sumaKosztu : null,
  };
}

export function podsumujReklamy({ google = [], meta = [], transakcje = [], zamowienia,
  stany = {}, od, do: doDnia, waluta = null, dzis }) {
  const g = podsumujZrodlo(google, { od, do: doDnia, dzis, stan: stany.ga4 ?? stany.google,
    preferowanaWaluta: waluta, nazwaZrodla: 'google' });
  const m = podsumujZrodlo(meta, { od, do: doDnia, dzis, stan: stany.meta,
    preferowanaWaluta: waluta, nazwaZrodla: 'meta' });
  const tx = transakcje.filter((row) => wOkresie(row, od, doDnia) && row.transactionId);
  const kluczTransakcji = (polaczenieId, transactionId) => JSON.stringify([
    polaczenieId == null ? null : String(polaczenieId), String(transactionId),
  ]);
  const zamowieniaPoId = new Map();
  for (const row of zamowienia ?? []) {
    const id = String(row.zrodloId ?? row.transactionId ?? '');
    if (!id) continue;
    const klucz = kluczTransakcji(row.polaczenieId, id);
    const lista = zamowieniaPoId.get(klucz) ?? [];
    lista.push(row);
    zamowieniaPoId.set(klucz, lista);
  }
  let przychodGa4 = 0n;
  let przychodOms = 0n;
  let przychodBruttoOms = 0n;
  let brakKwotyNetto = false;
  let brakKwotyBrutto = false;
  let konwersjeOms = 0;
  let niepotwierdzone = 0;
  const widziane = new Set();
  for (const row of tx) {
    const klucz = kluczTransakcji(row.polaczenieId, row.transactionId);
    if (widziane.has(klucz)) continue;
    widziane.add(klucz);
    przychodGa4 += grosze(row.przychod);
    const dopasowane = zamowieniaPoId.get(klucz) ?? [];
    const zamowienie = dopasowane.length === 1 ? dopasowane[0] : null;
    const status = String(zamowienie?.status ?? '').toLowerCase();
    const nieaktywne = /anul|cancel|zwrot|refund/.test(status);
    if (!zamowienie || nieaktywne
      || (zamowienie.waluta && (row.waluta ?? g.waluta) && zamowienie.waluta !== (row.waluta ?? g.waluta))) {
      niepotwierdzone += 1;
      continue;
    }
    konwersjeOms += 1;
    if (zamowienie.kwota == null) brakKwotyNetto = true;
    else przychodOms += grosze(zamowienie.kwota);
    if (zamowienie.kwotaBrutto == null) brakKwotyBrutto = true;
    else przychodBruttoOms += grosze(zamowienie.kwotaBrutto);
  }
  const maTx = g.stan !== 'niepodłączone' && g.stan !== 'brak uprawnień'
    && g.powody.koszt !== 'ROZNE_WALUTY' && (g.dni.length > 0 || tx.length > 0);
  g.przychodGa4 = maTx ? kwota(przychodGa4) : null;
  g.konwersjeGa4 = maTx ? widziane.size : null;
  g.przychodOms = maTx && zamowienia !== undefined && !brakKwotyNetto ? kwota(przychodOms) : null;
  g.przychodBruttoOms = maTx && zamowienia !== undefined && !brakKwotyBrutto
    ? kwota(przychodBruttoOms) : null;
  g.konwersjeOms = maTx && zamowienia !== undefined ? konwersjeOms : null;
  g.niepotwierdzone = maTx && zamowienia !== undefined ? niepotwierdzone : null;
  g.roasGa4 = g._kosztGrosze && g.przychodGa4 !== null
    ? zaokraglij(Number(przychodGa4), Number(g._kosztGrosze)) : null;
  g.roasOms = g._kosztGrosze && g.przychodOms !== null
    ? zaokraglij(Number(przychodOms), Number(g._kosztGrosze)) : null;
  g.powody.przychodGa4 = maTx ? null : (g.stan === 'niepodłączone' ? 'NIEPODLACZONE' : 'BRAK_DANYCH');
  g.powody.przychodOms = zamowienia === undefined ? 'BRAK_MAPOWANIA'
    : !maTx ? g.powody.przychodGa4 : brakKwotyNetto ? 'BRAK_KWOTY_NETTO' : null;
  g.powody.roasGa4 = g.roasGa4 === null ? (g._kosztGrosze === 0n ? 'BRAK_MIANOWNIKA' : g.powody.koszt) : null;
  g.powody.roasOms = g.roasOms === null ? (g.przychodOms === null ? g.powody.przychodOms
    : (g._kosztGrosze === 0n ? 'BRAK_MIANOWNIKA' : g.powody.koszt)) : null;

  m.przychodOms = null;
  m.przychodBruttoOms = null;
  m.roasOms = null;
  m.powody.przychodOms = 'BRAK_MAPOWANIA';
  m.powody.roasOms = 'BRAK_MAPOWANIA';
  const dostepne = [g, m].filter((zrodlo) => zrodlo._kosztGrosze !== null);
  const walutyLacznie = new Set(dostepne.map((zrodlo) => zrodlo.waluta));
  const mieszaneWaluty = walutyLacznie.size > 1 || [g, m].some((zrodlo) => zrodlo.powody.koszt === 'ROZNE_WALUTY');
  const lacznie = mieszaneWaluty
    ? { koszt: null, waluta: null, powod: 'ROZNE_WALUTY' }
    : dostepne.length === 0
      ? { koszt: null, waluta: null, powod: 'BRAK_DANYCH' }
      : { koszt: kwota(dostepne.reduce((suma, zrodlo) => suma + zrodlo._kosztGrosze, 0n)),
        waluta: dostepne[0].waluta, powod: null };
  delete g._kosztGrosze;
  delete m._kosztGrosze;
  return { okres: { od, do: doDnia }, google: g, meta: m, lacznie,
    dni: [...g.dni.map((d) => ({ ...d, zrodlo: 'google' })), ...m.dni.map((d) => ({ ...d, zrodlo: 'meta' }))],
    kampanie: [...g.kampanie.map((k) => ({ ...k, zrodlo: 'google' })), ...m.kampanie.map((k) => ({ ...k, zrodlo: 'meta' }))] };
}

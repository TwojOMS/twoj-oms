// Lustra reklam bieżących. Połączenie wskazuje konto danej instalacji,
// a poświadczenie żyje poza bazą; to ID połączenia izoluje kampanie o tych
// samych identyfikatorach w dwóch kontach.

const TYPY = new Set(['ga4', 'meta', 'google_ads']);
const DATA = /^\d{4}-\d{2}-\d{2}$/;
const KWOTA = /^-?\d+(?:\.\d+)?$/;

function wymagajTypu(typ) {
  if (!TYPY.has(typ)) throw new Error('Nieznane źródło reklam.');
  return typ;
}

function wymagajKwoty(wartosc, pole) {
  const napis = String(wartosc ?? '');
  if (!KWOTA.test(napis)) throw new Error(`${pole}: niepoprawna kwota dziesiętna.`);
  return napis;
}

function wymagajDnia(dzien) {
  if (typeof dzien !== 'string' || !DATA.test(dzien)) throw new Error('Niepoprawny dzień raportu.');
  if (new Date(`${dzien}T00:00:00Z`).toISOString().slice(0, 10) !== dzien) throw new Error('Niepoprawny dzień raportu.');
  return dzien;
}

function wymagajLicznika(wartosc, pole) {
  const liczba = Number(wartosc ?? 0);
  if (!Number.isSafeInteger(liczba) || liczba < 0) throw new Error(`${pole}: niepoprawna liczba.`);
  return liczba;
}

function wymagajId(id, pole) {
  const napis = String(id ?? '').trim();
  if (!napis || napis === '(not set)') throw new Error(`${pole}: pusty identyfikator.`);
  return napis;
}

function wTransakcji(db, nazwa, praca) {
  db.exec(`SAVEPOINT ${nazwa}`);
  try {
    const wynik = praca();
    db.exec(`RELEASE SAVEPOINT ${nazwa}`);
    return wynik;
  } catch (e) {
    db.exec(`ROLLBACK TO SAVEPOINT ${nazwa}`);
    db.exec(`RELEASE SAVEPOINT ${nazwa}`);
    throw e;
  }
}

export function zapiszPolaczenie(db, {
  typ, kontoId, kanal = null, regulaId = 'zrodlo_id', waluta = null, strefa = null, sekretRef = null,
}) {
  wymagajTypu(typ);
  const konto = wymagajId(kontoId, 'Konto');
  const walutaKod = waluta == null ? null : String(waluta).toUpperCase();
  if (!['zrodlo_id', 'numer'].includes(regulaId)) throw new Error('Nieznana reguła dopasowania zamówień.');
  if (walutaKod && !/^[A-Z]{3}$/.test(walutaKod)) throw new Error('Waluta musi mieć kod ISO 4217.');
  if (strefa) {
    try { new Intl.DateTimeFormat('en', { timeZone: strefa }); } catch { throw new Error('Niepoprawna strefa czasu.'); }
  }
  const wynik = db.prepare(`INSERT INTO reklamy_polaczenia
    (typ, konto_id, kanal, regula_id, waluta, strefa, sekret_ref) VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(typ, konto, kanal, regulaId, walutaKod, strefa, sekretRef);
  return { id: Number(wynik.lastInsertRowid), typ, kontoId: konto, kanal, regulaId, waluta: walutaKod, strefa, sekretRef };
}

export function polaczenia(db, { typ = null } = {}) {
  const wiersze = typ == null
    ? db.prepare('SELECT * FROM reklamy_polaczenia ORDER BY typ, id').all()
    : db.prepare('SELECT * FROM reklamy_polaczenia WHERE typ = ? ORDER BY id').all(wymagajTypu(typ));
  return wiersze.map((w) => ({
    id: w.id, typ: w.typ, kontoId: w.konto_id, kanal: w.kanal,
    regulaId: w.regula_id, waluta: w.waluta, strefa: w.strefa, sekretRef: w.sekret_ref,
  }));
}

function polaczenieDla(db, polaczenieId, typ) {
  const w = db.prepare('SELECT typ, waluta FROM reklamy_polaczenia WHERE id = ?').get(polaczenieId);
  if (!w || w.typ !== typ) throw new Error('Połączenie nie należy do tego źródła reklam.');
  return w;
}

export function zapiszDni(db, { typ, polaczenieId, wiersze, pobranoAt, od = null, do: doDnia = null }) {
  if (!['ga4', 'meta'].includes(typ)) throw new Error('Lustro dzienne obsługuje tylko GA4 i Meta.');
  const polaczenie = polaczenieDla(db, polaczenieId, typ);
  if (!Array.isArray(wiersze) || !pobranoAt) throw new Error('Brak wierszy lub czasu pobrania.');
  const tabela = typ === 'ga4' ? 'reklamy_google_dni' : 'reklamy_meta_dni';
  const kolumny = typ === 'ga4'
    ? 'polaczenie_id, dzien, kampania_id, nazwa, koszt, klikniecia, wyswietlenia, waluta, pobrane_at'
    : 'polaczenie_id, dzien, kampania_id, nazwa, wydatek, klikniecia, wyswietlenia, klikniecia_linku, waluta, pobrane_at';
  const miejsca = typ === 'ga4' ? '?, ?, ?, ?, ?, ?, ?, ?, ?' : '?, ?, ?, ?, ?, ?, ?, ?, ?, ?';
  const sql = `INSERT INTO ${tabela} (${kolumny}) VALUES (${miejsca})
    ON CONFLICT(polaczenie_id,dzien,kampania_id) DO UPDATE SET
    nazwa=excluded.nazwa, ${typ === 'ga4' ? 'koszt' : 'wydatek'}=excluded.${typ === 'ga4' ? 'koszt' : 'wydatek'},
    klikniecia=excluded.klikniecia, wyswietlenia=excluded.wyswietlenia,
    ${typ === 'meta' ? 'klikniecia_linku=excluded.klikniecia_linku,' : ''}
    waluta=excluded.waluta, pobrane_at=excluded.pobrane_at`;
  const insert = db.prepare(sql);
  return wTransakcji(db, 'zapis_reklamy_dni', () => {
    if (od != null && doDnia != null) {
      db.prepare(`DELETE FROM ${tabela} WHERE polaczenie_id = ? AND dzien BETWEEN ? AND ?`)
        .run(polaczenieId, wymagajDnia(od), wymagajDnia(doDnia));
    }
    for (const w of wiersze) {
      const wspolne = [
        polaczenieId, wymagajDnia(w.dzien), wymagajId(w.kampaniaId, 'Kampania'),
        w.nazwa ?? null, wymagajKwoty(typ === 'ga4' ? w.koszt : w.wydatek, 'Wydatek'),
        wymagajLicznika(w.klikniecia, 'Kliknięcia'), wymagajLicznika(w.wyswietlenia, 'Wyświetlenia'),
      ];
      if (typ === 'meta') wspolne.push(wymagajLicznika(w.kliknieciaLinku, 'Kliknięcia linku'));
      insert.run(...wspolne, w.waluta ?? polaczenie.waluta, pobranoAt);
    }
    return wiersze.length;
  });
}

export function dni(db, { typ, polaczenieId = null, kampaniaId = null, od = null, do: doDnia = null } = {}) {
  if (!['ga4', 'meta'].includes(typ)) throw new Error('Wybierz źródło GA4 albo Meta.');
  const tabela = typ === 'ga4' ? 'reklamy_google_dni' : 'reklamy_meta_dni';
  const warunki = [];
  const args = [];
  if (polaczenieId != null) { warunki.push('polaczenie_id = ?'); args.push(polaczenieId); }
  if (kampaniaId != null) { warunki.push('kampania_id = ?'); args.push(kampaniaId); }
  if (od != null) { warunki.push('dzien >= ?'); args.push(wymagajDnia(od)); }
  if (doDnia != null) { warunki.push('dzien <= ?'); args.push(wymagajDnia(doDnia)); }
  const where = warunki.length ? ` WHERE ${warunki.join(' AND ')}` : '';
  return db.prepare(`SELECT * FROM ${tabela}${where} ORDER BY dzien, polaczenie_id, kampania_id`).all(...args)
    .map((w) => ({
      polaczenieId: w.polaczenie_id, dzien: w.dzien, kampaniaId: w.kampania_id,
      nazwa: w.nazwa, koszt: w.koszt, wydatek: w.wydatek,
      klikniecia: w.klikniecia, wyswietlenia: w.wyswietlenia,
      kliknieciaLinku: w.klikniecia_linku, waluta: w.waluta, pobranoAt: w.pobrane_at,
    }));
}

export function zapiszTransakcje(db, { polaczenieId, wiersze, pobranoAt, od = null, do: doDnia = null }) {
  const polaczenie = polaczenieDla(db, polaczenieId, 'ga4');
  if (!Array.isArray(wiersze) || !pobranoAt) throw new Error('Brak transakcji lub czasu pobrania.');
  const insert = db.prepare(`INSERT INTO reklamy_google_transakcje
    (polaczenie_id,dzien,kampania_id,transaction_id,przychod,waluta,pobrane_at)
    VALUES (?,?,?,?,?,?,?)
    ON CONFLICT(polaczenie_id,transaction_id) DO UPDATE SET
    dzien=excluded.dzien, kampania_id=excluded.kampania_id,
    przychod=excluded.przychod, waluta=excluded.waluta, pobrane_at=excluded.pobrane_at`);
  return wTransakcji(db, 'zapis_reklamy_tx', () => {
    if (od != null && doDnia != null) {
      db.prepare('DELETE FROM reklamy_google_transakcje WHERE polaczenie_id = ? AND dzien BETWEEN ? AND ?')
        .run(polaczenieId, wymagajDnia(od), wymagajDnia(doDnia));
    }
    for (const w of wiersze) {
      insert.run(polaczenieId, wymagajDnia(w.dzien), wymagajId(w.kampaniaId, 'Kampania'),
        wymagajId(w.transactionId, 'Transakcja'), wymagajKwoty(w.przychod, 'Przychód'),
        w.waluta ?? polaczenie.waluta, pobranoAt);
    }
    return wiersze.length;
  });
}

export function transakcje(db, { polaczenieId = null, od = null, do: doDnia = null } = {}) {
  const warunki = [];
  const args = [];
  if (polaczenieId != null) { warunki.push('polaczenie_id = ?'); args.push(polaczenieId); }
  if (od != null) { warunki.push('dzien >= ?'); args.push(wymagajDnia(od)); }
  if (doDnia != null) { warunki.push('dzien <= ?'); args.push(wymagajDnia(doDnia)); }
  return db.prepare(`SELECT * FROM reklamy_google_transakcje
    ${warunki.length ? 'WHERE ' + warunki.join(' AND ') : ''}
    ORDER BY dzien, polaczenie_id, kampania_id, transaction_id`).all(...args)
    .map((w) => ({
      polaczenieId: w.polaczenie_id, dzien: w.dzien, kampaniaId: w.kampania_id,
      transactionId: w.transaction_id, przychod: w.przychod,
      waluta: w.waluta, pobranoAt: w.pobrane_at,
    }));
}

export function zapiszStan(db, { polaczenieId, ostatniaProbaAt, ostatniSukcesAt = null, kodBledu = null }) {
  db.prepare(`INSERT INTO reklamy_zrodla (polaczenie_id,ostatnia_proba_at,ostatni_sukces_at,kod_bledu)
    VALUES (?,?,?,?)
    ON CONFLICT(polaczenie_id) DO UPDATE SET
    ostatnia_proba_at=excluded.ostatnia_proba_at,
    ostatni_sukces_at=COALESCE(excluded.ostatni_sukces_at,reklamy_zrodla.ostatni_sukces_at),
    kod_bledu=excluded.kod_bledu`).run(polaczenieId, ostatniaProbaAt, ostatniSukcesAt, kodBledu);
}

export function stanPolaczenia(db, polaczenieId) {
  const w = db.prepare('SELECT * FROM reklamy_zrodla WHERE polaczenie_id = ?').get(polaczenieId);
  return w ? {
    polaczenieId: w.polaczenie_id, ostatniaProbaAt: w.ostatnia_proba_at,
    ostatniSukcesAt: w.ostatni_sukces_at, kodBledu: w.kod_bledu,
  } : null;
}

export function zapiszMetaKampanie(db, { polaczenieId, kampanie, pobranoAt }) {
  polaczenieDla(db, polaczenieId, 'meta');
  const insert = db.prepare(`INSERT INTO reklamy_meta_kampanie
    (polaczenie_id,kampania_id,nazwa,effective_status,budzet_dzienny,budzet_calosciowy,budzety_json,waluta,pobrane_at)
    VALUES (?,?,?,?,?,?,?,?,?)
    ON CONFLICT(polaczenie_id,kampania_id) DO UPDATE SET
    nazwa=excluded.nazwa,effective_status=excluded.effective_status,
    budzet_dzienny=excluded.budzet_dzienny,budzet_calosciowy=excluded.budzet_calosciowy,
    budzety_json=excluded.budzety_json,waluta=excluded.waluta,pobrane_at=excluded.pobrane_at`);
  return wTransakcji(db, 'zapis_reklamy_meta_kampanie', () => {
    db.prepare('DELETE FROM reklamy_meta_kampanie WHERE polaczenie_id = ?').run(polaczenieId);
    for (const k of kampanie) {
      insert.run(polaczenieId, wymagajId(k.id ?? k.kampaniaId, 'Kampania'), k.nazwa ?? null,
        k.effectiveStatus ?? null, k.budzetDzienny ?? null, k.budzetCalkowity ?? null,
        JSON.stringify(k.budzety ?? []), k.waluta ?? null, pobranoAt);
    }
    return kampanie.length;
  });
}

export function metaKampanie(db, { polaczenieId = null } = {}) {
  const sql = `SELECT * FROM reklamy_meta_kampanie
    ${polaczenieId == null ? '' : 'WHERE polaczenie_id = ?'}
    ORDER BY polaczenie_id,kampania_id`;
  return db.prepare(sql).all(...(polaczenieId == null ? [] : [polaczenieId]))
    .map((w) => ({
      polaczenieId: w.polaczenie_id, kampaniaId: w.kampania_id,
      nazwa: w.nazwa, effectiveStatus: w.effective_status,
      budzetDzienny: w.budzet_dzienny, budzetCalkowity: w.budzet_calosciowy,
      budzety: JSON.parse(w.budzety_json || '[]'), waluta: w.waluta, pobranoAt: w.pobrane_at,
    }));
}

function dodajGrosze(kwota) {
  const m = /^(\d+)(?:\.(\d{1,2}))?$/.exec(String(kwota ?? ''));
  if (!m) throw new Error('Kwota zamówienia nie jest zapisana w groszach dziesiętnych.');
  return BigInt(m[1]) * 100n + BigInt((m[2] ?? '').padEnd(2, '0'));
}

function kwotaZGroszy(grosze) {
  return `${grosze / 100n}.${String(grosze % 100n).padStart(2, '0')}`;
}

// Atrybucja Woo nie jest podstawą tego złączenia: GA4 może przypisać reklamie
// zakup zapisany przez sklep jako wejście bezpośrednie. Kluczem jest wyłącznie
// transactionId GA4 i zewnętrzny identyfikator zamówienia w przypiętym kanale.
export function potwierdzoneZamowienia(db, { polaczenieId, transactionIds = [] }) {
  const p = db.prepare('SELECT kanal, regula_id, waluta FROM reklamy_polaczenia WHERE id = ? AND typ = ?')
    .get(polaczenieId, 'ga4');
  if (!p) throw new Error('Nie ma połączenia GA4.');
  if (!p.kanal) return { przychod: null, liczba: null, niepotwierdzone: transactionIds.length, powod: 'BRAK_KANALU', zamowienia: [] };
  if (p.waluta !== 'PLN') return { przychod: null, liczba: null, niepotwierdzone: transactionIds.length, powod: 'NIEZGODNA_WALUTA', zamowienia: [] };
  const pole = p.regula_id === 'numer' ? 'numer' : 'CAST(zrodlo_id AS TEXT)';
  const query = db.prepare(`SELECT id, sklep, zrodlo_id, numer, kwota_brutto, anulowane, anulowane_recznie, zwrot_at
    FROM zamowienia WHERE sklep = ? AND ${pole} = ?`);
  const pozycje = db.prepare(`SELECT netto_linii FROM pozycje
    WHERE zamowienie_id = ? AND zrodlo = 'sklep'`);
  let suma = 0n;
  let sumaBrutto = 0n;
  let brakKwotyNetto = false;
  let liczba = 0;
  let niepotwierdzone = 0;
  let anulowane = 0;
  let zwroty = 0;
  let kolizje = 0;
  const zamowienia = [];
  for (const transactionId of new Set(transactionIds.map(String))) {
    const trafienia = query.all(p.kanal, transactionId);
    if (trafienia.length !== 1) {
      niepotwierdzone += 1;
      if (trafienia.length > 1) kolizje += 1;
      continue;
    }
    const w = trafienia[0];
    if (w.anulowane || w.anulowane_recznie) {
      anulowane += 1;
      zamowienia.push({ transactionId, zamowienieId: w.id, kwota: '0.00', kwotaBrutto: '0.00', status: 'anulowane' });
      continue;
    }
    if (w.zwrot_at) {
      zwroty += 1;
      zamowienia.push({ transactionId, zamowienieId: w.id, kwota: '0.00', kwotaBrutto: '0.00', status: 'zwrot' });
      continue;
    }
    const brutto = dodajGrosze(w.kwota_brutto);
    sumaBrutto += brutto;
    liczba += 1;
    // GA4 w tej instalacji dostaje wartość produktów netto po rabatach. Nie
    // odejmujemy dostawy/VAT od brutto: różne stawki wymagają kwot samych linii.
    const linie = pozycje.all(w.id);
    if (!linie.length || linie.some((linia) => linia.netto_linii == null)) {
      brakKwotyNetto = true;
      zamowienia.push({ transactionId, zamowienieId: w.id, kwota: null,
        kwotaBrutto: kwotaZGroszy(brutto), status: 'potwierdzone' });
      continue;
    }
    const netto = linie.reduce((acc, linia) => acc + dodajGrosze(linia.netto_linii), 0n);
    suma += netto;
    zamowienia.push({ transactionId, zamowienieId: w.id, kwota: kwotaZGroszy(netto),
      kwotaBrutto: kwotaZGroszy(brutto), status: 'potwierdzone' });
  }
  return { przychod: brakKwotyNetto ? null : kwotaZGroszy(suma),
    przychodBrutto: kwotaZGroszy(sumaBrutto), powod: brakKwotyNetto ? 'BRAK_KWOTY_NETTO' : null,
    liczba, niepotwierdzone, anulowane, zwroty, kolizje, zamowienia };
}

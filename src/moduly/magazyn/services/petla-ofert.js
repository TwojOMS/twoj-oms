// PRZ-160 E2.05 — pętla ofert ERLI (D9). Co przebieg zegara, dla każdego bieżącego konta ERLI:
// odczyt własnych produktów z kanału (`_search`), wysyłka nowych ofert, synchronizacja ilości i ceny
// względem ODCZYTU, treść względem skrótu ostatnio wysłanej, problemy po polsku.
// Zasady (decyzje kierownika E2.05): każdy zapis do kanału idzie przez `bramkaZapisu` (D23, D24, tylko odczyt,
// lista kont); wiersz (stan, próby, termin) zapisany PRZED wywołaniem kanału; `archived` nigdzie (D11).
import { znakInstalacji, przerwaPonowienia, skrotTresci, bramkaZapisu, cenaWymagaPotwierdzenia, POLA_POZA_TRESCIA } from './oferty-wspolne.js';
import { ofertaPoId, zmienOferte, ustawieniaOfertKonta } from '../../../oms/db/oferty-kanalow.ts';
import { trescOferty } from './tresc-oferty.js';
import { migawkaStanow, przelacznikStanow, wyjasnieniaOfert } from '../../../oms/db/stany-magazynowe.js';
import { iloscDlaKanalu, ocenRozjazdu, skokIlosci, wolnoPodniesc, zeroMasowe, PROBLEMY_ILOSCI,
  liczySieDoZeraMasowego, potwierdzenieZerZuzyte, bezPotwierdzeniaZer, potwierdzenieZerWazne } from '../../../domena/ilosc-kanalu.js';

// D29: części wspólne z pętlą Allegro mieszkają w `oferty-wspolne.js`; ponowny eksport trzyma importy E2.
export { znakInstalacji, przerwaPonowienia, skrotTresci, bramkaZapisu, cenaWymagaPotwierdzenia } from './oferty-wspolne.js';

export const ODSTEP_PETLI_OFERT_MS = 5 * 60_000;
/** Po tylu ms od wysyłki zdjęcie bez `internalUrl` uznajemy za niepobrane przez ERLI. */
export const CZAS_POBRANIA_ZDJEC_MS = 10 * 60_000;
const LIMIT_STRONY = 100;
const MAKS_STRON = 100;
export const LIMIT_BATCH_ERLI = 100;

const PROBLEMY_ERLI = {
  // `category`: kod NIEPOTWIERDZONY (P2) — scenariusz atrapy E2.10a. D12 (puste `categories`) to osobne zadanie po P2.
  category: 'ERLI nie rozpoznało kategorii — przypisz ją w panelu ERLI.',
  'shop-activity': 'Sklep w ERLI jest nieaktywny — kupujący nie mogą kupić produktu.',
  shopKyc: 'ERLI nie zakończyło weryfikacji sprzedawcy (KYC) — produkt nie może być kupiony.',
  delivery: 'Produkt nie ma poprawnego cennika dostaw w ERLI.',
  terms: 'Sklep w ERLI nie ma kompletnych warunków zwrotu, reklamacji i gwarancji.',
};

/** Identyfikator produktu ERLI karty: `<znak instalacji>-K<id karty>`. */
export function idProduktuErli(db, kartaId) {
  return `${znakInstalacji(db)}-K${kartaId}`;
}

/** `buyableProblems` z ERLI → [{kod, tekst}] po polsku; nieznany kod zostaje widoczny. */
export function tlumaczProblemyErli(lista) {
  if (!Array.isArray(lista)) return [];
  return lista.flatMap((p) => {
    const kod = typeof p === 'string' ? p : String(p?.code ?? p?.type ?? '');
    if (!kod) return [];
    return [{ kod, tekst: Object.hasOwn(PROBLEMY_ERLI, kod) ? PROBLEMY_ERLI[kod] : `ERLI zgłasza problem: ${kod}` }];
  });
}

/** `frozen` z odczytu → lista zamrożonych pól; `true` = wszystkie (`*`). Kształt przyjęty założeniem (P6). */
export function zamrozonePola(frozen) {
  if (frozen === true) return ['*'];
  if (Array.isArray(frozen)) return frozen.map(String).filter(Boolean);
  if (frozen && typeof frozen === 'object') return Object.keys(frozen).filter(k => frozen[k]);
  return [];
}

const zamrozone = (lista, pole) => lista.includes('*') || lista.includes(pole);

/** Problemy zdjęć: po `CZAS_POBRANIA_ZDJEC_MS` od wysyłki obraz bez `internalUrl` jest niepobrany. */
export function problemyZdjec(oferta, produkt, terazMs) {
  const od = Date.parse(oferta.wyslanoAt ?? '');
  if (!Number.isFinite(od) || terazMs - od <= CZAS_POBRANIA_ZDJEC_MS) return [];
  const obrazy = Array.isArray(produkt.images) ? produkt.images : [];
  const wyslane = Number(oferta.wyslanePola?.zdjecia) || 0;
  if (!obrazy.length && wyslane > 0) {
    return [{ kod: 'zdjecia', tekst: 'Zdjęcia nie zostały pobrane przez ERLI — sprawdź, czy ich adresy są publiczne.' }];
  }
  return obrazy.flatMap((o, i) => (o?.internalUrl ? [] : [{
    kod: 'zdjecie', tekst: `Zdjęcie ${i + 1} nie zostało pobrane przez ERLI — sprawdź, czy jego adres jest publiczny.`,
  }]));
}

const liczbaLubNull = w => (Number.isSafeInteger(w) && w >= 0 ? w : null);
const komunikat = e => String(e?.message ?? e ?? 'nieznany błąd');
// Horyzont wyjaśnień (B3, decyzja Szefa 14.11): okno zamówień zaczyna się od `ilosc_wyslana_at`, ale najwyżej 7 dni
// wstecz. Ogranicza TYLKO okno zapytania: oferta ze starszym T zostaje z prawdziwą bazą (W, stan karty), a jej wyjaśnienia
// są zerowe (poller bez zmian) — niedoszacowanie daje alarm (skok, rozjazd-dol) i decyzję człowieka, nie cichą wysyłkę.
const HORYZONT_WYJASNIEN_MS = 7 * 24 * 3600_000;
// E4.32a: stany wiersza oferty ERLI, która jest wystawiona i może sprzedawać — tylko one tworzą mianownik zera masowego.
const STANY_SPRZEDAZY = Object.freeze(['aktywna', 'nieaktywna', 'problem']);

export function createPetlaOfert({ db, konta, adresPublicznyZdjec = '', teraz = () => new Date(), log = () => {},
  pollerMs = 120_000, czekaj = ms => new Promise(resolve => setTimeout(resolve, ms)) }) {
  let wToku = false;
  let poBiezacym = false;
  let ostatniStart = -Infinity;
  let timer = null;
  let migawka;
  let wyjasnienia = new Map();
  // B1 r2: chwila tuż przed migawką — T dla każdego zapisu stanKartyWyslany z tej migawki (jedna chwila dla obu).
  let chwilaMigawki = null;
  let iloscPominieta = false;
  const iso = () => teraz().toISOString();
  const za = ms => new Date(teraz().getTime() + ms).toISOString();
  const opc = () => ({ teraz: iso() });
  const zmien = (id, zmiany) => zmienOferte(db, id, zmiany, opc());

  // Udana odpowiedź na żądanie z images: rejestr i blokada zdjęć zapisują się razem.
  function zapiszWysylkeZdjec(oferta, cialo, zmiany) {
    db.exec('SAVEPOINT wysylka_zdjec');
    try {
      const at = iso();
      const baza = adresPublicznyZdjec.replace(/\/+$/, '');
      db.prepare(`UPDATE zdjecia_kart SET wyslane_at = ? WHERE karta_id = ? AND wyslane_at IS NULL
        AND (adres_zrodlowy IN (SELECT json_extract(value, '$.url') FROM json_each(?))
          OR (? <> '' AND (? || '/z/' || sha256 || '.' || CASE typ
            WHEN 'image/jpeg' THEN 'jpg' WHEN 'image/png' THEN 'png' WHEN 'image/webp' THEN 'webp' END)
            IN (SELECT json_extract(value, '$.url') FROM json_each(?))))`)
        .run(at, oferta.kartaId, JSON.stringify(cialo.images ?? []), baza, baza, JSON.stringify(cialo.images ?? []));
      zmien(oferta.id, zmiany);
      db.exec('RELEASE wysylka_zdjec');
    } catch (e) {
      db.exec('ROLLBACK TO wysylka_zdjec');
      db.exec('RELEASE wysylka_zdjec');
      throw e;
    }
  }

  /** Bramka dla każdej oferty → zapis wierszy → dopiero wtedy wywołanie kanału (decyzje 4 i 5). */
  async function zapisDoKanalu(konto, klucze, ids, zapiszWiersze, wywolaj, zakres = null) {
    for (const id of ids) {
      const oferta = ofertaPoId(db, id);
      const decyzja = bramkaZapisu({ konto, ustawienia: ustawieniaOfertKonta(db, konto.klucz),
        oferta: { ...oferta, ilosc_z_oms: oferta?.iloscZOms ? 1 : 0 }, klucze,
        zakres: typeof zakres === 'function' ? zakres(id) : zakres });
      if (!decyzja.wolno) return { wyslano: false, powod: decyzja.powod };
    }
    zapiszWiersze();
    return { wyslano: true, wynik: await wywolaj() };
  }

  function wynikKanalu(r) {
    if (!r.ok) throw Object.assign(new Error(r.powod ?? 'kanał odmówił'), { chwilowy: false });
    return r.dane;
  }

  /** Błąd wywołania: chwilowy (5xx, połączenie, 429) zostawia termin ponowienia; inny kończy w `blad`. */
  function bladWywolania(id, e) {
    if (e?.chwilowy) zmien(id, { blad: komunikat(e) });
    else zmien(id, { stan: 'blad', blad: komunikat(e), nastepnaProbaAt: null });
  }

  function trescKarty(kartaId, ustawienia) {
    return trescOferty(db, kartaId, ustawienia, adresPublicznyZdjec, { migawka });
  }

  const celIlosci = (oferta, ustawienia) => iloscDlaKanalu({ migawka, kartaId: oferta.kartaId,
    tryb: oferta.tryb, iloscZOms: oferta.iloscZOms, bufor: ustawienia.buforSzt, stalaIlosc: ustawienia.stalaIlosc });
  const problemIlosci = (kod, cel, odczyt) => ({ ...PROBLEMY_ILOSCI[kod], od: iso(), cel, odczyt });

  function ocenIlosc(oferta, produkt, ustawienia, masoweZero) {
    const { ilosc: cel, powod } = celIlosci(oferta, ustawienia);
    const odczyt = Number.isSafeInteger(produkt.stock) ? produkt.stock : null;
    const zapis = { odczytIloscKanalu: odczyt };
    let problem = powod ? problemIlosci(powod, cel, odczyt) : null;
    let wolno = cel !== null && odczyt !== null;
    if (wolno) {
      const wyjasnienie = wyjasnienia.get(oferta.id) ?? {};
      const wspolne = { cel, odczyt, poller: wyjasnienie.poller, policzonoAt: migawka.policzonoAt, pollerMs };
      // N5: objęta po zapytaniu o wyjaśnienia (zmiana trybu w trakcie przebiegu) — stary stan karty nie jest bazą.
      const nowoObjeta = !wyjasnienia.has(oferta.id);
      const stanKartyWyslany = nowoObjeta ? null : oferta.stanKartyWyslany;
      if (nowoObjeta && oferta.stanKartyWyslany != null) zapis.stanKartyWyslany = null;
      const rozjazd = ocenRozjazdu({ ...wspolne, wyslanaIlosc: oferta.wyslanaIlosc,
        wyjasnienie, wToku: oferta.iloscWToku, odczytanoAt: iso(),
        alarmOd: ['karencja', 'rozjazd-dol'].includes(oferta.iloscProblem?.kod) ? oferta.iloscProblem.od : null });
      if (rozjazd.baza) {
        Object.assign(zapis, rozjazd.baza, { iloscWyslanaAt: chwilaMigawki, iloscWToku: null });
        // B1 (D53): T przesuwa się razem ze stanem karty — inaczej sprzedaż tylko w kanale kumuluje fałszywy skok.
        // T = chwila migawki (r2), bo z niej jest stan karty: ruch zapisany później wpada w okno następnego przebiegu.
        const stanTeraz = migawka.stany.get(oferta.kartaId)?.stan;
        if (stanKartyWyslany != null && Number.isFinite(stanTeraz)) zapis.stanKartyWyslany = stanTeraz;
      }
      problem = rozjazd.problem;
      wolno = rozjazd.wolnoWyslac;
      const skok = skokIlosci({ stan: migawka.stany.get(oferta.kartaId)?.stan,
        stanKartyWyslany, wyjasnioneKarty: wyjasnienie.wyjasnioneKarty,
        prog: ustawienia.progSkokuSzt, od: iso(), cel, odczyt });
      const podwyzka = wolnoPodniesc({ ...wspolne,
        poprzedniOdczyt: { ilosc: oferta.odczytIloscKanalu, odczytanoAt: oferta.odczytanoAt } });
      if (!podwyzka.wolno) { wolno = false; problem ??= problemIlosci(podwyzka.powod, cel, odczyt); }
      if (skok) { problem = skok; wolno = false; }
      if (zamrozone(zamrozonePola(produkt.frozen), 'stock')) { problem = problemIlosci('zamrozona-ilosc', cel, odczyt); wolno = false; }
      if (masoweZero && liczySieDoZeraMasowego(oferta, migawka)) { wolno = false; if (cel === 0 && odczyt > 0) problem = problemIlosci('zero-masowe', cel, odczyt); }
    }
    // E4.30: potwierdzenie zer zużyte (kanał ma 0 albo cel > 0) — zdjęte; `oferta` też, bo dalsze zapisy treści
    // w tym przebiegu rozwijają `oferta.wyslanePola`.
    // E4.30p: potwierdzenie z innego przełączenia stanów jest nieważne — też zdjęte.
    if (oferta.wyslanePola?.zeraPotwierdzone && (!potwierdzenieZerWazne(oferta, migawka) || potwierdzenieZerZuzyte({ cel, odczyt }))) {
      oferta.wyslanePola = zapis.wyslanePola = bezPotwierdzeniaZer(oferta.wyslanePola);
    }
    // Alarm wymaga decyzji człowieka, także gdy kolejny odczyt jest już zgodny z celem albo cel/odczyt są nieznane (B2).
    if (oferta.iloscProblem?.wstrzymuje) {
      problem = oferta.iloscProblem;
      if (problem.kod !== 'rozjazd-gora') wolno = false;
      else if (cel > odczyt) wolno = false;
    }
    zmien(oferta.id, { ...zapis, iloscProblem: problem });
    return wolno && cel !== odczyt ? cel : null;
  }

  /** Ten sam produkt, który wysłaliśmy (decyzja 6): nazwa i SKU równe wysłanym, nie zarchiwizowany. */
  function czySwoj(produkt, wyslane) {
    const swoj = produkt && produkt.name === wyslane?.name && produkt.sku === wyslane?.sku && !produkt.archived;
    return Boolean(swoj);
  }

  function konflikt(id) {
    zmien(id, {
      stan: 'problem', liczbaProb: 0, nastepnaProbaAt: null, blad: null,
      problemy: [{ kod: 'konflikt', tekst: 'Produkt o tym identyfikatorze już istnieje w ERLI — OMS go nie zmienia. Sprawdź produkt w panelu ERLI.' }],
    });
  }

  function potwierdzWyslana(oferta) {
    // Po restarcie galeria mogła się zmienić: zamrażamy tylko adresy zapamiętane przed POST.
    zapiszWysylkeZdjec(oferta, { images: oferta.wyslanePola?.images ?? [] }, {
      stan: 'sprawdzana', wyslanoAt: oferta.wyslanoAt ?? iso(), liczbaProb: 0, nastepnaProbaAt: null, blad: null,
      wyslanePola: oferta.wyslanePola ?? {}, wyslanySkrot: oferta.wyslanySkrot ?? null,
    });
  }

  async function wyslij(konto, klucze, oferta, ustawienia) {
    const { karta, bledy, cialo } = trescKarty(oferta.kartaId, ustawienia);
    if (!karta || karta.wycofana) {
      zmien(oferta.id, { stan: 'blad', blad: karta ? 'Karta jest wycofana — oferta nie zostanie wystawiona.' : 'Karta produktu nie istnieje.' });
      return;
    }
    if (bledy.length) { zmien(oferta.id, { stan: 'blad', blad: bledy.join(' ') }); return; }
    if (migawka.wlaczone && !Object.hasOwn(cialo, 'stock')) {
      if (!iloscPominieta) zmien(oferta.id, { iloscProblem: problemIlosci(celIlosci(oferta, ustawienia).powod, null, null) });
      return;
    }
    const proby = oferta.liczbaProb + 1;
    const wyslane = { name: cialo.name, sku: cialo.sku, deliveryPriceList: cialo.deliveryPriceList, status: 'inactive', zdjecia: cialo.images.length, images: cialo.images };
    let r;
    try {
      r = await zapisDoKanalu(konto, klucze, [oferta.id], () => zmien(oferta.id, {
        stan: 'wyslana', liczbaProb: proby, nastepnaProbaAt: za(przerwaPonowienia(proby)), blad: null,
        wyslanePola: { ...(oferta.wyslanePola ?? {}), ...wyslane }, wyslanySkrot: skrotTresci(cialo),
        wyslanaIlosc: cialo.stock, wyslanaCenaGr: cialo.price,
      }), () => konto.katalog.wystawOferte(oferta.idZewnetrzne, cialo));
      if (!r.wyslano) return;
      wynikKanalu(r.wynik);
    } catch (e) {
      if (e?.status !== 409) { bladWywolania(oferta.id, e); return; }
      try {
        const produkt = wynikKanalu(await konto.katalog.stanOferty(oferta.idZewnetrzne));
        const swoj = czySwoj(produkt, wyslane);
        // 409 odrzuciło bieżące ciało. Potwierdzenie dotyczy wcześniejszej próby,
        // której obrazy zachowaliśmy w ofercie sprzed zapisu nowego POST.
        const images = (oferta.wyslanePola?.images ?? []).filter(z => cialo.images.some(b => b.url === z.url));
        if (swoj) potwierdzWyslana({ ...oferta, wyslanePola: { ...(oferta.wyslanePola ?? {}), images } });
        else konflikt(oferta.id);
      } catch (e2) { bladWywolania(oferta.id, e2); }
      return;
    }
    zapiszWysylkeZdjec(oferta, cialo, { stan: 'sprawdzana', wyslanoAt: iso(), liczbaProb: 0, nastepnaProbaAt: null, blad: null });
    if (migawka.wlaczone) zmien(oferta.id, { iloscWyslanaAt: chwilaMigawki, stanKartyWyslany: migawka.stany.get(oferta.kartaId)?.stan ?? null, iloscWToku: null });
  }

  /** Wiersz po wysyłce bez potwierdzenia (restart, błąd chwilowy): nigdy drugi POST bez odczytu (decyzja 5). */
  async function wyslanaBezPotwierdzenia(konto, klucze, oferta, produkt, ustawienia) {
    if (produkt) {
      if (czySwoj(produkt, oferta.wyslanePola)) potwierdzWyslana(oferta); else konflikt(oferta.id);
      return;
    }
    if (oferta.nastepnaProbaAt && oferta.nastepnaProbaAt > iso()) return;
    let zKanalu;
    try { zKanalu = wynikKanalu(await konto.katalog.stanOferty(oferta.idZewnetrzne)); } catch (e) {
      log(`oferty-erli: odczyt ${oferta.idZewnetrzne}: ${komunikat(e)}`);
      return;
    }
    if (zKanalu) {
      if (czySwoj(zKanalu, oferta.wyslanePola)) potwierdzWyslana(oferta); else konflikt(oferta.id);
      return;
    }
    await wyslij(konto, klucze, oferta, ustawienia);
  }

  async function synchronizuj(konto, klucze, oferta, produkt, ustawienia, batch, masoweZero) {
    const terazIso = iso();
    const pola = zamrozonePola(produkt.frozen);
    const archived = produkt.archived === true;
    const problemy = tlumaczProblemyErli(produkt.buyableProblems);
    // Stan `problem` przy kodzie `category` (niepotwierdzony, P2); zapisy ceny i ilości idą dalej.
    let zablokowane = problemy.some(p => p.kod === 'category');
    if (archived) {
      problemy.push({ kod: 'zarchiwizowana', tekst: 'Produkt jest zarchiwizowany w ERLI — OMS go nie zmienia ani nie przywraca.' });
      zablokowane = true;
    }
    if (pola.length) {
      problemy.push({ kod: 'zamrozone', tekst: `Pola zablokowane w ERLI ręczną zmianą (${pola.join(', ')}) — OMS ich nie zmienia.` });
      zablokowane = true;
    }
    problemy.push(...problemyZdjec(oferta, produkt, teraz().getTime()));
    const odczyt = {
      odczytIlosc: liczbaLubNull(produkt.stock), odczytCenaGr: liczbaLubNull(produkt.price),
      odczytStatus: typeof produkt.status === 'string' ? produkt.status : null,
      odczytZamrozone: pola.length ? pola : null, odczytZarchiwizowana: archived, odczytanoAt: terazIso,
    };
    const stanOdczytu = produkt.status === 'active' ? 'aktywna' : 'nieaktywna';
    const zapisz = (dodatkowe = {}) => zmien(oferta.id, {
      ...odczyt, problemy, stan: zablokowane ? 'problem' : stanOdczytu, ...dodatkowe,
    });
    const objeta = oferta.tryb === 'zarzadzana' || oferta.iloscZOms;
    // D52: przy błędzie migawki ilość jest pominięta — bez oceny, problem ilości zostaje bez zmian.
    const stock = migawka.wlaczone && objeta && !iloscPominieta ? ocenIlosc(oferta, produkt, ustawienia, masoweZero()) : null;
    if (oferta.liczbaProb > 0 && oferta.nastepnaProbaAt && Date.parse(oferta.nastepnaProbaAt) > Date.parse(terazIso)) { zapisz(); return; }
    if (oferta.tryb !== 'zarzadzana' || archived) {
      zapisz();
      if (!archived && oferta.iloscZOms && stock !== null) batch.push({ id: oferta.id, externalId: oferta.idZewnetrzne,
        zmiany: { stock }, odczyt: produkt.stock, kartaId: oferta.kartaId, proby: oferta.liczbaProb + 1 });
      return;
    }

    const { karta, bledy, cialo } = trescKarty(oferta.kartaId, ustawienia);
    if (!karta) {
      problemy.push({ kod: 'karta', tekst: 'Karta produktu nie istnieje — OMS nie zmienia oferty.' });
      zablokowane = true;
      zapisz();
      return;
    }
    const wp = oferta.wyslanePola ?? {};
    if (karta.wycofana || wp.zdejmij) {
      // D25: raz `inactive`, potem bez przywracania ilości; `archived` nigdy (D11).
      if (produkt.status === 'inactive' || wp.wycofanoAt || zamrozone(pola, 'status')) { zapisz(); return; }
      zapisz();
      const proby = oferta.liczbaProb + 1;
      try {
        const r = await zapisDoKanalu(konto, klucze, [oferta.id],
          () => zmien(oferta.id, { liczbaProb: proby, nastepnaProbaAt: za(przerwaPonowienia(proby)) }),
          () => konto.katalog.zmienOferte(oferta.idZewnetrzne, { status: 'inactive' }));
        if (!r.wyslano) return;
        wynikKanalu(r.wynik);
      } catch (e) { bladWywolania(oferta.id, e); return; }
      zmien(oferta.id, { stan: 'nieaktywna', wyslanePola: { ...wp, wycofanoAt: iso() }, liczbaProb: 0, nastepnaProbaAt: null, blad: null });
      return;
    }
    if (bledy.length) {
      problemy.push(...bledy.map(tekst => ({ kod: 'karta', tekst })));
      zablokowane = true;
      zapisz();
      return;
    }

    const zmiany = {};
    if (migawka.wlaczone) { if (stock !== null) zmiany.stock = stock; }
    else if (produkt.stock !== cialo.stock) zmiany.stock = cialo.stock;
    let cenaDoPotwierdzeniaGr = null;
    if (produkt.price !== cialo.price) {
      if (cenaWymagaPotwierdzenia(produkt.price, cialo.price, ustawienia.progPotwierdzeniaBp) && wp.cenaPotwierdzonaGr !== cialo.price) {
        cenaDoPotwierdzeniaGr = cialo.price;
        problemy.push({ kod: 'cena', tekst: 'Zmiana ceny przekracza próg — czeka na potwierdzenie, do ERLI nic nie poszło.' });
      } else zmiany.price = cialo.price;
    }
    for (const pole of Object.keys(zmiany)) if (zamrozone(pola, pole)) delete zmiany[pole];
    zapisz({ cenaDoPotwierdzeniaGr });

    const skrot = skrotTresci(cialo);
    const trescZamrozona = Object.keys(cialo).some(k => !POLA_POZA_TRESCIA.includes(k) && zamrozone(pola, k));
    if (skrot !== oferta.wyslanySkrot && !trescZamrozona) {
      const tylkoDostawa = wp.deliveryPriceList !== undefined &&
        skrotTresci({ ...cialo, deliveryPriceList: wp.deliveryPriceList }) === oferta.wyslanySkrot;
      const tresc = tylkoDostawa ? { deliveryPriceList: cialo.deliveryPriceList }
        : Object.fromEntries(Object.entries(cialo).filter(([k]) => !POLA_POZA_TRESCIA.includes(k)));
      const proby = oferta.liczbaProb + 1;
      try {
        const r = await zapisDoKanalu(konto, klucze, [oferta.id],
          () => zmien(oferta.id, { wyslanePola: { ...wp, trescWToku: skrot }, liczbaProb: proby, nastepnaProbaAt: za(przerwaPonowienia(proby)) }),
          () => konto.katalog.zmienOferte(oferta.idZewnetrzne, tresc));
        if (!r.wyslano) return;
        wynikKanalu(r.wynik);
      } catch (e) { bladWywolania(oferta.id, e); return; }
      const { trescWToku: _pominiete, ...reszta } = wp;
      zapiszWysylkeZdjec(oferta, tresc, {
        wyslanySkrot: skrot, wyslanoAt: iso(), liczbaProb: 0, nastepnaProbaAt: null, blad: null,
        wyslanePola: { ...reszta, name: cialo.name, sku: cialo.sku, deliveryPriceList: cialo.deliveryPriceList, zdjecia: cialo.images.length, images: cialo.images },
      });
    }
    if (Object.keys(zmiany).length) batch.push({ id: oferta.id, externalId: oferta.idZewnetrzne, zmiany,
      odczyt: produkt.stock, kartaId: oferta.kartaId, proby: ofertaPoId(db, oferta.id).liczbaProb + 1 });
  }

  /** Pozycja nieprzyjęta: przy pewnej odmowie (`czyscWToku`) cel w toku znika — nie zostaje bazą rozjazdu (N5). */
  function odrzucona(b, e, czyscWToku) {
    bladWywolania(b.id, e);
    if (czyscWToku && migawka.wlaczone && b.zmiany.stock != null) zmien(b.id, { iloscWToku: null });
  }

  /** Ilość i cena jednym `batch-update` na konto; wynik dopasowany po `externalId`, nie po kolejności. */
  async function wyslijBatch(konto, klucze, batch, liczniki) {
    if (!batch.length) return;
    let r;
    try {
      r = await zapisDoKanalu(konto, klucze, batch.map(b => b.id), () => {
        for (const b of batch) zmien(b.id, { liczbaProb: b.proby, nastepnaProbaAt: za(przerwaPonowienia(b.proby)),
          ...(migawka.wlaczone && b.zmiany.stock != null ? { iloscWToku: { cel: b.zmiany.stock, at: iso() } } : {}) });
      }, () => {
        liczniki.batch++;
        liczniki.stock += batch.filter(b => b.zmiany.stock != null).length;
        liczniki.cena += batch.filter(b => b.zmiany.price != null).length;
        return konto.katalog.zmienIloscCene(batch.map(b => ({ externalId: b.externalId, ...b.zmiany })));
      },
      id => Object.keys(batch.find(b => b.id === id).zmiany).every(k => k === 'stock') ? 'ilosc' : null);
      if (!r.wyslano) return;
    } catch (e) {
      // N5: limit czasu, zerwane połączenie i 5xx = wynik nieznany (ERLI mogło przyjąć) — cel w toku zostaje.
      const nieznany = e?.status === undefined || e.status >= 500;
      for (const b of batch) odrzucona(b, e, !nieznany);
      return;
    }
    let dane;
    try { dane = wynikKanalu(r.wynik); } catch (e) { for (const b of batch) odrzucona(b, e, true); return; }
    const poId = new Map((Array.isArray(dane) ? dane : []).map(p => [p?.externalId, p]));
    for (const b of batch) {
      const pozycja = poId.get(b.externalId);
      if (!pozycja) { bladWywolania(b.id, new Error('ERLI nie zwróciło wyniku tej pozycji batch-update.')); continue; }
      if (pozycja.blad) { odrzucona(b, pozycja.blad, true); continue; }
      const teraz = ofertaPoId(db, b.id);
      zmien(b.id, {
        wyslanaIlosc: b.zmiany.stock ?? teraz.wyslanaIlosc, wyslanaCenaGr: b.zmiany.price ?? teraz.wyslanaCenaGr,
        ...(migawka.wlaczone && b.zmiany.stock != null ? { iloscWToku: null, iloscWyslanaAt: chwilaMigawki,
          stanKartyWyslany: migawka.stany.get(b.kartaId)?.stan ?? null } : {}),
        // E4.30: zapisane 0 zużywa potwierdzenie „Wyślij zera”.
        ...(b.zmiany.stock === 0 && teraz.wyslanePola?.zeraPotwierdzone ? { wyslanePola: bezPotwierdzeniaZer(teraz.wyslanePola) } : {}),
        liczbaProb: 0, nastepnaProbaAt: null, blad: null,
      });
    }
  }

  async function odczytaj(konto) {
    const mapa = new Map();
    let after;
    for (let strona = 0; strona < MAKS_STRON; strona++) {
      const pagination = { sortField: 'externalId', order: 'ASC', limit: LIMIT_STRONY, ...(after === undefined ? {} : { after }) };
      const dane = wynikKanalu(await konto.katalog.odczytOfert({ pagination }));
      const lista = Array.isArray(dane) ? dane : Array.isArray(dane?.products) ? dane.products : [];
      let nowe = 0;
      for (const p of lista) {
        if (p && typeof p.externalId === 'string' && !mapa.has(p.externalId)) { mapa.set(p.externalId, p); nowe++; }
      }
      // Atrapa i nieznany kontrakt `after`: brak postępu kończy odczyt zamiast pętli bez końca.
      if (lista.length < LIMIT_STRONY || !nowe) break;
      after = lista[lista.length - 1].externalId;
    }
    return mapa;
  }

  async function przebiegKonta(konto, klucze) {
    const ids = db.prepare('SELECT id FROM oferty_kanalow WHERE kanal = ? ORDER BY id').all(konto.klucz).map(w => Number(w.id));
    if (!ids.length) { log(`oferty-erli: konto ${konto.klucz}: batch 0, stock 0, cena 0`); return; }
    let produkty;
    try { produkty = await odczytaj(konto); } catch (e) {
      log(`oferty-erli: odczyt konta ${konto.klucz}: ${komunikat(e)}`);
      return;
    }
    const ustawienia = ustawieniaOfertKonta(db, konto.klucz);
    const batch = [];
    // Liczone leniwie, raz na konto: przy wyłączonych stanach albo pominiętej ilości — żadnych odczytów (D14).
    let zero;
    // E4.32a: mianownik tylko z ofert, które sprzedają (jak B4 w Allegro) — szkice, błędy, „do wysłania”,
    // zarchiwizowane i nieobecne w odczycie nie rozcieńczają bezpiecznika.
    const sprzedaje = o => {
      const p = produkty.get(o.idZewnetrzne);
      return Boolean(p) && !p.archived && p.status === 'active' && STANY_SPRZEDAZY.includes(o.stan);
    };
    const masoweZero = () => (zero ??= zeroMasowe(ids.map(id => ofertaPoId(db, id))
      .filter(o => (o.tryb === 'zarzadzana' || o.iloscZOms) && sprzedaje(o) && liczySieDoZeraMasowego(o, migawka))
      .map(o => ({ cel: celIlosci(o, ustawienia).ilosc, odczyt: produkty.get(o.idZewnetrzne)?.stock }))));
    for (const id of ids) {
      const oferta = ofertaPoId(db, id);
      if (!oferta || oferta.stan === 'szkic' || oferta.stan === 'blad') continue;
      if (oferta.problemy.some(p => p?.kod === 'konflikt')) continue;
      const produkt = produkty.get(oferta.idZewnetrzne) ?? null;
      try {
        if (oferta.stan === 'do_wyslania') await wyslij(konto, klucze, oferta, ustawienia);
        else if (oferta.stan === 'wyslana') await wyslanaBezPotwierdzenia(konto, klucze, oferta, produkt, ustawienia);
        else if (produkt) await synchronizuj(konto, klucze, oferta, produkt, ustawienia, batch, masoweZero);
        else if (oferta.stan !== 'sprawdzana') {
          zmien(oferta.id, { problemy: [{ kod: 'brak-w-odczycie', tekst: 'ERLI nie zwraca tego produktu w odczycie — sprawdź go w panelu ERLI.' }] });
        }
      } catch (e) {
        log(`oferty-erli: oferta ${oferta.id}: ${komunikat(e)}`);
      }
    }
    const paczki = [];
    if (migawka.wlaczone) {
      for (const podwyzka of [false, true]) {
        const grupa = batch.filter(b => (b.zmiany.stock != null && b.zmiany.stock > b.odczyt) === podwyzka);
        for (let i = 0; i < grupa.length; i += LIMIT_BATCH_ERLI) paczki.push(grupa.slice(i, i + LIMIT_BATCH_ERLI));
      }
    } else if (batch.length) paczki.push(batch);
    const liczniki = { batch: 0, stock: 0, cena: 0 };
    for (const [i, paczka] of paczki.entries()) {
      if (i) await czekaj(1000);
      await wyslijBatch(konto, klucze, paczka, liczniki);
    }
    log(`oferty-erli: konto ${konto.klucz}: batch ${liczniki.batch}, stock ${liczniki.stock}, cena ${liczniki.cena}`);
  }

  /** Wyjaśnienia tylko dla objętych ofert kont z listy, jednym zapytaniem (bez N+1). */
  function wyjasnieniaObjetych(klucze) {
    const granica = teraz().getTime() - HORYZONT_WYJASNIEN_MS;
    const wiersze = db.prepare(`SELECT id, kanal, id_zewnetrzne, karta_id, ilosc_wyslana_at FROM oferty_kanalow
      WHERE kanal IN (SELECT value FROM json_each(?)) AND (tryb = 'zarzadzana' OR ilosc_z_oms = 1)
        AND stan NOT IN ('szkic', 'blad')`).all(JSON.stringify(klucze));
    return wyjasnieniaOfert(db, wiersze.map(w => {
      const t = Date.parse(w.ilosc_wyslana_at);
      // Stare T nie wyznacza okna i dostaje zera wyjaśnień (z pollerem) — baza oferty zostaje (decyzja Szefa 14.11).
      const stare = Number.isFinite(t) && t < granica;
      return { id: Number(w.id), kanal: w.kanal, idZewnetrzne: w.id_zewnetrzne, kartaId: Number(w.karta_id),
        od: stare ? null : w.ilosc_wyslana_at, regula: 'zlozone' };
    }));
  }

  async function przebieg() {
    if (wToku) return;
    if (timer) { clearTimeout(timer); timer = null; }
    wToku = true;
    ostatniStart = teraz().getTime();
    try {
      const lista = konta();
      const klucze = lista.map(k => k.klucz);
      wyjasnienia = new Map(); chwilaMigawki = null; iloscPominieta = false;
      // D14: najpierw przełącznik — przy wyłączonych stanach żadnych dalszych zapytań ani nowych wyjątków.
      // Włączone: puls pollera i wyjaśnienia przed jedną wspólną migawką (D64). Błąd = ilość pominięta (D52),
      // treść, cena i nowe oferty idą dalej.
      try {
        const przelacznik = przelacznikStanow(db);
        if (!przelacznik.wlaczone) migawka = { ...przelacznik, stany: new Map(), znane: new Set(), zatwierdzenie: null };
        else {
          wyjasnienia = wyjasnieniaObjetych(klucze);
          chwilaMigawki = iso();
          migawka = migawkaStanow(db);
        }
      } catch (e) {
        log(`oferty-erli: migawka: ${komunikat(e)}`);
        iloscPominieta = true; wyjasnienia = new Map();
        migawka = { wlaczone: true, stany: new Map(), znane: new Set(), zatwierdzenie: null };
      }
      for (const konto of migawka.wlaczone ? [...lista].sort((a, b) => a.klucz.localeCompare(b.klucz)) : lista) {
        try { await przebiegKonta(konto, klucze); } catch (e) { log(`oferty-erli: konto ${konto.klucz}: ${komunikat(e)}`); }
      }
    } finally {
      wToku = false;
      if (poBiezacym) { poBiezacym = false; przyspiesz(); }
    }
  }

  function przyspiesz() {
    if (wToku) { poBiezacym = true; return; }
    if (timer) return;
    const odstep = Math.max(0, ostatniStart + 60_000 - teraz().getTime());
    timer = setTimeout(() => { timer = null; void przebieg().catch(e => log(`oferty-erli: ${komunikat(e)}`)); }, odstep);
    timer.unref?.();
  }

  return { przebieg, przyspiesz };
}

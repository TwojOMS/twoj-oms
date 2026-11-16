// Pętla stanów Woo. Dla każdego sklepu Woo z listy kont: oferty objęte ilością z OMS
// (`ilosc_z_oms = 1`), odczyt okresowy co ODCZYT_WOO_CO_MS i — przed każdą paczką zapisu — świeży odczyt tych
// pozycji, na którym liczą się rozjazd i podwyżka. Zapis tylko `stock_quantity` (pozycja bez
// własnego `manage_stock` dostaje problem, nie zapis). Każdy zapis przez `bramkaZapisu` (tylko odczyt).
// `ilosc_w_toku` zapisane przed wywołaniem sklepu; problemy do `ilosc_problem_json`.
import { przerwaPonowienia, bramkaZapisu } from './oferty-wspolne.js';
import { ofertaPoId, zmienOferte, ustawieniaOfertKonta } from '../../../oms/db/oferty-kanalow.ts';
import { migawkaStanow, przelacznikStanow, wyjasnieniaOfert } from '../../../oms/db/stany-magazynowe.js';
import { iloscDlaKanalu, ocenRozjazdu, skokIlosci, wolnoPodniesc, zeroMasowe, PROBLEMY_ILOSCI,
  liczySieDoZeraMasowego, potwierdzenieZerZuzyte, bezPotwierdzeniaZer, potwierdzenieZerWazne } from '../../../domena/ilosc-kanalu.js';

/** Odczyt okresowy stanu w sklepie, gdy nic nie wymaga świeżego odczytu wcześniej. */
export const ODCZYT_WOO_CO_MS = 15 * 60_000;
const HORYZONT_WYJASNIEN_MS = 7 * 24 * 3600_000;
const LIMIT_PACZKI_WOO = 100;
// Okno i pętla bez ofert w stanie szkic/blad; problem treści lub ceny nie blokuje ilości.
const OBJETE = "ilosc_z_oms = 1 AND stan NOT IN ('szkic', 'blad')";
const PEWNA_ODMOWA = ['WooInnyOrigin', 'WooKluczTylkoOdczyt', 'WooTylkoOdczyt'];
// Problemy, które znikają same, gdy sklep wróci do stanu prowadzonego i nieujemnego.
const SAMOCZYNNE = ['stan-rodzica', 'bez-stanu-w-sklepie', 'ujemny-stan'];
// Problemy oferty, której sklep nie prowadzi własnego stanu (manage_stock ≠ true).
const BEZ_STANU_SKLEPU = ['stan-rodzica', 'bez-stanu-w-sklepie'];
const komunikat = e => (e instanceof Error ? e.message : String(e));

/** `id_zewnetrzne` oferty Woo: `produkt` albo `rodzic/wariant`. */
export function adresWoo(idZewnetrzne) {
  const czesci = String(idZewnetrzne ?? '').split('/');
  if (czesci.length > 2 || !czesci.every(c => /^\d+$/.test(c))) return null;
  return czesci.length === 1 ? { rodzic: null, id: czesci[0] } : { rodzic: czesci[0], id: czesci[1] };
}

export function createPetlaStanowWoo({ db, konta, teraz = () => new Date(), log = () => {},
  pollerMs = 120_000, czekaj = ms => new Promise(resolve => setTimeout(resolve, ms)) }) {
  let wToku = false;
  let poBiezacym = false;
  let ostatniStart = -Infinity;
  let timer = null;
  let migawka;
  let wyjasnienia = new Map();
  // T = chwila tuż przed migawką — znacznik przy bazie i po sukcesie zapisu.
  let chwilaMigawki = null;
  const iso = () => teraz().toISOString();
  const za = ms => new Date(teraz().getTime() + ms).toISOString();
  const zmien = (id, zmiany) => zmienOferte(db, id, zmiany, { teraz: iso() });

  const celIlosci = (oferta, ustawienia) => iloscDlaKanalu({ migawka, kartaId: oferta.kartaId,
    tryb: oferta.tryb, iloscZOms: oferta.iloscZOms, bufor: ustawienia.buforSzt, stalaIlosc: ustawienia.stalaIlosc });
  const problemIlosci = (kod, cel, odczyt) => ({ ...PROBLEMY_ILOSCI[kod], od: iso(), cel, odczyt });

  /** Ocena na ŚWIEŻYM odczycie. Zwraca cel do zapisu albo null. */
  function ocenIlosc(oferta, produkt, ustawienia, masoweZero) {
    const { ilosc: cel, powod } = celIlosci(oferta, ustawienia);
    const swiezy = Number.isSafeInteger(produkt.stock_quantity) ? produkt.stock_quantity : null;
    const odczyt = swiezy;
    const odczytanoAt = iso();
    // Ujemny stan (backorders) nie trafia do `odczyt_ilosc` (CHECK ≥ 0) — tylko do ilości kanału i problemu.
    const ujemny = swiezy !== null && swiezy < 0;
    const zapis = { odczytIloscKanalu: swiezy, odczytanoAt, ...(ujemny ? {} : { odczytIlosc: swiezy }) };
    let problem = powod ? problemIlosci(powod, cel, odczyt) : null;
    let wolno = cel !== null && odczyt !== null;
    if (produkt.manage_stock !== true) {
      // `parent` = wariant bierze stan rodzica, `false` = sklep nie prowadzi stanu — nie zapisujemy.
      problem = problemIlosci(produkt.manage_stock === 'parent' ? 'stan-rodzica' : 'bez-stanu-w-sklepie', cel, odczyt);
      wolno = false;
    } else if (ujemny) {
      problem = problemIlosci('ujemny-stan', cel, odczyt);
      wolno = false;
    } else if (wolno) {
      const wyjasnienie = wyjasnienia.get(oferta.id) ?? {};
      const wspolne = { cel, odczyt, poller: wyjasnienie.poller, policzonoAt: chwilaMigawki, pollerMs };
      // Objęta po zapytaniu o wyjaśnienia — stary stan karty nie jest bazą skoku.
      const nowoObjeta = !wyjasnienia.has(oferta.id);
      const stanKartyWyslany = nowoObjeta ? null : oferta.stanKartyWyslany;
      if (nowoObjeta && oferta.stanKartyWyslany != null) zapis.stanKartyWyslany = null;
      const rozjazd = ocenRozjazdu({ ...wspolne, wyslanaIlosc: oferta.wyslanaIlosc,
        wyjasnienie, wToku: oferta.iloscWToku, odczytanoAt,
        alarmOd: ['karencja', 'rozjazd-dol'].includes(oferta.iloscProblem?.kod) ? oferta.iloscProblem.od : null });
      const stanTeraz = migawka.stany.get(oferta.kartaId)?.stan;
      if (rozjazd.baza) {
        Object.assign(zapis, rozjazd.baza, { iloscWyslanaAt: chwilaMigawki, iloscWToku: null });
        // Zgodny odczyt rozstrzyga nieznany wynik — stary termin ponowienia i błąd nie wstrzymują następnej zmiany.
        if (oferta.liczbaProb || oferta.nastepnaProbaAt || oferta.blad) Object.assign(zapis, { liczbaProb: 0, nastepnaProbaAt: null, blad: null });
        if (stanKartyWyslany != null && Number.isFinite(stanTeraz)) zapis.stanKartyWyslany = stanTeraz;
      }
      problem = rozjazd.problem;
      wolno = rozjazd.wolnoWyslac;
      const skok = skokIlosci({ stan: stanTeraz, stanKartyWyslany, wyjasnioneKarty: wyjasnienie.wyjasnioneKarty,
        prog: ustawienia.progSkokuSzt, od: iso(), cel, odczyt });
      const podwyzka = wolnoPodniesc({ ...wspolne,
        poprzedniOdczyt: { ilosc: oferta.odczytIloscKanalu, odczytanoAt: oferta.odczytanoAt } });
      if (!podwyzka.wolno) { wolno = false; problem ??= problemIlosci(podwyzka.powod, cel, odczyt); }
      if (skok) { problem = skok; wolno = false; }
      if (masoweZero && liczySieDoZeraMasowego(oferta, migawka)) { wolno = false; if (cel === 0 && odczyt > 0) problem = problemIlosci('zero-masowe', cel, odczyt); }
    }
    // Potwierdzenie zer zużyte (sklep ma 0 albo cel > 0) — zdjęte; nieważne (inne przełączenie) też.
    if (oferta.wyslanePola?.zeraPotwierdzone && (!potwierdzenieZerWazne(oferta, migawka) || potwierdzenieZerZuzyte({ cel, odczyt }))) {
      zapis.wyslanePola = bezPotwierdzeniaZer(oferta.wyslanePola);
    }
    // Alarm wymaga decyzji człowieka; przy `rozjazd-gora` wolno tylko obniżyć.
    if (oferta.iloscProblem?.wstrzymuje && !SAMOCZYNNE.includes(oferta.iloscProblem.kod)) {
      problem = oferta.iloscProblem;
      if (problem.kod !== 'rozjazd-gora' || cel > odczyt) wolno = false;
    }
    zmien(oferta.id, { ...zapis, iloscProblem: problem });
    return wolno && cel !== odczyt ? cel : null;
  }

  /** Odczyt pogrupowany po rodzicu; błąd jednej grupy nie zatrzymuje innych. */
  async function odczytaj(konto, oferty) {
    const grupy = new Map();
    for (const o of oferty) {
      const adres = adresWoo(o.idZewnetrzne);
      if (!adres) { log(`stany-woo: oferta ${o.id}: niepoprawny identyfikator Woo`); continue; }
      const klucz = adres.rodzic ?? '';
      if (!grupy.has(klucz)) grupy.set(klucz, []);
      grupy.get(klucz).push({ oferta: o, adres });
    }
    const odczytane = new Map();
    for (const [rodzic, lista] of grupy) {
      try {
        const ids = lista.map(p => p.adres.id);
        const dane = rodzic === '' ? await konto.klient.pobierzStany(ids) : await konto.klient.pobierzStanyWariantow(rodzic, ids);
        const poId = new Map(dane.map(p => [String(p?.id), p]));
        for (const { oferta, adres } of lista) {
          const produkt = poId.get(adres.id);
          if (produkt) odczytane.set(oferta.id, { produkt, adres });
        }
      } catch (e) {
        log(`stany-woo: konto ${konto.klucz}: odczyt ${rodzic ? `wariantów ${rodzic}` : 'produktów'}: ${komunikat(e)}`);
      }
    }
    return odczytane;
  }

  /** Bramka dla każdej pozycji → wiersze (próby, termin, ilość w toku) → dopiero wtedy batch sklepu. */
  async function wyslijPaczke(konto, klucze, { rodzic, pozycje }, liczniki) {
    const ustawienia = ustawieniaOfertKonta(db, konto.klucz);
    const bramkaKonta = { klucz: konto.klucz, tylkoOdczyt: () => konto.klient?.tylkoOdczyt === true };
    const dozwolone = pozycje.filter(b => {
      const oferta = ofertaPoId(db, b.id);
      const decyzja = bramkaZapisu({ konto: bramkaKonta, ustawienia, klucze, kanal: 'Woo', zakres: 'ilosc',
        oferta: oferta && { ...oferta, ilosc_z_oms: oferta.iloscZOms ? 1 : 0 } });
      if (!decyzja.wolno) log(`stany-woo: oferta ${b.id}: ${decyzja.powod}`);
      return decyzja.wolno;
    });
    if (!dozwolone.length) return;
    for (const b of dozwolone) {
      zmien(b.id, { liczbaProb: b.proby, nastepnaProbaAt: za(przerwaPonowienia(b.proby)), iloscWToku: { cel: b.cel, at: iso() } });
    }
    liczniki.zapis++;
    liczniki.stock += dozwolone.length;
    let wynik;
    try {
      wynik = await konto.klient.zapiszStanyHurtem(rodzic, dozwolone.map(b => ({ id: Number(b.adres.id), stock_quantity: b.cel })));
    } catch (e) {
      // Pewna odmowa (klucz tylko do odczytu, inny origin) — cel w toku znika; inny błąd = wynik nieznany.
      const pewna = PEWNA_ODMOWA.includes(e?.name);
      for (const b of dozwolone) zmien(b.id, { blad: komunikat(e), ...(pewna ? { iloscWToku: null } : {}) });
      return;
    }
    const poId = new Map((Array.isArray(wynik) ? wynik : []).map(w => [String(w?.id), w]));
    for (const b of dozwolone) {
      const w = poId.get(b.adres.id);
      // Klient Woo nie odróżnia odmowy od zerwanej paczki — cel w toku zostaje, następny świeży odczyt rozstrzygnie.
      if (!w?.ok) { zmien(b.id, { blad: w?.blad ?? 'Brak wyniku zapisu stanu Woo' }); continue; }
      // Zapisane 0 zużywa potwierdzenie „Wyślij zera”.
      const wp = b.cel === 0 ? ofertaPoId(db, b.id)?.wyslanePola : null;
      zmien(b.id, { wyslanaIlosc: b.cel, iloscWToku: null, iloscWyslanaAt: chwilaMigawki,
        stanKartyWyslany: migawka.stany.get(b.kartaId)?.stan ?? null, liczbaProb: 0, nastepnaProbaAt: null, blad: null,
        ...(wp?.zeraPotwierdzone ? { wyslanePola: bezPotwierdzeniaZer(wp) } : {}) });
    }
  }

  async function przebiegKonta(konto, klucze) {
    const ustawienia = ustawieniaOfertKonta(db, konto.klucz);
    if (!ustawienia.czynne) { log(`stany-woo: konto ${konto.klucz}: wstrzymane`); return; }
    const oferty = db.prepare(`SELECT id FROM oferty_kanalow WHERE kanal = ? AND ${OBJETE} ORDER BY id`)
      .all(konto.klucz).map(w => ofertaPoId(db, Number(w.id))).filter(Boolean);
    const terazMs = teraz().getTime();
    const doOdczytu = oferty.filter(o => {
      const termin = !o.odczytanoAt || !(terazMs - Date.parse(o.odczytanoAt) < ODCZYT_WOO_CO_MS);
      const { ilosc: cel, powod } = celIlosci(o, ustawienia);
      // Brak-stanu zapisany i zdjęty jak w ERLI — bez czekania na termin odczytu; potwierdzenie zer rozstrzyga świeży odczyt.
      // Tylko ważne potwierdzenie (bieżące przełączenie stanów) wymusza odczyt.
      const brakStanuZapisany = o.iloscProblem?.kod === 'brak-stanu';
      const brakStanuDoZmiany = powod === 'brak-stanu' ? !brakStanuZapisany && !o.iloscProblem?.wstrzymuje : brakStanuZapisany;
      return termin || o.iloscWToku != null || (cel != null && (cel !== o.odczytIloscKanalu || cel !== o.wyslanaIlosc))
        || brakStanuDoZmiany || potwierdzenieZerWazne(o, migawka);
    });
    const odczytane = doOdczytu.length ? await odczytaj(konto, doOdczytu) : new Map();
    let zero;
    // Mianownik tylko z ofert prowadzących stan w sklepie (manage_stock === true) z odczytem ≥ 0. Oferta
    // bez świeżego odczytu w tym przebiegu liczy się z poprzednim odczytem, o ile nie ma problemu „bez stanu”.
    const prowadziStan = o => {
      const swiezy = odczytane.get(o.id)?.produkt;
      const odczyt = swiezy ? swiezy.stock_quantity : o.odczytIloscKanalu;
      const zarzadza = swiezy ? swiezy.manage_stock === true : !BEZ_STANU_SKLEPU.includes(o.iloscProblem?.kod);
      return zarzadza && Number.isSafeInteger(odczyt) && odczyt >= 0;
    };
    const masoweZero = () => (zero ??= zeroMasowe(oferty.filter(o => prowadziStan(o) && liczySieDoZeraMasowego(o, migawka)).map(o => ({ cel: celIlosci(o, ustawienia).ilosc,
      odczyt: odczytane.has(o.id) ? odczytane.get(o.id).produkt.stock_quantity : o.odczytIloscKanalu }))));
    /** Ocena na świeżym odczycie → pozycja paczki albo null. `oferta` = wiersz sprzed przebiegu (poprzedni odczyt). */
    const pozycja = (oferta, { produkt, adres }) => {
      try {
        const cel = ocenIlosc(oferta, produkt, ustawienia, masoweZero());
        if (cel === null) return null;
        const po = ofertaPoId(db, oferta.id);
        // Termin ponowienia jednej oferty nie wstrzymuje pozostałych.
        if (po.liczbaProb > 0 && po.nastepnaProbaAt && Date.parse(po.nastepnaProbaAt) > terazMs) return null;
        return { id: oferta.id, oferta, adres, cel, odczyt: produkt.stock_quantity, kartaId: oferta.kartaId, proby: po.liczbaProb + 1 };
      } catch (e) {
        log(`stany-woo: oferta ${oferta.id}: ${komunikat(e)}`);
        return null;
      }
    };
    /** Przed każdą kolejną paczką świeży odczyt jej pozycji i ocena od nowa (pierwsza ma odczyt sprzed chwili). */
    const odswiez = async paczka => {
      const swieze = await odczytaj(konto, paczka.pozycje.map(b => b.oferta));
      return { rodzic: paczka.rodzic, pozycje: paczka.pozycje.map(b => swieze.has(b.id) ? pozycja(b.oferta, swieze.get(b.id)) : null).filter(Boolean) };
    };
    const batch = [];
    for (const [id, odczyt] of odczytane) {
      const oferta = ofertaPoId(db, id);
      if (!oferta?.iloscZOms) continue;
      const b = pozycja(oferta, odczyt);
      if (b) batch.push(b);
    }
    // Obniżki przed podwyżkami, jedna paczka na rodzica, najwyżej 100 pozycji.
    const paczki = [];
    for (const podwyzka of [false, true]) {
      const poRodzicu = new Map();
      for (const b of batch.filter(b => (b.cel > b.odczyt) === podwyzka)) {
        const r = b.adres.rodzic;
        if (!poRodzicu.has(r)) poRodzicu.set(r, []);
        poRodzicu.get(r).push(b);
      }
      for (const [rodzic, lista] of poRodzicu) {
        for (let i = 0; i < lista.length; i += LIMIT_PACZKI_WOO) paczki.push({ rodzic, pozycje: lista.slice(i, i + LIMIT_PACZKI_WOO) });
      }
    }
    const liczniki = { zapis: 0, stock: 0 };
    for (const [i, paczka] of paczki.entries()) {
      if (i) await czekaj(1000);
      const swieza = i ? await odswiez(paczka) : paczka;
      if (swieza.pozycje.length) await wyslijPaczke(konto, klucze, swieza, liczniki);
    }
    log(`stany-woo: konto ${konto.klucz}: odczyt ${odczytane.size}, zapis ${liczniki.zapis}, stock ${liczniki.stock}`);
  }

  /** Wyjaśnienia objętych ofert wszystkich kont jednym zapytaniem; stare T (poza horyzontem) → zera. */
  function wyjasnieniaObjetych(klucze) {
    const granica = teraz().getTime() - HORYZONT_WYJASNIEN_MS;
    const wiersze = db.prepare(`SELECT id, kanal, id_zewnetrzne, karta_id, ilosc_wyslana_at FROM oferty_kanalow
      WHERE kanal IN (SELECT value FROM json_each(?)) AND ${OBJETE}`).all(JSON.stringify(klucze));
    return wyjasnieniaOfert(db, wiersze.map(w => {
      const t = Date.parse(w.ilosc_wyslana_at);
      // Horyzont ogranicza tylko okno zapytania — W zostaje, wyjaśnienia są zerowe.
      const stare = Number.isFinite(t) && t < granica;
      return { id: Number(w.id), kanal: w.kanal, idZewnetrzne: w.id_zewnetrzne, kartaId: Number(w.karta_id),
        od: stare ? null : w.ilosc_wyslana_at, regula: 'zmienione' };
    }));
  }

  async function przebieg() {
    if (wToku) return;
    if (timer) { clearTimeout(timer); timer = null; }
    wToku = true;
    ostatniStart = teraz().getTime();
    try {
      wyjasnienia = new Map(); chwilaMigawki = null;
      let przelacznik;
      try { przelacznik = przelacznikStanow(db); } catch (e) { log(`stany-woo: przełącznik: ${komunikat(e)}`); return; }
      // Stany wyłączone → żadnego żądania do sklepu i żadnej linii logu
      // (instalacja z wyłączonymi stanami nie może mieć nowego wpisu co 5 min).
      if (!przelacznik.wlaczone) return;
      const lista = [...konta()].sort((a, b) => a.klucz.localeCompare(b.klucz));
      const klucze = lista.map(k => k.klucz);
      try {
        wyjasnienia = wyjasnieniaObjetych(klucze);
        chwilaMigawki = iso();
        migawka = migawkaStanow(db);
      } catch (e) {
        log(`stany-woo: migawka: ${komunikat(e)}`);
        return;
      }
      for (const konto of lista) {
        try { await przebiegKonta(konto, klucze); } catch (e) { log(`stany-woo: konto ${konto.klucz}: ${komunikat(e)}`); }
      }
    } finally {
      wToku = false;
      if (poBiezacym) { poBiezacym = false; przyspiesz(); }
    }
  }

  /** Przebieg najwcześniej minutę po poprzednim starcie; w trakcie przebiegu — zaraz po nim. */
  function przyspiesz() {
    if (wToku) { poBiezacym = true; return; }
    if (timer) return;
    const odstep = Math.max(0, ostatniStart + 60_000 - teraz().getTime());
    timer = setTimeout(() => { timer = null; void przebieg().catch(e => log(`stany-woo: ${komunikat(e)}`)); }, odstep);
    timer.unref?.();
  }

  return { przebieg, przyspiesz };
}

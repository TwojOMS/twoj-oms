import { etykietyStatusow } from '../../../oms/db/statusy.js';
import {
  listaKampanii, zamowieniaZKuponami, zamowieniaZAtrybucjaKampanii, metaDni, ga4Dni, stanyZrodel,
} from '../../../oms/db/kampanie.js';
import {
  wybierzKampanie, stanKampanii, agregatKuponow, dolaczZrodla,
  dolaczZamowieniaZReklam, alertyKampanii, faleKampanii,
} from '../../../domena/kampania.js';
import { dzienWarszawa } from '../../../domena/format-daty.js';
import { kluczOkresu } from '../../../domena/okres-rozliczeniowy.js';
import { adresKanalu } from '../../../domena/kanaly.js';
import {
  polaczenia as polaczeniaReklam, dni as dniReklam, transakcje as transakcjeReklam,
  stanPolaczenia, metaKampanie, potwierdzoneZamowienia,
} from '../../../oms/db/reklamy.js';
import { podsumujReklamy } from '../../../domena/reklamy.js';

// Zakladka /kampania (WRZESIEN30, 2026-08-25). Trasa jest CIENKA — wzorzec
// routes/raporty.js: wybiera kampanie, wola domene, renderuje. Etap 0 liczy WYLACZNIE
// z wlasnej bazy (zamowienia.kupony_json) — ani jednego zapytania na zewnatrz, wiec nie
// potrzebuje ani `config`, ani zadnej uslugi. Sekcje GA4/Meta to osobne etapy i osobne
// czuwacze, NIE zapytania w trasie: panel nie moze wisiec na dostepnosci Google i Mety.

const WZORZEC_DNIA = /^\d{4}-\d{2}-\d{2}$/;

// ⚠️ CZAS WARSZAWSKI, nie UTC — ta sama funkcja i ten sam powod, co przy /raporty:
// w nocy `toISOString()` pokazuje jeszcze dzien poprzedni, a „dzien 2 z 15" na naglowku
// ma sie zgadzac z kalendarzem na scianie.
const dzisiaj = () => dzienWarszawa(new Date().toISOString());

// Dzien odniesienia z parametru (podglad historyczny i testy) albo dzis.
// ⚠️ Walidacje robi `kluczOkresu`, NIE `new Date` — V8 cicho przewija 30 lutego na
// 2 marca (ta sama pulapka i to samo lekarstwo, co w routes/raporty.js).
function dzienOdniesienia(surowy) {
  if (typeof surowy !== 'string' || !WZORZEC_DNIA.test(surowy.trim())) return dzisiaj();
  try { kluczOkresu(surowy.trim()); } catch { return dzisiaj(); }
  return surowy.trim();
}

const WIDOKI_REKLAM = new Set(['podsumowanie', 'google', 'meta', 'kampanie']);

function poczatekOkresu(dzis, liczbaDni) {
  const data = new Date(`${dzis}T00:00:00Z`);
  data.setUTCDate(data.getUTCDate() - liczbaDni + 1);
  return data.toISOString().slice(0, 10);
}

function stanZPolaczen(lista, stany) {
  if (!lista.length) return 'niepodłączone';
  if (stany.some((stan) => stan?.ostatniSukcesAt && !stan.kodBledu)) return 'działa';
  if (stany.some((stan) => stan?.kodBledu === 'BRAK_UPRAWNIEN')) return 'brak uprawnień';
  if (stany.some((stan) => stan?.kodBledu)) return 'błąd';
  return 'weryfikacja';
}

function daneReklam(db, kampanie, dzis, widok, liczbaDni) {
  const od = poczatekOkresu(dzis, liczbaDni);
  const polaczenia = polaczeniaReklam(db);
  const dla = (typ) => polaczenia.filter((p) => p.typ === typ);
  const stany = new Map(polaczenia.map((p) => [p.id, stanPolaczenia(db, p.id)]));
  const odczyty = (typ) => dla(typ).map((p) => ({
    typ, kontoId: p.kontoId, kanal: p.kanal, waluta: p.waluta, strefa: p.strefa,
    stan: stanZPolaczen([p], [stany.get(p.id)]),
    ostatniSukcesAt: stany.get(p.id)?.ostatniSukcesAt ?? null,
    kodBledu: stany.get(p.id)?.kodBledu ?? null,
  }));
  const google = dniReklam(db, { typ: 'ga4', od, do: dzis });
  const meta = dniReklam(db, { typ: 'meta', od, do: dzis });
  const transakcje = transakcjeReklam(db, { od, do: dzis });
  const ga4 = dla('ga4');
  let zamowienia;
  if (ga4.length && ga4.every((p) => p.kanal)) {
    const wyniki = ga4.map((p) => ({ p, wynik: potwierdzoneZamowienia(db, {
      polaczenieId: p.id,
      transactionIds: transakcje.filter((t) => t.polaczenieId === p.id).map((t) => t.transactionId),
    }) }));
    if (wyniki.every(({ wynik }) => wynik.przychod !== null || wynik.powod === 'BRAK_KWOTY_NETTO')) {
      zamowienia = wyniki.flatMap(({ p, wynik }) => wynik.zamowienia
        .map((z) => ({ ...z, polaczenieId: p.id, waluta: p.waluta })));
    }
  }
  const raport = podsumujReklamy({ google, meta, transakcje, zamowienia,
    stany: { ga4: stanZPolaczen(ga4, ga4.map((p) => stany.get(p.id))),
      meta: stanZPolaczen(dla('meta'), dla('meta').map((p) => stany.get(p.id))) },
    od, do: dzis, dzis });
  const metaInfo = new Map(metaKampanie(db).map((k) => [`${k.polaczenieId}|${k.kampaniaId}`, k]));
  raport.meta.kampanie = raport.meta.kampanie.map((k) => ({ ...k,
    szczegoly: metaInfo.get(`${k.polaczenieId}|${k.kampaniaId}`) ?? null }));
  const obecneMeta = new Set(raport.meta.kampanie.map((k) => `${k.polaczenieId}|${k.kampaniaId}`));
  for (const [klucz, k] of metaInfo) {
    if (obecneMeta.has(klucz)) continue;
    raport.meta.kampanie.push({
      polaczenieId: k.polaczenieId, kampaniaId: k.kampaniaId, nazwa: k.nazwa || k.kampaniaId,
      waluta: k.waluta, koszt: null, klikniecia: null, wyswietlenia: null,
      emituje: false, szczegoly: k,
    });
  }
  const promocyjne = {
    trwajace: kampanie.filter((k) => k.od_dnia <= dzis && dzis <= k.do_dnia),
    archiwum: kampanie.filter((k) => k.do_dnia < dzis),
    nadchodzace: kampanie.filter((k) => k.od_dnia > dzis),
  };
  return { raport, polaczenia: {
    ga4: odczyty('ga4'), google_ads: odczyty('google_ads'), meta: odczyty('meta'),
  }, promocyjne, widok, liczbaDni, dzis };
}

export function zarejestrujTrasyKampanii(app, { db, config = {}, definicje, czuwaczKampanii = null, czuwaczReklam = null }) {
  app.post('/kampania/odswiez-reklamy', async (_req, reply) => {
    if (!czuwaczReklam) return reply.code(503).send('Odczyt reklam nie jest dostępny.');
    await czuwaczReklam.przebieg();
    return reply.redirect('/kampania', 303);
  });
  // ⚠️ „ODSWIEZ TERAZ" ISTNIEJE Z JEDNEGO POWODU: zegar chodzi co godzine, wiec bez tego
  // przycisku pierwsze liczby po wdrozeniu (albo po poprawieniu klucza) pojawialyby sie
  // dopiero po godzinie — a czlowiek stoi przy ekranie WLASNIE wtedy, gdy cos zmienil.
  // Ten sam uklad, co „Odśwież teraz" przy kosztach z KSeF.
  //
  // ⚠️ Awaria zrodla NIE gasi ekranu: lustro ma poprzedni stan, a czuwacz zapisal juz
  // powod do `kampania_zrodla`, wiec sekcja i tak go pokaze. Tutaj przekierowujemy
  // z powrotem na ekran (PRG) — dwa zdania o jednej awarii na jednym ekranie byłyby
  // gorsze niż jedno.
  app.post('/kampania/odswiez', async (req, reply) => {
    if (!czuwaczKampanii) {
      return reply.code(503).send('Panel nie ma podpiętej ani Mety, ani GA4 — nie ma czego odświeżać.');
    }
    try {
      await czuwaczKampanii.przebieg();
    } catch {
      // Powód i tak wylądował w `kampania_zrodla` — ekran go pokaże przy właściwym źródle.
    }
    const kod = typeof req.body?.kampania === 'string' && req.body.kampania
      ? `?kampania=${encodeURIComponent(req.body.kampania)}`
      : '';
    // Fastify 5: `redirect(adres, kod)`. Stara kolejnosc `(303, adres)` konczy sie tu 500,
    // bo adres trafia do `code()` — pilnuja tego dwa testy w web-kampania.test.js.
    return reply.redirect(`/kampania${kod}`, 303);
  });

  app.get('/kampania', async (req, reply) => {
    const kampanie = listaKampanii(db);
    const dzis = dzienOdniesienia(req.query?.dzien);
    const szukanyKod = req.query?.kampania || null;
    if (!szukanyKod) {
      const widok = WIDOKI_REKLAM.has(req.query?.widok) ? req.query.widok : 'podsumowanie';
      const liczbaDni = String(req.query?.okres) === '30' ? 30 : 7;
      return reply.view('reklamy.ejs', { title: 'Reklamy',
        ...daneReklam(db, kampanie, dzis, widok, liczbaDni), mozliweOdswiezenieReklam: Boolean(czuwaczReklam) });
    }
    const kampania = wybierzKampanie(kampanie, dzis, szukanyKod);
    const zamowienia = zamowieniaZKuponami(db);
    // ⚠️ Liczby z Mety i GA4 przychodza z LUSTRA (Etapy 1-2), nigdy z zapytania w trasie —
    // ekran ma sie wyrenderowac tak samo szybko przy padnietym Google, jak przy dzialajacym.
    // Ten sam uklad, co zakladka KOSZTY wobec KSeF.
    const meta = kampania ? metaDni(db, kampania.kod) : [];
    const stan = kampania
      ? dolaczZamowieniaZReklam(
        dolaczZrodla(stanKampanii({ kampania, zamowienia, dzis }), {
          meta,
          ga4: ga4Dni(db, kampania.kod),
          stany: stanyZrodel(db),
        }),
        // Drugi licznik kampanii: zamowienia z utm_campaign — takze bez kodu rabatowego.
        { kampania, zamowieniaUtm: zamowieniaZAtrybucjaKampanii(db) },
      )
      : null;
    // Ciemna wizualizacja kampanii jest zawartością wspólnej ramy OMS. Jej własne zmienne
    // i skrypt prezentacyjny są ograniczone do `.strona-kampania`; nagłówek, konto i
    // nawigacja pochodzą z layout-oms.ejs tak samo jak na pozostałych ekranach.
    return reply.view('kampania.ejs', {
      title: 'Kampania',
      kampanie,
      kampania,
      dzis,
      szukanyKod,
      stan,
      // Alerty kontrolne — liczone z tego, co ekran i tak ma; pusta lista = spokoj.
      alerty: stan ? alertyKampanii({ stan, meta, dzis }) : [],
      // Etapy kampanii (prowadnice wykresu pieniedzy) — z wiersza kampanii, przez domene.
      fale: kampania ? faleKampanii(kampania) : [],
      agregat: agregatKuponow(zamowienia),
      etykiety: etykietyStatusow(db),
      // PRZ-063: etykiety kanałów z definicji instalacji (PRZ-053: bez globalnej mapy firmy).
      adresKanalu: (sklep) => adresKanalu(sklep, definicje),
      // ⚠️ „NIESKONFIGUROWANE" TO CO INNEGO NIZ „ZERO" I NIZ „AWARIA" — a w tabeli wszystkie
      // trzy wygladaja tak samo (brak wierszy). Bez tej pary flag ekran nie umialby napisac,
      // czy czekac na dane, czy wpisac klucz do `.env.oms`.
      zrodlaWlaczone: { meta: Boolean(config.meta), ga4: Boolean(config.ga4) },
      // Przycisk „Odśwież teraz" pokazuje się WYŁĄCZNIE, gdy jest co odświeżać — inaczej
      // klikałby w trasę oddającą 503, czyli w cichy błąd.
      mozliweOdswiezenie: Boolean(czuwaczKampanii),
    });
  });
}

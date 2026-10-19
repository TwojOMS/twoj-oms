// ZAKLADKA /przesylki (pomysl właściciela 23.08, razem z zegarem sledzenia). Jedna lista paczek
// zamiast otwierania kart po kolei: kurier, numer, ETAP z dniami w drodze, ostatni ruch
// i filtr „bez ruchu" (>3 dni robocze — prog z domain/etap-przesylki.js, wspolny ze sprawa
// na pasku „Do zalatwienia" karty).
//
// Etap liczy TA SAMA regula, co pastylka na karcie i selekcja czuwacza — zadnej drugiej
// kopii. Okno listy = 60 dni wstecz: dwa razy dluzsze niz okno zegara, zeby paczka, ktora
// wypadla z odpytywania, nie znikala tez z oczu.

import {
  przesylkiDoSledzenia, pobierzPrzesylke, ukryjPrzesylke, przywrocPrzesylke,
} from '../db/przesylki.js';
import { dopiszLog } from '../../../oms/db/zamowienia.js';
import { przesylkaUkryta } from '../../../domena/przesylka-stan.js';
import { nazwaDostawy } from '../../../domena/wysylka.js';
import { przewoznikWiersza, adresSledzenia } from '../../../domena/przewoznik-przesylki.js';
import { dzienWarszawa } from '../../../domena/format-daty.js';
import { podjazdPoTerminie } from '../../../domena/podjazdy.js';
import { ktoKlikal } from '../../zamowienia/lista.js';
import {
  etapPrzesylki, etykietaEtapu, dniKalendarzowe, bezRuchu, kategoriaPrzesylki,
} from '../../../domena/etap-przesylki.js';

const OKNO_LISTY_DNI = 60;
const WZORZEC_DATY = /^\d{4}-\d{2}-\d{2}$/;

const POKAZ = ['utworzone', 'w_drodze', 'bez_ruchu', 'doreczone', 'ukryte', 'wszystkie'];

function tekst(surowy) {
  if (typeof surowy !== 'string') return null;
  const s = surowy.trim();
  return s || null;
}

function data(surowa) {
  const s = tekst(surowa);
  if (!s || !WZORZEC_DATY.test(s)) return null;
  // ⚠️ Sam ksztalt RRRR-MM-DD NIE WYSTARCZA i `dzienWarszawa` tego nie domyka: dla
  // „2026-02-30" oddaje z powrotem „2026-02-30", bo formatuje tekst, a nie sprawdza
  // kalendarz. Porownanie skladowych z `Date.UTC` lapie 30 lutego i 31 kwietnia —
  // przez formularz `<input type="date">` nie wejda, ale przez recznie sklejony adres tak,
  // a wtedy filtr po cichu oddaje pusta liste zamiast powiedziec, ze data jest bledna.
  const [rok, miesiac, dzien] = s.split('-').map(Number);
  const d = new Date(Date.UTC(rok, miesiac - 1, dzien));
  const istnieje = d.getUTCFullYear() === rok
    && d.getUTCMonth() === miesiac - 1
    && d.getUTCDate() === dzien;
  return istnieje ? s : null;
}

function parseFiltry(source = {}) {
  const od = data(source?.od);
  const doDnia = data(source?.do);
  if ((source?.od || source?.do) && (!od || !doDnia)) {
    return {
      blad: 'Niepoprawna data: parametry od, do muszą być poprawnymi datami w formacie RRRR-MM-DD.',
    };
  }
  if (od && doDnia && od > doDnia) {
    return { blad: 'Niepoprawny zakres: parametr od nie może być późniejszy niż do.' };
  }
  return {
    od,
    do: doDnia,
    kurier: tekst(source?.kurier),
    sklep: tekst(source?.sklep),
  };
}

// PRZ-066 (zgoda właściciela 13.10): domyślnie „Utworzone” — paczki czekające na odbiór kuriera.
const DOMYSLNY_POKAZ = 'utworzone';

function adresPrzesylki({ pokaz = DOMYSLNY_POKAZ, od = null, do: doDnia = null, kurier = null, sklep = null }) {
  const czesci = [];
  if (pokaz) czesci.push(['pokaz', pokaz]);
  if (od) czesci.push(['od', od]);
  if (doDnia) czesci.push(['do', doDnia]);
  if (kurier) czesci.push(['kurier', kurier]);
  if (sklep) czesci.push(['sklep', sklep]);
  if (!czesci.length) return '/przesylki';
  return `/?${czesci.map(([k, w]) => `${k}=${encodeURIComponent(w)}`).join('&')}`.replace('/?', '/przesylki?');
}

// Przesuniecie o cale DNI KALENDARZOWE, na tekscie `RRRR-MM-DD`, nie na znaczniku czasu.
//
// ⚠️ Liczone przez `Date.UTC` z samych skladowych dnia i z powrotem — bez godziny, wiec
// zmiana czasu nie ma tu czego zepsuc. Odejmowanie 6×24 h od znacznika DAWALOBY zly dzien
// w dobe przestawienia zegara (25.10.2026 ma 25 godzin), a skrot „ostatnie 7 dni" pokazalby
// wtedy osiem albo szesc.
function przesunDni(dzien, oIle) {
  const [rok, miesiac, dzienMiesiaca] = dzien.split('-').map(Number);
  const d = new Date(Date.UTC(rok, miesiac - 1, dzienMiesiaca + oIle));
  return d.toISOString().slice(0, 10);
}

function pasujeNaFiltr(d, filtry) {
  if (filtry.od || filtry.do) {
    // ⚠️ `utworzona_at`, a NIE caly wiersz. Podanie wiersza wywala zakladke bledem
    // „Cannot convert object to primitive value" — nie pusta lista, tylko 500, i to na
    // kazdym uzyciu filtra daty. Dzien liczy `dzienWarszawa`, ta sama funkcja co przy
    // filtrach listy zamowien (niezmiennik 4.13b): znaczniki przesylek sa w UTC, a operator
    // filtruje dniami warszawskimi — paczka z 23:30 UTC nalezy juz do nastepnego dnia.
    const dzien = dzienWarszawa(d.utworzona_at);
    if (!dzien) return false;
    if (filtry.od && dzien < filtry.od) return false;
    if (filtry.do && dzien > filtry.do) return false;
  }
  // PRZ-067: filtr po PRAWDZIWYM przewozniku (klucz z domena/przewoznik-przesylki.js), a nie po
  // kodzie drogi nadania. „DPD" ma pokazac tez paczki Allegro jadace DPD. Nieznany klucz (np.
  // stara zakladka `?kurier=allegro_wza`) nie pasuje do niczego — widok mowi o tym wprost.
  if (filtry.kurier && d.przewoznik?.klucz !== filtry.kurier) return false;
  if (filtry.sklep && d.sklep !== filtry.sklep) return false;
  return true;
}

export function registerPrzesylkiRoutes(app, { db }) {
  app.get('/przesylki', async (req, reply) => {
    const filtry = parseFiltry(req.query);
    if (filtry.blad) return reply.code(400).send(filtry.blad);

    const teraz = new Date();
    const dzisWarszawa = dzienWarszawa(teraz.toISOString());
    const odIso = new Date(teraz.getTime() - OKNO_LISTY_DNI * 24 * 3600 * 1000).toISOString();
    const pokaz = POKAZ.includes(req.query?.pokaz) ? req.query.pokaz : DOMYSLNY_POKAZ;
    // ⚠️ Filtr daty ROZSZERZA okno listy poza domyslne 60 dni — bez tego „pokaz mi marzec"
    // oddawaloby pustke i filtr bylby ozdoba.
    //
    // ⚠️⚠️ Doba zapasu, bo to ciecie jest ZGRUBNE i liczone w UTC, a operator filtruje
    // dniami WARSZAWSKIMI. Paczka z 24.08 23:30 UTC nalezy do 25.08 czasu warszawskiego;
    // proste `${od}T00:00:00.000Z` wycinaloby ja w SQL, zanim `pasujeNaFiltr` zdazyloby
    // policzyc dzien po warszawsku — czyli filtr gubilby wieczorne paczki z pierwszego dnia
    // zakresu i nikt by tego nie zauwazyl poza dniem, w ktorym akurat nadano cos po 22:00.
    // Dokladne ciecie robi `pasujeNaFiltr`; SQL ma tylko nie odciac za duzo.
    const bazaOd = filtry.od
      ? new Date(`${filtry.od}T00:00:00.000Z`).getTime() - 24 * 3600 * 1000
      : null;
    const bazaOdIso = bazaOd === null ? odIso : new Date(bazaOd).toISOString();

    const numery = new Map(db.prepare(`
      SELECT id, numer, sklep, metoda_wysylki, metoda_wysylki_nazwa, pobranie, wysylka_reczna_json
      FROM zamowienia
    `).all().map((z) => [z.id, z]));

    // ⚠️ SUROWE trzymamy osobno, bo listy rozwijane filtrow musza pochodzic z PELNEGO
    // zbioru, a nie z tego, co zostalo po zawezeniu (niezmiennik 4.13b — lista wartosci
    // filtra nigdy nie jest wpisana na sztywno ani przyciete do biezacego wyniku).
    // Lista budowana po filtrze zatrzaskuje operatora: wybral DPD, wiec w rozwijanym
    // zostal sam DPD i jedyne wyjscie to „Wyczysc filtry", czyli utrata reszty filtrow.
    const surowe = przesylkiDoSledzenia(db, bazaOdIso);

    // PRZ-067: przewoznik liczony RAZ na wiersz, PRZED filtrem — filtr i lista rozwijana pytaja
    // o niego, a lista musi powstac z pelnego zbioru (niezmiennik 4.13b, akapit wyzej).
    const zPrzewoznikiem = surowe.map((p) => {
      const zamowienie = numery.get(p.zamowienie_id) ?? null;
      return { ...p, zamowienie, przewoznik: przewoznikWiersza(p, zamowienie) };
    });

    const wiersze = zPrzewoznikiem
      .filter((p) => pasujeNaFiltr(p, filtry))
      .map((p) => {
      const etap = etapPrzesylki(p.status_kuriera, p.status_kuriera_kod);
      const stoi = bezRuchu({
        etap, statusKurieraAt: p.status_kuriera_at, nadanaAt: p.utworzona_at, teraz,
      });
      // ⚠️ TA SAMA FUNKCJA, CO NA KARCIE (domain/przesylka-stan.js). Ukrycie dzialajace
      // w zakladce, ale nie w sprawach karty, zostawialoby zamowienie na liscie roboczej
      // z odznaka, ktorej juz nic nie zdejmie — czyli sprzatanie bylo by polsrodkiem.
      const ukryta = przesylkaUkryta(p);
      const aktywnyPodjazd = db.prepare(`SELECT j.stan, j.id, j.termin_json FROM podjazdy_przesylki pp
        JOIN podjazdy j ON j.id=pp.podjazd_id
        WHERE pp.przesylka_id=? AND pp.aktywna_rezerwacja=1 ORDER BY j.id DESC LIMIT 1`).get(p.id);
      let poTerminie = false;
      try { poTerminie = aktywnyPodjazd?.stan === 'potwierdzony'
        && podjazdPoTerminie(JSON.parse(aktywnyPodjazd.termin_json), teraz.toISOString()); }
      catch { poTerminie = false; }
      const { zamowienie } = p;
      // Nazwa uslugi (np. „Allegro Kurier DPD pobranie") zostaje pod logo dla przesylek Allegro —
      // pobranie i rodzaj uslugi operator musi widziec. Dla wlasnego DPD/InPostu logo wystarcza.
      const zAllegro = p.kurier === 'allegro_wza' || p.kurier === 'allegro';
      const kurierEtykieta = zAllegro && zamowienie ? nazwaDostawy(zamowienie) : p.kurier;
      return {
        ...p,
        kurierEtykieta,
        usluga: zAllegro && zamowienie ? kurierEtykieta : null,
        adresSledzenia: adresSledzenia(p.przewoznik?.klucz, p.numer_listu),
        etap,
        kategoria: kategoriaPrzesylki(p, etap),
        etykietaEtapu: etykietaEtapu(etap ?? 'nadana', dniKalendarzowe(p.utworzona_at, teraz.toISOString())),
        // Ukryta paczka NIE „stoi bez ruchu" — czlowiek juz o niej zdecydowal. Liczymy
        // to jednak osobno od `ukryta`, zeby chip „Ukryte" mogl pokazac, co tam wpadlo.
        bezRuchu: stoi && !ukryta,
        ukryta,
        aktywnyPodjazd,
        podjazdPoTerminie: poTerminie,
        mozePodjazd: !ukryta && p.kurier === 'allegro_wza' && p.status === 'nadana'
          && !p.przejeta_at && !aktywnyPodjazd && !!p.id_przesylki_kuriera
          && !!(p.etykieta_sciezka || p.etykieta_zpl_sciezka),
      };
    });

    // Unikalni przewoznicy z PELNEGO zbioru, po nazwie. Wartosc w adresie = klucz.
    const przewozcy = [...new Map(zPrzewoznikiem.filter((w) => w.przewoznik)
      .map((w) => [w.przewoznik.klucz, { klucz: w.przewoznik.klucz, nazwa: w.przewoznik.nazwa }])).values()]
      .sort((a, b) => a.nazwa.localeCompare(b.nazwa, 'pl'));
    const kurierNieznany = !!filtry.kurier && !przewozcy.some((p) => p.klucz === filtry.kurier);
    const sklepy = [...new Set(surowe.map((w) => w.sklep).filter(Boolean))].sort();
    // ⚠️ LICZNIKI ZAWSZE PELNE (liczone przed filtrem), ale UKRYTE WYPADAJA ze wszystkich
    // pozostalych kubelkow. Inaczej „Bez ruchu (8)" swiecilby dalej osmioma, z ktorych
    // szesciu nie ma jak zobaczyc — czyli licznik klamalby o tym, co jest do zrobienia.
    const zywe = wiersze.filter((w) => !w.ukryta);
    const liczniki = {
      utworzone: zywe.filter((w) => w.kategoria === 'utworzone').length,
      w_drodze: zywe.filter((w) => w.kategoria === 'w_drodze').length,
      bez_ruchu: zywe.filter((w) => w.bezRuchu).length,
      doreczone: zywe.filter((w) => w.kategoria === 'doreczone').length,
      ukryte: wiersze.filter((w) => w.ukryta).length,
      wszystkie: zywe.length,
    };
    const widoczne = wiersze.filter((w) => {
      if (pokaz === 'ukryte') return w.ukryta;
      if (w.ukryta) return false;
      if (pokaz === 'bez_ruchu') return w.bezRuchu;
      if (pokaz === 'wszystkie') return true;
      return w.kategoria === pokaz;
    });

    return reply.view('przesylki-lista.ejs', {
      title: 'Przesyłki',
      wiersze: widoczne,
      filtry,
      pokaz,
      liczniki,
      przewozcy,
      kurierNieznany,
      sklepy,
      // GOTOWE PRZEDZIALY (zgloszenie właściciela 18.09). Dzien biezacy liczy `dzienWarszawa`,
      // ta sama funkcja co filtr (niezmiennik 4.104) — skrot ustawiajacy „dzis" wedlug UTC
      // wskazywalby wczoraj przez pierwsze dwie godziny doby czasu warszawskiego.
      //
      // ⚠️ Skroty NIOSA `pokaz` i pozostale filtry. Skrot, ktory przy okazji kasuje
      // przewoznika albo wyrzuca ze statusu, jest tym samym bledem, co formularz bez
      // ukrytego `pokaz` — tylko schowanym w wygodzie.
      skroty: [
        {
          etykieta: 'Ten miesiąc',
          adres: adresPrzesylki({
            ...filtry, pokaz, od: `${dzisWarszawa.slice(0, 8)}01`, do: dzisWarszawa,
          }),
        },
        {
          etykieta: 'Ostatnie 7 dni',
          // Siedem dni WLACZNIE z dzisiejszym, czyli dzis i szesc wstecz.
          adres: adresPrzesylki({
            ...filtry, pokaz, od: przesunDni(dzisWarszawa, -6), do: dzisWarszawa,
          }),
        },
      ],
      adresDo: (nowy) => adresPrzesylki({ ...filtry, pokaz: nowy }),
      // ⚠️ „Wyczysc filtry" czysci FILTRY, ale zostawia CHIP — to dwa rozne wymiary tego
      // samego ekranu. Rozlanie `...filtry` tutaj (tak bylo napisane) dawalo przycisk,
      // ktory prowadzi dokladnie tam, gdzie operator juz stoi: nic nie czysci i nie widac
      // tego inaczej niz probujac.
      adresWyczysc: adresPrzesylki({ pokaz }),
    });
  });

  // UKRYCIE I PRZYWROCENIE — dwie trasy, jeden ksztalt.
  //
  // ⚠️ Formularze w widoku ida BEZ ukrytego pola z tokenem: ochrona CSRF (src/security/csrf.js)
  // stoi na naglowku `Origin`, tak samo jak przy formularzach magazynu i kosztow.
  //
  // ⚠️ WPIS DO LOGU ZAMOWIENIA, a nie tylko kolumna. Ukrycie zdejmuje zamowienie z listy
  // roboczej, wiec musi zostac slad KTO i KIEDY — ta sama formulka „Ręcznie (kto): …",
  // co przy „sprawa zalatwiona recznie".
  const akcja = (nazwa, wykonaj, opis) => app.post(`/przesylki/:id/${nazwa}`, async (req, reply) => {
    const p = pobierzPrzesylke(db, Number(req.params.id));
    if (!p) return reply.code(404).send('Nie ma takiej przesyłki.');
    const kto = ktoKlikal(req);
    const filtrPoAkcji = parseFiltry(req.body);
    if (filtrPoAkcji.blad) return reply.redirect(adresPrzesylki({ pokaz: POKAZ.includes(req.body?.pokaz) ? req.body.pokaz : DOMYSLNY_POKAZ }));
    wykonaj(p, kto);
    dopiszLog(db, p.zamowienie_id, {
      akcja: `przesylka.${nazwa}`,
      wynik: `Ręcznie (${kto}): paczka nr ${p.kolejnosc} (${p.numer_listu ?? 'bez numeru'}) — ${opis}`,
    });
    // Wracamy na TEN filtr, z ktorego przyszlo klikniecie: po ukryciu z „Bez ruchu" operator
    // ma zobaczyc te sama liste bez tej paczki, a nie zostac przerzucony na widok domyslny.
    const skad = POKAZ.includes(req.body?.pokaz) ? req.body.pokaz : DOMYSLNY_POKAZ;
    return reply.redirect(adresPrzesylki({ ...filtrPoAkcji, pokaz: skad }));
  });

  akcja('ukryj', (p, kto) => ukryjPrzesylke(db, p.id, kto), 'ukryta z listy przesyłek');
  akcja('przywroc', (p) => przywrocPrzesylke(db, p.id), 'przywrócona na listę przesyłek');
}

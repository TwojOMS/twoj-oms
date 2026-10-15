import { przeprowadzWiazanie } from '../../../oms/allegro/wiazanie.js';
import { stanyKanalowZKolizjami } from '../../../domena/kanal-stan.js';

// WIAZANIE KANALU Z PANELU (device flow bez terminala).
//
// ⚠️⚠️ TA USLUGA NADPISUJE PARE TOKENOW, A TEGO NIE DA SIE COFNAC. Udane wiazanie
// uniewaznia dotychczasowa pare PO STRONIE ALLEGRO — kanal, ktory dzialal, przestaje
// dzialac do czasu, az ktos przejdzie device flow do konca. Dlatego dwie bariery:
// zdrowego kanalu wiazac NIE WOLNO, a drugiego wiazania tego samego kanalu NIE ZACZYNAMY.
//
// ⚠️ ODPYTYWANIE ZYJE PO STRONIE SERWERA, NIE KARTY. `przeprowadzWiazanie` to petla
// trwajaca do 30 minut — trzymanie jej w zadaniu HTTP znaczyloby, ze zamkniecie
// przegladarki przerywa wiazanie w polowie. Zadanie wraca NATYCHMIAST z kodem, a petla
// chodzi dalej i sama zapisze pare.

// ⚠️ STAN W PAMIECI PROCESU, NIE W BAZIE — i to jest decyzja. `device_code` jest sekretem,
// ktorym odbiera sie tokeny; zapisany do bazy zylby w kopiach zapasowych dluzej niz same
// 30 minut jego waznosci. Cena: restart panelu gubi wiazanie w toku. To jest w porzadku —
// kod i tak wygasa, a czlowiek zaczyna od nowa jednym kliknieciem.
export function createWiazanieKanalow({
  tokenyKanalow = {}, przeprowadz = przeprowadzWiazanie, teraz = () => Date.now(), log = () => {},
  // ⚠️⚠️ `spij` MUSI BYC PODANE. `przeprowadzWiazanie` bierze je BEZ wartosci domyslnej —
  // celowo, zeby test nie zasnal naprawde — wiec brak tego parametru konczy sie
  // `TypeError: spij is not a function` przy PIERWSZEJ odpowiedzi `authorization_pending`.
  // Do 28.08.2026 tego tu nie bylo i wiazanie z panelu NIE DZIALALO NIGDY: czlowiek
  // dostawal kod, a zaraz pod nim „Wiazanie przerwane bledem panelu." — bez slowa
  // o przyczynie, bo `log` tez byl pusty. Suita byla zielona, bo testy uslugi
  // wstrzykuja atrape `przeprowadz` i prawdziwej petli nie dotykaja.
  spij = (ms) => new Promise((koniec) => { setTimeout(koniec, ms); }),
}) {
  const wToku = new Map();

  const zywe = (kanal) => {
    const w = wToku.get(kanal);
    if (!w) return null;
    // Wpis po terminie przestaje blokowac — inaczej nieudane wiazanie zamykaloby kanal
    // na pol godziny bez zadnego powodu (4.9).
    if (w.wygasaAt && teraz() > w.wygasaAt) { wToku.delete(kanal); return null; }
    return w;
  };

  function stan(kanal) {
    const w = zywe(kanal);
    if (!w) return null;
    // ⚠️ BIALA LISTA POL. `device_code` nie przechodzi przez te usluge w ogole, ale ekran
    // ma dostac DOKLADNIE to, czego potrzebuje, a nie „co akurat jest w mapie".
    return { kanal, userCode: w.userCode, adres: w.adres, wygasaAt: w.wygasaAt, blad: w.blad ?? null };
  }

  async function rozpocznij(kanal) {
    const tokeny = tokenyKanalow[kanal];
    if (!tokeny) return { ok: false, powod: `Panel nie zna kanału „${kanal}".` };

    // ⚠️ BARIERA PIERWSZA: zdrowego kanalu nie wiazemy. Ta sama regula rzadzi przyciskiem
    // na ekranie — ale ekran nie jest bariera: zadanie moze przyjsc z reki albo ze starej,
    // otwartej karty, na ktorej kanal byl jeszcze zepsuty.
    // UWAGA: ocena WSZYSTKICH kanalow, nie tego jednego — inaczej usluga nie zobaczy
    // kolizji kont i odmowi przewiazania kanalu, ktory ekran wlasnie pokazal jako pilny.
    const wszystkie = stanyKanalowZKolizjami(
      Object.values(tokenyKanalow).map((t) => t.stanDlaEkranu()),
    );
    const s = wszystkie.find((x) => x.kanal === kanal);
    if (!s) return { ok: false, powod: `Panel nie zna stanu kanału „${kanal}".` };
    if (!s.wolnoWiazac) {
      return {
        ok: false,
        powod: `Kanał „${kanal}" działa. Ponowne wiązanie unieważniłoby działającą parę tokenów `
          + 'po stronie Allegro i kanał przestałby działać, dopóki ktoś nie przejdzie wiązania do końca.',
      };
    }

    // ⚠️⚠️ BARIERA DRUGA: DRUGIE WIAZANIE TEGO SAMEGO KANALU TO NIE NOWY KOD, TYLKO TEN SAM.
    // Kazde `rozpocznijPowiazanie()` prosi Allegro o WLASNY kod, a potwierdzenie nowego
    // uniewaznia poprzedni. 14.08.2026 uruchomilem dwa procesy wiazania rownolegle (kody
    // `5jazcov8` i `xtsxfpnh`) — skonczylo sie dobrze wylacznie dlatego, ze pierwszy wygasl
    // bez potwierdzenia. Czlowiek klikajacy dwa razy, bo „nic sie nie dzieje", trafilby
    // dokladnie w to samo.
    const trwa = zywe(kanal);
    if (trwa) return { ok: true, juzTrwa: true, stan: stan(kanal) };

    let dane = null;
    try {
      // ⚠️ CZEKAMY WYLACZNIE NA KOD, nie na cale wiazanie. Obietnica petli zostaje bez
      // `await` — i dlatego `.catch` jest OBOWIAZKOWY: odrzucona obietnica bez obslugi
      // to `unhandled rejection`, ktore kladzie caly proces OMS-u.
      // ⚠️⚠️ OBIETNICA MA DWA WYJSCIA, NIE JEDNO. `await kod` nizej czeka na `naStart`,
      // ktore pada dopiero PO udanym `/device`. Gdy tamto wywolanie rzuci (albo gdy petla
      // skonczy sie na blednym ksztalcie odpowiedzi), `naStart` NIE PADA NIGDY — a bez
      // drogi odrzucenia zadanie HTTP wisi w nieskonczonosc: przegladarka sie kreci,
      // czlowiek nie widzi ani kodu, ani bledu. Zmierzone 28.08.2026.
      let odrzucKod = () => {};
      const kod = new Promise((rozwiaz, odrzuc) => { dane = rozwiaz; odrzucKod = odrzuc; });
      const petla = przeprowadz({
        tokeny,
        opisKanalu: kanal,
        spij,
        naStart: (d) => { wToku.set(kanal, { ...d }); dane(d); },
      });
      petla
        .then((w) => {
          if (w?.gotowe) wToku.delete(kanal);
          // Nieudane wiazanie ZOSTAJE w mapie z powodem — inaczej ekran wracalby do „nic
          // sie nie dzieje" i czlowiek nie wiedzialby, czemu kanal dalej nie zyje.
          else if (wToku.has(kanal)) wToku.set(kanal, { ...wToku.get(kanal), blad: w?.komunikat ?? 'Wiązanie nie doszło do skutku.' });
          // ⚠️ Odblokuj czekajacego, gdy petla skonczyla sie BEZ `naStart` (np. bledny
          // ksztalt odpowiedzi `/device`). Na obietnicy juz rozwiazanej to nic nie robi.
          odrzucKod(new Error(w?.komunikat ?? 'Wiązanie nie doszło do skutku.'));
        })
        .catch((e) => {
          log('wiązanie kanału:', e?.message ?? e);
          if (wToku.has(kanal)) wToku.set(kanal, { ...wToku.get(kanal), blad: 'Wiązanie przerwane błędem panelu.' });
          odrzucKod(e);
        });
      await kod;
    } catch (e) {
      wToku.delete(kanal);
      return { ok: false, powod: `Allegro nie oddało kodu do wiązania: ${e?.message ?? e}` };
    }

    return { ok: true, stan: stan(kanal) };
  }

  return { rozpocznij, stan, stanyWszystkich: () => Object.keys(tokenyKanalow).map(stan).filter(Boolean) };
}

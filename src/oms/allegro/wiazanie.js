import {
  adresDoPrzegladarki,
  czyPotkniecieSieci,
  instrukcjaDlaCzlowieka,
  komunikatCzasu,
  komunikatSukcesu,
  limitCzasuMs,
  nastepnyOdstepMs,
  ocenPowod,
  odstepStartowyMs,
  sprawdzOdpowiedzDevice,
} from '../../domena/wiazanie-kanalu.js';

// Petla device flow: sklejenie czystych regul (`domain/wiazanie-kanalu.js`) z mechanizmem
// tokenow (`allegro/tokeny.js`). Nie ma tu ani konsoli, ani zegara systemowego, ani bazy —
// wszystko wchodzi argumentem, wiec calosc da sie zmierzyc BEZ WYCHODZENIA DO ALLEGRO.
//
// ⚠️ ZAPIS PARY TOKENOW ROBI `dokonczPowiazanie()`, I TYLKO ONO. Drugiej drogi zapisu tu
// nie ma i byc nie moze: liczenie terminow waznosci (`zapiszPare` w tokeny.js) rozjechaloby
// sie miedzy dwiema kopiami przy pierwszej poprawce jednej z nich, a skutkiem bylby kanal,
// ktory milknie w terminie, o ktorym panel nie wie.
//
// ⚠️ POZA DEVICE FLOW (OAuth) TEN MODUL NIE WYSYLA DO ALLEGRO NICZEGO. Plan A jest kanalem
// DO ODCZYTU.
export async function przeprowadzWiazanie({
  tokeny,
  opisKanalu = '',
  pisz = () => {},
  // Hak dla EKRANU (patrz uzasadnienie przy wywolaniu). Skrypt terminalowy go nie podaje.
  naStart = () => {},
  spij,
  teraz = () => Date.now(),
}) {
  const start = await tokeny.rozpocznijPowiazanie();
  const bladKsztaltu = sprawdzOdpowiedzDevice(start);
  if (bladKsztaltu) return { gotowe: false, powod: 'kształt odpowiedzi', komunikat: bladKsztaltu };

  const limitMs = limitCzasuMs(start.expires_in);
  const adres = adresDoPrzegladarki(start);
  pisz(instrukcjaDlaCzlowieka({
    userCode: start.user_code, adres, limitMs, opisKanalu,
  }));
  // ⚠️ TE SAME DANE, ALE STRUKTURALNIE — dla EKRANU, nie dla terminala. Skrypt wiazania
  // dostaje je napisem (`pisz`), bo czlowiek czyta je w konsoli; panel musi je wstawic
  // w link i w pole do przepisania, wiec parsowanie tamtego napisu byloby drugim zrodlem
  // prawdy o kodzie. Wolajacy bez ekranu po prostu tego haka nie podaje.
  //
  // ⚠️ `user_code` WOLNO pokazac (jednorazowy, wazny minuty) — TOKENOW NIGDY (4.10).
  // Ten hak nie dostaje `start` w calosci wlasnie po to: `device_code` jest sekretem, ktorym
  // odbiera sie pare tokenow, i nie ma prawa trafic na ekran ani do logu.
  naStart({ userCode: start.user_code, adres, limitMs, wygasaAt: teraz() + limitMs });

  // ⚠️ GRANICA CZASU LICZONA RAZ, OD POCZATKU. Odswiezanie jej przy kazdym obrocie petli
  // zamienia „czekamy 10 minut" w „czekamy w nieskonczonosc", bo kazdy `authorization_pending`
  // odsuwalby koniec — a petla bez wyjscia jest dokladnie tym stanem, ktorego ten panel
  // miec nie moze (niezmiennik 4.9).
  const koniec = teraz() + limitMs;
  let odstep = odstepStartowyMs(start.interval);
  let ostatniPowod = null;
  // ⚠️ KOLEJNE potkniecia sieci, nie laczne. Zerowanie po KAZDEJ odpowiedzi, ktora doszla,
  // jest tu calym sensem: pojedyncze mrugniecie sieci w srodku dziesieciominutowego
  // czekania nie ma prawa zblizyc skryptu do poddania sie. Granica ma zlapac siec NAPRAWDE
  // zerwana, a nie zsumowac dwadziescia niezaleznych mrugniec.
  let kolejneSieciowe = 0;

  for (;;) {
    const wynik = await tokeny.dokonczPowiazanie(start.device_code);
    if (wynik?.gotowe) {
      return { gotowe: true, komunikat: komunikatSukcesu(tokeny.stanDlaEkranu()) };
    }

    ostatniPowod = wynik?.powod ?? null;
    kolejneSieciowe = czyPotkniecieSieci(ostatniPowod) ? kolejneSieciowe + 1 : 0;
    const ocena = ocenPowod(ostatniPowod, kolejneSieciowe);
    if (!ocena.dalej) return { gotowe: false, powod: ostatniPowod, komunikat: ocena.komunikat };

    // `slow_down` wydluza odstep PRZED sprawdzeniem granicy czasu — inaczej skrypt zasnalby
    // na dluzej, niz zostalo mu zycia kodu, i obudzil sie tylko po to, zeby dostac
    // `expired_token`.
    odstep = nastepnyOdstepMs(odstep, ostatniPowod);
    if (teraz() + odstep >= koniec) {
      return { gotowe: false, powod: 'czas', komunikat: komunikatCzasu({ limitMs, ostatniPowod }) };
    }
    await spij(odstep);
  }
}

// Z JAKIM KONTEM ALLEGRO KANAL JEST NAPRAWDE ZWIAZANY.
//
// ⚠️⚠️ POWOD ISTNIENIA. 28.08.2026 wlasciciel kliknal „Polacz z Allegro" przy kanale
// `allegro_b`, bedac zalogowanym w przegladarce na konto A. Device flow
// zrobil dokladnie to, o co go poproszono, i zwiazal kanal z cudzym kontem. Panel nie mial
// jak tego zauwazyc: kanal byl polaczony, bez bledu, z kompletem osmiu zakresow i 89 dniami
// waznosci — ZDROWY wedle kazdego sita, jakie mial (kanal-stan.js).
//
// Przez ~40 minut poller ciagnal cudze zamowienia pod nazwa allegro_b: 6 zdublowanych
// zamowien, 5 zdublowanych PLATNOSCI (przychod policzony dwa razy w raportach), 18 watkow
// i 59 wiadomosci w lustrze, a na koniec PRZESTAWIONY KURSOR POLLERA — ten ostatni po cichu
// pomijalby prawdziwe zamowienia allegro_b z calego okna. Wyszlo to na jaw dopiero po
// tym, jak czlowiek zobaczyl ten sam watek dwa razy na ekranie.
//
// ⚠️ IDENTYFIKATOR KONTA NIE JEST POSWIADCZENIEM (niezmiennik 4.10 dotyczy tokenow i hasel).
// Wolno go pokazac — i trzeba, bo to JEDYNA rzecz, po ktorej czlowiek pozna, ze przewiazal
// kanal na zle konto. Sam token nie opuszcza tego modulu.

import { payloadTokenu } from './token-jwt.js';

/**
 * Identyfikator konta Allegro z tokenu, albo `null`, gdy tokenu nie da sie odczytac.
 *
 * ⚠️ ZAWSZE NAPIS. Allegro potrafi podac `user_name` jako liczbe, a porownanie miedzy
 * kanalami musi isc miedzy tymi samymi typami — inaczej 75246625 !== '75246625'
 * i kolizja przechodzi niezauwazona.
 */
export function kontoZTokenu(accessToken) {
  const payload = payloadTokenu(accessToken);
  const konto = payload?.user_name;
  if (konto === null || konto === undefined || konto === '') return null;
  return String(konto);
}

/**
 * Kanaly wiszace na tym samym koncie Allegro — posortowane, zawsze OBA (albo wszystkie).
 *
 * ⚠️ TO JEST NIEZMIENNIK, KTORY NIE WYMAGA ZADNEGO USTAWIENIA. Panel nie musi wiedziec,
 * ktore konto jest „wlasciwe" dla ktorego kanalu — wystarczy mu, ze DWA KANALY TO DWA KONTA.
 * Kanal istnieje po to, zeby oddzielic jedno konto sprzedazowe od drugiego; dwa wpisy na
 * jednym koncie znacza, ze ktores wiazanie poszlo nie tam. Reguly opartej na konfiguracji
 * („allegro_b ma miec konto 12345678") swiadomie tu NIE MA: wymagalaby wpisania numerow
 * recznie, a wpis recznie robiony myli sie tak samo jak klikniecie.
 *
 * ⚠️ WSKAZUJEMY OBA, bo panel nie wie, ktory jest zly. Czlowiek wie.
 *
 * ⚠️⚠️ NIEZNANE KONTO TO NIE JEST TO SAMO KONTO. Dwa nieczytelne tokeny nie sa dowodem
 * kolizji, a kolizja OTWIERA bariere ponownego wiazania — czyli zaprasza do nadpisania
 * dzialajacej pary tokenow, czego cofnac sie nie da. Ta sama regula rzadzi
 * `brakujaceUprawnienia()`: „nie wiem" nie uruchamia kroku nieodwracalnego.
 */
export function kolizjeKont(stany) {
  const wgKonta = new Map();
  for (const s of stany ?? []) {
    const konto = s?.kontoAllegro;
    if (!konto) continue;
    if (!s?.kanal) continue;
    if (!wgKonta.has(konto)) wgKonta.set(konto, []);
    wgKonta.get(konto).push(s.kanal);
  }
  const sklejone = [];
  for (const kanaly of wgKonta.values()) {
    if (kanaly.length > 1) sklejone.push(...kanaly);
  }
  return sklejone.sort();
}

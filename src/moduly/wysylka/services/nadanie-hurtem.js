import { dopiszLog } from '../../../oms/db/zamowienia.js';
import { adresOdbiorcy } from '../../../domena/adres-odbiorcy.js';
import { czyPobranie, kwotaPobrania } from '../../../domena/wysylka.js';
import { komunikatDlaOperatora } from '../../../domena/bledy.js';
import { wstawEtykieteDoKolejki } from './kolejka-po-nadaniu.js';

/**
 * Ile czasu wolno zająć partii, zanim pętla przestanie ZACZYNAĆ nowe paczki — ta sama liczba
 * i ten sam powód, co `BUDZET_HURTU_MS` faktur (services/faktura-hurtem.js): panel nie ma
 * limitu żądania przychodzącego (`requestTimeout: 0`), więc budżet chroni CZŁOWIEKA, który
 * czeka na ekran, a nie serwer.
 *
 * ⚠️ PRZED PRZ-070 BUDŻETU NIE BYŁO, bo hurt nadawał wyłącznie DPD (sekundy na paczkę). Od
 * 14.10.2026 nadaje też paczkomaty i „Wysyłam z Allegro", gdzie jedna paczka potrafi czekać
 * na numer kilkanaście sekund — dziesięć takich to minuty przed pustym ekranem.
 */
export const BUDZET_NADANIA_HURTEM_MS = 150_000;

/**
 * @param kolejka wstrzykiwana tylko w testach — domyślnie TA SAMA funkcja, co na karcie.
 */
export function createNadanieHurtem({ db, nadanie, teraz = () => Date.now(), kolejka = wstawEtykieteDoKolejki }) {
  /**
   * @param wiersze `{ z, paczka }` — `z` po `podzielDoNadania` (niesie `rodzajFormularza`),
   *   `paczka` po `paczkaWiersza`. Ta funkcja NICZEGO nie odsiewa: podział pokazał człowiekowi
   *   ekran podglądu, a druga kopia reguły rozjechałaby się z tym, co zatwierdził.
   * @param start moment PRZYJŚCIA żądania (liczba ms). Nie-liczba = liczymy od wejścia w pętlę;
   *   zapomnienie ma być tanie (to samo uzasadnienie, co przy `wystawWiele` faktur).
   */
  async function nadajWiele(wiersze, { start, drukowac = false } = {}) {
    const lista = wiersze ?? [];
    const poczatek = Number.isFinite(start) ? start : teraz();
    const udane = [];
    const nieudane = [];
    const nietkniete = [];
    for (let i = 0; i < lista.length; i += 1) {
      const { z, paczka } = lista[i];
      // Pierwsza próba ZAWSZE (`i > 0`): partia, która nie zrobiła nic, jest gorsza niż
      // niepełna. Reszta wraca JAWNIE — operator ma wiedzieć, co zaznaczyć jeszcze raz.
      if (i > 0 && teraz() - poczatek > BUDZET_NADANIA_HURTEM_MS) {
        for (const r of lista.slice(i)) nietkniete.push({ id: r.z.id, numer: r.z.numer });
        break;
      }
      try {
        // ⚠️ PIENIĄDZE. Hurt nie ma pola kwoty — kurier bierze ją z zamówienia (DPD) albo
        // z podpowiedzi Allegro (WzA). Ten wpis jest jedynym miejscem, z którego po miesiącu
        // da się odpowiedzieć, ile panel kazał zainkasować: kolumnę `kwota_pobrania` poller
        // nadpisuje ze sklepu. Pada PRZED kurierem, żeby został także przy nadaniu, które
        // skończy się paczką już utworzoną u kuriera.
        if (czyPobranie(z)) {
          dopiszLog(db, z.id, {
            akcja: 'nadanie.pobranie',
            wynik: z.rodzajFormularza === 'wza'
              ? `nadanie hurtem: kwotę pobrania poda Allegro (w zamówieniu ${kwotaPobrania(z) ?? '?'} zł)`
              : `nadanie hurtem: kurier zainkasuje kwotę z zamówienia — ${kwotaPobrania(z)} zł`,
          });
        }
        // Kolejność ZAWSZE 1 (paczki nr N > 1 podział wyklucza) i BEZ `kwotaPobrania`:
        // brak nadpisania znaczy dla usługi „kwota z zamówienia".
        const w = await nadanie.nadaj(z.id, paczka, {
          kolejnosc: 1,
          komentarz: 'nadanie zbiorcze z listy zamówień',
          adres: adresOdbiorcy(z),
          drukowac,
        });
        // InPost bywa asynchroniczny: przesyłka JEST, numeru jeszcze nie ma. To nie porażka,
        // ale też nie numer — i nie ma jeszcze etykiety, którą dałoby się wstawić do kolejki.
        if (!w?.numerListu) {
          udane.push({
            id: z.id, numer: z.numer,
            opis: 'przesyłka tworzona u kuriera — dokończ przyciskiem „Sprawdź ponownie” na karcie',
          });
          continue;
        }
        let opis = w.numerListu;
        if (drukowac) {
          const k = kolejka(db, z.id, 1, 'Nadaj i drukuj — hurt');
          opis += k === 'w_kolejce' ? ' · etykieta w kolejce druku' : ' · etykieta tylko PDF — wydrukuj z karty';
        }
        udane.push({ id: z.id, numer: z.numer, opis });
      } catch (e) {
        // ⚠️ Awaria JEDNEJ paczki nie zatrzymuje pozostałych. To, co już poszło do kuriera,
        // i tak się nie cofnie, a przerwanie pętli zostawiałoby połowę zaznaczenia w stanie,
        // którego nikt nie widzi. Pełna treść do logu, na ekran to, co napisaliśmy dla ludzi.
        dopiszLog(db, z.id, { akcja: 'nadanie.masowe', wynik: `BŁĄD: ${e.message}` });
        nieudane.push({ id: z.id, numer: z.numer, powod: komunikatDlaOperatora(e) });
      }
    }
    return { udane, nieudane, nietkniete };
  }

  return { nadajWiele };
}

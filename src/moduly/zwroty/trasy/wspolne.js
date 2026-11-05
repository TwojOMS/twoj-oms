import { stronaOdmowy } from '../../../core/web/odmowa.js';
import { pobierzZamowienie, dopiszLog } from '../../../oms/db/zamowienia.js';
import {
  dodajZwrot, usunZwrot, oznaczPieniadzeOddane, zwrot, odblokujKorekte, zapiszRecznyNumerKorekty,
} from '../../../oms/db/zwroty.js';
import {
  parsujZwrot, powodOdmowyUsunieciaZwrotu, korektaPrzepadla, powodOdmowyOdblokowaniaKorekty,
  parsujNumerKorekty, korektaNieSprawdzona, powodOdmowyKorektyDlaFaktury,
  powodOdmowyRejestracjiZwrotu, wierszeFormularzaZwrotu, powodOdmowyKorektyBezDostawy, zwrotWymagaPozycjiDostawy,
} from '../../../domena/zwrot.js';
import { idDokumentu, czyDokumentProgramu, podgladFakturyZTerminem } from '../../../domena/dokument-programu.js';
import { formularzZwrotu, przygotujKrok2, razemZwrotuZl } from '../../../domena/zwrot-formularz.js';
import { dzienWarszawa } from '../../../domena/format-daty.js';
import { komunikatDlaOperatora } from '../../../domena/bledy.js';
import { adresKartyZamowienia, adresEkranuZwrotu } from '../../../domena/adres-karty-zamowienia.js';
import { bezpiecznyPowrotNaListe } from '../../../domena/filtry-listy.js';
import { ktoKlikal } from '../../zamowienia/wspolne.js';
import { odmianaNazwyProgramu, gdzieDokument } from '../../../domena/nazwa-programu.js';

// Helpery widoku i odmów frozen, używane przez osiem domykanych tras.
export function createWspolne({ db, korekta = null, definicje, infakt: programFaktur = null }) {
  const korektaDostepna = Boolean(korekta);
  const powrotKarty = (req) => bezpiecznyPowrotNaListe(req.query?.powrot ?? req.body?.powrot, definicje);
  const adresKarty = (req, id) => adresKartyZamowienia(id, { powrot: powrotKarty(req) }, definicje);
  // PRZ-147.03: ekran zwrotu z tym samym `powrot` (przekierowanie po zleceniu korekty, „Odśwież stan”).
  const adresZwrotu = (req, id) => adresEkranuZwrotu(id, { powrot: powrotKarty(req) }, definicje);

  const zamowienieAlbo404 = (req, reply) => {
    const id = Number(req.params.id);
    const z = pobierzZamowienie(db, id);
    if (!z) { stronaOdmowy(reply, 404, 'Nie ma takiego zamówienia', { tytul: 'Nie udało się obsłużyć zwrotu', wroc: '/', napisWroc: 'Wróć do listy zamówień' }); return null; }
    return z;
  };

  // Skrot na dwie formy tego samego wpisu. Slad zapisujemy ZAWSZE tym samym ksztaltem, co
  // reszta panelu: udana akcja to „Ręcznie (kto): …", nieudana to „BŁĄD: …".
  const slad = (id, akcja, wynik) => dopiszLog(db, id, { akcja, wynik });
  const decyzja = (req, tresc) => `Ręcznie (${ktoKlikal(req)}): ${tresc}`;

  // ---------------------------------------------------------------------------------
  // ⚠️⚠️ EKRAN NOWEGO ZWROTU MA DWA KROKI (prosba wlasciciela, 2026-08-15: „nie widać kwot
  // jakie mam wpisać […] czy to liczy się samo?").
  //
  // Krok 1 (`GET /zwrot`) pokazuje podsumowanie zamowienia i tabele pozycji z JUZ WPISANYMI
  // podpowiedziami sztuk i kwot. Krok 2 (`POST /zwrot/podglad`) wypisuje, co wraca, i RAZEM
  // policzone przez serwer. Zapisuje dopiero `POST /zwrot` — trasa BEZ ZMIAN.
  //
  // Powodem podzialu na dwa kroki jest to, ze panel NIE MA JAVASCRIPTU W PRZEGLADARCE i miec
  // nie ma: sumy nie da sie pokazac w trakcie wpisywania, wiec pokazuje sie ja po wyslaniu.
  //
  // ⚠️ Reguly (podpowiedzi, suma, zerowanie dostawy) licza sie w domenie
  // (domain/zwrot-formularz.js) — trasa ich nie liczy, dokladnie jak przy `parsujZwrot`.
  // ---------------------------------------------------------------------------------

  // Wszystko, co ekran pokazuje POZA formularzem nowego zwrotu — mapy decyzji domenowych dla
  // sekcji „Zarejestrowane zwroty". Trzy trasy renderuja ten sam widok (GET, odmowa na kroku 2
  // i „Wstecz — popraw"), wiec licza sie w JEDNYM miejscu.
  const daneRozliczenia = (z) => ({
    // Mapa `id zwrotu -> czy zlecenie korekty przepadlo` — widok NIE liczy tego sam
    // (domain/zwrot.js: korektaPrzepadla), zeby regula progu mieszkala w jednym miejscu.
    przepadle: Object.fromEntries((z.zwroty ?? []).map((w) => [w.id, korektaPrzepadla(w)])),
    // ⚠️⚠️ WARUNEK (recenzja kontrolna 2026-08-15): mapa `id zwrotu -> czy `doczytaj` SWIADOMIE
    // NIE ZAPYTAL inFaktu o ten zwrot` (sito W3 „wiecej niz jedna otwarta sprawa korekty",
    // domain/zwrot.js: korektaNieSprawdzona — DOKLADNIE ta sama regula, ktorej uzywa
    // `services/korekta.js`). Bez tego rozroznienia ekran po progu (`przepadle`) mowil „inFakt
    // nie wystawił dokumentu — zlecenie zostało odrzucone" NAWET WTEDY, gdy nikt nigdy nie
    // zapytal — zdanie o fakcie, ktorego panel nie zna. Widok CZYTA te mape, nie liczy jej sam.
    niePytano: Object.fromEntries(
      (z.zwroty ?? []).map((w) => [w.id, korektaNieSprawdzona(w, z.zwroty)]),
    ),
    // DROBIAZG 1 (recenzja 2026-08-15): mapa `id zwrotu -> dlaczego trasa POST /korekta
    // ZAWSZE by odmowila` (domain/zwrot.js: powodOdmowyKorektyDlaFaktury — ta sama regula,
    // ktora liczy `services/korekta.js` PRZED wywolaniem inFaktu). `null`, gdy przycisk
    // moze sie udac. Widok ma NIE RYSOWAC przycisku, ktory i tak dostalby 400 — zamiast tego
    // pokazuje to samo zdanie, ktore trasa by oddala.
    korektaBlokada: Object.fromEntries(
      (z.zwroty ?? []).map((w) => [w.id, powodOdmowyKorektyDlaFaktury(w, z.zwroty)]),
    ),
  });

  /**
   * Renderuje KROK 1. `wpisane` (cialo formularza) wygrywa z podpowiedziami — dzieki temu
   * „Wstecz — popraw" z kroku 2 i odmowa reguly wracaja na ekran Z ZACHOWANYMI wartosciami,
   * zamiast kazac operatorowi wpisywac wszystko od nowa.
   */
  // PRZ-148.03: zwrot z dostawą bez korekty — pozycje faktury z programu, żeby ekran znał regułę „faktura bez pozycji
  // Dostawa” (domena/zwrot.js) zanim operator kliknie. Mapa `id zwrotu -> zdanie`; błąd odczytu → pusta mapa
  // (przycisk zostaje, odmowę da jak dotąd usługa korekty).
  const korektaBezDostawy = async (z) => {
    if (!korektaDostepna || typeof programFaktur?.pobierzFakture !== 'function'
      || !czyDokumentProgramu(z.faktura, programFaktur)) return {};
    const zDostawa = (z.zwroty ?? []).filter(zwrotWymagaPozycjiDostawy);
    if (!zDostawa.length) return {};
    const faktura = await podgladFakturyZTerminem(programFaktur, idDokumentu(z.faktura));
    if (!faktura) return {};
    const nazwa = odmianaNazwyProgramu(programFaktur);
    return Object.fromEntries(zDostawa.map((w) => [w.id, powodOdmowyKorektyBezDostawy(w, faktura, { nazwa })]));
  };

  const pokazKrok1 = async (req, reply, z, { blad = null, wpisane = null, kod = 200 } = {}) => {
    const dzis = dzienWarszawa(new Date().toISOString());
    let formularz = null;
    // ⚠️ DROBIAZG 2 (recenzja 2026-08-15): zamowienie ANULOWANE dostawalo pelny, wypelniony
    // formularz — z podsumowaniem i podpowiedziami kwot — a odmowe dopiero PO kliknieciu
    // „Zarejestruj zwrot", na ekranie bez pol. Regule liczy DOMENA (tym samym zdaniem, ktore
    // oddaje `parsujZwrot`), a trasa tylko nie rysuje formularza, ktory nie ma prawa sie zapisac.
    const odmowaZamowienia = powodOdmowyRejestracjiZwrotu(z);
    let bladEkranu = blad ?? odmowaZamowienia;
    try {
      if (!odmowaZamowienia) formularz = formularzZwrotu(z, { dzis, wpisane });
    } catch (e) {
      // ⚠️ `kwotaOczekiwanaGrosze` i `wartoscPozycjiGrosze` RZUCAJA przy pozycji bez ceny —
      // i takiemu zamowieniu `parsujZwrot` odmawia zapisu z tego samego powodu (bariera kwoty
      // lapie ten sam wyjatek). Ekran ma wtedy POWIEDZIEC, dlaczego, zamiast oddac 500 albo
      // narysowac formularz, ktory nie ma prawa sie zapisac.
      bladEkranu = bladEkranu ?? komunikatDlaOperatora(e);
    }
    return reply.code(kod).view('zwrot.ejs', {
      title: `Zamówienie ${z.numer} / Zwrot`,
      okruszki: [{ tekst: `Zamówienie ${z.numer}`, href: `/zamowienia/${z.id}` }, { tekst: 'Zwrot' }],
      z,
      powrot: powrotKarty(req),
      adresKarty: adresKarty(req, z.id),
      adresZwrotu: adresZwrotu(req, z.id),
      dzis,
      formularz,
      korektaDostepna,
      // PRZ-118.09: nazwa programu fakturowego w zdaniach o korekcie (bez programu — inFakt, jak dotąd).
      nazwaProgramu: odmianaNazwyProgramu(programFaktur),
      gdzieProgramu: gdzieDokument(programFaktur),
      blad: bladEkranu,
      ...daneRozliczenia(z),
      korektaBezDostawy: await korektaBezDostawy(z),
    });
  };

  return { powrotKarty, adresKarty, adresZwrotu, zamowienieAlbo404, slad, decyzja, pokazKrok1 };
}

import { describe, it, expect } from 'vitest';
import { linkDoSledzenia } from '../../src/domena/tracking.js';

describe('linkDoSledzenia', () => {
  it('składa link DPD z numerem listu', () => {
    // Dokladny wzorzec potwierdzony w Zadaniu 8 na prawdziwym numerze.
    expect(linkDoSledzenia('dpd', '00123456789012')).toBe('https://tracktrace.dpd.com.pl/parcelDetails?p1=00123456789012');
  });

  // ⚠️ Wzorzec InPostu sprawdzony 2026-08-04 na zywej stronie, tak samo jak wzorzec DPD
  // w Zadaniu 8: `?number=` NAPEDZA wyszukiwanie, a nie tylko wisi w adresie — dla numeru
  // nieistniejacego strona pisze „Nie znalezlismy paczki o podanym numerze” i pokazuje
  // „Przesylka nr: <numer>”, czyli numer naprawde do niej dotarl. (Rozpoznanie ShipX opisuje
  // wylacznie API `GET /tracking/{numer}`, adresu strony dla czlowieka nie zawiera.)
  it('składa link InPostu z numerem przesyłki', () => {
    expect(linkDoSledzenia('inpost', '520000123456789012345678'))
      .toBe('https://inpost.pl/sledzenie-przesylek?number=520000123456789012345678');
  });

  it('bez numeru nie ma linku', () => {
    expect(linkDoSledzenia('dpd', null)).toBeNull();
    expect(linkDoSledzenia('inpost', null)).toBeNull();
    expect(linkDoSledzenia('dpd', '')).toBeNull();
    expect(linkDoSledzenia('inpost', '')).toBeNull();
  });

  // ⚠️ PRZYKLADEM BYL TU KIEDYS 'inpost' — i przestal nim byc dokladnie w chwili, w ktorej
  // InPost dostal wlasny wzorzec (Zadanie 9). Sama regula sie NIE ZMIENILA i dalej jest
  // pilnowana, tylko na kurierach, ktorych panel naprawde nie zna: „brak linku jest lepszy
  // niz link otwierajacy pusta wyszukiwarke”.
  it('nieznany kurier → brak linku zamiast zmyślonego', () => {
    expect(linkDoSledzenia('gls', '123')).toBeNull();
    expect(linkDoSledzenia('poczta_polska', '123')).toBeNull();
    expect(linkDoSledzenia(null, '123')).toBeNull();
  });

  // Numer trafia do PARAMETRU ZAPYTANIA, wiec znak specjalny w nim nie ma prawa ani rozbic
  // adresu, ani doczepic drugiego parametru.
  it('numer jest kodowany, a nie wklejany surowo', () => {
    expect(linkDoSledzenia('inpost', 'A&x=1')).toBe('https://inpost.pl/sledzenie-przesylek?number=A%26x%3D1');
  });

  // ⚠️⚠️ STAN FAKTYCZNY, NIE TYMCZASOWY BRAK: kurier 'allegro' NIE MA wzorca, bo adresu
  // sledzenia po stronie Allegro NIKT NIE ZMIERZYL (patrz komentarz w domain/tracking.js).
  // `null` nie jest tu ubytkiem — jest lepsza z dwoch dostepnych odpowiedzi: `lista-ikony.js`
  // robi `href: sledzenie ?? '/zamowienia/<id>'`, wiec brak wzorca znaczy, ze ikona prowadzi
  // do KARTY ZAMOWIENIA (link zawsze uzyteczny, ta sama zakladka), a wzorzec zamienilby to
  // na adres niesprawdzony otwierany w nowej zakladce.
  //
  // ⚠️ TEN TEST JEST BRAMKA POMIARU. Dopisanie wzorca `allegro` do `WZORCE` zaczerwieni go
  // NATYCHMIAST — i tak ma byc: najpierw pomiar w przegladarce (czy strona pokazuje TEN
  // numer, czy istnieje odpowiednik po stronie SPRZEDAJACEGO), potem swiadoma zmiana tej
  // asercji na pelny adres, jak przy DPD i InPoscie wyzej. Nigdy odwrotnie.
  it('numer z Allegro NIE DOSTAJE LINKU, dopóki adres nie zostanie zmierzony', () => {
    expect(linkDoSledzenia('allegro', 'AD0LK57DLG0756H4H')).toBeNull();
  });

  // Bez numeru nie ma linku takze dla Allegro — ta asercja przezyje pomiar i dopisanie
  // wzorca, bo „brak numeru = brak linku" jest regula CALEJ funkcji, a nie wlasnoscia
  // pustego wpisu w mapie.
  it('kanał Allegro bez numeru listu też nie dostaje linku', () => {
    expect(linkDoSledzenia('allegro', null)).toBeNull();
    expect(linkDoSledzenia('allegro', '')).toBeNull();
  });

  // ⚠️ TA REGULA ZOSTAJE PRAWDZIWA NIEZALEZNIE OD WYNIKU POMIARU i dlatego jest osobnym
  // testem, napisanym tak, zeby przechodzil takze wtedy, gdy wzorzec `allegro` juz istnieje.
  // Paczka nadana w panelu Allegro jedzie na ICH umowie: numeru „AD…" na tracktrace.dpd.com.pl
  // NIE MA. Ta sama rodzina bledu, co numer InPostu wyslany do DPD (04.08.2026).
  it('numer z Allegro NIGDY nie prowadzi do śledzenia DPD', () => {
    expect(linkDoSledzenia('allegro', 'AD0LK57DLG0756H4H') ?? '').not.toContain('dpd.com.pl');
    // Kontrola sensu: gdyby `linkDoSledzenia` przestala rozrozniac kurierow i oddawala null
    // wszystkim, asercja wyzej przechodzilaby z powodu awarii. Ten sam numer podany jako
    // 'dpd' MUSI dalej trafiac do DPD.
    expect(linkDoSledzenia('dpd', 'AD0LK57DLG0756H4H')).toContain('tracktrace.dpd.com.pl');
  });

  it('nieznany przewoźnik nie dostaje linku — pusta wyszukiwarka jest gorsza niż brak linku', () => {
    expect(linkDoSledzenia('cos_nowego', 'X1')).toBe(null);
  });
});

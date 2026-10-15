// tests/mail/mail-html.test.js — oprawa HTML maili z panelu (skórka SZKICOWNIA PRO).
// Treść pozostaje plain-textem zatwierdzonym przez człowieka; renderMailHtml tylko ją
// opakowuje (wordmark, akapity, tabela wyceny z kanonicznych linii, stopka).
import { describe, it, expect } from 'vitest';
import { renderMailHtml } from '../../pomoc/mail-html-parytetu.js';

describe('renderMailHtml — oprawa', () => {
  it('zawiera wordmark SZKICOWNIA PRO i kolory identyfikacji', () => {
    const html = renderMailHtml({ text: 'Dzień dobry,' });
    expect(html).toContain('SZKICOWNIA');
    expect(html).toContain('PRO');
    expect(html).toContain('by szkicownia.pl');
    expect(html).toContain('#F7F3EC'); // Płótno — tło
    expect(html).toContain('#3E5566'); // Stal — akcent
  });

  it('escapuje HTML z treści (treść bywa wpisywana ręcznie)', () => {
    const html = renderMailHtml({ text: 'a <script>alert(1)</script> b' });
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('akapity z pustych linii, pojedyncze łamania jako <br>', () => {
    const html = renderMailHtml({ text: 'linia 1\nlinia 2\n\ndrugi akapit' });
    expect(html).toMatch(/linia 1<br\s*\/?>linia 2/);
    expect(html).toContain('drugi akapit');
    // dwa osobne <p> — pusta linia rozdziela akapity
    expect(html.match(/<p[\s>]/g).length).toBeGreaterThanOrEqual(2);
  });

  it('linkifikuje URL-e (mail z linkiem do sklepu musi być klikalny)', () => {
    const link = 'https://szkicownia.pl/?oferta=12&t=abc';
    const html = renderMailHtml({ text: `Link:\n${link}` });
    expect(html).toMatch(/<a [^>]*href="https:\/\/szkicownia\.pl\/\?oferta=12&amp;t=abc"/);
  });
});

describe('renderMailHtml — tabela wyceny', () => {
  const quoteText = [
    'Dzień dobry,',
    'Wycena:',
    '2x szablon malarski wielorazowy logo 60x40 - 240zł brutto/szt',
    'wysyłka kurierem DPD 25zł brutto',
    'przygotowanie projektu w cenie',
    'Razem: 505zł (410,57zł netto)',
    '',
    'pozdrawiam',
  ].join('\n');

  it('kanoniczne linie wyceny stają się wierszami tabeli', () => {
    const html = renderMailHtml({ text: quoteText });
    expect(html).toContain('<table');
    expect(html).toContain('szablon malarski wielorazowy logo 60x40');
    expect(html).toContain('240zł');
    expect(html).toContain('wysyłka kurierem DPD');
  });

  it('wiersz Razem jest pogrubiony, netto mniejszym drukiem', () => {
    const html = renderMailHtml({ text: quoteText });
    expect(html).toMatch(/Razem/);
    expect(html).toMatch(/bold[^>]*>[^<]*505zł|505zł<\/strong>|<strong>505zł/);
    expect(html).toContain('410,57zł netto');
  });

  it('linie tabelaryczne NIE dublują się jako akapity', () => {
    const html = renderMailHtml({ text: quoteText });
    // pozycja występuje raz (w tabeli), a surowa linia plain-textu nie ląduje w akapicie
    expect(html.split('szablon malarski wielorazowy logo 60x40').length - 1).toBe(1);
    expect(html).not.toContain('- 240zł brutto/szt');
  });

  it('mail bez linii pozycji (np. dane do przelewu) nie dostaje tabeli wyceny', () => {
    const html = renderMailHtml({ text: 'Dzień dobry,\nKwota: 505 zł\nTytuł: k@x.pl' });
    expect(html).not.toContain('brutto/szt');
    // dopuszczamy tabele layoutowe oprawy; nie może być wiersza sumy wyceny
    expect(html).not.toMatch(/Razem<\/td>/);
  });

  it('wysyłka gratis też trafia do tabeli', () => {
    const t = ['Wycena:', '1x szablon - 100zł brutto/szt', 'wysyłka gratis', 'Razem: 100zł (81,30zł netto)'].join('\n');
    const html = renderMailHtml({ text: t });
    expect(html).toContain('wysyłka gratis');
    const poTabeli = html.indexOf('wysyłka gratis');
    expect(poTabeli).toBeGreaterThan(html.indexOf('<table'));
  });
});

describe('renderMailHtml — stopka', () => {
  it('renderuje linie stopki, każda w osobnym wierszu', () => {
    const html = renderMailHtml({ text: 'x', footer: 'Lumina Marek Zywiecki\nindywidualne@szkicownia.pl' });
    expect(html).toContain('Lumina Marek Zywiecki');
    expect(html).toContain('indywidualne@szkicownia.pl');
    expect(html).toMatch(/Lumina Marek Zywiecki<br\s*\/?>/);
  });

  it('escapuje stopkę (edytowalna w ustawieniach)', () => {
    const html = renderMailHtml({ text: 'x', footer: '<img src=x onerror=1>' });
    expect(html).not.toContain('<img');
  });

  it('pusta stopka → brak bloku stopki', () => {
    const html = renderMailHtml({ text: 'x', footer: '' });
    expect(html).not.toContain('mail-footer');
  });
});

// ⚠️ ZGŁOSZENIE WŁAŚCICIELA (19.08.2026): „gdy nie ma podanej ceny to przygotowanie projektu
// wypada z tabeli tak jak dawniej. Kurier DPD to samo." Wiersz bez kwoty szedł przez obie
// kolumny (colspan), więc wyglądał jak zdanie wrzucone w środek tabeli.
describe('dodatki bez kwoty — „w cenie" i „gratis" po prawej, jak kwota', () => {
  const zTabeli = (html) => {
    const start = html.indexOf('border-collapse');
    const pierwsza = html.slice(start, html.indexOf('</table>', start));
    return [...pierwsza.matchAll(/<tr>(.*?)<\/tr>/gs)].map((m) =>
      [...m[1].matchAll(/<td[^>]*>(.*?)<\/td>/gs)].map((x) => x[1].replace(/<[^>]+>/g, ' ').trim()));
  };

  it('bez kwot: obie pozycje są wierszami tabeli z wartością po prawej', () => {
    const t = [
      'Wycena:', '1x szablon - 100zł brutto/szt',
      'przygotowanie projektu - w cenie', 'wysyłka kurierem DPD - gratis',
      'Razem: 100zł (81,30zł netto)',
    ].join('\n');
    const wiersze = zTabeli(renderMailHtml({ text: t }));
    expect(wiersze).toContainEqual(['przygotowanie projektu', 'w cenie']);
    expect(wiersze).toContainEqual(['wysyłka kurierem DPD', 'gratis']);
  });

  it('z kwotami: ten sam kształt wiersza — różni się tylko prawa kolumna', () => {
    const t = [
      'Wycena:', '1x szablon - 100zł brutto/szt',
      'przygotowanie projektu - 80zł brutto', 'wysyłka kurierem DPD - 25zł brutto',
      'Razem: 205zł (166,67zł netto)',
    ].join('\n');
    const wiersze = zTabeli(renderMailHtml({ text: t }));
    expect(wiersze).toContainEqual(['przygotowanie projektu', '80zł brutto']);
    expect(wiersze).toContainEqual(['wysyłka kurierem DPD', '25zł brutto']);
  });

  // Sedno usterki: żaden wiersz wyceny nie ma prawa rozciągać się na obie kolumny.
  it('żaden wiersz tabeli nie rozciąga się na obie kolumny', () => {
    const t = [
      'Wycena:', '1x szablon - 100zł brutto/szt',
      'przygotowanie projektu - w cenie', 'wysyłka kurierem DPD - gratis',
      'Razem: 100zł (81,30zł netto)',
    ].join('\n');
    expect(renderMailHtml({ text: t })).not.toContain('colspan');
  });

  /* ⚠️ WYGLĄD NAGŁÓWKÓW ZMIENIŁ SIĘ 22.08.2026: z pogrubionego zdania na „eyebrow" w rejestrze
     PRO (wersaliki, rozstrzelenie, kolor akcentu) — ten sam, co nad tytułem strony oferty,
     żeby mail i sklep czytały się jak jedno miejsce. Dwukropek jest UMOWĄ TEKSTOWĄ (po nim
     renderer poznaje nagłówek) i dlatego w wersji HTML go nie ma: w wersalikach wygląda
     jak literówka, a w plain-textcie zostaje. */
  const naglowkiZ = (html) => [...html.matchAll(/letter-spacing:2px;text-transform:uppercase;color:[^"]*">(.*?)<\/p>/g)].map((m) => m[1]);

  it('„Wycena:" i „Czas realizacji:" są nagłówkami sekcji, nie akapitami', () => {
    const t = [
      'Wycena:', '1x szablon - 100zł brutto/szt', 'Razem: 100zł (81,30zł netto)',
      '', 'Czas realizacji:', 'Standardowy 3-7 dni - 0zł',
    ].join('\n');
    const naglowki = naglowkiZ(renderMailHtml({ text: t }));
    expect(naglowki).toContain('Wycena');
    expect(naglowki).toContain('Czas realizacji');
  });

  it('nagłówki ZAMÓWIENIE i ZWROTY też są nagłówkami sekcji', () => {
    const t = ['Dzień dobry,', '', 'Zamówienie:', 'Wybierz sposób:', '', 'Zwroty:', 'Nie ma zwrotów.'].join('\n');
    expect(naglowkiZ(renderMailHtml({ text: t }))).toEqual(['Zamówienie', 'Zwroty']);
  });

  /* ⚠️ NAJWĘŻSZE MIEJSCE TEJ REGUŁY. Zdanie „Możesz też przelać należność bezpośrednio na
     nasze konto:" też kończy się dwukropkiem — ale jest długie i stoi WEWNĄTRZ pudełka
     (nie ma nad sobą pustej linii). Gdyby zostało nagłówkiem, w środku opcji 3 wyrósłby
     wielki wersalikowy napis. */
  /* ⚠️ DRUGA POŁOWA TEJ REGUŁY, wykryta mutacją: samo „nad linią jest pusta linia" nie
     wystarcza. Akapit ZACZYNAJĄCY się od długiego zdania z dwukropkiem (a takie stoją
     w kilku tekstach w /settings) miałby nad sobą pustą linię i bez limitu słów wyrósłby
     na wersalikowy nagłówek — z całym zdaniem klienta w środku. */
  it('⚠️ długie zdanie z dwukropkiem otwierające akapit NIE jest nagłówkiem', () => {
    const t = ['Dzień dobry,', '',
      'dziękuję za akceptację wyceny — poniżej przesyłam wszystkie dane potrzebne do wpłaty:',
      'Lumina Marek Zywiecki'].join('\n');
    const html = renderMailHtml({ text: t });
    expect(naglowkiZ(html)).toEqual([]);
    expect(html).toContain('poniżej przesyłam wszystkie dane potrzebne do wpłaty:');
  });

  /* ⚠️ Etykieta przycisku też kończy się dwukropkiem i też stoi po pustej linii. Krótka
     („Zamów teraz:") przechodzi przez limit słów — rozstrzyga wtedy TO, CO POD NIĄ.
     Bez tej gardy przycisk traci podpis, a nad nim wyrasta nagłówek sekcji. */
  it('⚠️ krótka etykieta przycisku nie zamienia się w nagłówek sekcji', () => {
    const t = ['Dzień dobry,', '', 'Zamów teraz:', 'https://pro/?oferta=9'].join('\n');
    const html = renderMailHtml({ text: t });
    expect(naglowkiZ(html)).toEqual([]);
    expect(html).toMatch(/<a href="https:\/\/pro\/\?oferta=9"[^>]*>Zamów teraz<\/a>/);
  });

  /* ⚠️ „Czas realizacji:" pasuje TAKŻE do reguły nagłówka sekcji — ale tylko jego własna
     gałąź WŁĄCZA tryb tabeli. Gdy przestanie być rozpoznawany jako nagłówek realizacji,
     wiersze „opis - kwota" cicho zamieniają się w akapity i tabela znika z maila. */
  it('⚠️ tabela czasu realizacji renderuje się jako DWIE KOLUMNY, nie akapity', () => {
    const t = ['Czas realizacji:', 'Standardowy 3-7 dni - 0zł', 'Ekspres 48h - +50zł'].join('\n');
    const html = renderMailHtml({ text: t });
    expect(html).toContain('<table role="presentation"');
    expect(html).toMatch(/<td[^>]*>Standardowy 3-7 dni<\/td><td align="right"[^>]*>0zł<\/td>/);
    expect(html).toMatch(/<td[^>]*>Ekspres 48h<\/td><td align="right"[^>]*>\+50zł<\/td>/);
  });

  it('⚠️ długie zdanie z dwukropkiem w środku pudełka NIE jest nagłówkiem', () => {
    const t = ['Zamówienie:', 'Wybierz:', '', '1. Przelew tradycyjny',
      'Możesz też przelać należność bezpośrednio na nasze konto:', '07 1090 1014 0000 0000 0000 0001'].join('\n');
    const html = renderMailHtml({ text: t });
    expect(naglowkiZ(html)).toEqual(['Zamówienie']);
    expect(html).toContain('Możesz też przelać należność bezpośrednio na nasze konto:');
  });

  describe('pudełka opcji płatności', () => {
    const MAIL = [
      'Zamówienie:', 'Wybierz sposób:', '',
      '1. Zamówienie w sklepie',
      'Zapłacisz kartą.',
      'Akceptuję wycenę:',
      'https://pro/?oferta=1', '',
      '2. Faktura proforma',
      'Podaj dane.',
      'Wypełnij dane do proformy:',
      'https://pro/?proforma=2', '',
      '3. Przelew tradycyjny',
      'Na nasze konto:',
      '07 1090 1014 0000 0000 0000 0001',
      'kwota: 100zł',
    ].join('\n');

    it('każda ponumerowana opcja dostaje własne pudełko z kółkiem numeru', () => {
      const html = renderMailHtml({ text: MAIL });
      expect((html.match(/background-color:#F4EFE6/g) || [])).toHaveLength(3);
      expect(html).toContain('>1</span>Zamówienie w sklepie');
      expect(html).toContain('>2</span>Faktura proforma');
      expect(html).toContain('>3</span>Przelew tradycyjny');
    });

    /* Przycisk poza pudełkiem czytałby się jak osobny krok, a nie jak sposób wykonania
       tej właśnie opcji. */
    it('⚠️ przycisk stoi WEWNĄTRZ pudełka swojej opcji', () => {
      const html = renderMailHtml({ text: MAIL });
      // ⚠️ Podział po POCZĄTKU pudełka nie wystarcza i mutacja to pokazała: przycisk
      // wyrzucony ZA pudełko nadal wpada w ten sam kawałek (między jednym pudełkiem
      // a drugim), więc test świecił na zielono przy zepsutym układzie. Rozstrzyga
      // domknięcie tabeli pudełka: przycisk musi stać PRZED nim.
      const pudelka = html.split('background-color:#F4EFE6').slice(1);
      expect(pudelka[0].split('</table>')[0]).toContain('https://pro/?oferta=1');
      expect(pudelka[1].split('</table>')[0]).toContain('https://pro/?proforma=2');
      expect(pudelka[2].split('</table>')[0]).not.toContain('href');
    });

    /* Ten sam mail bez pudełek — dwa przyciski luzem (tak wygląda np. mail z projektem,
       gdyby kiedyś dostał drugi odnośnik). Reguła „pierwszy wypełniony" ma działać także
       na tej ścieżce; mutacja pokazała, że fixture z samymi pudełkami jej nie dotyka. */
    it('⚠️ kolejność rozstrzyga także dla przycisków POZA pudełkami', () => {
      const t = ['Dzień dobry,', '', 'Zobacz projekt:', 'https://pro/?a=1', '', 'Pobierz plik:', 'https://pro/?b=2'].join('\n');
      const linki = [...renderMailHtml({ text: t }).matchAll(/<a href="([^"]+)" style="([^"]+)"/g)].map((m) => m[2]);
      expect(linki).toHaveLength(2);
      expect(linki[0]).toContain('background-color:#3E5566');
      expect(linki[1]).toContain('border:1px solid #3E5566');
      expect(linki[1]).not.toContain('background-color:#3E5566');
    });

    /* Dwa jednakowo mocne przyciski każą klientowi zgadywać, który jest „ten właściwy". */
    it('⚠️ pierwszy przycisk wypełniony, drugi obrysowany — rozstrzyga KOLEJNOŚĆ', () => {
      // Badamy SAME znaczniki <a>, a nie okno tekstu przed adresem: pudełko niesie między
      // nimi kilkaset znaków własnego stylu (kółko z numerem), więc okno mierzyłoby co innego,
      // niż nazywa test. Ta pomyłka zdarzyła się przy pisaniu tego pliku.
      const linki = [...renderMailHtml({ text: MAIL }).matchAll(/<a href="([^"]+)" style="([^"]+)"/g)]
        .map((m) => ({ url: m[1], styl: m[2] }));
      expect(linki.map((l) => l.url)).toEqual(['https://pro/?oferta=1', 'https://pro/?proforma=2']);
      expect(linki[0].styl).toContain('background-color:#3E5566');
      expect(linki[0].styl).toContain('color:#ffffff');
      expect(linki[0].styl).not.toContain('border:1px solid');
      expect(linki[1].styl).toContain('border:1px solid #3E5566');
      expect(linki[1].styl).toContain('color:#3E5566');
      expect(linki[1].styl).not.toContain('background-color:#3E5566');
    });

    it('numer konta renderuje się czcionką o stałej szerokości, żeby dało się go przepisać', () => {
      const html = renderMailHtml({ text: MAIL });
      expect(html).toMatch(/monospace;">07 1090 1014 0000 0000 0000 0001</);
      // Kwota obok NIE jest numerem konta i zostaje zwykłą czcionką.
      expect(html).not.toMatch(/monospace;">kwota/);
    });

    /* Mail bez ponumerowanych opcji (projekt, dane do przelewu, przypomnienie) ma przejść
       tą samą drogą bez żadnej zmiany — pudełka nie mogą się w nim pojawić. */
    it('mail bez ponumerowanych opcji nie dostaje żadnego pudełka', () => {
      const html = renderMailHtml({ text: 'Dzień dobry,\nW załączniku projekt.\n\npozdrawiam' });
      expect(html).not.toContain('#F4EFE6');
    });
  });
});

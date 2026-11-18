import { describe, it, expect } from 'vitest';
import {
  opisDoSekcji,
  sekcjeAllegroDoSekcji,
  sekcjeDoTekstu,
  sekcjeDlaAllegro,
  sekcjeDlaErli,
  poprawneSekcje,
} from '../../src/domena/opis-sekcje.js';

const tekst = (html) => ({ typ: 'tekst', html });
const zdjecie = (adres) => ({ typ: 'zdjecie', adres });
const opis = (...elementy) => ({ sekcje: elementy.map((e) => ({ elementy: [e] })) });
const htmlWyniku = (wynik) =>
  wynik.sekcje
    .flatMap((s) => s.elementy)
    .filter((e) => e.typ === 'tekst')
    .map((e) => e.html)
    .join('');

describe('opis sklepu → sekcje OMS', () => {
  it.each([
    ['tekst luzem', 'Lampa do czytania', '<p>Lampa do czytania</p>'],
    [
      'listy zagnieżdżone',
      '<ul><li>Klosz<ol><li>Mały</li><li>Duży</li></ol></li><li>Ramię</li></ul>',
      '<ul><li>Klosz<ol><li>Mały</li><li>Duży</li></ol></li><li>Ramię</li></ul>',
    ],
    [
      'atrybuty i zamiana tagów',
      '<h3 dir="ltr">Lampa</h3><h4 class="tytul">Wymiary</h4><p style="color:red" class="opis" dir="ltr"><strong>Mosiądz</strong> <em>matowy</em> <i>i</i> <span>ciepły</span></p><h5>Pięć</h5><h6>Sześć</h6>',
      '<h2>Lampa</h2><h2>Wymiary</h2><p><b>Mosiądz</b> matowy i ciepły</p><h2>Pięć</h2><h2>Sześć</h2>',
    ],
    [
      'skrypt i komentarz',
      '<p>Bezpieczna<script>if (a < b) alert("<p>zło</p>")</script><!-- > <p>szum</p> --> lampa</p>',
      '<p>Bezpieczna lampa</p>',
    ],
    ['encje', '<p>Żółty&#8211;&nbsp;&amp; &#x142; &lt;klosz&gt;</p>', '<p>Żółty– &amp; ł &lt;klosz&gt;</p>'],
    ['encje nie są dekodowane drugi raz', '<p>&amp;lt; &ouml; &amp;amp;</p>', '<p>&amp;lt; &ouml; &amp;amp;</p>'],
    [
      'szum nie domyka akapitu na zewnątrz',
      '<p>Lampa<svg><text><p>Nie pokazuj</p></text></svg> do czytania</p>',
      '<p>Lampa do czytania</p>',
    ],
    ['br dzieli akapit', '<p>Pierwszy<br>Drugi<br/>Trzeci</p>', '<p>Pierwszy</p><p>Drugi</p><p>Trzeci</p>'],
    ['div i tekst luzem', 'Przed<div>W środku</div>Po', '<p>Przed</p><p>W środku</p><p>Po</p>'],
    [
      'odnośniki w tekście i same odnośniki',
      '<p>W zestawie <a href="/x">przewód</a>.</p><p><b><a href="/y">Blog</a></b> <a href="/z">Sklep</a></p><ul><li><a href="/z">Kup</a></li><li>Ramię</li></ul>',
      '<p>W zestawie przewód.</p><ul><li>Ramię</li></ul>',
    ],
    ['znak > w atrybucie', '<p title="a > b">Lampa</p>', '<p>Lampa</p>'],
    [
      'CDATA jest tekstem, a nie HTML',
      '<![CDATA[<script>tekst</script>]]>',
      '<p>&lt;script&gt;tekst&lt;/script&gt;</p>',
    ],
    ['samotne li', '<li>x</li><li>y</li>', '<p>x</p><p>y</p>'],
    ['blok w nagłówku', '<h3>przed<p>x</p>po</h3>', '<h2>przed</h2><p>x</p><h2>po</h2>'],
    ['blok w pogrubieniu', '<b>przed<p>x</p>po</b>', '<p><b>przed</b></p><p>x</p><p><b>po</b></p>'],
    ['nagłówek w pogrubieniu', '<b><h2>x</h2></b>', '<h2>x</h2>'],
    [
      'odnośnik z podlistą',
      '<ul><li><a href="/k">Komplet</a><ul><li>Klosz</li><li>Ramię</li></ul></li></ul>',
      '<ul><li>Komplet<ul><li>Klosz</li><li>Ramię</li></ul></li></ul>',
    ],
    [
      'odnośnik z podlistą numerowaną',
      '<ol><li><a href="/k">Komplet</a><ol><li>Klosz</li></ol></li></ol>',
      '<ol><li>Komplet<ol><li>Klosz</li></ol></li></ol>',
    ],
    ['tekst w liście', '<ul>tekst<li>x</li> \n </ul>', '<ul><li>tekst</li><li>x</li></ul>'],
    ['biały tekst w liście', '<ul>\n <li>x</li>\n <li>y</li>\n</ul>', '<ul><li>x</li><li>y</li></ul>'],
    ['znak mniejszości jest tekstem', '<p>Lampa < duża, 1<2</p>', '<p>Lampa &lt; duża, 1&lt;2</p>'],
    ['odnośniki w div i br', '<div><a>Wpis</a><br><a>Inny</a></div>', ''],
    ['mieszane akapity z div', '<div><a>Wpis</a><br>Opis <a>lampy</a></div>', '<p>Opis lampy</p>'],
  ])('%s', (_, wejscie, html) => {
    const wynik = opisDoSekcji(wejscie);
    expect(wynik).toEqual(html ? opis(tekst(html)) : { sekcje: [] });
    expect(poprawneSekcje(wynik)).toEqual({ ok: true, bledy: [] });
  });

  it.each([
    '',
    null,
    undefined,
    '  ',
    '<p>&nbsp;</p>',
    '<script>x</script><style>x</style><hr><form>formularz<input></form><button>Kup</button><select><option>x</option></select><textarea>x</textarea><noscript>x</noscript><svg><text>x</text></svg><iframe>x</iframe>',
  ])('usuwa pustkę i szum: %s', (html) => {
    expect(opisDoSekcji(html)).toEqual({ sekcje: [] });
  });

  it('obrazek w akapicie dzieli tekst, zachowując formatowanie i adres', () => {
    expect(opisDoSekcji('<p><b>Przed<img src="lokalne/żółty?a=1&amp;b=2" alt="x">Po</b></p>')).toEqual(
      opis(tekst('<p><b>Przed</b></p>'), zdjecie('lokalne/żółty?a=1&b=2'), tekst('<p><b>Po</b></p>')),
    );
  });

  it('figure usuwa w całości, także obrazek i podpis; sam img pozostaje', () => {
    expect(
      opisDoSekcji('<figure><img src="pomijany"><figcaption>Podpis</figcaption></figure><img src="zostaje">'),
    ).toEqual(opis(zdjecie('zostaje')));
  });

  const sklep = `<h3 dir="ltr">Pracownia Półcień — kinkiet</h3>
    <p style="color:red">Mosiądz <strong>szczotkowany</strong> &#8211;&nbsp;matowy &amp; trwały.</p><hr/>
    <div class="poradnik st-blok"><h4>Jak zamontować lampę</h4><p>Przykręć podstawę.</p>
    <figure><video controls><source src="film.mp4">Film</video></figure>
    <p><a href="https://polcien.example/blog">Więcej na blogu</a></p>
    <button>Kup teraz</button><p>Dołączamy <a href="/przewod">przewód</a>.</p>
    <div class="wpisy"><div><a href="/wpis-1"><img src="/blog-1.jpg"><span>Lampa nad fotelem</span></a></div>
    <div><a href="/wpis-2"><br><img src="/blog-2.jpg"><br><span>Światło w sypialni</span><br></a></div></div></div>`;

  it('czyści kształt sklepu bez wycinania klasy', () => {
    expect(
      opisDoSekcji(sklep)
        .sekcje.flatMap((s) => s.elementy)
        .every((e) => e.typ === 'tekst'),
    ).toBe(true);
    expect(htmlWyniku(opisDoSekcji(sklep))).toBe(
      '<h2>Pracownia Półcień — kinkiet</h2><p>Mosiądz <b>szczotkowany</b> – matowy &amp; trwały.</p><h2>Jak zamontować lampę</h2><p>Przykręć podstawę.</p><p>Dołączamy przewód.</p>',
    );
  });
  it('wycina całą zawartość dokładnie wskazanej klasy', () => {
    expect(htmlWyniku(opisDoSekcji(sklep, { klasyDoWyciecia: ['st-blok'] }))).toBe(
      '<h2>Pracownia Półcień — kinkiet</h2><p>Mosiądz <b>szczotkowany</b> – matowy &amp; trwały.</p>',
    );
    expect(htmlWyniku(opisDoSekcji('<div class="st-blok-inny">Zostaje</div>', { klasyDoWyciecia: ['st-blok'] }))).toBe(
      '<p>Zostaje</p>',
    );
  });
});

describe('Allegro i ERLI', () => {
  const zrodlo = {
    sections: [
      {
        items: [
          {
            type: 'TEXT',
            content: '<h3 style="color:red">Żółta lampa</h3><p>Pracownia <strong>Półcień</strong><br>Ramię</p>',
          },
          { type: 'IMAGE', url: 'https://polcien.example/lampa.jpg' },
        ],
      },
      {
        items: [
          { type: 'IMAGE', url: 'plik/lampa' },
          { type: 'TEXT', content: '<p>Drugi opis</p>' },
        ],
      },
    ],
  };
  it('zachowuje dwuelementowe sekcje i kolejność, czyści content', () => {
    expect(sekcjeAllegroDoSekcji(zrodlo)).toEqual({
      sekcje: [
        {
          elementy: [
            tekst('<h2>Żółta lampa</h2><p>Pracownia <b>Półcień</b></p><p>Ramię</p>'),
            zdjecie('https://polcien.example/lampa.jpg'),
          ],
        },
        { elementy: [zdjecie('plik/lampa'), tekst('<p>Drugi opis</p>')] },
      ],
    });
  });
  it('adres zdjęcia z Allegro to JSON, nie HTML — „&amp;” zostaje bez zmian', () => {
    const url = 'https://zdjecia.przyklad.invalid/lampa.jpg?w=800&amp;h=600&#38;x=1';
    const wynik = sekcjeAllegroDoSekcji({ sections: [{ items: [{ type: 'IMAGE', url }] }] });
    expect(wynik).toEqual({ sekcje: [{ elementy: [zdjecie(url)] }] });
    expect(sekcjeDlaAllegro(wynik).sections[0].items[0].url).toBe(url);
  });
  it.each([sekcjeDlaAllegro, sekcjeDlaErli])('eksportuje sekcje zgodne z walidatorem OMS i kanału: %s', (eksport) => {
    const oms = sekcjeAllegroDoSekcji(zrodlo);
    const wynik = eksport(oms);
    expect(wynik.sections.map((s) => s.items.length)).toEqual([2, 2]);
    expect(sekcjeAllegroDoSekcji(wynik)).toEqual(oms);
    expect(poprawneSekcje(sekcjeAllegroDoSekcji(wynik))).toEqual({ ok: true, bledy: [] });
    for (const sekcja of wynik.sections)
      for (const element of sekcja.items) {
        if (element.type === 'IMAGE') {
          expect(typeof element.url).toBe('string');
          continue;
        }
        expect(element.type).toBe('TEXT');
        const dozwolone = eksport === sekcjeDlaAllegro ? /^(h1|h2|p|b|ul|ol|li)$/ : /^(h1|h2|h3|p|b|br|ul|ol|li)$/;
        for (const znacznik of element.content.matchAll(/<\/?([^>]+)>/g)) {
          expect(znacznik[1].replace(/\/$/, '')).toMatch(dozwolone);
          if (znacznik[1].startsWith('br')) expect(znacznik[0]).toBe('<br/>');
        }
        expect(element.content).toMatch(/^<(h1|h2|p|ul|ol)>/);
      }
  });
  it('liczy cały JSON opisu w bajtach UTF-8, bez cichego obcinania', () => {
    const pusty = sekcjeDlaAllegro(opis(tekst('<p></p>')));
    const narzut = Buffer.byteLength(JSON.stringify(pusty));
    const ile = Math.floor((40000 - narzut) / 2);
    const graniczny = opis(tekst(`<p>${'ą'.repeat(ile)}</p>`));
    expect(sekcjeDlaAllegro(graniczny)).not.toHaveProperty('blad');
    expect(sekcjeDlaAllegro(graniczny)).toHaveProperty('sections');
    expect(Buffer.byteLength(JSON.stringify(sekcjeDlaAllegro(graniczny)))).toBeLessThanOrEqual(40000);
    expect(sekcjeDlaAllegro(opis(tekst(`<p>${'ą'.repeat(ile + 1)}</p>`))).blad).toMatch(/40.?000.*bajt/);
    expect(sekcjeDlaAllegro(opis(zdjecie('ą'.repeat(20000))))).toHaveProperty('blad');
  });
  it('obsługuje pusty opis', () => {
    expect(sekcjeAllegroDoSekcji(null)).toEqual({ sekcje: [] });
    expect(sekcjeDlaAllegro({ sekcje: [] })).toEqual({ sections: [] });
    expect(sekcjeDlaErli({ sekcje: [] })).toEqual({ sections: [] });
  });
});

describe('tekst i walidacja OMS', () => {
  it('pomija biały tekst między pozycjami listy również dla gotowych sekcji', () => {
    const html = '<ul>\n <li>Ramię</li>\n <li>Klosz</li>\n</ul>';
    expect(sekcjeDoTekstu(opis(tekst(html)))).toBe('- Ramię\n- Klosz');
    expect(sekcjeDoTekstu(opisDoSekcji(html))).toBe('- Ramię\n- Klosz');
  });
  it('oddziela akapity pustą linią, listy mają myślniki, encje są tekstem', () => {
    const wynik = opisDoSekcji(
      '<h2>Lampa</h2><p>Mosiądz &amp; szkło</p><ul><li>Duża<ul><li>Matowa</li></ul></li><li>Mała</li></ul><p>Koniec</p>',
    );
    expect(sekcjeDoTekstu(wynik)).toBe('Lampa\n\nMosiądz & szkło\n\n- Duża\n- Matowa\n- Mała\n\nKoniec');
    expect(sekcjeDoTekstu(opis(zdjecie('lokalne')))).toBe('');
  });
  it.each([
    null,
    {},
    { sekcje: {} },
    { sekcje: [null] },
    { sekcje: [{ elementy: [] }] },
    { sekcje: [{ elementy: [tekst('<p>x</p>'), tekst('<p>y</p>'), zdjecie('x')] }] },
    opis({ typ: 'film', adres: 'x' }),
    opis({ typ: 'zdjecie', adres: 12 }),
    opis({ typ: 'tekst', html: null }),
    ...[
      '<p style="color:red">x</p>',
      '<h3>x</h3>',
      '<p>x<br/>y</p>',
      '<p onclick="x">x</p>',
      '<script>x</script>',
      '<p><b>x</p></b>',
      '<p>x',
      'tekst luzem',
      '<!-- komentarz -->',
      '<ul>tekst<li>x</li></ul>',
      '<ol>tekst<li>x</li></ol>',
    ].map((h) => opis(tekst(h))),
  ])('odrzuca błędną postać %j', (wejscie) => {
    const wynik = poprawneSekcje(wejscie);
    expect(wynik.ok).toBe(false);
    expect(wynik.bledy.length).toBeGreaterThan(0);
    expect(wynik.bledy.every((b) => typeof b === 'string')).toBe(true);
  });
  it('dopuszcza pusty opis, wspólne tagi i dowolny napis adresu zdjęcia', () => {
    expect(poprawneSekcje({ sekcje: [] })).toEqual({ ok: true, bledy: [] });
    expect(
      poprawneSekcje(opis(tekst('<h1>Lampa</h1><h2>Mała</h2><p><b>Opis</b></p><ol><li>x</li></ol>'), zdjecie(''))),
    ).toEqual({ ok: true, bledy: [] });
  });
});

describe('regresje wrogich wejść recenzenta', () => {
  it.each([
    '<li>x</li>',
    '<h3><p>x</p></h3>',
    '<b><p>x</p></b>',
    '<b><h2>x</h2></b>',
    '<ul>tekst<li>x</li></ul>',
    '<ul><li><p>x</p></li></ul>',
    '<ul><li><h4>x</h4></li></ul>',
    '<p>a<ul><li>x</li></ul>b</p>',
    '<b>a<strong>b</strong></b>',
    '<table><tr><td>A</td><td>B</td></tr></table>',
    '<ol><li>a<li>b</ol>',
    '<ul><li><div>x</div></li></ul>',
    '<ul><li>a<br>b</li></ul>',
    '<h2>a<br>b</h2>',
    '<ul><li>a<img src="z">b</li></ul>',
    '<h3>a<img src="z">b</h3>',
    '<p>Lampa<b onclick="x',
    '<p title="x>Lampa</p><p>Druga</p>',
    '<p>a<!-- <script>alert(1)</script> -->b</p>',
    '<p>a < b > c 1<2</p>',
  ])('czyszczenie daje poprawną postać OMS: %s', (html) => {
    expect(poprawneSekcje(opisDoSekcji(html))).toEqual({ ok: true, bledy: [] });
  });
});

describe('adresy zdjęć', () => {
  it.each([
    'javascript:alert(1)',
    'data:image/png;base64,abc',
    '&#106;avascript:x',
    'ftp://polcien.example/x',
    'x" onerror="x',
    "x'y",
    'java\nscript:x',
    '/x\u0000y',
    '/x&#34;y',
  ])('pomija niebezpieczny adres: %s', (adres) => {
    expect(opisDoSekcji(`<img src='${adres.replace(/'/g, '&#39;')}'>`)).toEqual({ sekcje: [] });
    expect(sekcjeAllegroDoSekcji({ sections: [{ items: [{ type: 'IMAGE', url: adres }] }] })).toEqual({ sekcje: [] });
  });
  it.each(['https://polcien.example/x?a=1&amp;b=2', 'http://polcien.example/x', '/lokalne/x', 'lokalne/x', '../x'])(
    'zachowuje dozwolony adres po dekodowaniu: %s',
    (adres) => {
      const oczekiwany = opis(zdjecie(adres.replace('&amp;', '&')));
      expect(opisDoSekcji(`<img src="${adres}">`)).toEqual(oczekiwany);
      // Adres z JSON-u Allegro nie jest HTML-em: zostaje dosłownie (wcześniej „&amp;” zamieniało się w „&”).
      expect(sekcjeAllegroDoSekcji({ sections: [{ items: [{ type: 'IMAGE', url: adres }] }] })).toEqual(
        opis(zdjecie(adres)),
      );
    },
  );
});

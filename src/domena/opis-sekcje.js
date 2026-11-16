// Czyste przekształcenia opisu. Tokenizer czyta pojedyncze znaczniki z uwzględnieniem
// cudzysłowów; nigdy nie interpretuje tekstu z encji jako znacznika.
const DOZWOLONE = new Set(['h1', 'h2', 'p', 'b', 'ul', 'ol', 'li']);
const WYCINANE = new Set(['video', 'figure', 'iframe', 'script', 'style', 'hr', 'form', 'button', 'input', 'select', 'textarea', 'noscript', 'svg']);
const PUSTE = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);
const BLOKOWE = new Set(['p', 'div', 'section', 'article', 'header', 'footer', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'figure', 'hr']);
const ENCJE = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', hellip: '…', bull: '•', copy: '©', reg: '®', trade: '™', times: '×', laquo: '«', raquo: '»', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', euro: '€' };

function dekoduj(tekst) {
  return tekst.replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]+);/gi, (calosc, kod) => {
    if (kod[0] !== '#') return ENCJE[kod] ?? calosc;
    const liczba = kod[1].toLowerCase() === 'x' ? parseInt(kod.slice(2), 16) : Number(kod.slice(1));
    return liczba > 0 && liczba <= 0x10ffff && !(liczba >= 0xd800 && liczba <= 0xdfff)
      ? String.fromCodePoint(liczba).replace(/\u00a0/g, ' ') : '�';
  }).replace(/\u00a0/g, ' ');
}

function zabezpiecz(tekst) {
  return tekst.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function kodujTekst(tekst) {
  let wynik = '', start = 0;
  for (const encja of tekst.matchAll(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]+);/gi)) {
    wynik += zabezpiecz(tekst.slice(start, encja.index));
    // Nieznane encje nazwane zachowujemy w poprawnej postaci HTML.
    wynik += encja[1][0] === '#' || Object.hasOwn(ENCJE, encja[1]) ? zabezpiecz(dekoduj(encja[0])) : encja[0];
    start = encja.index + encja[0].length;
  }
  return wynik + zabezpiecz(tekst.slice(start));
}

function* tokeny(html) {
  let i = 0;
  let surowy = '';
  const male = html.toLowerCase();
  while (i < html.length) {
    if (surowy) {
      let koniec = male.indexOf(`</${surowy}`, i);
      while (koniec !== -1 && !/[\s>\/]/.test(html[koniec + surowy.length + 2] ?? '')) {
        koniec = male.indexOf(`</${surowy}`, koniec + 2);
      }
      if (koniec === -1) { yield { typ: 'tekst', tekst: html.slice(i) }; return; }
      yield { typ: 'tekst', tekst: html.slice(i, koniec) };
      i = koniec;
      surowy = '';
    }
    if (html.startsWith('<!--', i) || html.startsWith('<![CDATA[', i)) {
      const cdata = html.startsWith('<![CDATA[', i);
      const start = i + (cdata ? 9 : 4);
      const koniec = html.indexOf(cdata ? ']]>' : '-->', start);
      yield { typ: cdata ? 'cdata' : 'komentarz', tekst: html.slice(start, koniec === -1 ? html.length : koniec) };
      i = koniec === -1 ? html.length : koniec + 3;
      continue;
    }
    if (html[i] !== '<') {
      const koniec = html.indexOf('<', i);
      yield { typ: 'tekst', tekst: html.slice(i, koniec === -1 ? html.length : koniec) };
      i = koniec === -1 ? html.length : koniec;
      continue;
    }
    let j = i + 1;
    let cytat = '';
    for (; j < html.length; j++) {
      const znak = html[j];
      if (cytat) { if (znak === cytat) cytat = ''; }
      else if (znak === '"' || znak === "'") cytat = znak;
      else if (znak === '>') break;
    }
    const surowe = html.slice(i, j + 1);
    const tag = /^<(\/?)([a-z][a-z0-9:-]*)([\s\S]*?)>$/i.exec(surowe);
    if (!tag) {
      if (/^<!|^<\?/.test(surowe)) yield { typ: 'deklaracja', tekst: surowe };
      else yield { typ: 'tekst', tekst: '<' };
      i = /^<!|^<\?/.test(surowe) ? j + 1 : i + 1;
      continue;
    }
    const nazwa = tag[2].toLowerCase();
    const zamkniecie = !!tag[1];
    const atrybuty = {};
    for (const a of tag[3].matchAll(/([^\s=/'"<>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g)) {
      const klucz = a[1].toLowerCase();
      if (!Object.hasOwn(atrybuty, klucz)) atrybuty[klucz] = dekoduj(a[2] ?? a[3] ?? a[4] ?? '');
    }
    yield { typ: 'tag', nazwa, zamkniecie, atrybuty, reszta: tag[3], sam: /\/\s*$/.test(tag[3]) };
    i = j + 1;
    if (!zamkniecie && ['script', 'style', 'textarea', 'noscript', 'iframe'].includes(nazwa)) surowy = nazwa;
  }
}

function drzewo(html, klasy = new Set()) {
  const korzen = { nazwa: '', dzieci: [] };
  const stos = [korzen];
  const pomijane = [];
  for (const t of tokeny(html)) {
    // Wycinanie przed naprawą struktury: np. p wewnątrz SVG nie może
    // domknąć akapitu opisu i wypchnąć zawartości SVG poza usuwany blok.
    if (pomijane.length) {
      if (t.typ === 'tag') {
        if (t.zamkniecie) {
          const indeks = pomijane.lastIndexOf(t.nazwa);
          if (indeks >= 0) pomijane.length = indeks;
        } else if (!PUSTE.has(t.nazwa)) pomijane.push(t.nazwa);
      }
      continue;
    }
    if (t.typ === 'tag' && !t.zamkniecie && (WYCINANE.has(t.nazwa) || (t.atrybuty.class ?? '').split(/\s+/).some(k => klasy.has(k)))) {
      if (!PUSTE.has(t.nazwa)) pomijane.push(t.nazwa);
      continue;
    }
    if (t.typ === 'tekst' || t.typ === 'cdata') {
      stos.at(-1).dzieci.push({ tekst: t.typ === 'cdata' ? t.tekst : dekoduj(t.tekst), html: t.typ === 'cdata' ? zabezpiecz(t.tekst) : kodujTekst(t.tekst) });
    } else if (t.typ === 'tag') {
      if (t.zamkniecie) {
        const indeks = stos.findLastIndex(w => w.nazwa === t.nazwa);
        if (indeks > 0) stos.length = indeks;
        continue;
      }
      // Domknięcie typowych niejawnych końców w HTML sklepu.
      if (BLOKOWE.has(t.nazwa)) {
        const p = stos.findLastIndex(w => w.nazwa === 'p');
        if (p > 0) stos.length = p;
      }
      if (t.nazwa === 'li') {
        for (let k = stos.length - 1; k > 0; k--) {
          if (['ul', 'ol'].includes(stos[k].nazwa)) break;
          if (stos[k].nazwa === 'li') { stos.length = k; break; }
        }
      }
      const wezel = { nazwa: t.nazwa, atrybuty: t.atrybuty, dzieci: [] };
      stos.at(-1).dzieci.push(wezel);
      if (!PUSTE.has(t.nazwa)) stos.push(wezel);
    }
  }
  return korzen;
}

const maTresc = html => dekoduj(html.replace(/<[^>]*>/g, '')).trim().length > 0;
const znacznik = nazwa => ({ strong: 'b', h3: 'h2', h4: 'h2', h5: 'h2', h6: 'h2' })[nazwa] ?? nazwa;

function adresZdjecia(adres, encje = true) {
  if (typeof adres !== 'string') return null;
  const wynik = encje ? dekoduj(adres) : adres;
  if (!wynik.trim() || /[\u0000-\u001f\u007f-\u009f"']/.test(wynik)) return null;
  if (/^[^/?#]*:/.test(wynik) && !/^https?:\/\//i.test(wynik)) return null;
  return wynik;
}

function czysc(html, klasy) {
  const wyciety = w => WYCINANE.has(w.nazwa) || (w.atrybuty?.class ?? '').split(/\s+/).some(k => klasy.has(k));

  // Metadane tekstu zachowujemy do chwili utworzenia akapitu/li,
  // również gdy granica powstała dopiero przez div lub br.
  function opakuj(elementy, tag) {
    const wynik = [];
    let zawartosc = '', link = false, inny = false;
    function zakoncz() {
      if (maTresc(zawartosc) && (!['p', 'li'].includes(tag) || !link || inny)) {
        wynik.push({ html: `<${tag}>${tag === 'b' ? zawartosc : zawartosc.trim()}</${tag}>`, blok: tag !== 'b', tag, link, inny });
      }
      zawartosc = ''; link = false; inny = false;
    }
    for (const e of elementy) {
      if (e.html !== undefined && (!e.blok || tag === 'li')) {
        zawartosc += e.html; link ||= e.link; inny ||= e.inny;
      } else { zakoncz(); if (!e.przerwa) wynik.push(e); }
    }
    zakoncz();
    return wynik;
  }

  function renderuj(w, wLinku = false, rodzic = '') {
    if ('tekst' in w) return [{ html: w.html.replace(/\s+/g, ' '), blok: false, link: wLinku && !!w.tekst.trim(), inny: !wLinku && !!w.tekst.trim() }];
    if (wyciety(w)) return [];
    if (w.nazwa === 'img') {
      const adres = adresZdjecia(w.atrybuty.src, false);
      return !wLinku && adres !== null ? [{ adres }] : [];
    }
    if (w.nazwa === 'br') return [{ przerwa: true }];
    const dzieci = w.dzieci.flatMap(d => renderuj(d, wLinku || w.nazwa === 'a', w.nazwa));
    if (!w.nazwa || BLOKOWE.has(w.nazwa) && !DOZWOLONE.has(znacznik(w.nazwa))) return opakuj(dzieci, 'p');
    const tag = w.nazwa === 'li' && !['ul', 'ol'].includes(rodzic) ? 'p' : znacznik(w.nazwa);
    if (!DOZWOLONE.has(tag)) return dzieci;
    if (['ul', 'ol'].includes(tag)) {
      const pozycje = [];
      let inline = [];
      function zakoncz() { pozycje.push(...opakuj(inline, 'li')); inline = []; }
      for (const e of dzieci) {
        if (e.tag === 'li' || e.adres !== undefined) { zakoncz(); pozycje.push(e); }
        else if (e.przerwa) zakoncz();
        else inline.push(e);
      }
      zakoncz();
      // Obrazek dzieli również listę: po obu stronach zostaje pełna struktura.
      const wynik = [];
      let html = '';
      function zamknijListe() { if (html) wynik.push({ html: `<${tag}>${html}</${tag}>`, blok: true, tag, link: false, inny: true }); html = ''; }
      for (const e of pozycje) {
        if (e.html !== undefined) html += e.html;
        else { zamknijListe(); wynik.push(e); }
      }
      zamknijListe();
      return wynik;
    }
    return opakuj(dzieci, tag);
  }

  const sekcje = [];
  let tekst = '';
  function zakoncz() {
    if (tekst) sekcje.push({ elementy: [{ typ: 'tekst', html: tekst }] });
    tekst = '';
  }
  for (const e of renderuj(drzewo(html, klasy))) {
    if (e.html !== undefined) tekst += e.html;
    else if (e.adres !== undefined) { zakoncz(); sekcje.push({ elementy: [{ typ: 'zdjecie', adres: e.adres }] }); }
  }
  zakoncz();
  return { sekcje };
}

export function opisDoSekcji(html, { klasyDoWyciecia = [] } = {}) {
  return czysc(typeof html === 'string' ? html : '', new Set(klasyDoWyciecia));
}

export function sekcjeAllegroDoSekcji(description) {
  const sekcje = [];
  for (const sekcja of description?.sections ?? []) {
    const elementy = [];
    for (const item of sekcja.items ?? []) {
      if (item?.type === 'IMAGE') {
        // `url` przychodzi w JSON-ie, nie w HTML-u — „&amp;” zostaje bez zmian. Adres, który
        // byłby niebezpieczny po zdekodowaniu encji (`&#106;avascript:`), i tak odrzucamy.
        const adres = adresZdjecia(item.url) === null ? null : adresZdjecia(item.url, false);
        if (adres !== null) elementy.push({ typ: 'zdjecie', adres });
      }
      if (item?.type === 'TEXT') elementy.push(...opisDoSekcji(item.content).sekcje.flatMap(s => s.elementy));
    }
    // Prawidłowe sekcje źródłowe (1–2 elementy) pozostają razem. Obrazki
    // osadzone w nieprawidłowym TEXT mogą zwiększyć liczbę elementów.
    for (let i = 0; i < elementy.length; i += 2) sekcje.push({ elementy: elementy.slice(i, i + 2) });
  }
  return { sekcje };
}

export function sekcjeDoTekstu(opis) {
  const teksty = [];
  for (const sekcja of opis?.sekcje ?? []) for (const element of sekcja.elementy ?? []) {
    if (element.typ !== 'tekst') continue;
    let tekst = '';
    let listy = 0;
    const stos = [];
    for (const t of tokeny(element.html)) {
      if (t.typ === 'tekst' && !(listy && ['ul', 'ol'].includes(stos.at(-1)) && !t.tekst.trim())) tekst += dekoduj(t.tekst);
      if (t.typ !== 'tag') continue;
      if (t.zamkniecie) stos.pop(); else stos.push(t.nazwa);
      if (t.nazwa === 'li') tekst += t.zamkniecie ? (tekst.endsWith('\n') ? '' : '\n') : `${tekst.endsWith('\n') || !tekst ? '' : '\n'}- `;
      else if (['ul', 'ol'].includes(t.nazwa)) {
        listy += t.zamkniecie ? -1 : 1;
        if (t.zamkniecie) tekst = tekst.replace(/\n*$/, listy === 0 ? '\n\n' : '\n');
      } else if (t.zamkniecie && ['p', 'h1', 'h2'].includes(t.nazwa)) tekst += '\n\n';
    }
    teksty.push(tekst.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim());
  }
  return teksty.filter(Boolean).join('\n\n');
}

function dlaKanalu(opis) {
  return { sections: opis.sekcje.map(s => ({ items: s.elementy.map(e => e.typ === 'tekst'
    ? { type: 'TEXT', content: e.html }
    : { type: 'IMAGE', url: e.adres }) })) };
}

export function sekcjeDlaAllegro(opis) {
  const wynik = dlaKanalu(opis);
  return Buffer.byteLength(JSON.stringify(wynik), 'utf8') > 40000
    ? { blad: 'Opis Allegro przekracza limit 40 000 bajtów UTF-8.' } : wynik;
}

export function sekcjeDlaErli(opis) {
  // OMS nie zawiera br: podziały są osobnymi akapitami, legalnymi w ERLI.
  return dlaKanalu(opis);
}

export function poprawneSekcje(opis) {
  const bledy = [];
  if (!opis || !Array.isArray(opis.sekcje)) return { ok: false, bledy: ['Opis musi zawierać tablicę sekcje.'] };
  for (const [i, sekcja] of opis.sekcje.entries()) {
    if (!Array.isArray(sekcja?.elementy) || sekcja.elementy.length < 1 || sekcja.elementy.length > 2) {
      bledy.push(`Sekcja ${i + 1} musi zawierać 1–2 elementy.`);
      continue;
    }
    for (const element of sekcja.elementy) {
      if (element?.typ === 'zdjecie' && typeof element.adres === 'string') continue;
      if (element?.typ !== 'tekst' || typeof element.html !== 'string') {
        bledy.push(`Sekcja ${i + 1}: nieprawidłowy typ elementu lub jego treści.`);
        continue;
      }
      const stos = [];
      let poprawny = true;
      for (const t of tokeny(element.html)) {
        if (t.typ === 'tekst') { if (t.tekst.trim() && !['p', 'h1', 'h2', 'b', 'li'].includes(stos.at(-1))) poprawny = false; continue; }
        if (t.typ !== 'tag' || !DOZWOLONE.has(t.nazwa) || t.reszta.trim() || t.sam) { poprawny = false; continue; }
        if (t.zamkniecie) { if (stos.pop() !== t.nazwa) poprawny = false; }
        else {
          const rodzic = stos.at(-1);
          if (!rodzic && ['b', 'li'].includes(t.nazwa)) poprawny = false;
          if (['p', 'h1', 'h2', 'b'].includes(rodzic) && t.nazwa !== 'b') poprawny = false;
          if (['ul', 'ol'].includes(rodzic) && t.nazwa !== 'li') poprawny = false;
          stos.push(t.nazwa);
        }
      }
      if (stos.length || !poprawny) bledy.push(`Sekcja ${i + 1}: HTML zawiera niedozwolone znaczniki, atrybuty lub błędne zagnieżdżenie.`);
    }
  }
  return { ok: bledy.length === 0, bledy };
}

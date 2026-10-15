/* ===========================================================================
   KOMPONER KARTY — jedno pole do pisania maili na całą kartę.

   Trzy rzeczy, których nie da się zrobić po stronie serwera i dlatego są tutaj:

   1. ZAŁĄCZNIKI. `input.files` (FileList) jest TYLKO DO ODCZYTU — nic go nie czyści.
      To jest przyczyna zgłoszonej usterki „złego pliku nie da się usunąć": dawny kod
      wyłącznie WYŚWIETLAŁ nazwę z inputa, więc odrzucony plik zostawał do przeładowania
      strony. Własna lista + odbudowa FileList przez DataTransfer to jedyna droga.

   2. PRZELANIE SZKICU. Przyciski prawej kolumny proszą serwer o gotową treść maila
      (dane do przelewu, link do sklepu, odpowiedź AI, poprawka). Odpowiedź ląduje
      w poczekalni `#komponer-wsad`, a stąd trafia do pól komponera.

   3. POTWIERDZENIE WYSYŁKI. Robi je ten formularz, a nie drugi POST — pliku nie da się
      przepisać do pola ukrytego między krokami, więc dwukrokowa wysyłka po stronie
      serwera gubiłaby załącznik PO CICHU (mail wychodzi poprawny, tylko bez projektu).
   =========================================================================== */
(function () {
  'use strict';

  var form = document.getElementById('komponer');
  if (!form) return;

  var poleTemat = document.getElementById('komponer-subject');
  var poleTresc = document.getElementById('komponer-body');
  var poleKind = document.getElementById('komponer-kind');
  var poleConfirm = document.getElementById('komponer-confirm');
  var btnWyslij = document.getElementById('komponer-wyslij');
  var btnRano = document.getElementById('komponer-rano');
  var btnAnuluj = document.getElementById('komponer-anuluj-wysylke');
  var btnCofnij = document.getElementById('komponer-cofnij');
  var btnPopraw = document.getElementById('komponer-popraw');
  var btnWyczysc = document.getElementById('komponer-wyczysc');
  var poleDw = document.getElementById('komponer-dw');
  var dwZwiniete = document.getElementById('komponer-dw-zwiniete');
  var dwPole = document.getElementById('komponer-dw-pole');
  var btnDwPokaz = document.getElementById('komponer-dw-pokaz');
  var pasekTryb = document.getElementById('komponer-tryb');
  var tekstTryb = document.getElementById('komponer-tryb-tekst');
  var uwaga = document.getElementById('komponer-uwaga');

  // Stan, do którego wraca „Wyczyść". Temat domyślny to „Re: <temat klienta>" policzone przez
  // serwer; przy karcie z telefonu jest pusty. Odnośniki wątku zapamiętujemy, bo szkic
  // (np. „Dane do przelewu") potrafi je podmienić — po wyczyszczeniu mają wrócić te z wątku.
  var TEMAT_DOMYSLNY = form.dataset.tematDomyslny || '';
  var poleIrt = form.querySelector('[name=inReplyTo]');
  var poleRefs = form.querySelector('[name=references]');
  var IRT_DOMYSLNY = poleIrt ? poleIrt.value : '';
  var REFS_DOMYSLNE = poleRefs ? poleRefs.value : '';

  var strefa = document.getElementById('zal-strefa');
  var wejscie = document.getElementById('zal-input');
  var lista = document.getElementById('zal-lista');
  var pusto = document.getElementById('zal-pusto');
  var bladBox = document.getElementById('zal-blad');
  var dodajBox = document.getElementById('zal-dodaj');
  var sumaBox = document.getElementById('zal-suma');

  var DOZWOLONE = (strefa.dataset.rozszerzenia || '').split(',').filter(Boolean);
  var LIMIT = Number(strefa.dataset.limit) || 25 * 1024 * 1024;

  var UWAGA_DOMYSLNA = uwaga ? uwaga.textContent : '';
  // Etykiety trybu. `kind` jedzie na serwer i decyduje, CO panel zapisze po wysyłce —
  // pasek nad polem mówi operatorowi to samo, zanim kliknie „Wyślij".
  var TRYBY = {
    quote: '📄 Wycena',
    reminder: '📄 Przypomnienie o ważności oferty',
    transfer: '✉️ Dane do przelewu',
    'shipping-request': '✉️ Prośba o dane do wysyłki',
    'shop-link': '🔗 Link do zamówienia w sklepie',
    project: '🎨 Projekt do akceptacji',
    'project-reminder': '📤 Przypomnienie o akceptacji projektu',
    decline: '✖ Odmowa',
  };

  // Tryby, które w ogóle wolno odłożyć do rana — lustro `KIND_ODRACZALNE` z
  // `routes/zaplanowane.js`. Projekt, proforma i odmowa muszą wyjść wtedy, gdy operator je
  // zatwierdza, a nie osiem godzin później, gdy stan po drugiej stronie bywa już inny.
  // ⚠️ To jest WYGODA, nie zabezpieczenie: rozstrzyga trasa, która odmawia z komunikatem.
  var ODRACZALNE = ['reply', 'quote'];
  var DNI_TYG = ['niedziela', 'poniedziałek', 'wtorek', 'środa', 'czwartek', 'piątek', 'sobota'];

  /* ------------------------------- załączniki ------------------------------- */

  var pliki = [];
  var poprzedniaTresc = null;
  // Do jakiej „grupy" należy plik dołożony przez panel (dziś tylko `proforma`). Ręcznie
  // wybrane pliki grupy nie mają — nikt ich nie zastępuje.
  var grupy = new WeakMap();

  function rozszerzenie(nazwa) {
    var i = String(nazwa).lastIndexOf('.');
    return i === -1 ? '' : String(nazwa).slice(i + 1).toLowerCase();
  }

  // Lustro reguł z src/domain/zalaczniki.js. ⚠️ To jest WYGODA, nie zabezpieczenie —
  // rozstrzyga serwer (sprawdzKomplet w routes/reply.js). Wartości (lista rozszerzeń,
  // limit) przychodzą z tamtego modułu przez atrybuty `data-`, więc nie ma dwóch list.
  function zly(plik) {
    var ext = rozszerzenie(plik.name);
    if (!ext) return 'brak rozszerzenia';
    if (DOZWOLONE.indexOf(ext) === -1) return 'niedozwolony typ (.' + ext + ')';
    if (!plik.size) return 'plik jest pusty (0 bajtów)';
    return null;
  }

  // Poniżej megabajta liczymy w kilobajtach: „0 MB" przy pliku 1,5 kB wygląda jak awaria
  // odczytu rozmiaru, a operator ma po tej liczbie poznać, czy plik się w ogóle wczytał.
  function mb(bajty) {
    if (bajty < 1024 * 1024) return Math.max(1, Math.round(bajty / 1024)) + ' kB';
    return String(Math.round((bajty / (1024 * 1024)) * 10) / 10).replace('.', ',') + ' MB';
  }

  function suma() {
    return pliki.reduce(function (s, p) { return s + p.size; }, 0);
  }

  // FileList jest niezapisywalna wprost — odbudowujemy ją z własnej listy, żeby FormData
  // (a przez nie htmx) wysłało dokładnie to, co widać na ekranie.
  function przepiszDoInputa() {
    var dt = new DataTransfer();
    pliki.forEach(function (p) { dt.items.add(p); });
    wejscie.files = dt.files;
  }

  function rysujZalaczniki() {
    lista.innerHTML = '';
    var bledy = [];
    pliki.forEach(function (p, idx) {
      var powod = zly(p);
      if (powod) bledy.push(p.name + ' — ' + powod);
      var li = document.createElement('li');
      li.className = 'zal' + (powod ? ' zly' : '');
      li.innerHTML =
        '<span class="ikona">' + (powod ? '⛔' : '📄') + '</span>' +
        '<span class="nazwa"></span>' +
        '<span class="waga"></span>' +
        '<span class="sp"></span>' +
        '<button type="button" class="zal-usun" title="usuń załącznik">✕</button>';
      li.querySelector('.nazwa').textContent = p.name;
      li.querySelector('.waga').textContent = mb(p.size);
      li.querySelector('.zal-usun').addEventListener('click', function () {
        pliki.splice(idx, 1);
        przepiszDoInputa();
        rysujZalaczniki();
      });
      lista.appendChild(li);
    });

    var zaDuzo = suma() > LIMIT;
    if (zaDuzo) bledy.push('Załączniki ważą razem ' + mb(suma()) + ', a limit jednej wiadomości to ' + mb(LIMIT) + '.');

    lista.hidden = pliki.length === 0;
    pusto.hidden = pliki.length > 0;
    dodajBox.hidden = pliki.length === 0;
    strefa.classList.toggle('pusta', pliki.length === 0);
    sumaBox.textContent = pliki.length ? 'łącznie ' + mb(suma()) + ' z ' + mb(LIMIT) : '';

    bladBox.hidden = bledy.length === 0;
    bladBox.textContent = bledy.join(' · ');

    // ⚠️ „Wyślij" gaśnie, dopóki na liście jest plik z błędem — odmowa ma przyjść PRZED
    // wysyłką, a nie po niej, gdy mail już poszedł do klienta bez połowy załączników.
    btnWyslij.disabled = bledy.length > 0;
    btnWyslij.title = bledy.length ? 'usuń plik z błędem, żeby wysłać' : '';

    // ⚠️ „Wyślij rano" gaśnie Z TEGO SAMEGO POWODU, i to jest ważniejsze niż przy „Wyślij":
    // zaplanowana wiadomość odbija się o walidację dopiero o 7:00, gdy przy klawiaturze nie
    // ma już nikogo, kto by ten plik poprawił.
    if (btnRano) {
      btnRano.disabled = bledy.length > 0;
      btnRano.title = bledy.length
        ? 'usuń plik z błędem, żeby zaplanować'
        : 'mail poczeka w kolejce i wyjdzie o ustalonej godzinie';
    }

    // Dołożony albo usunięty załącznik zmienia odpowiedź na pytanie „czy jest co czyścić".
    odswiezPasek();
  }

  /**
   * @param {ArrayLike<File>} nowe
   * @param {string|null} grupa  gdy podana, USUWA z listy poprzedni plik tej samej grupy.
   *
   * ⚠️ ZASTĘPOWANIE W GRUPIE ISTNIEJE Z JEDNEGO POWODU: kolejna proforma UNIEWAŻNIA
   * poprzednią po stronie OMS-u. Dwa kliknięcia „Wystaw proformę" bez tego zostawiłyby
   * w mailu OBA dokumenty — klient dostałby razem z ważnym także ten, który przed chwilą
   * przestał obowiązywać, i nie miałby jak ich rozróżnić. Dokładnie to, przed czym broni
   * automatyczne unieważnianie po tamtej stronie.
   */
  function dodajPliki(nowe, grupa) {
    if (grupa) {
      pliki = pliki.filter(function (p) { return grupy.get(p) !== grupa; });
    }
    Array.prototype.forEach.call(nowe, function (p) {
      if (grupa) grupy.set(p, grupa);
      pliki.push(p);
    });
    przepiszDoInputa();
    rysujZalaczniki();
    zerujPotwierdzenie();
  }

  document.getElementById('zal-wybierz').addEventListener('click', function () { wejscie.click(); });
  document.getElementById('zal-dodaj-btn').addEventListener('click', function () { wejscie.click(); });
  wejscie.addEventListener('change', function () {
    // Pliki z inputa kopiujemy do własnej listy i input zaraz potem i tak nadpiszemy —
    // inaczej drugi wybór skasowałby pierwszy (FileList się nie sumuje).
    var wybrane = Array.prototype.slice.call(wejscie.files);
    wejscie.value = '';
    dodajPliki(wybrane);
  });

  ['dragenter', 'dragover'].forEach(function (ev) {
    strefa.addEventListener(ev, function (e) { e.preventDefault(); strefa.classList.add('drag'); });
  });
  ['dragleave', 'drop'].forEach(function (ev) {
    strefa.addEventListener(ev, function (e) { e.preventDefault(); strefa.classList.remove('drag'); });
  });
  strefa.addEventListener('drop', function (e) {
    if (e.dataTransfer && e.dataTransfer.files.length) dodajPliki(e.dataTransfer.files);
  });

  /* --------------------------------- tryb ---------------------------------- */

  function ustawTryb(kind) {
    poleKind.value = kind || 'reply';
    var etykieta = TRYBY[poleKind.value];
    if (etykieta) {
      tekstTryb.innerHTML = '';
      tekstTryb.appendChild(document.createTextNode('Tryb: '));
      var b = document.createElement('b');
      b.textContent = etykieta;
      tekstTryb.appendChild(b);
    } else {
      // Bez trybu pasek nie ma co mówić — zostawiona etykieta wróciłaby przy następnym
      // pokazaniu paska jako duch poprzedniego trybu.
      tekstTryb.textContent = '';
    }
    odswiezPasek();
    // Zmiana trybu może zabrać albo oddać „Wyślij rano" — odroczyć wolno tylko odpowiedź
    // i wycenę, więc przycisk musi zniknąć razem z przejściem na projekt czy odmowę.
    odswiezRano();
  }

  /* -------------------------------- „Wyczyść" -------------------------------- */

  // Czy w komponerze jest COKOLWIEK, co wyczyszczenie by zabrało. Sam temat domyślny się
  // nie liczy — z nim komponer jest „pusty".
  function maCoCzyscic() {
    return poleTemat.value !== TEMAT_DOMYSLNY
      || poleTresc.value.trim() !== ''
      || pliki.length > 0
      || Boolean(TRYBY[poleKind.value]);
  }

  // ⚠️ Przycisk pokazuje się TYLKO wtedy, gdy jest co czyścić (decyzja właściciela, 19.08.2026);
  // przy pustym komponerze znika razem z paskiem. Wcześniej wisiał zawsze przy ustawionym
  // trybie i kasował WYŁĄCZNIE etykietę trybu — nie temat, nie treść, nie załączniki —
  // więc jego nazwa obiecywała coś, czego nie robił.
  function odswiezPasek() {
    var etykieta = Boolean(TRYBY[poleKind.value]);
    var czysc = maCoCzyscic();
    tekstTryb.hidden = !etykieta;
    btnWyczysc.hidden = !czysc;
    pasekTryb.hidden = !etykieta && !czysc;
  }

  function wyczysc() {
    poleTemat.value = TEMAT_DOMYSLNY;
    poleTresc.value = '';
    pliki = [];
    przepiszDoInputa();
    rysujZalaczniki();
    if (poleIrt) poleIrt.value = IRT_DOMYSLNY;
    if (poleRefs) poleRefs.value = REFS_DOMYSLNE;
    poprzedniaTresc = null;
    btnCofnij.hidden = true;
    pokazUwage(null);
    ustawTryb('reply');
    zerujPotwierdzenie();
    poleTresc.focus();
  }

  // DW jest ZWINIĘTE, dopóki karta nie ma adresów w kopii — to sprawa rzadka i nie ma prawa
  // zajmować miejsca na każdej karcie. Rozwinięte zostaje do przeładowania strony; po wysyłce
  // wraca samo, bo widok renderuje je otwarte, gdy karta ma zapisaną kopię.
  //
  // ⚠️ ZWIJANIA NIE MA — po rozwinięciu pole zostaje. Zwinięcie musiałoby albo skasować
  // wpisane adresy (cicha strata przed samą wysyłką), albo je ukryć, a wtedy operator
  // wysyłałby kopię, której nie widzi.
  if (btnDwPokaz && dwPole) {
    btnDwPokaz.addEventListener('click', function () {
      dwPole.hidden = false;
      if (dwZwiniete) dwZwiniete.hidden = true;
      if (poleDw) poleDw.focus();
    });
  }

  btnWyczysc.addEventListener('click', wyczysc);
  poleTemat.addEventListener('input', odswiezPasek);
  poleTresc.addEventListener('input', odswiezPasek);

  /* --------------------------- przelanie szkicu ----------------------------- */

  function pokazUwage(tekst) {
    if (!uwaga) return;
    uwaga.textContent = tekst || UWAGA_DOMYSLNA;
    uwaga.classList.toggle('uwaga-mocna', Boolean(tekst));
  }

  /**
   * Bierze szkic z pudełka `.reply-box` i wlewa go do komponera.
   *
   * ⚠️ ROZSTRZYGA OBECNOŚĆ `textarea[name=body]`. Pudełko bez niej to KOMUNIKAT
   * („nie udało się wygenerować", „brak adresu e-mail") albo krok potwierdzenia
   * (tam `body` jest polem ukrytym) — takie zostaje na miejscu i ma być widoczne.
   */
  function przelej(box) {
    var tresc = box.querySelector('textarea[name=body]');
    if (!tresc) return false;

    var temat = box.querySelector('[name=subject]');
    var kind = box.querySelector('[name=kind]');
    var irt = box.querySelector('[name=inReplyTo]');
    var refs = box.querySelector('[name=references]');

    // Pole podmieniamy TYLKO wtedy, gdy przyszło w szkicu. „Popraw" oddaje samą treść —
    // nadpisanie tematu pustym ciągiem skasowałoby operatorowi to, co już wpisał.
    poleTresc.value = tresc.value;
    if (temat) poleTemat.value = temat.value;
    if (kind) ustawTryb(kind.value);
    if (irt) form.querySelector('[name=inReplyTo]').value = irt.value;
    if (refs) form.querySelector('[name=references]').value = refs.value;

    var ostrzezenie = box.querySelector('.warn');
    pokazUwage(ostrzezenie ? ostrzezenie.textContent.trim() : null);

    box.remove();
    zerujPotwierdzenie();
    odswiezPasek();
    poleTresc.scrollIntoView({ block: 'nearest' });
    return true;
  }

  /**
   * Pudełko przynoszące GOTOWY PLIK (dziś: proforma wystawiona przez OMS) — dokłada go do
   * listy załączników tak, jakby operator sam wybrał go z dysku: z krzyżykiem, z wagą,
   * wliczony do sumy 25 MB i sprawdzony tą samą walidacją.
   *
   * ⚠️ ATRYBUT KASUJEMY OD RAZU, PRZED pobraniem. Pudełko zostaje na ekranie jako
   * potwierdzenie („proforma PF/3/08/2026 dołączona"), a htmx potrafi przetworzyć ten sam
   * węzeł powtórnie — bez tego drugi przebieg dokleiłby DRUGĄ kopię tego samego dokumentu,
   * i klient dostałby proformę dwa razy w jednym mailu.
   *
   * Pudełko z plikiem NIE MA `textarea[name=body]`, więc `przelej` go nie tknie: treść maila
   * pisze operator albo wstawia ją „Dane do przelewu". Proforma się DOKŁADA, nie zastępuje.
   */
  function dolaczPlik(box) {
    // ⚠️ LISTA IDZIE PRZED POJEDYNCZYM PLIKIEM i ma własną gałąź, bo to inne pudełko:
    // `data-plik` niesie dokument wystawiony przez panel (proforma, projekt do
    // przypomnienia), `data-pliki` — załączniki ODWOŁANEJ wiadomości wracające do pisania.
    // Sklejenie obu w jedną ścieżkę wymusiłoby wspólną grupę zastępowania, a tego akurat
    // nie wolno: dwa odzyskane projekty mają wrócić OBA, nie jeden zamiast drugiego.
    if (box.dataset && box.dataset.pliki) {
      var lista = box.dataset.pliki;
      box.removeAttribute('data-pliki');
      dolaczListe(box, lista);
      return true;
    }
    var zrodlo = box.dataset ? box.dataset.plik : null;
    if (!zrodlo) return false;
    box.removeAttribute('data-plik');
    var nazwa = box.dataset.plikNazwa || 'zalacznik.pdf';
    fetch(zrodlo)
      .then(function (r) {
        // ⚠️ `fetch` NIE RZUCA przy 404 — a odkąd pudełko potrafi nieść ADRES pliku
        // (przypomnienie o akceptacji), odpowiedź błędu jest zwykłym tekstem, który bez
        // tego sprawdzenia trafiłby do maila jako „projekt.pdf" z treścią „Brak katalogu
        // plików". Klient dostałby załącznik-śmieć, a panel powiedziałby „dołączono".
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.blob();
      })
      .then(function (blob) {
        dodajPliki([new File([blob], nazwa, { type: blob.type || 'application/pdf' })], box.dataset.plikGrupa || null);
      })
      .catch(function () {
        // Pudełko zostało na ekranie z napisem „Dołączono" — bez tej korekty operator
        // wysłałby maila w przekonaniu, że plik jest w środku.
        box.classList.add('warn');
        box.textContent = 'Nie udało się dołączyć pliku „' + nazwa + '" — dołóż go z dysku przed wysyłką.';
        pokazUwage('Plik przyszedł, ale nie udało się go dołączyć — wystaw dokument ponownie albo dołóż go z dysku.');
      });
    return true;
  }

  /**
   * Załączniki wracające do komponera po „Edytuj" — lista `[{url, nazwa}]` w `data-pliki`.
   *
   * ⚠️ TO SĄ PRAWDZIWE PLIKI, nie identyfikatory. `input.files` jest tylko do odczytu, więc
   * nie da się „przypiąć" do formularza pliku, który leży na serwerze — a serwer nie ma jak
   * skleić starych załączników z nowo wybranymi, bo nie wie, których operator nie skasował.
   * Dlatego każdy plik pobieramy `fetch`-em i składamy z niego `new File(...)`, dokładnie
   * tak, jakby operator wybrał go z dysku: z krzyżykiem, z wagą i wliczony do limitu 25 MB.
   * Bez tego „Edytuj" po cichu gubiłby projekt — mail wychodzi poprawny, tylko bez pliku.
   *
   * ⚠️ BEZ GRUPY ZASTĘPOWANIA (drugi argument `dodajPliki`). Odwołana wiadomość potrafi
   * nieść kilka plików naraz i wszystkie mają wrócić; grupa zostawiłaby ostatni.
   */
  function dolaczListe(box, json) {
    var pozycje = [];
    try { pozycje = JSON.parse(json) || []; } catch (e) { pozycje = []; }
    pozycje.forEach(function (p) {
      if (!p || !p.url) return;
      var nazwa = p.nazwa || 'zalacznik';
      fetch(p.url)
        .then(function (r) {
          // Ta sama pułapka, co wyżej: `fetch` NIE RZUCA przy 404, więc bez tego
          // sprawdzenia treść błędu pojechałaby do klienta jako „projekt.pdf".
          if (!r.ok) throw new Error('HTTP ' + r.status);
          return r.blob();
        })
        .then(function (blob) {
          dodajPliki([new File([blob], nazwa, { type: blob.type || 'application/octet-stream' })]);
        })
        .catch(function () {
          box.classList.add('warn');
          box.textContent = 'Nie udało się odzyskać załącznika „' + nazwa + '" — dołóż go z dysku przed wysyłką.';
          pokazUwage('Załącznik odwołanej wiadomości nie wrócił — dołóż go z dysku przed wysyłką.');
        });
    });
  }

  // Szkic potrafi przyjść do RÓŻNYCH miejsc: poczekalni komponera, ale też do celów
  // etapowych (#etap1-reply, #etap2-quote — tam obok szkicu wraca np. formularz wyceny,
  // który ma zostać na miejscu). Dlatego nasłuch jest globalny, a wybiera pudełko po treści.
  function obsluzPudelko(box) {
    dolaczPlik(box);
    przelej(box);
  }

  document.body.addEventListener('htmx:afterSwap', function (e) {
    var boxy = e.target.querySelectorAll ? e.target.querySelectorAll('.reply-box') : [];
    Array.prototype.forEach.call(boxy, function (box) { obsluzPudelko(box); });
    if (e.target.classList && e.target.classList.contains('reply-box')) obsluzPudelko(e.target);
  });

  // Przyciski wypełniające komponer bez pytania serwera (treść jest w ustawieniach panelu
  // i przyszła już z widokiem) — np. „Wyślij projekt".
  document.body.addEventListener('click', function (e) {
    var btn = e.target.closest ? e.target.closest('[data-wypelnij]') : null;
    if (!btn) return;
    e.preventDefault();
    if (btn.dataset.subject) poleTemat.value = btn.dataset.subject;
    if (btn.dataset.body) poleTresc.value = btn.dataset.body;
    ustawTryb(btn.dataset.kind);
    pokazUwage(null);
    zerujPotwierdzenie();
    poleTresc.scrollIntoView({ block: 'nearest' });
    poleTresc.focus();
  });

  // ⚠️ KOPIOWANIE ŚCIEŻKI WYPROWADZONE DO `public/kopiuj.js` (19.08.2026). Stało tutaj
  // i było martwe z dwóch niezależnych powodów naraz: wychodziło na `!navigator.clipboard`
  // (którego panel po HTTP w LAN-ie nie ma), a całe to IIFE i tak kończy się na `!form`
  // wcześniej, więc na stronie bez komponera nie podpinało się w ogóle. Nie wracać tu z tym.

  /* -------------------------------- „Popraw" -------------------------------- */

  btnPopraw.addEventListener('click', function () {
    // Zapamiętujemy treść PRZED wysłaniem zapytania — po podmianie ma być czym cofnąć.
    poprzedniaTresc = poleTresc.value;
  });

  btnCofnij.addEventListener('click', function () {
    if (poprzedniaTresc === null) return;
    poleTresc.value = poprzedniaTresc;
    poprzedniaTresc = null;
    btnCofnij.hidden = true;
    pokazUwage(null);
    odswiezPasek();
  });

  /* ---------------------------- potwierdzenie ------------------------------- */

  // Który przycisk jest UZBROJONY do drugiego kliknięcia: 'wyslij' | 'rano' | null.
  //
  // ⚠️ SAMO `confirm=1` NIE WYSTARCZY, odkąd przyciski są dwa. Gdyby stan potwierdzenia był
  // jedną flagą na cały komponer, uzbrojenie „Wyślij rano" przepuściłoby natychmiastowe
  // „Wyślij" JEDNYM kliknięciem — czyli mail do klienta o 23:00 zamiast o 7:00, dokładnie
  // odwrotnie do tego, po co ta funkcja powstała.
  var uzbrojony = null;

  function zerujPotwierdzenie() {
    poleConfirm.value = '';
    uzbrojony = null;
    btnWyslij.textContent = 'Wyślij';
    btnWyslij.classList.remove('potwierdz');
    btnAnuluj.hidden = true;
    if (btnRano) btnRano.classList.remove('potwierdz');
    // Etykietę „Wyślij rano (…)" odtwarza odświeżacz — on jeden zna aktualną godzinę.
    odswiezRano();
  }

  /**
   * Komu PÓJDZIE ten mail — tekst na przycisk potwierdzenia.
   *
   * ⚠️ PRZYCISK NIE MA PRAWA PRZEMILCZEĆ KOPII. „Potwierdź wysyłkę do <klient>" przy
   * wypełnionym DW to zdanie NIEPRAWDZIWE: mail idzie do dwóch osób, a operator zatwierdza
   * je w przekonaniu, że do jednej. To jedyny krok, w którym człowiek ogląda kopertę.
   *
   * Czytamy POLE, nie kartę: adres wpisany przed chwilą nigdzie jeszcze nie został zapisany.
   * Przy kilku adresach na przycisk idzie ich LICZBA — pełna lista i tak stoi w polu wyżej,
   * a przycisk rozciągnięty na trzy linijki przestaje wyglądać jak przycisk.
   */
  function komuIdzie() {
    var adres = form.dataset.adres || 'klienta';
    var kopia = poleDw ? poleDw.value.trim() : '';
    if (!kopia) return adres;
    var ile = kopia.split(/[,;\s]+/).filter(Boolean).length;
    return adres + (ile === 1 ? ' + kopia do ' + kopia : ' + kopia do ' + ile + ' adresów');
  }

  btnAnuluj.addEventListener('click', zerujPotwierdzenie);

  // ⚠️ Zasada „mail nigdy nie wychodzi sam" ZOSTAJE — zmienił się tylko mechanizm.
  // Pierwsze kliknięcie nie wysyła: przestawia przycisk w „Potwierdź wysyłkę do <adres>".
  form.addEventListener('submit', function (e) {
    if (poleConfirm.value === '1' && uzbrojony === 'wyslij') return;
    e.preventDefault();
    e.stopPropagation();
    if (btnWyslij.disabled) return;
    if (!poleTresc.value.trim()) {
      pokazUwage('Pusta treść — nie ma czego wysłać.');
      return;
    }
    poleConfirm.value = '1';
    uzbrojony = 'wyslij';
    btnWyslij.textContent = 'Potwierdź wysyłkę do ' + komuIdzie();
    btnWyslij.classList.add('potwierdz');
    btnAnuluj.hidden = false;
    // Uzbrojone przed chwilą „Wyślij rano" musi się rozbroić — inaczej dwa przyciski
    // naraz obiecywałyby, że to ONE pójdą przy następnym kliknięciu.
    if (btnRano) { btnRano.classList.remove('potwierdz'); odswiezRano(); }
  }, true);

  // Po każdej odpowiedzi serwera wracamy do stanu „przed potwierdzeniem". Przy udanej
  // wysyłce i tak leci HX-Redirect i strona się przeładowuje; przy błędzie operator ma
  // poprawić i znów kliknąć dwa razy, a nie wysłać jednym przypadkowym klikiem.
  form.addEventListener('htmx:afterRequest', function () {
    zerujPotwierdzenie();
  });

  // „cofnij poprawkę" pokazuje się dopiero wtedy, gdy poprawka faktycznie weszła.
  document.body.addEventListener('htmx:afterSwap', function (e) {
    if (e.target.id === 'komponer-wsad' && poprzedniaTresc !== null && poprzedniaTresc !== poleTresc.value) {
      btnCofnij.hidden = false;
    }
  });

  /* ----------------------------- „Wyślij rano" ------------------------------ */

  function parsujGodzine(hhmm) {
    var m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || ''));
    if (!m) return null;
    var h = Number(m[1]);
    var min = Number(m[2]);
    if (h < 0 || h > 23 || min < 0 || min > 59) return null;
    return { h: h, m: min };
  }

  /**
   * Czy zegar przeglądarki stoi w oknie `od` → `doGodz` (np. 18:00 → 7:00).
   *
   * ⚠️ OKNO PRZECHODZI PRZEZ PÓŁNOC. Naiwne „godzina >= 18" zgasiłoby przycisk o 00:01 —
   * czyli dokładnie wtedy, gdy jest najbardziej potrzebny: mail pisany w nocy ma wyjść
   * o świcie TEGO SAMEGO dnia.
   *
   * ⚠️ ŻADNYCH STREF PO TEJ STRONIE. Liczymy z zegara laptopa, który chodzi w czasie
   * warszawskim; przeliczenia Warszawa↔UTC mieszkają wyłącznie na serwerze
   * (`src/domain/pora-wysylki.js`), bo tam kontener stoi w UTC.
   *
   * ⚠️ TO JEST DECYZJA WIDOKU, nigdy reguła. Serwer przyjmuje zaplanowanie o KAŻDEJ porze
   * i nie wolno tego zmienić — okno to wygoda operatora, nie zabezpieczenie.
   */
  function wOknie(teraz, od, doGodz) {
    var a = parsujGodzine(od);
    var b = parsujGodzine(doGodz);
    if (!a || !b) return false;
    var chwila = teraz.getHours() * 60 + teraz.getMinutes();
    var start = a.h * 60 + a.m;
    var koniec = b.h * 60 + b.m;
    if (start === koniec) return false;
    return start < koniec
      ? (chwila >= start && chwila < koniec)
      : (chwila >= start || chwila < koniec);
  }

  /**
   * „jutro (czwartek) o 7:00" albo „dziś o 7:00" — NAJBLIŻSZE wystąpienie godziny wysyłki.
   *
   * ⚠️ PO PÓŁNOCY MUSI MÓWIĆ „dziś". O 00:30 świt jest za sześć godzin, a nie za trzydzieści;
   * przycisk obiecujący „jutro" kłamałby o całą dobę — i to inaczej, niż policzy serwer
   * (`najblizszaPora` też bierze najbliższe wystąpienie, nie jutrzejsze).
   */
  function etykietaRano(teraz, hhmm) {
    var g = parsujGodzine(hhmm);
    if (!g) return '';
    var termin = new Date(teraz.getFullYear(), teraz.getMonth(), teraz.getDate(), g.h, g.m, 0, 0);
    var dzis = termin.getTime() > teraz.getTime();
    // `Date` z dniem +1 sam normalizuje koniec miesiąca i rok.
    if (!dzis) termin = new Date(teraz.getFullYear(), teraz.getMonth(), teraz.getDate() + 1, g.h, g.m, 0, 0);
    var kiedy = dzis ? 'dziś' : 'jutro (' + DNI_TYG[termin.getDay()] + ')';
    return kiedy + ' o ' + termin.getHours() + ':' + ('0' + termin.getMinutes()).slice(-2);
  }

  function odswiezRano() {
    if (!btnRano) return;
    var teraz = new Date();
    var widac = ODRACZALNE.indexOf(poleKind.value) !== -1
      && wOknie(teraz, btnRano.dataset.od, btnRano.dataset.godzina);
    btnRano.hidden = !widac;
    // W kroku potwierdzenia przycisk mówi „Potwierdź…" — tykający co minutę odświeżacz nie
    // ma prawa zabrać mu tego napisu w połowie decyzji operatora.
    if (widac && uzbrojony !== 'rano') {
      btnRano.textContent = 'Wyślij rano (' + etykietaRano(teraz, btnRano.dataset.godzina) + ')';
    }
  }

  if (btnRano) {
    /**
     * ⚠️ ŻĄDANIE WYSYŁA htmx Z `hx-post` NA SAMYM PRZYCISKU, a nie ten formularz. htmx 1.9
     * zapamiętuje ścieżkę W DOMKNIĘCIU przy przetwarzaniu węzła (`Ht` w htmx.min.js), więc
     * podmiana `hx-post` na formularzu z JS-a nie zmieniłaby NIC: mail poszedłby natychmiast
     * pod `send-reply`, mimo że operator kliknął „Wyślij rano". Wartości formularza (razem
     * z plikami i `hx-encoding`) htmx dokłada sam — dla żądania innego niż GET bierze
     * NAJBLIŻSZY formularz.
     *
     * ⚠️ Pierwsze kliknięcie NIE PLANUJE. Anulowanie `htmx:beforeRequest` jest tu
     * odpowiednikiem `preventDefault` na submicie: uzbraja przycisk i zatrzymuje żądanie.
     */
    btnRano.addEventListener('htmx:beforeRequest', function (e) {
      if (poleConfirm.value === '1' && uzbrojony === 'rano') return;
      e.preventDefault();
      if (!poleTresc.value.trim()) {
        pokazUwage('Pusta treść — nie ma czego wysłać.');
        return;
      }
      poleConfirm.value = '1';
      uzbrojony = 'rano';
      // Rozbrajamy „Wyślij" — po tym kliknięciu ma iść kolejka, nie natychmiastowa wysyłka.
      btnWyslij.textContent = 'Wyślij';
      btnWyslij.classList.remove('potwierdz');
      // ⚠️ Potwierdzenie mówi o GODZINIE, nie o wysyłce „teraz". To jedyne miejsce, gdzie
      // operator widzi, co dokładnie obiecuje kliknięcie.
      btnRano.textContent = 'Potwierdź: wyślij ' + etykietaRano(new Date(), btnRano.dataset.godzina) + ' do ' + komuIdzie();
      btnRano.classList.add('potwierdz');
      btnAnuluj.hidden = false;
    });

    // ⚠️ CO MINUTĘ, nie tylko przy wejściu. Kartę trzyma się otwartą godzinami — render
    // z 17:50 zabetonowałby brak przycisku na całą noc, czyli akurat na czas, w którym
    // ta funkcja ma sens.
    setInterval(odswiezRano, 60 * 1000);
  }

  rysujZalaczniki();
  // Tryb bierzemy Z POLA, nie na sztywno: po „Edytuj" widok wypełnia komponer treścią
  // odwołanej wiadomości i `kind` bywa wtedy `quote`. Przy zwykłym wejściu pole i tak
  // zawiera `reply`, więc dla reszty kart nic się nie zmienia.
  ustawTryb(poleKind.value || 'reply');

  // ⚠️ `htmx:afterSwap` NIE ODPALA SIĘ PRZY ZWYKŁYM WEJŚCIU NA STRONĘ. Pudełko, które
  // przyszło razem z HTML-em karty (powrót z „Edytuj" — patrz `?edytuj=` w routes/cards.js),
  // nie ma żadnego swapu, na którym mógłby się zaczepić nasłuch wyżej. Bez tego skanu
  // załączniki odwołanej wiadomości po prostu by nie wróciły, a panel i tak powiedziałby
  // „treść wróciła do komponera".
  Array.prototype.forEach.call(document.querySelectorAll('.reply-box'), function (box) {
    obsluzPudelko(box);
  });
})();

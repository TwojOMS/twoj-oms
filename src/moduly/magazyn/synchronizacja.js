import { stronaOdmowy } from '../../core/web/odmowa.js';

export function registerSynchronizacjaMagazynu(app, { db, magazyn, sklepy, pomoc, karta, trescAllegro }) {
  const { produktyPominiete, utworzKartyZNiepowiazanych, grupujPominiete, BEZ_SKLEPOW, BEZ_SKLEPOW_ODMOWA, zEtykietaKanalu, bezpiecznyWroc } = pomoc;
  // Odmowa „brak sklepu” w układzie OMS (status i tekst bez zmian); powrót na listę, z której przyszedł człowiek.
  const odmowaBezSklepow = (req, reply) => stronaOdmowy(reply, 503, BEZ_SKLEPOW_ODMOWA, {
    tytul: 'Magazyn nie ma skąd czytać katalogu', napisWroc: 'Wróć do magazynu',
    wroc: pomoc.bezpiecznyWroc(req.query?.wroc ?? req.body?.wroc) ?? '/magazyn',
  });
  app.post('/magazyn/odswiez', async (req, reply) => {
    if (!magazyn || magazyn.gotowy?.() === false) return odmowaBezSklepow(req, reply);
    magazyn.start();
    // 303, a nie 302: po POST-cie przegladarka ma pojsc GET-em, zeby odswiezenie strony
    // nie proponowalo powtorzenia odczytu.
    return reply.code(303).redirect('/magazyn');
  });

  // „Pobierz treść i zdjęcia ofert" — osobny przebieg w tle, tylko odczyt z Allegro.
  // Jak odczyt katalogów: start i natychmiastowy powrót (303), postęp pokazuje lista.
  app.post('/magazyn/tresc-allegro', async (req, reply) => {
    if (!trescAllegro || trescAllegro.gotowy?.() === false) {
      return stronaOdmowy(reply, 503, 'Żadne konto Allegro nie jest połączone — połącz je w Ustawieniach, potem pobierz treść ofert.', {
        tytul: 'Nie ma skąd pobrać treści ofert', napisWroc: 'Wróć do magazynu', wroc: '/magazyn',
      });
    }
    trescAllegro.start();
    return reply.code(303).redirect('/magazyn');
  });

  app.post('/magazyn/:id/tresc-oferty/:ofertaId', async (req, reply) => {
    const kartaId = Number(req.params.id);
    const ofertaWskazana = Number(req.params.ofertaId);
    const oferta = Number.isSafeInteger(ofertaWskazana) && Number.isSafeInteger(kartaId)
      ? db.prepare('SELECT karta_id, kanal, zniknal_at FROM produkty_sklepowe WHERE id = ?').get(ofertaWskazana) : null;
    if (!oferta || oferta.karta_id !== kartaId || !pomoc.KANALY_ALLEGRO.includes(oferta.kanal)) {
      return stronaOdmowy(reply, 404, 'Nie ma takiej oferty Allegro na tej karcie.', { wroc: '/magazyn' });
    }
    if (oferta.zniknal_at) {
      return stronaOdmowy(reply, 400, 'Oferta zniknęła z Allegro — nie można pobrać jej treści.', { wroc: `/magazyn/${kartaId}` });
    }
    if (!trescAllegro || trescAllegro.gotowy?.() === false) {
      return stronaOdmowy(reply, 503, 'Żadne konto Allegro nie jest połączone — połącz je w Ustawieniach, potem pobierz treść ofert.', { wroc: `/magazyn/${kartaId}` });
    }
    if (trescAllegro.stan().trwa) return reply.code(303).redirect(`/magazyn/${kartaId}?tresc=w-toku`);
    const wynik = trescAllegro.start({ ofertaWskazana });
    return reply.code(303).redirect(`/magazyn/${kartaId}?tresc=${wynik.wystartowal ? 'rozpoczeta' : 'w-toku'}`);
  });

  // Ekran „pominiete" — CZYTANY, nie zakladajacy niczego. Ta sama para funkcji, co pod
  // przyciskiem (`produktyPominiete` chodzi po tym samym zapytaniu i tej samej regule),
  // wiec pokazuje dokladnie to, co przycisk pominal.
  app.get('/magazyn/pominiete', async (req, reply) => {
    if (!magazyn || magazyn.gotowy?.() === false) return reply.view('pusta-strona.ejs', { ...BEZ_SKLEPOW, szerokosc: 'tabela' });
    // `?kanal=` — „dlaczego" z podglądu importu pokazuje pominięte TEGO kanału i wraca
    // do importu. Klucz spoza listy kanałów magazynu nie zawęża (zostaje cały ekran, powrót jak dotąd).
    const kanal = typeof req.query?.kanal === 'string' && pomoc.KANALY_MAGAZYNU.includes(req.query.kanal) ? req.query.kanal : null;
    const pominiete = produktyPominiete(db).filter((p) => !kanal || p.kanal === kanal);
    return reply.view('magazyn-pominiete.ejs', { szerokosc: 'tabela',
      title: 'Magazyn — pominięte',
      utworzone: null,
      // Powrót na ZAWĘŻONĄ listę, z której tu wszedł operator (reguła: powrót na zawężony widok).
      // `bezpiecznyWroc` oddaje `null` dla wartości spoza magazynu — wtedy zostaje goły ekran zakładki.
      adresPowrotu: kanal ? `/magazyn/import?kanal=${encodeURIComponent(kanal)}` : (bezpiecznyWroc(req.query?.wroc) ?? '/magazyn'),
      grupy: grupujPominiete(zEtykietaKanalu(pominiete)),
    });
  });

  // ⚠️ OPERACJA MASOWA: jedno kliknięcie zakłada setki kart. Ekran wyniku jest jedynym
  // miejscem, w którym widać, CZEGO panel nie tknął — dlatego trasa RENDERUJE wynik,
  // zamiast przekierować na listę (ta sama zasada, co przy nadaniu zbiorczym).
  app.post('/magazyn/utworz-karty', async (req, reply) => {
    if (!magazyn || magazyn.gotowy?.() === false) return odmowaBezSklepow(req, reply);
    const { utworzone } = utworzKartyZNiepowiazanych(db);
    return reply.view('magazyn-pominiete.ejs', { szerokosc: 'tabela',
      title: 'Magazyn — pominięte',
      utworzone,
      // ⚠️ DRUGI RENDER TEGO SAMEGO WIDOKU — z ciała formularza, nie z adresu. Ta akcja
      // zakłada setki kart i kończy się właśnie tutaj, więc zgubienie zawężenia bolałoby
      // po najdłuższej operacji zakładki.
      adresPowrotu: bezpiecznyWroc(req.body?.wroc) ?? '/magazyn',
      // Liczone PO utworzeniu, z bazy — a nie przepisane z wyniku: te dwa zbiory maja byc
      // tym samym zbiorem i wlasnie dlatego czytamy je z jednego miejsca.
      grupy: grupujPominiete(zEtykietaKanalu(produktyPominiete(db))),
    });
  });

  // ——— EDYCJA HURTEM ——————————————————————————————————————————————————————————
  //
  // ⚠️ Ekran skladany jest w JEDNYM miejscu i uzywaja go OBIE trasy: podglad i wynik
}

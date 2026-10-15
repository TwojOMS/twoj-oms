// Port frozen 5b9cd765: 1080–1124.
export function registerSynchronizacjaMagazynu(app, { db, magazyn, sklepy, pomoc, karta }) {
  const { produktyPominiete, utworzWzoryZNiepowiazanych, grupujPominiete, BEZ_SKLEPOW, BEZ_SKLEPOW_ODMOWA, zEtykietaKanalu, bezpiecznyWroc } = pomoc;
  app.post('/magazyn/odswiez', async (req, reply) => {
    if (!magazyn) return reply.code(503).send(BEZ_SKLEPOW_ODMOWA);
    magazyn.start();
    // 303, a nie 302: po POST-cie przegladarka ma pojsc GET-em, zeby odswiezenie strony
    // nie proponowalo powtorzenia odczytu.
    return reply.code(303).redirect('/magazyn');
  });

  // Ekran „pominiete" — CZYTANY, nie zakladajacy niczego. Ta sama para funkcji, co pod
  // przyciskiem (`produktyPominiete` chodzi po tym samym zapytaniu i tej samej regule),
  // wiec pokazuje dokladnie to, co przycisk pominal.
  app.get('/magazyn/pominiete', async (req, reply) => {
    if (!magazyn) return reply.view('pusta-strona.ejs', BEZ_SKLEPOW);
    return reply.view('magazyn-pominiete.ejs', {
      title: 'Magazyn — pominięte',
      utworzone: null,
      // Powrot na ZAWEZONA liste, z ktorej tu wszedl operator (4.13d). `bezpiecznyWroc`
      // oddaje `null` dla wartosci spoza magazynu — wtedy zostaje goly ekran zakladki.
      adresPowrotu: bezpiecznyWroc(req.query?.wroc) ?? '/magazyn',
      grupy: grupujPominiete(zEtykietaKanalu(produktyPominiete(db))),
    });
  });

  // ⚠️ OPERACJA MASOWA: jedno klikniecie zaklada ~980 wzorow. Ekran wyniku jest jedynym
  // miejscem, w ktorym widac, CZEGO panel nie tknal — dlatego trasa RENDERUJE wynik,
  // zamiast przekierowac na liste (ta sama zasada, co przy nadaniu zbiorczym).
  app.post('/magazyn/utworz-wzory', async (req, reply) => {
    if (!magazyn) return reply.code(503).send(BEZ_SKLEPOW_ODMOWA);
    const { utworzone } = utworzWzoryZNiepowiazanych(db);
    return reply.view('magazyn-pominiete.ejs', {
      title: 'Magazyn — pominięte',
      utworzone,
      // ⚠️ DRUGI RENDER TEGO SAMEGO WIDOKU — z ciala formularza, nie z adresu. Ta akcja
      // zaklada ~980 wzorow i konczy sie wlasnie tutaj, wiec zgubienie zawezenia bolaloby
      // po najdluzszej operacji zakladki.
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

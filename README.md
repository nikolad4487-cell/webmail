# WebmailHR

Webmail na hrvatskom za organizacije, škole i fakultete. Zajednički ulaz na `https://webmailhr.com` omogućuje odabir vrste računa i daje pristup sandučićima, adresama za slanje i kalendarima koji su korisniku dodijeljeni u PostgreSQL-u. Postojeći sandučići koriste IMAP/SMTP. Opcija 2 sprema poštu u PostgreSQL i šalje preko Mailjeta, bez VPS-a; početna proba koristi `demo@skolehr.xyz`, a dodatni osobni sandučići uključuju se kroz administraciju.


## Opcija 2: Cloudflare → HTTPS → PostgreSQL, Mailjet za slanje (bez VPS-a)

Sučelje ostaje na **https://webmailhr.com**, administracija na
**https://admin.webmailhr.com**, u istom Vercel projektu. Postojeći korisnički
računi, prijava, sesije i `grants.can_send` ostaju izvor ovlasti. Nema novog
Auth sustava niti izmjena e-Dnevnika. `demo@skolehr.xyz` je stvarni primatelj
i naziv probnog sandučića; ne postoji adresa za prosljeđivanje.

`POST /api/inbound/cloudflare` prima binarni `message/rfc822`, izvorni MIME s
privicima. Zaglavlja `X-Webmail-Timestamp`, `X-Webmail-From`, `X-Webmail-To`,
`X-Webmail-Sha256` i `X-Webmail-Signature` prenose SMTP omotnicu i potpis.
Potpis je hex HMAC-SHA256 nad `timestamp + "\n" + from + "\n" + to + "\n" +
sha256(raw)`, UTF-8, timestamp u milisekundama s tolerancijom pet minuta.
Ruta ne koristi korisnički cookie, odbija zahtjeve s pregledničkim Originom i
na admin hostu; prije čitanja tijela provjerava potpis i dopuštenog primatelja.
Za odabir sandučića koristi potpisani SMTP primatelj, a ne MIME zaglavlje To.

Migracija [001-native-mail.sql](migrations/001-native-mail.sql) dodaje
`mailboxes.storage_kind` (zadano `imap`), `native_messages`, `native_attachments`
i `native_send_attempts`. Izvorna poruka i dekodirani privitci spremaju se u
PostgreSQL `bytea`, bez javnih URL-ova i lokalnog diska. Popis, prikaz teksta,
preuzimanje privitaka, oznake, pretraživanje, skice, Otpad i Poslano koriste
postojeći API i UI. HTML poruke ne izvršava se u sučelju. Svaki pristup prvo
provjerava postojeću sesiju i dodjelu sandučića. Native slanje dopušta osobnu
adresu sandučića; slanje preko native aliasa nije dio ove probe.

Spremanje je atomsko s privicima i provjerom kvote. Jedinstveni ključ
`(box, sha256(raw))` sprječava ponovnu dostavu i kad nedostaje Message-ID ili
je poruka premještena u Otpad. Šest istodobnih dostava stvara jednu poruku.
Isti MIME dostavljen drugom omogućenom sandučiću predstavlja zasebnu poruku.
Potpuno identičan MIME ponovljen istom sandučiću smatra se duplikatom.

### Lokalna proba bez DNS promjena

```sh
npm ci
# Posebna jednokratna baza na portu 55433; ne koristite produkcijsku bazu.
docker compose -f compose.native.yaml up -d --wait
TEST_DATABASE_URL=postgresql://webmail:local-native-only@127.0.0.1:55433/webmail_native_test npm run test:native
npm run build
```

Test sam pokreće API na loopbacku i lokalnu HTTP simulaciju Mailjet API-ja.
Zahtijeva praznu bazu i odbija postojeću tablicu users. Pri ponavljanju koristite
novu praznu probnu bazu; lokalnu jednokratnu instancu možete ukloniti naredbom
`docker compose -f compose.native.yaml down` pa je ponovno pokrenuti.
Produkcijske Mailjet tajne nisu potrebne. Test stvara lokalni korisnički račun
s postojećom PIN prijavom, sandučić `demo@skolehr.xyz` i drugog korisnika bez
pristupa. Ne šalje poštu na Internet. Poziv ulazne HTTPS rute u ovoj fazi je
izravan HTTP poziv na loopback; isti potpis i tijelo koriste se u produkciji preko HTTPS-a.

Provjere obuhvaćaju potpis, izmijenjeni sadržaj, istek potpisa, ograničenje
primatelja/veličine/hosta, konkurentnu deduplikaciju, tekst i privitak, izolaciju
svih operacija, odgovor s In-Reply-To/References i privitkom, Poslano, grešku
Mailjeta, skice/oznake/mape/pretraživanje, kvotu, deaktivaciju i Worker retry
nakon izgubljene potvrde. Provjera Workera ne simulira Cloudflareov SMTP sustav.
`npm test` ostaje zasebna regresijska IMAP/SMTP provjera prema uputama iznad.

### Serverske postavke u Vercelu i aktivacija sandučića

1. Zadržite postojeći `DATABASE_URL` WebmailHR-a (TLS, pooled connection),
   `APP_ORIGIN=https://webmailhr.com`, `ADMIN_ORIGIN=https://admin.webmailhr.com`
   i postojeće postavke prijave. Ne koristite bazu e-Dnevnika za pohranu pošte.
   Pokrenite `npm run migrate` nad bazom WebmailHR-a. Migracija je ponovljiva;
   postojeći sandučići ostaju `imap`. Za migraciju tijekom builda vrijede upute
   za `WEBMAIL_MIGRATE_ON_BUILD` u nastavku.
2. U Vercel **Settings → Environment Variables → Production** postavite
   `CLOUDFLARE_INBOUND_SECRET` (nasumičan, najmanje 32 znaka),
   `NATIVE_ENABLED_ADDRESSES=demo@skolehr.xyz`, `NATIVE_MAILBOX_BYTES=25000000`,
   `NATIVE_TOTAL_BYTES=100000000`, `MAILJET_API_KEY`, `MAILJET_SECRET_KEY`,
   `MAILJET_SANDBOX=1`, `MAILJET_DAILY_RECIPIENTS=100`,
   `MAILJET_MONTHLY_RECIPIENTS=1000`. Ponovno objavite aplikaciju. Tajne ostaju
   u postavkama servisa, nikad u Git-u, Worker vars, pregledniku ili `VITE_*`.
3. U postojećoj administraciji pronađite ili dodajte **osobni** sandučić
   `demo@skolehr.xyz`, label `demo@skolehr.xyz`, na domeni njegove organizacije.
   Dodijelite ga točno jednom postojećem aktivnom korisniku iste organizacije
   s ovlasti slanja. Ne mijenjajte korisnikovu vrstu prijave ili lozinku.
   Domena mora imati uključen primitak i slanje.
4. S pristupom toj bazi pokrenite `npm run native:pilot`. Skripta provjerava
   vlasnika, aktivnost i domenu te mijenja **samo** taj sandučić u `native` i
   bilježi audit. Ne kreira korisnike, ne dodjeljuje ovlasti, ne kontaktira
   Mailcow i ne mijenja DNS. Stare IMAP poruke ne kopira; za ostale sandučiće
   zadržite `MAIL_ROUTES`. Ne pokrećite Mailcow bulk provisioning za ovu probu.
5. Najprije izravno pozovite zaštićenu rutu s potpisanim MIME-om (format iznad),
   otvorite poruku i privitak u računu vlasnika te provjerite zabranu drugom
   korisniku. Ponovite identičan zahtjev i potvrdite isti ID i `duplicate:true`.
   HTTP 201 znači prvi upis, 200 duplikat, 401 loš/istekao potpis, 403
   nedopušten primatelj/host, 404 neaktivan/nepostojeći native sandučić,
   413 prevelik MIME i 507 puna logička kvota. Uspjeh se vraća nakon COMMIT-a.

Za izravnu probu spremite originalnu poruku kao lokalnu `.eml` datoteku s
privitkom. Postavite secret u okruženju ljuske ili lokalnoj datoteci koja nije
u Git-u, pa pokrenite:

```sh
INBOUND_PROBE_URL=https://webmailhr.com/api/inbound/cloudflare \
INBOUND_PROBE_FILE=/apsolutna/putanja/poruka.eml \
INBOUND_PROBE_FROM=sender@example.test npm run inbound:probe
```

Skripta šalje isti MIME dvaput za `demo@skolehr.xyz` i ispisuje samo status,
ID i oznaku duplikata. Za lokalno pokretanje koristite odgovarajući loopback URL.
Ne šalje odgovor ni ne mijenja MX. Za produkcijski test postavite stvarnog
pošiljatelja u `INBOUND_PROBE_FROM`; konačna SMTP/Gmail proba ostaje zasebna.

Ako koristite zasebnu DB aplikacijsku ulogu, DDL migracije radi vlasnik tablica.
Nove tablice imaju RLS bez javnih pravila. Aplikacijska serverska uloga mora
imati SELECT/INSERT/UPDATE nad porukama i pokušajima slanja, SELECT/INSERT za privitke,
USAGE/SELECT nad njihovim serial sekvencama i RLS pravila TO toj **serverskoj**
ulozi s USING (true) / WITH CHECK (true). Tablice smije čitati i vlasnik kroz
serversku vezu. Nikad ne dodjeljujte pristup Supabase anon/authenticated rolama;
WebmailHR cookie nije Supabase JWT. Ovlasti korisnika provjerava Express API.

### Cloudflare Worker, bez promjene MX-a u prvoj fazi

Konfiguracija je u [cloudflare/wrangler.jsonc](cloudflare/wrangler.jsonc),
a kod u [email-worker.mjs](cloudflare/email-worker.mjs). U Cloudflare Worker
postavkama unesite vars `INBOUND_URL=https://webmailhr.com/api/inbound/cloudflare`
i `ENABLED_RECIPIENTS=demo@skolehr.xyz`. Kao **Secret** unesite `INBOUND_SECRET`
s istom vrijednošću kao Vercelov `CLOUDFLARE_INBOUND_SECRET`.

```sh
npx wrangler@4.165.0 deploy --dry-run --config cloudflare/wrangler.jsonc
# Tek kad su pristupi dostupni: objava koda ne mijenja DNS/MX niti uključuje SMTP rutu.
npx wrangler@4.165.0 secret put INBOUND_SECRET --config cloudflare/wrangler.jsonc
npx wrangler@4.165.0 deploy --config cloudflare/wrangler.jsonc
```

Worker nema HTTP rutu ni catch-all. `email()` šalje izvorni MIME na WebmailHR i
čeka potvrdu upisa. HTTP grešku ili izgubljenu potvrdu pokušava ponoviti najviše
tri puta s istim sadržajem. Nakon neuspjeha izričito odbija poruku (`setReject`)
i zapisuje generičnu grešku bez sadržaja ili tajni. To **nije trajni red**;
ne pretpostavljajte automatsku kasniju dostavu. Nakon otklanjanja kvara
pošiljatelj treba ponoviti slanje. Ako je upis prošao, a potvrda izgubljena,
ponovno slanje identičnog MIME-a neće stvarati duplikate.

**Sada ne uključujte Email Routing koji traži promjenu MX-a.** `skolehr.xyz`
ostaje na Private Email, a `formapoint.online` na Zoho EU. Proba izravnog
poziva HTTPS rute radi bez promjene oba MX-a. Nakon uspješne probe i posebnog
odobrenja za prijelaz, u Cloudflare Email Routing odabire se pravilo **Send to
a Worker** za točno `demo@skolehr.xyz`, bez forward adrese. MX promjena djeluje
na cijelu domenu, ne samo demo adresu: prije nje treba pripremiti pravila za
ostale primatelje kako im pošta ne bi prestala dolaziti. Konfiguracija u ovom
repozitoriju ne radi tu promjenu.

### Mailjet i besplatni paketi

Mailjet koristi HTTPS Send API v3.1. `MAILJET_SANDBOX=1` je zadani siguran
probni način: ne isporučuje poruku, a UI to navodi nakon slanja. Lokalni test
provjerava zahtjev prema simulaciji API-ja, ne stvarni Mailjet račun. Za stvarno
slanje prvo u Mailjetu verificirajte `demo@skolehr.xyz` ili domenu i unesite
DNS zapise koje prikaže taj račun (DKIM i SPF, uz očuvanje postojećih sendera).
Ne dodajte drugi SPF TXT; postojeći SPF treba pravilno objediniti. To ne zahtijeva
promjenu MX-a. Kad je spremno, izričito postavite `MAILJET_SANDBOX=0` u Vercelu
i ponovno objavite aplikaciju. Provjerite odgovor na vlastiti Gmail i zaglavlja
autentifikacije. Nepoznat ishod predaje ne ponavlja se automatski: provjerite
Mailjet zapis kako ne biste poslali odgovor dvaput.

Pilot ograničava izvorni MIME na **3.000.000 bajtova** (u oba smjera, uključujući
base64 privitke), ispod Vercelova ograničenja tijela zahtjeva od 4,5 MB. Primjenjuje
logički limit 25 MB po sandučiću i 100 MB ukupno. Obračun uključuje MIME,
tekst i dekodirane privitke, ali ne PostgreSQL indekse, TOAST/WAL/backupe ni
ostatak baze. Pratite stvarnu zauzetost baze; to nije obećanje 15 GB besplatno.
Kvote iz `target_quota_gb` i Mailcow gumba ne upravljaju native pohranom.
Otpad i stare skice i dalje zauzimaju prostor; trajno brisanje nije dio probe.

Mailjet budget rezervira broj primatelja prije predaje, uz DB zaključavanje,
za sve native sandučiće zajedno: zadano 100 dnevno i 1000 mjesečno (UTC).
Probni i nepoznati ishodi također troše budget kako ponavljanje ne bi zaobišlo
limit. Sandbox nema stvarnu isporuku. Izvan-WebmailHR slanje s istog Mailjet
računa nije uključeno u ovaj obračun; ostavite rezervu i pratite provider dashboard.
Aktualne limite i prihvatljivu namjenu računa provjerite prije aktivacije:
[Mailjet](https://www.mailjet.com/pricing/),
[Cloudflare Workers](https://developers.cloudflare.com/workers/platform/limits/),
[Vercel Functions](https://vercel.com/docs/functions/limitations).
Besplatni paketi ne jamče kapacitet za neograničen broj osobnih sandučića.

Dodatne domene koriste isti Worker. Registrirajte domenu u administraciji i odaberite
Cloudflare / Mailjet za nove osobne sandučiće, zatim za tu domenu konfigurirajte
Cloudflare Email Routing catch-all i potvrdu Mailjet pošiljatelja. U univerzalnom
Workeru s `ENABLED_RECIPIENTS=*` nema popisa domena: poslužitelj prihvaća samo
registrirane native domene i postojeće aktivne osobne sandučiće. DNS migracija
svake domene zaseban je korak; dodavanje domene ne mijenja MX.

### Uključivanje dodatnog osobnog sandučića

Novi sandučići na native domeni uključuju se automatski opisanim postupkom ispod.
Postojeći osobni IMAP sandučić glavni administrator uključuje gumbom
**Sandučići → Uredi → Uključi Cloudflare / Mailjet**. Vlasnik mora biti aktivan,
imati istu adresu i organizaciju te biti jedini korisnik s dodjelom sandučića.
Postojeće IMAP poruke se ne prenose. Nakon toga provjerite poruku izvana, privitak
i odgovor. Uz catch-all nisu potrebne nove varijable ili Worker kod za svaku adresu.
Za `formapoint.online` zadržite Zoho MX do dogovorenog prelaska cijele domene.

Native adresa ne može se naknadno preimenovati niti pretvoriti u zajednički
sandučić kroz obrazac. Dodjela drugom korisniku odbija se i na serverskoj ruti.

### Automatsko i skupno stvaranje osobnih sandučića

Migracija `003-mailbox-provisioning.sql` dodaje `domains.mailbox_backend`.
Domene ostaju na `imap`, osim domena koje pri prvoj primjeni već imaju aktivan
osobni native sandučić: one preuzimaju `native`. Ponovna migracija ne poništava
kasniji izričiti izbor administratora. Zoho domena bez native sandučića ostaje
nepromijenjena. Migracija ne stvara sandučiće, ne mijenja postojeću pohranu ni DNS.

Glavni administrator bira **Domene → Uredi → Novi osobni sandučići → Cloudflare / Mailjet**.
Na takvoj domeni, uz uključeno primanje/slanje i konfigurirane ključeve, spremanje
novog osobnog sandučića automatski uključuje native pohranu i dodjeljuje ga aktivnom
korisniku iste adrese i organizacije. Ako vlasnik ne postoji, cijelo spremanje se
odbija. Zajednički i postojeći IMAP sandučići ne pretvaraju se automatski u native.

U **Korisnici** i **Sandučići** gumb **Kreiraj sandučiće korisnicima** prvo prikazuje
do 100 kandidata. Potvrda stvara samo nedostajuće osobne sandučiće i njihove ovlasti.
Postojeće adrese, aliasi, automatski pošiljatelji, neaktivni i sinkronizirani korisnici
se preskaču. Administrator organizacije radi samo u svojoj organizaciji; root može
odabrati organizaciju ili sve. Ponovljeni i istodobni zahtjevi ne stvaraju duplikate.
Za više od 100 kandidata postupak se ponavlja; dovršeni korisnici više nisu u pregledu.

Za automatski primitak jednom pripremite Cloudflare za svaku već prebačenu domenu:

1. U **Domene → Uredi** kliknite **Kopiraj kod Workera**, zamijenite kod u
   `webmailhr-inbound` i kliknite **Deploy**. Kod je dostupan i u polju za ručno kopiranje.
2. Postavite Workerovu tekstualnu varijablu `ENABLED_RECIPIENTS` na `*` i objavite je.
   `INBOUND_URL` i postojeći `INBOUND_SECRET` ostaju isti. Zadani Worker i dalje
   dopušta samo demo dok se ova opcija izričito ne uključi.
3. Na domeni koja već ima odobren Cloudflare MX postavite **Email Routing → Catch-all →
   Send to a Worker → webmailhr-inbound**. Postojeća pojedinačna demo pravila mogu ostati.
4. Novi aktivni osobni native sandučići prihvaćaju se prema domenskoj politici baze,
   bez novih pojedinačnih Cloudflare pravila ili Vercel allowliste. HMAC je obavezan.
   Nepostojeća, IMAP, zajednička i neaktivna adresa odbija se prije čitanja MIME tijela;
   dolazna poruka nikada ne stvara korisnika ni sandučić.

Postojeći IMAP sandučić poput prethodno izrađenog Viktorova uključuje se zasebnim
gumbom **Uključi Cloudflare / Mailjet**. Skupno stvaranje ga ne prepisuje i ne prenosi
stare poruke. Za `formapoint.online` ne uključujte Cloudflare Routing niti mijenjajte
Zoho MX bez zasebno dogovorenog prijelaza cijele domene.

Lokalna provjera automatike koristi praznu PostgreSQL bazu:
`TEST_PROVISION_DATABASE_URL=postgresql://USER:PASSWORD@127.0.0.1:5432/DISPOSABLE_DB npm run test:provisioning`.

### Automatski sandučići za FormaPoint registracije

FormaPointova serverska ruta `/api/webmail-sync` provjerava aktualnog korisnika preko
Supabase Auth `/user`, uključujući potvrđen e-mail, anonimnost i zabranu prijave.
Preglednik ne smije zadati tuđi identitet. Potvrđena korisnička sesija automatski
pokreće idempotentno povezivanje, odvojeno od prijave i provjere ovlasti; prekid
veze ne blokira korištenje FormaPointa, a profil nudi ponovni pokušaj i WebmailHR poveznicu.

FormaPoint i WebmailHR trebaju isti nasumični ključ od najmanje 32 znaka, isključivo
u serverskim Production secrets: `WEBMAILHR_SYNC_SECRET` (FormaPoint) i
`FORMAPOINT_PROVISION_SECRET` (WebmailHR). U WebmailHR uključite
`FORMAPOINT_AUTO_MAILBOXES=1` i postojeće `FORMAPOINT_SUPABASE_*` postavke za prijavu.
FormaPoint koristi već postavljeni `SUPABASE_URL` i serverski Supabase ključ.
Privatni ključ, JWT korisnika i njegova lozinka nikad se ne šalju u payloadu WebmailHR-u.
Receiver `/api/integrations/formapoint/provision` zahtijeva HMAC tijela s vremenskom
provjerom i točnim projektnim identitetom; odbija preglednički Origin.

Za jednokratnu pripremu operator poziva FormaPoint API s Bearer servisnim ključem
(`WEBMAILHR_SYNC_SECRET`) i tijelom `{"mode":"setup"}`. To odabire native pohranu
domene u aplikaciji, bez DNS promjene. Zatim `{"mode":"import","page":1}` uvozi
postojeće potvrđene korisnike u serijama po 10; slijedite `nextPage` do `null`.
Anonimni, nepotvrđeni i zabranjeni računi preskaču se. Ovi servisni pozivi nisu
pristupačni običnoj korisničkoj sesiji ili pregledniku.

Adresa s vlastite domene ostaje ista ako nije rezervirana. Za vanjski prijavni e-mail
stvara se stabilna adresa `lokalni-dio.<16 hex znakova identiteta>@formapoint.online`.
Povezani korisnik zadržava adresu i nakon promjene prijavnog e-maila. U početku se
prijavljuje FormaPoint podacima uz provjeru izvornog UUID-a. Postojeća neovisna
WebmailHR lozinka ostaje važeća. Neaktivni, tuđi i rezervirani računi se ne preuzimaju;
postojeći IMAP sandučić vraća `needs_activation` i ne pretvara se automatski.

### Provjere

Lokalno se koriste prazne PostgreSQL baze i simulirana vanjska autentikacija/slanje:
12 native testova, 10 testova skupnog i automatskog stvaranja (uključujući treću
domenu), 8 testova FormaPoint povezivanja, 6 testova lozinki, 5 testova migracija
i 5 Worker testova. `npm run build` provjerava TypeScript i Vite.
`TEST_FORMAPOINT_DATABASE_URL=postgresql://USER:PASSWORD@127.0.0.1:5432/DISPOSABLE_DB npm run test:formapoint`.
FormaPoint ima zasebne testove vlastite serverske rute.

Korisnik je 20. 11. 2026. potvrdio stvarni primitak i slanje za demo i Viktora na
`skolehr.xyz`. Worker koristi `redirect:'manual'` jer workerd ne podržava `'error'`.
FormaPoint DNS prelazak i stvarna registracija kroz produkcijski preglednik zahtijevaju
zasebnu provjeru. Lokalni testovi ne dokazuju SMTP isporuku na Gmail.

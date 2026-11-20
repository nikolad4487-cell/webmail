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

Potvrđena adresa s vlastite domene ostaje ista, uključujući `admin@formapoint.online`;
naziv adrese ne dodjeljuje administratorsku ulogu. Zauzete adrese i aliasi se ne preuzimaju. Za osobni prijavni e-mail
stvara se adresa `ime.prezime@formapoint.online` iz potvrđenog računa. Kvačice se
uklanjaju (`Marić` → `maric`, `Đurić` → `duric`). Zauzeto ime dobiva nastavke
`ime.prezime2`, `ime.prezime3`, bez dodatne točke. Kad ime i prezime nisu dostupni,
koristi se lokalni dio osobne e-mail adrese. Dodjela je transakcijska i provjerava
korisnike, sandučiće, aliase i servisne adrese.
Povezani korisnik zadržava adresu i nakon promjene prijavnog e-maila. U početku se
prijavljuje FormaPoint podacima uz provjeru izvornog UUID-a. Postojeća neovisna
WebmailHR lozinka ostaje važeća. Neaktivni, tuđi i rezervirani računi se ne preuzimaju;
postojeći IMAP sandučić vraća `needs_activation` i ne pretvara se automatski.

### Provjere

Lokalno se koriste prazne PostgreSQL baze i simulirana vanjska autentikacija/slanje:
12 native testova, 10 testova skupnog i automatskog stvaranja (uključujući treću
domenu), 10 testova FormaPoint povezivanja, 6 testova lozinki, 5 testova migracija
i 5 Worker testova. `npm run build` provjerava TypeScript i Vite.
`TEST_FORMAPOINT_DATABASE_URL=postgresql://USER:PASSWORD@127.0.0.1:5432/DISPOSABLE_DB npm run test:formapoint`.
FormaPoint ima zasebne testove vlastite serverske rute.

Korisnik je 20. 11. 2026. potvrdio stvarni primitak i slanje za demo i Viktora na
`skolehr.xyz`. Worker koristi `redirect:'manual'` jer workerd ne podržava `'error'`.
FormaPoint DNS prelazak i stvarna registracija kroz produkcijski preglednik zahtijevaju
zasebnu provjeru. Lokalni testovi ne dokazuju SMTP isporuku na Gmail.

## Lokalno pokretanje

Preduvjeti su Node.js 22.12+, Docker Compose, Bash i OpenSSL. IMAP/SMTP probni računi koriste domenu `.test`. Zasebna proba opcije 2 koristi isključivo `demo@skolehr.xyz` kao dolaznog primatelja.

```sh
npm ci
bash scripts/quota-demo.sh
bash scripts/local.sh npm run migrate
DEMO_TLS=1 bash scripts/local.sh npm run seed
DEMO_TLS=1 bash scripts/local.sh npm run dev
```

Pričekajte pokretanje Postfixa i Dovecota prije sjetve. Ako IMAP još nije spreman, provjerite `docker compose -f compose.yaml -f compose.quota.yaml logs quota-mail`, pa ponovite sjetvu. Aplikacija sluša na priključku 3000. Na prijavi odaberite **Otvori probni sandučić**. Ostali primjeri su `ivan@skolehr.test`, `mia@skolehr.test` i `petra@fzom.isvu.test`. Zajednička probna lozinka za web je `Webmail-Test-2026`. Ivan i Mia pripadaju različitim školama na istoj domeni, a Ivan ima pristup školskoj referadi.

Lokalni Postfix zahtijeva autentifikaciju na portu 3465, Dovecot koristi IMAPS na 3993. Node izričito vjeruje samo lokalnom certifikatu generiranom za taj primjer. Dovecot primjenjuje 15 GiB. Pri isteku certifikata generirajte novi par u `.quota-demo/tls` i ponovno pokrenite servis. Alternativno, `docker compose up -d --wait` pokreće lakši GreenMail bez TLS-a i stvarne kvote. U tom slučaju izostavite `DEMO_TLS=1`. Demo aplikacija odbija odredišta izvan `.test`. Testne servise ostavite vezane na loopback.

U zasebnim terminalima pokrenite lokalne simulacije izvora prijave, integracijski poslužitelj i provjere:

```sh
node scripts/mock-auth.mjs
# Drugi terminal
DEMO_TLS=1 bash scripts/test-env.sh npm run dev
# Treći terminal
DEMO_TLS=1 npm test
npm run build
```

Testovi provjeravaju izolaciju škola, pristup referadi, zabranu tuđeg privitka i pošiljatelja, SMTP/IMAP u oba smjera, sadržaj privitka, kvotu, jednu kopiju u Poslano, kalendar, .ics, ograničenje ključa, idempotentnost i odjavu. Provjeravaju i učeničku prijavu preko zaštićene rute, izravnu FormaPoint prijavu s provjerom Auth ID-a, zasebnu prijavu administratora, promjenu izvorne lozinke, reset lozinke i pristup samo dodijeljenim sandučićima. Lokalni servisi simuliraju produkcijske izvore prijave. GreenMail varijanta provjerava i ispravan odgovor kad poslužitelj ne oglašava IMAP QUOTA.

## Produkcija

1. Postavite PostgreSQL i vrijednosti iz [.env.example](.env.example) u serverskom upravitelju tajni. Koristite odvojene DB ovlasti za migracije i rad aplikacije, s TLS-om prema udaljenoj bazi. Pokrenite `npm ci` i `npm run migrate`, zatim postavite [glavnog administratora](#glavni-administrator).
2. `npm run build` i `npm start`. Pred aplikaciju stavite HTTPS reverse proxy za obje domene. Sačuvajte izvorno zaglavlje `Host` pri prosljeđivanju zahtjeva. Dopustite `TRUST_PROXY=1` samo za topologiju s jednim pouzdanim proxyjem koji prepisuje zaglavlja prosljeđivanja. Aplikacijski port ograničite na privatnu mrežu proxyja.
3. U administraciji dodajte organizacije, škole, domene, korisnike, sandučiće, pristupe i aliase. Poveznicu prema školi dodijelite korisničkom računu. Na mail poslužitelju zasebno provisionirajte stvarne sandučiće, SMTP identitete, dolazne aliase i kvote. Aplikacija ciljanu kvotu drži odvojeno od vrijednosti izmjerene kroz IMAP QUOTA. Za mailcow opcionalno postavite `MAILCOW_URL` i `MAILCOW_API_KEY` s ograničenjem IP-a i najmanjim raspoloživim pravima te primijenite kvotu u prikazu pohrane. `MAIL_CAPACITY_BYTES` je operativno dodijeljeni ukupni kapacitet pošte, očitan iz produkcijske infrastrukture i vidljiv glavnom administratoru. Kvote iznad 15 GiB, uključujući 100 GiB, dodijelite tek nakon provjere raspoloživog prostora i limita davatelja.
4. `MAIL_ROUTES` je serverski JSON, indeksiran punom adresom sandučića ili servisnog pošiljatelja. Svaki zapis ima `imap` i/ili `smtp` objekt. Primjer strukture bez tajni:

```json
{
  "info@formapoint.online": {
    "imap": {"host":"imap.example.test","port":993,"user":"info@formapoint.online","password":"FROM_SECRET_STORE","secure":true},
    "smtp": {"host":"smtp.example.test","port":587,"user":"info@formapoint.online","password":"FROM_SECRET_STORE","secure":false}
  }
}
```

SMTP s `secure:false` zahtijeva STARTTLS, IMAP s `secure:false` također zahtijeva STARTTLS. Certifikati se provjeravaju. Zajednički sandučić koristi odvojeni servisni pristup ograničen na taj sandučić. Dopuštenje aplikacije provjerava se prije IMAP-a i SMTP-a, a SMTP servis mora odbiti slanje s adresa izvan dodijeljenog identiteta i njegovih aliasa. Onemogućite automatsko kopiranje u Poslano na pružatelju ako je uključeno, jer WebmailHR nakon potvrđene predaje sprema jednu IMAP kopiju. Kod nepoznatog SMTP ishoda ili greške pri spremanju kopije provjerite zapis servisa prije ponovne predaje.

### Objava na Vercelu

`vercel.json` objavljuje Vite izlaz iz `dist` i usmjerava `/api/*` na Node
funkciju `api/index.ts`. Funkcija koristi isti Express API kao `npm start`.
Dodijelite `webmailhr.com` i `admin.webmailhr.com` istom projektu. U produkcijskim
postavkama projekta postavite serverski `DATABASE_URL`, `APP_ORIGIN` i
`ADMIN_ORIGIN`, primijenite migracije na ciljnu bazu i ponovno objavite projekt.

Ako lokalna mreža ne može otvoriti PostgreSQL port, migraciju može izvršiti
jedna produkcijska objava na Vercelu:

1. Na postojećem projektu u **Settings → Environment Variables** provjerite
   da `DATABASE_URL` pokazuje na produkcijsku bazu WebmailHR-a. Ako aplikacijska
   uloga nema DDL ovlasti, privremeno dodajte serverski `MIGRATION_DATABASE_URL`
   s ovlastima za migraciju iste baze.
2. Samo za **Production** postavite `WEBMAIL_MIGRATE_ON_BUILD=1`. Izgradnja koristi
   Vercelovu sistemsku varijablu `VERCEL_ENV` za provjeru okruženja.
3. U **Deployments** ponovno objavite produkcijsku verziju s ovom konfiguracijom,
   bez build cachea. U logu potražite `WebmailHR: migracije su primijenjene.`, a
   zatim provjerite [status baze](https://admin.webmailhr.com/api/health).
4. Uklonite privremeni `WEBMAIL_MIGRATE_ON_BUILD` i, ako ste je dodali,
   `MIGRATION_DATABASE_URL`. Zadržite produkcijski `DATABASE_URL` za aplikaciju.

Prisma Postgres može odbiti bezuvjetni `REVOKE` porukom
`restricted superuser cannot grant or revoke privileges`. Native migracija zato
prvo provjerava postoji li stvarna PUBLIC dodjela. Ako je nema, ne izvršava
nepotreban REVOKE; ako postoji, a servis zabrani njegovo izvršavanje, migracija
se zaustavlja. RLS ostaje uključen. Za postojeću Prisma serversku ulogu
`prisma_application` kreiraju se zasebna pravila, uz providerove dodjele
ovlasti; ovlasti krajnjih korisnika i dalje provjerava WebmailHR API.

Ako build prijavi `42501`, nova dijagnostika ispisuje **Korak** i prepoznati
objekt za koji nedostaje ovlast, bez connection stringa, SQL-a ili tajni.
`zaključavanje migracije` znači da prvo treba provjeriti dopušta li servis
`pg_advisory_xact_lock`; migracija tada nije stigla do promjena tablica.
`osnovna shema` ili `pohrana poruka i privitaka` znači da treba provjeriti
ovlasti nad navedenom shemom/tablicom i koristiti `MIGRATION_DATABASE_URL`
s ovlastima vlasnika iste baze. Sam pooled/direct način povezivanja ne jamči
te ovlasti. Ne gasite migraciju samo kako bi build prošao dok shema nedostaje.
Lokalne provjere dijagnostike: `npm run test:migration`.

Ako koristite i `www.webmailhr.com`, dodijelite je istom projektu. Obje javne
domene prihvaćaju prijavu s vlastitog HTTPS podrijetla. Zahtjev s jedne domene
na drugu i dalje se odbija. Reverse proxy treba sačuvati izvorni `Host`.

Na `https://admin.webmailhr.com/api/login-settings` očekuje se JSON s
`adminSite: true`. Ako ta adresa vraća HTML ili platformsku stranicu 404,
provjerite je li aktivna objava izgradila API funkciju i koristi li preusmjeravanja
iz repozitorija. [Provjera baze](https://admin.webmailhr.com/api/health) vraća 200 kad API može pristupiti
tablicama za prijavu i ima potrebne ovlasti pisanja. Kod odgovora 503 postupak
ovisi o polju `code`.

| Kod | Postupak |
| --- | --- |
| `DB_CONFIG` | Provjerite produkcijski `DATABASE_URL` i pristupne podatke baze. Nakon izmjene varijable ponovno objavite projekt. |
| `DB_CONNECTION` | Provjerite dostupnost hosta i porta te TLS. Ako koristite Supabase i izvršno okruženje ne može dosegnuti izravnu vezu na IPv6, koristite session pooler URL iz projekta. |
| `DB_SCHEMA` | Pokrenite `npm run migrate` nad istom bazom koju koristi produkcija. |
| `DB_PERMISSION` | Provjerite koristi li aplikacija PostgreSQL ulogu s potrebnim ovlastima pisanja u tablice za prijavu. |

Konfiguracija administracije i provjera prijave slijede u idućem odjeljku.

## Glavni administrator

Postavite `APP_ORIGIN=https://webmailhr.com` i `ADMIN_ORIGIN=https://admin.webmailhr.com`.
Administratorski obrazac i ploča otvaraju se na korijenu administratorske domene.
Migracije i naredbe za račun trebaju serverski `DATABASE_URL` za istu bazu koju koristi aplikacija.

- Ako glavni administrator još ne postoji, pokrenite `npm run bootstrap` uz `BOOTSTRAP_EMAIL=admin@webmailhr.com`, `BOOTSTRAP_ORG`, `BOOTSTRAP_NAME` i `BOOTSTRAP_PASSWORD`. Ako baza već ima glavnog administratora, bootstrap će odbiti stvaranje dodatnog računa.
- Ako račun postoji, pokrenite `npm run admin:password` uz `ADMIN_PASSWORD`. `ADMIN_EMAIL` zadano je `admin@webmailhr.com`. Naredba mijenja hash aktivnog glavnog administratora na navedenoj adresi i opoziva njegove sesije i tokene za oporavak.
- Administratorska lozinka mora imati najmanje osam znakova. Vrijednost proslijedite samo procesu kojem je potrebna i uklonite privremene varijable nakon izvršavanja. U bazi se čuva scrypt hash s nasumičnom soli.
- Ako želite omogućiti oporavak e-poštom, potrebno je prethodno potvrditi adresu oporavka (`BOOTSTRAP_RECOVERY` za novi račun) i postaviti `RECOVERY_SENDER`. Poveznica za oporavak koristi administratorsku domenu.

### Jednokratno postavljanje administratora iz Vercela

Ako lokalna mreža nema pristup PostgreSQL-u, u produkcijskim varijablama
postojećeg WebmailHR projekta postavite `WEBMAIL_ADMIN_SETUP=1` i novu
serversku tajnu `ADMIN_PASSWORD`. Ova objava stvara `admin@webmailhr.com` ako
glavni administrator ne postoji. Ako je na toj adresi već aktivan lokalni
glavni administrator, postavlja novu lozinku i opoziva sesije. Ako postoji
drugi glavni administrator ili je adresa zauzeta običnim računom, objava
prekida postupak i zadržava postojeće ovlasti.

Ponovno objavite odgovarajući produkcijski commit bez build cachea. Nakon
poruke o uspjehu u Build Logs uklonite `WEBMAIL_ADMIN_SETUP` i `ADMIN_PASSWORD`
te provjerite prijavu na administratorskoj domeni.

## Prijava i povezivanje s izvornim računima

Na `https://webmailhr.com/` jedan obrazac prima korisničko ime ili e-mail adresu. Glavni administrator koristi postojeći lokalni račun na `https://admin.webmailhr.com/`. Postojeći lokalni demo računi s adresama `.test` ostaju dostupni u demo okruženju.

- **e-Dnevnik.** Učenik unosi postojeće korisničko ime ili školsku e-mail adresu i lozinku. Postavite `EDNEVNIK_SUPABASE_PROJECT_ID` na project ref, `EDNEVNIK_SUPABASE_URL` na HTTPS URL Supabase projekta i `EDNEVNIK_USERNAME_LOGIN_URL` na puni HTTPS URL `https://e-ocjene.skolehr.xyz/api/auth/webmail/student`. Serverski `EDNEVNIK_USERNAME_LOGIN_TOKEN` mora imati istu vrijednost kao `WEBMAILHR_STUDENT_LOGIN_TOKEN` u e-Dnevniku. Ako su potrebne dodatne školske domene, navedite ih u `EDNEVNIK_LOGIN_DOMAINS` odvojene zarezom. Prema zadanim postavkama to su `skolehr.xyz` i `eskole.me`. WebmailHR povezuje vraćeni Auth ID i project ref s aktivnim računom s dodijeljenim osobnim sandučićem `@skolehr.xyz`.
- **FormaPoint.** Postavite `FORMAPOINT_SUPABASE_PROJECT_ID` na zaseban project ref, `FORMAPOINT_SUPABASE_URL` na njegov HTTPS URL i `FORMAPOINT_SUPABASE_AUTH_KEY` na publishable ili anon ključ toga projekta. Novi FormaPoint korisnik može dobiti samostalnu WebmailHR lozinku bez vanjskog Auth ID-a. Za povezani račun u administraciji unesite stabilni Auth ID i e-mail kako je upisan u FormaPoint Supabase Auth. Korisnik u isti obrazac unosi taj e-mail ili svoju povezanu WebmailHR adresu. Dok povezanom računu nije dodijeljena WebmailHR lozinka, WebmailHR pronalazi spremljeni izvorni e-mail, provjerava lozinku na `/auth/v1/token?grant_type=password` i traži isti Auth ID prije izdavanja sesije. Nakon migracije dopunite izvorni e-mail na već povezanim FormaPoint računima. Dodijelite `info@formapoint.online` samo ovlaštenim djelatnicima.
- **Djelatnici.** Administrator u obrascu korisnika dodjeljuje lozinku za WebmailHR ili klikne **Generiraj lozinku**. Nove lozinke imaju najmanje 8 znakova, a generator izdaje točno 8 nasumičnih brojčanih znamenki. Postojeći PIN-ovi ostaju valjani dok ih korisnik ili administrator ne zamijeni. `STAFF_PIN_PEPPER` potreban je samo za te stare PIN-ove; nove lozinke ne ovise o njemu.

U administraciji odaberite vrstu računa prije povezivanja i dodijelite potrebne sandučiće. Aplikacija čuva par referenca projekta + izvorni Auth ID. Izvorni sustavi provjeravaju učeničku lozinku i FormaPoint lozinku dok račun nema dodijeljenu WebmailHR lozinku. WebmailHR ne pohranjuje lozinke ni tokene izvornih sustava i sam provjerava dodjele za svako otvaranje sandučića ili privitka.

### Skupna sinkronizacija i osobni sandučići

`npm run directory:sync -- ednevnik` i `npm run directory:sync -- formapoint`
prikazuju broj prihvatljivih računa. Dodatak `--apply` povezuje račune prema
identifikatoru izvornog projekta i Supabase Auth UUID-u, stvara osobne sandučiće
na Mailcowu i dodjeljuje ih njihovim vlasnicima. Sinkronizacija ne mijenja
postojeće zajedničke sandučiće niti preuzima adresu s postojećim vlasnikom.
Ponovni poziv obrađuje i nedovršene zahtjeve. Objavu sandučića u WebmailHR-u
odgađa do potvrde Mailcowa.

| Izvor | Pravila |
| --- | --- |
| e-Dnevnik | Potvrđeni računi s aktivnim školskim članstvom. Učenici i djelatnici dobivaju odvojene vrste lokalnih računa. Sva aktivna članstva spremaju se uz primarnu školu. Adrese školske domene `eskole.me` mapiraju se u `skolehr.xyz`. |
| FormaPoint | Potvrđeni Auth računi u konfiguriranom projektu, uključujući kupce. Računi bez adrese u ciljnoj domeni dobivaju adresu sa stabilnim nastavkom. Prijava ostaje preko izvorne adrese. |

Izvori trebaju postojeće `*_SUPABASE_PROJECT_ID` i `*_SUPABASE_URL` te zasebni
serverski ključ `EDNEVNIK_DIRECTORY_KEY` odnosno `FORMAPOINT_DIRECTORY_KEY`
s pravom čitanja Auth imenika. e-Dnevnik ključ mora čitati i `user_profiles`,
`user_school_roles` i `schools`. U Supabaseu je to uobičajeno serverski
service-role ključ. Držite ih samo u okruženju radnika ili privremeno u Vercel
Production postavkama. Organizacije i domene zadane su u `.env.example`.
Domene moraju biti pripremljene na Mailcowu. Potrebni su `MAILCOW_URL`,
`MAILCOW_API_KEY`, `MAILCOW_MAIL_HOST` s IMAPS 993 i SMTPS 465 te
`MAILBOX_ENCRYPTION_KEY` od 64 heksadecimalna znaka (npr. `openssl rand -hex 32`).
Poštanski ključevi generiraju se zasebno od prijavnih lozinki i spremaju
šifrirani. Ključ za dešifriranje treba biti jednak u radniku i API-ju.

Primijenite migracije prije prve primjene. Pokretanje ponavljajte na radniku
koji ima pristup produkcijskom PostgreSQL-u i poštanskom poslužitelju. Za
jednokratnu primjenu putem Vercela postavite `WEBMAIL_DIRECTORY_SYNC` na
`ednevnik`, `formapoint` ili `both` samo u **Production**, ponovno objavite
odgovarajući commit i uklonite privremenu varijablu nakon obrade. Za veće
imenike koristite radnika zbog ograničenog vremena Vercel izgradnje.
Odsutnost korisnika u jednom učitavanju sama ne uklanja postojeći račun,
članstvo ili poštu. Pri odlasku djelatnika deaktivirajte njegov WebmailHR
račun prema pravilima ustanove.

Administrator u **Korisnici → Početne lozinke** može po organizaciji izdati
lozinke za do 50 aktivnih djelatnika i FormaPoint korisnika koji nemaju WebmailHR
lozinku. Datoteka sadrži lozinke u čitljivom obliku; predajte je sigurnim kanalom.
Postojeće WebmailHR lozinke ne mijenjaju se. Pojedinačni reset dostupnom korisniku
odmah opoziva sve njegove sesije. Lozinke se u bazi spremaju kao scrypt hash sa soli.

Djelatnik, FormaPoint korisnik i glavni administrator mogu u izborniku računa
odabrati **Promijeni lozinku**, unijeti trenutnu i dvaput novu lozinku. Nakon
uspjeha sve sesije su opozvane i korisnik se ponovno prijavljuje. Promjena vrijedi
samo za WebmailHR, ne mijenja lozinku u izvornom FormaPoint sustavu niti IMAP/SMTP
pristupne podatke. Za učenike lozinkom i dalje upravlja e-Dnevnik.

Prije objave primijenite migraciju `002-mail-passwords.sql` kroz `npm run migrate`
ili postojeću Vercel migraciju. Ona označava stare staff PIN hashove i dopušta
lokalnu lozinku za FormaPoint račune, uz očuvanje izvornih identiteta. Nove lozinke
ne zapisujte u Git, logove ili audit; audit sadrži samo vrstu radnje i ID korisnika.

Provjera novog toka na praznoj lokalnoj PostgreSQL bazi:

```sh
TEST_PASSWORD_DATABASE_URL=postgresql://USER:PASSWORD@127.0.0.1:5432/DISPOSABLE_DB npm run test:passwords
```

Provjere obuhvaćaju dodjelu i generiranje, stari PIN, promjenu vlastite lozinke,
opoziv sesija, postojeću FormaPoint prijavu, samostalni FormaPoint račun i granice
ovlasti administratora i korisnika.

### Dodjela učeničkog sandučića

Ako WebmailHR potvrdi prijavu kroz e-Dnevnik i zatraži dodjelu sandučića,
provjerite postoje li u istoj organizaciji:

1. Aktivan zapis u **Korisnici** vrste **Učenik · e-Dnevnik**, s učenikovom
   adresom `@skolehr.xyz` i vrijednošću **Stabilni ID korisnika** koja odgovara
   Auth UUID-u u projektu e-Dnevnika.
2. Aktivan osobni zapis pod **Sandučići** s istom adresom. U tom retku otvorite
   **Ovlasti i aliasi**, odaberite učenika i kliknite **Spremi ovlasti**.

Stvarni sandučić mora postojati i na poštanskom poslužitelju. Za prikaz pošte
WebmailHR-u je potrebna njegova IMAP konfiguracija u `MAIL_ROUTES`.

## Domene i DNS

| Domena ili adresa | Postavka |
| --- | --- |
| `webmailhr.com` | A/AAAA ili CNAME prema HTTPS ulazu aplikacije |
| `admin.webmailhr.com` | A/AAAA ili CNAME prema istom HTTPS ulazu. TLS certifikat mora pokrivati i administratorsku domenu. |
| `skolehr.xyz` | MX prema poštanskom poslužitelju. Osobni računi i zajednička `referada@skolehr.xyz` |
| `formapoint.online` | MX za `info@formapoint.online`. `promocije@formapoint.online` kao servisni pošiljatelj |
| `formapoint.hr` | `narudzba@formapoint.hr` za potvrde, uz Reply-To na `info@formapoint.online`. Ako ta domena prima poštu, postavite MX i dolazni alias na `info@formapoint.online` na poslužitelju |
| `{kratica}.isvu.me` | MX za svaku aktivnu poddomenu i zaseban `referada@` sandučić |
| Sve izlazne domene | Jedan SPF TXT s ovlaštenim servisima, DKIM TXT za stvarno korišteni selektor, DMARC TXT na `_dmarc` i odgovarajuće poravnanje domene. Za vlastiti SMTP osigurajte PTR, A/AAAA i TLS |

U konfiguraciju DNS-a upišite hostove, DKIM ključeve i SPF podatke stvarnog pružatelja. Gumb Webmail na fakultetskom portalu može koristiti `<a href="https://webmailhr.com">Webmail</a>`. Primjer za stari HTTPS ulaz uz postojeći certifikat i DNS:

```nginx
server {
    listen 443 ssl;
    server_name webmail.isvu.me;
    ssl_certificate /path/to/fullchain.pem;
    ssl_certificate_key /path/to/privkey.pem;
    return 308 https://webmailhr.com/;
}
```

## FormaPoint

Klijentska aplikacija za narudžbe i kampanje vodi raspored, primatelje i privole. Pošiljatelji u WebmailHR-u vežu se uz registriranu adresu i vrstu slanja (`order` ili `promotion`). Serverski `INTEGRATION_KEYS` sadrži samo SHA-256 sažetke dugih nasumičnih ključeva. Svaki zapis ima `hash`, `address`, `kind`, te opcionalno `consent` ili `delivery`. Dajte odvojeni ključ za promjenu privola i potvrde dostave. Pri svakom pozivu pošaljite `Authorization: Bearer …`.

- `POST /api/integrations/formapoint/send` prima `kind`, `eventId`, `recipient`, `subject`, `text` i za promocije `list`. Narudžba se može predati samo jednom po identifikatoru događaja i pošiljatelju. Promocija se deduplicira po kampanji, primatelju i listi. `pending` i `unknown` zahtijevaju provjeru kod servisa. SMTP prihvat daje `submitted`.
- `PUT /api/integrations/formapoint/consent` prima `recipient`, `list` i `allowed`. Dopuštenje (`true`) pošaljite nakon zabilježene privole, uključujući novu privolu nakon odjave. Odjava se bilježi za konkretnu listu. `UNSUBSCRIBE_SECRET` i HTTPS `APP_ORIGIN` potpisuju adresu odjave. Za RFC 8058 pružatelj mora DKIM-om potpisati zaglavlja List-Unsubscribe i List-Unsubscribe-Post.
- `PUT /api/integrations/formapoint/delivery/:id` prima `status` kao `delivered` ili `failed`. Povezani servis treba pozvati ovu adresu tek nakon provjere autentičnosti događaja pružatelja. Bez te veze status ostaje `submitted` ili `unknown`.

## Sigurnosne kopije i vraćanje

Redovito radite šifrirani `pg_dump --format=custom --file=webmail.dump "$DATABASE_URL"` i snimku volumena poštanskog poslužitelja (poruke, korisnici, kvote, aliasi, ključevi). Sačuvajte verziju aplikacije, popis DNS zapisa i odvojenu kopiju serverskih tajni prema proceduri pružatelja. Vratite dump u novu praznu bazu koristeći `pg_restore --exit-on-error --no-owner --dbname="$RESTORE_DATABASE_URL" webmail.dump`, vratite korespondirajuće mail volumene prema uputama servisa i u izoliranoj mreži provjerite prijavu, kvotu, privitke i probno slanje prije prebacivanja prometa. Pri vraćanju identiteta i sesija nakon incidenta poništite postojeće sesije i tokene oporavka te rotirajte tajne.

Dolazna poruka prikazuje se kao tekst, a MIME privitci se preuzimaju kao datoteke. Pretraga i mape rade na IMAP-u. Niti se grupiraju prema zaglavljima Message-ID i In-Reply-To unutar trenutačno učitanih poruka. Pozivnice se mogu preuzeti kao .ics. Označavanje dostave traži stvarno povezani servis.

### Ispravak prve uvezene FormaPoint adrese

Migracija `004-formapoint-original-address.sql` vraća `admin@formapoint.online`
umjesto nastavka dodijeljenog pri prvom uvozu. Obuhvaća samo točno povezani
potvrđeni izvorni račun i njegov osobni native sandučić. Provjerava kolizije i
vlasništvo, zadržava iste ID-eve računa i sandučića te lozinku, poruke, privitke i
dodjele. Račun ostaje u ulozi `user`; stare sesije opozivaju se. Ponovna primjena
ne stvara dodatne zapise. Serverska provjera pri migraciji potvrđuje rezultat.

### Obavijest o FormaPoint sandučiću

Uz serverski `FORMAPOINT_WELCOME_EMAIL=1`, stvaranje novog povezanog osobnog
sandučića dodaje jednu obavijest u `formapoint_welcomes` (migracija 005). Poruka ide
na potvrđenu izvornu e-mail adresu preko postojećeg Mailjeta, s nazivom pošiljatelja
FormaPoint Tim, adresom novog sandučića i retkom **Lozinka: ona koju ste postavili
za prijavu na FormaPoint**. Lozinka se ne generira, ne čita i ne šalje. Prijava
i dalje provjerava izvornu FormaPoint lozinku i UUID. Postojeće neovisne WebmailHR
lozinke ostaju sačuvane; takvim se računima ova uputa ne šalje.

Obavijest se zapisuje u istoj transakciji kao sandučić i preuzima prije mrežnog
poziva. Istodobne prijave ne šalju dvaput. Uspjeh se označava `sent` tek kad Mailjet
potvrdi predaju. Kvota i nedostajuće postavke ostavljaju `pending`, a nejasan
mrežni ishod ostavlja `unknown` za operatersku provjeru, bez automatskog ponavljanja.
Sljedeći poziv provisioniranja obrađuje do 10 čekajućih obavijesti. Red ne sadrži
lozinke ni tajne i ima server-only RLS. Odvojena dodjela lozinke ili promjena
identiteta prije slanja poništava zastarjelu obavijest.

Postojeće adrese s izvornim UUID nastavkom preimenuju se samo ako se potvrdi točan
izvorni identitet i osobno vlasništvo. ID-evi, poruke, privitci, lozinke i prava
ostaju isti; prilagođene i već skraćene adrese se ne mijenjaju. Jednokratna
korisnička uputa za `nikoladuric280@gmail.com` dodjeljuje `nikola.duric@formapoint.online`
i stavlja obavijest u red. DNS/MX se ovom objavom ne mijenja.

Provjere: `npm run test:formapoint` (imenovanje, kolizije, preimenovanje),
`npm run test:welcome` (jedna obavijest, točan predložak, izvorna prijava, bez
promjene lozinke), native/lozinka/migracijske regresijske provjere i produkcijski build.

### Zajednička FormaPoint i WebmailHR lozinka

Računi s povezanim FormaPoint projektom, UUID-om i izvornim e-mailom uvijek
provjeravaju prijavu u izvornom Supabase Auth sustavu, uključujući račune s
ranijom lokalnom WebmailHR lozinkom. Izvorna lozinka time je jedina za obje prijave.
Lokalni djelatnički i nepovezani računi zadržavaju svoju postojeću prijavu.

Promjena u WebmailHR profilu provjerava aktivnu vlastitu sesiju, ponovno se
prijavljuje na izvor trenutačnom lozinkom i uspoređuje vraćeni UUID prije promjene.
Zatim `PUT /auth/v1/user` s vlastitim novim izvornim tokenom i `current_password`
mijenja istu FormaPoint lozinku. Ne koristi se administratorski Supabase ključ.
Tek nakon potvrde izvora briše se raniji lokalni override, poništavaju se WebmailHR
sesije i bilježi audit. Neuspjeh izvora ne stvara lokalnu lozinku. Ako potvrda
izvora ili lokalni commit izostane, API ne tvrdi da je promjena uspjela; sljedeća
prijava uvijek provjerava aktualnu lozinku izvora.

FormaPoint profil ima obrazac s trenutačnom, novom i potvrdom lozinke. Koristi
Supabase provjeru aktualnog korisnika, ponovnu vlastitu prijavu i `updateUser`.
Povezane FormaPoint lozinke na obje lokacije zahtijevaju najmanje 8 znakova,
barem jedno malo slovo, jedno veliko slovo i jednu znamenku. Simbol nije obavezan. Povezani računi isključeni su iz dodjele zasebnih lozinki u
administraciji i skupnog generiranja. Lozinke se ne zapisuju u logove.

Provjera: 6 testova promjene lozinki, uključujući osam znakova sa slovima i brojem, promjene s obje
strane, krivu lozinku/UUID, nedostupan izvor i zaštitu od lokalnog overridea;
13 FormaPoint, 12 native i 5 welcome regresijskih testova te produkcijski build.
FormaPoint ima dodatne testove vlastitog obrasca/helpera i jednokratnu, zasebno
upravljanu produkcijsku provjeru pravila izvornog Auth sustava.

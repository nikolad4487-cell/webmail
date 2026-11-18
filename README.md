# WebmailHR

Webmail na hrvatskom za organizacije, škole i fakultete. Zajednički ulaz na `https://webmailhr.com` omogućuje odabir vrste računa i daje pristup sandučićima, adresama za slanje i kalendarima koji su korisniku dodijeljeni u PostgreSQL-u. Poruke, mape, privitci i stvarne kvote dolaze s poštanskog poslužitelja.

## Lokalno pokretanje

Preduvjeti su Node.js 22.12+, Docker Compose, Bash i OpenSSL. Svi probni računi koriste domenu `.test`.

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

Testovi provjeravaju izolaciju škola, pristup referadi, zabranu tuđeg privitka i pošiljatelja, SMTP/IMAP u oba smjera, sadržaj privitka, kvotu, jednu kopiju u Poslano, kalendar, .ics, ograničenje ključa, idempotentnost i odjavu. Provjeravaju i učeničku prijavu preko zaštićene rute, izravnu FormaPoint prijavu s provjerom Auth ID-a, zasebnu prijavu administratora, promjenu izvorne lozinke, reset PIN-a i pristup samo dodijeljenim sandučićima. Lokalni servisi simuliraju produkcijske izvore prijave. GreenMail varijanta provjerava i ispravan odgovor kad poslužitelj ne oglašava IMAP QUOTA.

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
- **FormaPoint.** Postavite `FORMAPOINT_SUPABASE_PROJECT_ID` na zaseban project ref, `FORMAPOINT_SUPABASE_URL` na njegov HTTPS URL i `FORMAPOINT_SUPABASE_AUTH_KEY` na publishable ili anon ključ toga projekta. U administraciji WebmailHR-a za račun vrste FormaPoint unesite stabilni Auth ID i e-mail kako je upisan u FormaPoint Supabase Auth. Korisnik u isti obrazac unosi taj e-mail ili svoju povezanu WebmailHR adresu. WebmailHR pronalazi spremljeni izvorni e-mail, provjerava lozinku na `/auth/v1/token?grant_type=password` i traži isti Auth ID prije izdavanja sesije. Nakon migracije dopunite izvorni e-mail na već povezanim FormaPoint računima. Dodijelite `info@formapoint.online` samo ovlaštenim djelatnicima.
- **Školski djelatnici.** Koriste punu WebmailHR adresu i osam znamenaka. U administraciji odaberite **Generiraj / resetiraj lozinku**. Lozinka se prikazuje jednom, a reset opoziva postojeće sesije. Postavite serverski `STAFF_PIN_PEPPER` na nasumičnu tajnu od najmanje 32 znaka. Ako je promijenite, izdajte nove lozinke.

U administraciji odaberite vrstu računa prije povezivanja i dodijelite potrebne sandučiće. Aplikacija čuva par referenca projekta + izvorni Auth ID. Izvorni sustavi provjeravaju lozinku pri svakoj novoj prijavi. WebmailHR ne pohranjuje njihove lozinke ni tokene i sam provjerava dodjele za svako otvaranje sandučića ili privitka.

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

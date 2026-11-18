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

Testovi provjeravaju izolaciju škola, pristup referadi, zabranu tuđeg privitka i pošiljatelja, SMTP/IMAP u oba smjera, sadržaj privitka, kvotu, jednu kopiju u Poslano, kalendar, .ics, ograničenje ključa, idempotentnost i odjavu. Provjeravaju i tri vrste prijave, isto korisničko ime i izvorni ID u oba projekta, promjenu izvorne lozinke, generiranje i reset PIN-a, opoziv sesije i pristup samo dodijeljenim sandučićima. Lokalni servisi simuliraju sučelja Supabase Auth i vlastite serverske prijave. GreenMail varijanta provjerava i ispravan odgovor kad poslužitelj ne oglašava IMAP QUOTA.

## Produkcija

1. Postavite PostgreSQL i vrijednosti iz [.env.example](.env.example) u serverskom upravitelju tajni. Koristite odvojene DB ovlasti za migracije i rad aplikacije, s TLS-om prema udaljenoj bazi. Pokrenite `npm ci`, `npm run migrate` i jednom `npm run bootstrap` uz `BOOTSTRAP_*`. Oporavak omogućite samo uz prethodno neovisno potvrđenu adresu oporavka, registriran servisni `RECOVERY_SENDER` i HTTPS `APP_ORIGIN`. Uklonite bootstrap lozinku iz konfiguracije nakon stvaranja računa.
2. `npm run build` i `npm start`. Pred aplikaciju stavite HTTPS reverse proxy. Dopustite `TRUST_PROXY=1` samo za topologiju s jednim pouzdanim proxyjem koji prepisuje zaglavlja prosljeđivanja. Aplikacijski port ograničite na privatnu mrežu proxyja.
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

## Prijava i povezivanje s izvornim računima

- **Učenik · e-Dnevnik** koristi postojeće korisničko ime i lozinku. WebmailHR traži aktivan, osobni sandučić koji je dodijeljen tom korisniku i odgovara njegovoj adresi `@skolehr.xyz`.
- **Školski djelatnik** koristi punu WebmailHR adresu i točno osam ASCII znamenaka. Nakon spremanja računa odaberite **Generiraj / resetiraj lozinku** u administraciji korisnika. Predajte prikazanu vrijednost sigurnim kanalom. Prikazuje se jednom, uključujući početne nule. U bazi ostaje samo hash, a izdavanje nove lozinke opoziva postojeće sesije. Postavite `STAFF_PIN_PEPPER` na nasumičnu serversku tajnu od najmanje 32 znaka. Ako rotirate tu tajnu, izdajte nove lozinke djelatnicima.
- **FormaPoint** provjerava korisničko ime i lozinku u vlastitom projektu te prikazuje samo dodijeljene sandučiće. Dodijelite `info@formapoint.online` isključivo ovlaštenim djelatnicima.
- **Glavni administrator / probni račun** koristi postojeću lokalnu prijavu e-mailom. Lokalni računi koji nisu glavni administratori mogu se prijaviti u demo okruženju s adresama `.test`. Nakon migracije postojećim produkcijskim korisnicima odaberite odgovarajuću vrstu računa u administraciji.

Za svaki izvor zasebno potvrdite postojeći postupak prijave u njegovoj konfiguraciji ili kodu. Postavite `EDNEVNIK_SUPABASE_PROJECT_ID` i `FORMAPOINT_SUPABASE_PROJECT_ID` na različite stabilne reference projekata (project ref) te odgovarajuće `*_SUPABASE_URL` na različite HTTPS ulaze projekata. U tablici korisnika odaberite vrstu računa i unesite stabilni ID iz tog projekta, npr. `auth.users.id` za Supabase Auth. Aplikacija sprema par project ref + izvorni ID. Korisničko ime, e-mail izvornog sustava i metapodaci izvora ne daju ovlast za poštu. Nakon povezivanja dodijelite potrebne sandučiće. Prijava s ispravnom izvornom lozinkom bez dodjele prikazuje poruku o potrebnoj dodjeli.

| Način izvornog sustava | Postavke s prefiksom `EDNEVNIK_` ili `FORMAPOINT_` |
| --- | --- |
| Supabase Auth s e-mailom ili telefonom | `SUPABASE_AUTH_KEY` je ključ projekta za Auth/Gateway (publishable ili anon). `USERNAME_RPC` je ime ograničene RPC funkcije. `USERNAME_RPC_TOKEN` je serverski Bearer JWT s dozvolom izvršenja samo potrebnog postupka, prema ulozi definiranoj u projektu. |
| Postojeća serverska provjera korisničkim imenom | `USERNAME_LOGIN_URL` je puni HTTPS URL postojećeg postupka ili njegova tankog adaptera. `USERNAME_LOGIN_TOKEN` je njegov serverski Bearer ključ. Kad je URL postavljen, koristi se taj postupak. |

RPC prima JSON `{"username":"..."}` i vraća objekt s točno jednim identifikatorom `{"email":"..."}` ili `{"phone":"+..."}`, odnosno JSON `null` ako korisnik ne postoji. Koristi postojeća pravila uparivanja korisničkih imena i smije vratiti samo jedno jednoznačno podudaranje. Funkciji ukinite javni `EXECUTE` i dopustite ga samo namjenskoj ulozi. RPC ne prima lozinku. WebmailHR šalje identifikator i lozinku na `/auth/v1/token?grant_type=password` istog projekta i koristi samo `user.id` iz uspješne provjere.

Postojeći serverski postupak ili adapter prima `{"username":"...","password":"..."}` i nakon stvarne provjere vraća `{"user_id":"stabilni-id"}`. Za nevaljane pristupne podatke vraća HTTP 401. Adapter provjerava Bearer ključ prije obrade i koristi izvorni postupak, bez dnevnika koji sadrži tijela zahtjeva ili lozinke. Ako projekt koristi dodatne korake kao što je višefaktorska provjera, prvo potvrdite podržani serverski postupak koji poštuje ta pravila. WebmailHR ne sprema izvorne lozinke ni tokene i provjerava lozinku pri svakoj novoj prijavi. Već izdana WebmailHR sesija ima vlastiti rok važenja.

## Domene i DNS

| Domena ili adresa | Postavka |
| --- | --- |
| `webmailhr.com` | A/AAAA ili CNAME prema HTTPS ulazu aplikacije |
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

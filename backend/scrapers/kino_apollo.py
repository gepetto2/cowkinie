import logging
import re
import asyncio
from html import unescape
from datetime import datetime
from zoneinfo import ZoneInfo
from curl_cffi import requests
from utils import clean_title, ScraperError
from db.database import upsert_cinema, upsert_movies_batch, upsert_screenings_chunked

logger = logging.getLogger(__name__)

# Kino Apollo (Poznań, studyjne). Strona WordPress bez API repertuaru, ale:
# - lista TYLKO filmowych seansów (odsiane teatr/koncerty/stand-up) jest pod JSF-em z paginacją,
# - czyste dane seansu (tytuł z datą, link biletowy) są w REST CPT 'repertuar',
# - plakat/opis filmu w REST CPT 'kino'.
CITY = "Poznań"
FILM_LISTING = "https://kinoapollo.pl/kino/?jsf=jet-engine:repertuar&pagenum={}"
REST = "https://kinoapollo.pl/wp-json/wp/v2"
MAX_PAGES = 20


def _strip_html(text: str):
    if not text:
        return None
    return unescape(re.sub(r"<[^>]+>", "", text)).strip() or None


def _match_key(title: str):
    """Klucz do dopasowania seans->film: bez sufiksów (rok), '– wersja/seans...', bez diakrytyków."""
    t = unescape(title or "")
    t = re.sub(r"\s*\((?:19|20)\d\d\)\s*$", "", t)                       # (1995)
    t = re.sub(r"\s*[–—-]\s*(?:wersja|seans|pokaz|napisy|dubbing|premiera|spotkanie).*$", "", t, flags=re.I)
    return re.sub(r"\s+", " ", t).strip().lower()


_QUOTES = "„“”‟«»\""  # „ " " ‟ « » "


def _clean_apollo_name(name: str):
    """Zdejmuje z tytułu Apollo dopiski i zwraca (czysta_nazwa, rok_produkcji, movie_type):
    - tytuł opakowany w cudzysłów + opis (retransmisje: „André Rieu..." Retransmisja...) -> część w cudzysłowie,
    - nazwa cyklu w cudzysłowie + film po separatorze („Kultowe wakacje" - Ghost in the Shell) -> film,
    - 'NzN' (np. 'Big Shark NzN') = Najlepsze z Najgorszych -> movie_type,
    - rok w nawiasie (np. 'Milczenie owiec (1991)') -> rok produkcji (i lepszy tytuł do dopasowania/TMDB)."""
    name = (name or "").strip()
    # Opcjonalne "Cykl" przed nazwą cyklu w cudzysłowie (Cykl „Filmy dokumentalne w Apollo" - Monterey Pop).
    name = re.sub(r"^\s*Cykl\s+(?=[" + _QUOTES + "])", "", name, flags=re.IGNORECASE)

    # Tytuł zaczynający się od cudzysłowu ma dwa warianty:
    #   „Film" opis...           -> tytuł jest w cudzysłowie (np. „André Rieu..." Retransmisja...),
    #   „Cykl": Film / „Cykl" - Film -> w cudzysłowie jest nazwa cyklu, film jest PO separatorze.
    m = re.match(rf"^\s*[{_QUOTES}]([^{_QUOTES}]+)[{_QUOTES}]\s*(.*)$", name)
    if m:
        quoted, rest = m.group(1).strip(), m.group(2).strip()
        after = re.match(r"^[:–—-]\s*(.+)$", rest)
        name = after.group(1).strip() if after else (quoted if not rest else quoted)

    movie_type = None
    if re.search(r"[,\s]+NzN\s*$", name, flags=re.IGNORECASE):
        movie_type = "NAJLEPSZE Z NAJGORSZYCH"
        name = re.sub(r"[,\s]+NzN\s*$", "", name, flags=re.IGNORECASE)

    # Rok czytamy PRZED odcięciem członu po ukośniku - przy "Lot nad kukułczym gniazdem / One Flew
    # Over the Cuckoo's Nest (1975)" stoi on na samym końcu, więc odwrotna kolejność by go zgubiła.
    # Rok jest cenny: to on odróżnia klasyk od remake'u przy dopasowaniu w TMDB.
    year = None
    m = re.search(r"\s*\((\d{4})\)\s*$", name)
    if m:
        yr = int(m.group(1))
        if 1900 <= yr <= 2100:
            year = yr
            name = name[:m.start()].rstrip()

    # Tytuł oryginalny doklejony ukośnikiem - zostawiamy polski, bo pod nim film występuje
    # w pozostałych kinach i dzięki temu trafia w scalanie.
    if "/" in name:
        head = name.split("/")[0].strip()
        if len(head) >= 3:
            name = head

    # Dopiski o okazji, nie o filmie.
    name = re.sub(r"\s*[–—-]\s*(?:seans|pokaz|wersja|spotkanie|prelekcja|retransmisja)\b.*$", "", name, flags=re.IGNORECASE)

    return name.strip(), year, movie_type


_WEEKDAYS = {"poniedziałek", "wtorek", "środa", "czwartek", "piątek", "sobota", "niedziela"}
_KINDS = {"kino", "teatr", "kabaret", "koncert", "stand-up"}


def parse_listing(html: str) -> list:
    """Parsuje stronę listingu JSF -> lista seansów: (booking_id, tytuł, start_time, rok, movie_type).

    Dlaczego stąd, a nie z REST CPT 'repertuar': Apollo ma w nim DWA formaty wpisów. Starszy trzyma
    wszystko w tytule ("Milczenie owiec (1991) 2026-08-01 20:15:00 677621"), nowszy ma w tytule sam
    numer biletu, a datę w polu `data-i-godzina` - i NIE ujawnia przez REST powiązania z filmem, więc
    nie sposób poznać jego tytułu. Scraper parsujący tytuł gubił wszystkie nowe wpisy, czyli około
    jednej trzeciej repertuaru.
    Listing renderuje jedno i drugie jednakowo: data, dzień tygodnia, godzina, tytuł, typ i link
    biletowy jako zwykły tekst. Zawiera przy tym WYŁĄCZNIE pozycje filmowe, więc znika też potrzeba
    osobnej whitelisty odsiewającej teatr i kabaret.

    Czysta funkcja (testowalna offline).
    """
    out = []
    for part in html.split("jet-listing-grid__item")[1:]:
        part = part[:24000]
        texts = [unescape(x).strip() for x in re.findall(r">([^<>]{1,120})<", part)]
        texts = [t for t in texts if t]

        date = next((t for t in texts if re.fullmatch(r"\d{2}\.\d{2}\.\d{4}", t)), None)
        time = next((t for t in texts if re.fullmatch(r"[0-2]?\d:[0-5]\d", t)), None)
        if not date or not time:
            continue

        # Tytuł to pierwszy sensowny tekst PO godzinie - przed nim stoją data i dzień tygodnia.
        idx = texts.index(time)
        raw_name = next(
            (t for t in texts[idx + 1:]
             if len(t) > 3 and t.lower() not in _WEEKDAYS and t.lower() not in _KINDS
             and t.lower() != "kup bilet"),
            None,
        )
        if not raw_name:
            continue

        m_id = re.search(r"event/view/id/(\d+)", part)
        d, mo, y = (int(x) for x in date.split("."))
        hh, mm = (int(x) for x in time.split(":"))
        start_time = datetime(y, mo, d, hh, mm, tzinfo=ZoneInfo("Europe/Warsaw")).isoformat()

        name, year, movie_type = _clean_apollo_name(raw_name)
        name = clean_title(name)
        if not name or name.isdigit():
            continue
        out.append((m_id.group(1) if m_id else None, name, start_time, year, movie_type))
    return out


async def _fetch_json(client, url):
    resp = await client.get(url, timeout=40.0)
    if resp.status_code == 200:
        return resp.json()
    return None


async def _fetch_screenings(client) -> list:
    """Paginuje listing filmowy (JSF) i zwraca wszystkie seanse, deduplikowane po ID biletu."""
    seen, out = set(), []
    for pg in range(1, MAX_PAGES + 1):
        try:
            resp = await client.get(FILM_LISTING.format(pg), timeout=40.0)
        except Exception as e:
            logger.error(f"[Apollo] Błąd pobierania listy filmowej str {pg}: {e}")
            break
        if resp.status_code != 200:
            break
        page = parse_listing(resp.text)
        # Klucz z ID biletu; przy jego braku z godziny i tytułu - żeby powtórzona strona nie dublowała.
        fresh = [s for s in page if (s[0] or f"{s[2]}|{s[1]}") not in seen]
        if not fresh:
            break  # brak nowych pozycji = koniec paginacji
        for s in fresh:
            seen.add(s[0] or f"{s[2]}|{s[1]}")
        out.extend(fresh)
    return out


async def _fetch_all(client, cpt: str, fields: str) -> list:
    """Pobiera wszystkie posty danego CPT z REST (paginacja po 100)."""
    out = []
    for page in range(1, 30):
        data = await _fetch_json(client, f"{REST}/{cpt}?per_page=100&page={page}&_fields={fields}")
        if not data:
            break
        out.extend(data)
        if len(data) < 100:
            break
    return out


async def scrape_and_save(supabase):
    async with requests.AsyncSession(impersonate="chrome") as client:
        try:
            logger.info("Rozpoczynam scraping Kina Apollo (Poznań)...")
            db_cinema_id = upsert_cinema(supabase, "Kino Apollo", CITY, "Kino Apollo", "studyjne")

            # Seanse z listingu (zawiera wyłącznie pozycje filmowe) + filmy z CPT 'kino' (plakat/opis)
            screenings, kino_posts = await asyncio.gather(
                _fetch_screenings(client),
                _fetch_all(client, "kino", "id,title,plakat,opis"),
            )
            logger.info(f"Kino Apollo: {len(screenings)} seansów z listingu, {len(kino_posts)} filmów w katalogu.")
            if not screenings:
                raise ScraperError("Kino Apollo: listing filmowy nie zwrócił żadnego seansu - zmiana struktury strony?")

            # Mapa dopasowania: klucz tytułu -> plakat/opis z CPT 'kino'.
            # UWAGA: danych technicznych (reżyser/rok/długość) NIE bierzemy ze stron katalogu.
            # Ich treść jest NIESTABILNA między żądaniami - strona filmu potrafi raz zawierać
            # linię 'reż. …' z bloku polecanych (czyli CUDZEGO filmu), a raz nie. Sprawdzone:
            # ta sama strona zwróciła raz 'Miloš Forman, 1975', raz nic. Błędny reżyser jest
            # gorszy niż jego brak, bo psuje dopasowanie w TMDB.
            # Katalog trzyma tytuły SUROWE („Kultowe wakacje” – Ghost in the Shell (1995)), a listing
            # oddaje już OCZYSZCZONE (Ghost in the Shell), więc klucz budujemy po tym samym czyszczeniu.
            # Rejestrujemy też wariant surowy - tytuły bez ozdobników trafiają wtedy obiema drogami.
            kino_by_key = {}
            for k in kino_posts:
                raw = (k.get("title") or {}).get("rendered") or ""
                cleaned, _, _ = _clean_apollo_name(unescape(raw))
                for key in (_match_key(clean_title(cleaned)), _match_key(raw)):
                    if key and key not in kino_by_key:
                        kino_by_key[key] = k

            # KROK 1: filmy
            movies_to_upsert = {}
            meta = {}
            parsed = []  # (title, start_time, booking_link)
            for booking_id, title, start_time, year, movie_type in screenings:
                booking_link = f"https://bilety.kinoapollo.pl/event/view/id/{booking_id}" if booking_id else None
                parsed.append((title, start_time, booking_link))

                if title not in movies_to_upsert:
                    km = kino_by_key.get(_match_key(title))
                    movies_to_upsert[title] = {"title": title}
                    # Dane opisowe -> wspólne kolumny małych kin (core/small_sources.py).
                    meta[title] = {
                        "poster": (km or {}).get("plakat") or None,
                        "description": _strip_html((km or {}).get("opis")),
                        "release_year": year,
                        "movie_type": movie_type,
                    }

            movies_cache = upsert_movies_batch(supabase, movies_to_upsert)
            logger.info(f"Zapisano {len(movies_cache)} filmów Kina Apollo.")

            # KROK 2: seanse
            new_screenings = {}
            for title, start_time, booking_link in parsed:
                movie_id = movies_cache.get(title)
                if not movie_id:
                    continue
                screening_key = (movie_id, start_time, "")
                new_screenings[screening_key] = {
                    "movie_id": movie_id,
                    "cinema_id": db_cinema_id,
                    "start_time": start_time,
                    "room_name": "",
                    "booking_link": booking_link,
                }

            if new_screenings:
                upsert_screenings_chunked(supabase, new_screenings, "Kino Apollo")

            logger.info("Zakończono zapisywanie danych z Kina Apollo!")
            return meta

        except Exception:
            logger.exception("[Kino Apollo] Błąd w trakcie scrapowania")
            raise

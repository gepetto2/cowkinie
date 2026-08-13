import asyncio
import logging
import re
from html import unescape

logger = logging.getLogger(__name__)

# Wszystkie małe kina opisują film jedną linią w tym samym układzie:
#   Bułgarska  reż. Darren Aronofsky, USA, 2000 r., 102 min.
#   Apollo     reż. Miloš Forman, USA 1975, 133 min
#   Pałacowe   reż. Olivia Wilde, USA 2026, 108’
#   Rialto     Reż. Olivia Wilde<br/>USA, 2026, 108 minut
# Rialto rozdziela człony znacznikami <br>, więc przed czyszczeniem HTML zamieniamy je na przecinki -
# wtedy wszystkie cztery sprowadzają się do jednego wzorca i wystarczy jeden parser.
#
# Akceptujemy też angielskie "dir.": Pałacowe prowadzi część stron po angielsku (pokazy z napisami,
# repremiery) i wtedy zamiast "reż." pisze "Breathless , dir. Jean-Luc Godard, France 1960, 90’".
# Bez tego traciliśmy z takich stron reżysera, rok i długość naraz - a że to właśnie wznowienia klasyki,
# brak reżysera prowadził dalej do błędnego dopasowania w TMDB (Godard rozpoznany jako remake McBride'a).
_CREDITS = re.compile(r"(?:re[żz]|dir)\.\s*([^<]{5,220})", re.IGNORECASE)


# Małe kina ogłaszają zamknięcia i vouchery jako zwykłe pozycje repertuaru - bez tego trafiają
# do bazy jako filmy (tak powstało "KINO NIECZYNNE" z Pałacowego).
_NOT_A_SCREENING = re.compile(r"kino\s+nieczynne|przerwa\s+techniczna|bilet\s+podarunkowy", re.IGNORECASE)


def is_not_a_screening(title: str) -> bool:
    """True dla komunikatu udającego pozycję repertuaru."""
    return bool(_NOT_A_SCREENING.search(title or ""))


def html_to_text(html: str) -> str:
    """HTML -> tekst, z <br> zamienionym na przecinek (patrz komentarz przy _CREDITS)."""
    t = re.sub(r"<br\s*/?>", ", ", html or "", flags=re.IGNORECASE)
    return unescape(re.sub(r"<[^>]+>", " ", t))


def parse_credits(text: str):
    """Z linii 'reż. X, KRAJ ROK, N min' wyciąga (reżyser, rok, długość). Braki jako None.

    Reżysera bierzemy z pierwszego członu po przecinku. Przy duecie ('Mariano Cohn, Gastón Duprat')
    tracimy drugie nazwisko - do dopasowania w TMDB wystarcza jedno, a pełną listę wnosi potem samo
    TMDB. Rozdzielanie nazwisk od krajów bez słownika państw byłoby zgadywaniem ('Nowa Zelandia'
    wygląda jak imię i nazwisko).
    """
    m = _CREDITS.search(text or "")
    if not m:
        return None, None, None
    line = re.sub(r"\s+", " ", m.group(1)).strip()

    m_y = re.search(r"\b(19\d{2}|20\d{2})\b", line)
    year = int(m_y.group(1)) if m_y else None

    # Długość: 'min', 'minut' albo prim (108’) - Pałacowe używa tego ostatniego.
    m_l = re.search(r"(\d{2,3})\s*(?:min|’|')", line)
    length = int(m_l.group(1)) if m_l else None

    first = line.split(",")[0].strip()
    # Odsiewamy przypadek bez reżysera: linia zaczynająca się od kraju albo liczby.
    director = first if len(first.split()) >= 2 and not any(c.isdigit() for c in first) else None
    return director, year, length


async def fetch_details(client, urls: dict, concurrency: int = 4, headers: dict = None) -> dict:
    """Pobiera strony szczegółów filmów i zwraca {klucz: (reżyser, rok, długość)}.

    `urls` to {klucz: adres} - klucz jest zwykle identyfikatorem filmu, dzięki czemu pobieramy
    KAŻDY film raz, a nie raz na seans (przy Pałacowym to 50 zapytań zamiast 80).
    Ograniczona równoległość, bo to małe witryny na współdzielonym hostingu.

    `headers` przydaje się przy witrynach dwujęzycznych: Pałacowe wybiera język po `Accept-Language`
    i bez wymuszenia polskiego oddaje część stron po angielsku, gdzie zamiast "reż." stoi "dir.".
    """
    sem = asyncio.Semaphore(concurrency)

    async def one(key, url):
        async with sem:
            try:
                resp = await client.get(url, timeout=30.0, headers=headers or {})
            except Exception as e:
                logger.debug("Nie pobrano szczegółów %s: %s", url, e)
                return key, (None, None, None)
            if resp.status_code != 200:
                return key, (None, None, None)
            return key, parse_credits(html_to_text(resp.text))

    return dict(await asyncio.gather(*[one(k, u) for k, u in urls.items()]))

# Wspólny zestaw kolumn dla MAŁYCH kin (studyjne/niezależne), zamiast osobnego kompletu per kino.
#
# Po co: każde kolejne małe kino oznaczałoby 8 nowych kolumn, a dane i tak rzadko się nakładają -
# 86% filmów granych wyłącznie w kinach studyjnych leci w JEDNYM takim kinie. Sieciówki (Multikino,
# Cinema City, Helios) zachowują własne kolumny: dostarczają komplet danych dla większości repertuaru
# i chcemy nad nimi ziarnistej kontroli priorytetów.
#
# Największą wartość mają `release_year`, `original_title` i `director` - to sygnały, których brak
# powodował dopasowanie filmu do niewłaściwej pozycji w TMDB (klasyk kontra remake).
FIELDS = (
    "poster", "description", "genre", "length",
    "release_year", "original_title", "director", "movie_type",
)

# Kolejność = PRIORYTET przy scalaniu. Rozstrzyga per POLE: dla każdego pola wygrywa pierwsze źródło
# z listy, które ma niepustą wartość. Dzięki temu Rialto może wnieść długość, a Pałacowe plakat
# tego samego filmu.
#
# Kolejność wynika z jakości danych, nie z wielkości kina:
#  - malta     - najbogatsze źródło: reżyser przy KAŻDYM filmie, pełne opisy i duże plakaty
#                (oklasowane pola wtyczki wpmovielibrary), ale bez roku produkcji - patrz EXCLUDED_FIELDS,
#  - orzel     - dane ze strony filmu w oklasowanych parach etykieta/wartość (reżyser w 26 z 35
#                filmów, tytuł oryginalny), a rok to REALNY rok produkcji, nie rok dystrybucji,
#  - apollo    - ma rok produkcji i realny opis filmu,
#  - rialto    - podaje gatunek i długość wprost przy seansie,
#  - palacowe  - dobre plakaty, ale UWAGA: jego `lead` opisuje WYDARZENIE ("Plenerowe Pałacowe 2026,
#                Dziedziniec Zamkowy…"), a nie film, więc opisu stamtąd świadomie nie bierzemy,
#  - lumiere   - opis, gatunek i długość z API kina (niewiele filmów, ale dane czyste),
#  - bulgarska - najuboższe źródło, na końcu.
PRIORITY = ("malta", "orzel", "apollo", "rialto", "palacowe", "lumiere", "bulgarska")

# Pola, których dane źródło NIE dostarcza wiarygodnie - pomijamy je przy scalaniu nawet wtedy, gdy
# scraper coś w nich zwróci. To zabezpieczenie na przyszłość: samo pominięcie pola w scraperze działa,
# ale nie niesie ostrzeżenia i ktoś (łącznie ze mną) dopisze je później "bo przecież jest na stronie".
EXCLUDED_FIELDS = {
    # Malta podaje w nawiasie rok POLSKIEJ dystrybucji, nie produkcji: "Requiem dla snu (2026)" przy
    # filmie z 2000, "Harry Angel (2025)" przy filmie z 1987. A że to kino regularnie gra wznowienia
    # klasyki, taki rok w release_year kierowałby TMDB prosto na remake - dokładnie ten błąd, przez
    # który Oldboy dostał opis i plakat wersji z 2013 zamiast oryginału z 2003.
    "malta": ("release_year",),
}


def merge_by_priority(per_source: dict) -> dict:
    """Scala dane z wielu małych kin w jeden zestaw na film, rozstrzygając per pole wg PRIORITY.

    `per_source` to {źródło: {tytuł: {pole: wartość}}}. Zwraca {tytuł: {pole_small: wartość}}
    gotowe do zapisania.

    Scalanie jest tu, a nie w scraperach, bo scrapery działają RÓWNOLEGLE - gdyby każdy zapisywał
    te kolumny sam, o wartości decydowałby ten, który akurat skończy później, i plakat filmu granego
    w dwóch kinach zmieniałby się między przebiegami.
    """
    known = [s for s in PRIORITY if s in per_source]
    unknown = [s for s in per_source if s not in PRIORITY]
    if unknown:
        # Nowe kino bez wpisu w PRIORITY trafia na koniec - działa, ale bez kontroli nad pierwszeństwem.
        logger.warning("Źródła spoza PRIORITY (trafiają na koniec kolejki): %s", ", ".join(sorted(unknown)))
    order = known + sorted(unknown)

    merged: dict[str, dict] = {}
    for source in order:
        excluded = EXCLUDED_FIELDS.get(source, ())
        for title, data in (per_source.get(source) or {}).items():
            target = merged.setdefault(title, {})
            for field in FIELDS:
                if field in excluded:
                    continue
                col = f"{field}_small"
                # Pierwsze źródło z wartością wygrywa - kolejne już jej nie nadpisują.
                if target.get(col) is None and data.get(field) is not None:
                    target[col] = data[field]
    return merged


def save_small_sources(supabase, per_source: dict) -> int:
    """Zapisuje scalone dane małych kin do kolumn *_small. Zwraca liczbę zaktualizowanych filmów.

    Aktualizujemy PO tytule, bo scrapery małych kin i tak upsertują filmy po nim - nie potrzebujemy
    tu identyfikatorów i unikamy dodatkowego zapytania na film.
    """
    merged = merge_by_priority(per_source)
    if not merged:
        logger.info("Małe kina: brak danych do zapisania.")
        return 0

    updated = 0
    for title, values in merged.items():
        payload = {k: v for k, v in values.items() if v is not None}
        if not payload:
            continue
        try:
            res = supabase.table("movies").update(payload).eq("title", title).execute()
            if res.data:
                updated += 1
        except Exception as e:
            logger.error("Błąd zapisu danych małego kina dla '%s': %s", title, e)

    logger.info("Małe kina: uzupełniono dane %s filmów (źródła: %s).",
                updated, ", ".join(sorted(per_source)))
    return updated

import logging
import asyncio
import aiohttp
import re
import urllib.parse
from html import unescape
from typing import Optional

from utils import parse_release_date


logger = logging.getLogger(__name__)
_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
}

async def _fetch_json(session, url, retries: int = 2):
    """GET JSON z timeoutem i ponowieniami. Zwraca None po wyczerpaniu prób.
    Ponawiamy przy błędach sieci/timeout oraz 429/5xx (chwilowe), nie przy 4xx (trwałe)."""
    for attempt in range(retries + 1):
        try:
            async with session.get(url, headers=_HEADERS, timeout=aiohttp.ClientTimeout(total=10)) as resp:
                if resp.status == 200:
                    return await resp.json()
                if resp.status in (429, 500, 502, 503, 504) and attempt < retries:
                    await asyncio.sleep(0.5 * (attempt + 1))
                    continue
                return None
        except (aiohttp.ClientError, asyncio.TimeoutError):
            if attempt < retries:
                await asyncio.sleep(0.5 * (attempt + 1))
                continue
            return None
    return None

def _extract_filmweb_pl_date(dates_json):
    """Polska data premiery kinowej z /dates (countryPublicReleaseDate, country == PL)."""
    node = (dates_json or {}).get("countryPublicReleaseDate") or {}
    if node.get("country") == "PL" and node.get("dateInt"):
        return parse_release_date(node.get("dateInt"))
    return None

def _fw_poster_url(info_json):
    """Buduje URL plakatu z /info (posterPath ma placeholder '$' na rozmiar; 3 = duży)."""
    path = (info_json or {}).get("posterPath")
    if not path:
        return None
    return f"https://fwcdn.pl/fpo{path.replace('$', '3')}"

def _fw_description(description_json, preview_data):
    """Opis: pełny z /description, a w razie braku krótki z /preview (plot.synopsis)."""
    text = (description_json or {}).get("synopsis") or ((preview_data.get("plot") or {}).get("synopsis"))
    if not text:
        return None
    # Usuwa bbcode Filmwebu ([person=5182]Michael Jordan[/person]), zostawiając tekst w środku.
    text = re.sub(r"\[/?[a-zA-Z]+(?:=[^\]]*)?\]", "", text)
    return unescape(text).strip() or None

def _fw_cast(preview_data):
    """Główna obsada z /preview (mainCast - topowe nazwiska), złączona przecinkiem."""
    cast = [c.get("name") for c in preview_data.get("mainCast", []) if c.get("name")]
    return ", ".join(cast) or None

def _fw_genre(preview_data):
    """Gatunki z /preview (genres - lista {name:{text}}), złączone przecinkiem."""
    genres = [(g.get("name") or {}).get("text") for g in preview_data.get("genres", [])]
    return ", ".join(g for g in genres if g) or None

# Ilu kandydatów sprawdzamy pod kątem roku. Przy tytułach-bliźniakach właściwy jest wysoko,
# a limit chroni przed serią zapytań przy tytułach generycznych.
_YEAR_CHECK_LIMIT = 5

# Rok produkcji i rok polskiej premiery nagminnie różnią się o jeden, a źródła podają różne.
_YEAR_TOLERANCE = 1


async def get_filmweb_movie_id(title: str, year: Optional[int], session: aiohttp.ClientSession):
    query = urllib.parse.quote(title)
    url = f"https://www.filmweb.pl/api/v1/search?query={query}"

    data = await _fetch_json(session, url)
    if data is None:
        logger.warning(f"Błąd/brak odpowiedzi z API Filmwebu dla zapytania: '{title}'")
        return None

    search_hits = data.get("searchHits", [])

    film_hits = [hit for hit in search_hits if hit.get("type") == "film"]

    # Bajki telewizyjne grane w kinach w blokach ("Pucio", "Kicia Kocia") są na Filmwebie SERIALAMI.
    # Bierzemy je dopiero, gdy nie ma żadnego filmu - inaczej podmieniłyby poprawne dopasowanie.
    # Endpointy `/api/v1/film/{id}/*` obsługują też id seriali.
    if not film_hits:
        film_hits = [hit for hit in search_hits if hit.get("type") == "serial"]
        if film_hits:
            logger.info("Filmweb: '%s' istnieje tylko jako serial - biorę id %s.", title, film_hits[0].get("id"))

    if not film_hits:
        logger.debug(f"Nie znaleziono żadnych filmów dla zapytania: '{title}'")
        return None

    # Wyszukiwarka nie zwraca roku przy trafieniach, więc rok kandydata dociągamy z `/preview`.
    # Idziemy po kolei i przerywamy na pierwszym trafionym - zwykle poprawny jest pierwszy wynik,
    # więc kosztuje to jedno dodatkowe żądanie na film zamiast setek na przebieg.
    if year and len(film_hits) > 1:
        for hit in film_hits[:_YEAR_CHECK_LIMIT]:
            hit_id = hit.get("id")
            if not hit_id:
                continue
            preview = await _fetch_json(session, f"https://www.filmweb.pl/api/v1/film/{hit_id}/preview")
            try:
                hit_year = int((preview or {}).get("year"))
            except (TypeError, ValueError):
                continue
            if abs(hit_year - int(year)) <= _YEAR_TOLERANCE:
                logger.debug(f"Dopasowano po roku: '{hit.get('matchedTitle')}' ({hit_year}, szukano {year}) z ID: {hit_id}")
                return hit_id

        # Żaden kandydat nie mieści się w roku - pierwsze trafienie to niemal na pewno INNY film
        # o tym samym tytule (wyszukiwarka sortuje po popularności). Wolimy brak danych niż cudze:
        # ocena Filmwebu wchodzi do rankingu.
        logger.info("Filmweb: brak filmu '%s' z roku ~%s wśród %s kandydatów - pomijam Filmweb dla tego filmu.",
                    title, year, min(len(film_hits), _YEAR_CHECK_LIMIT))
        return None

    # Bez znanego roku nie mamy czym rozstrzygać - bierzemy pierwsze trafienie.
    first_film_id = film_hits[0].get("id")
    first_film_title = film_hits[0].get("matchedTitle")

    logger.debug(f"Znaleziono film: '{first_film_title}' z ID: {first_film_id}")
    return first_film_id

async def get_filmweb_rating_by_id(movie_id: int, session: aiohttp.ClientSession):
    """Sama ocena dla ZNANEGO id - jedno zapytanie zamiast pięciu z get_filmweb_movie_details.

    Zwraca {"rating_filmweb": float|None, "rating_count_filmweb": int|None} albo None przy błędzie.
    """
    rating_json = await _fetch_json(session, f"https://www.filmweb.pl/api/v1/film/{movie_id}/rating")
    if rating_json is None:
        return None
    rate = rating_json.get("rate")
    count = rating_json.get("count")
    # Bez głosów Filmweb zwraca rate=0 - traktujemy jako brak oceny.
    has_votes = isinstance(rate, (int, float)) and rate and count
    return {
        "rating_filmweb": round(rate, 1) if has_votes else None,
        "rating_count_filmweb": count if has_votes else None,
    }


async def get_filmweb_movie_details(movie_id: int, session: aiohttp.ClientSession):
    """Pobiera szczegółowe informacje o filmie na podstawie jego ID."""
    base = f"https://www.filmweb.pl/api/v1/film/{movie_id}"

    # Równolegle: preview (podstawa + obsada), dates (data PL), rating (ocena),
    # description (pełny opis), info (plakat). Każde z ponowieniami; brakujące zwracają None.
    data, dates_json, rating_json, description_json, info_json = await asyncio.gather(
        _fetch_json(session, f"{base}/preview"),
        _fetch_json(session, f"{base}/dates"),
        _fetch_json(session, f"{base}/rating"),
        _fetch_json(session, f"{base}/description"),
        _fetch_json(session, f"{base}/info"),
    )

    if data is None:
        logger.warning(f"Błąd/brak odpowiedzi z Filmwebu dla szczegółów filmu (ID: {movie_id})")
        return None

    directors_list = data.get("directors", [])
    directors = ", ".join([d.get("name") for d in directors_list if d.get("name")])

    # Tytuł z fallbackiem na oryginalny, gdy `title` jest pusty.
    title_obj = data.get("title") or {}
    orig_title_obj = data.get("originalTitle") or {}
    film_title = title_obj.get("title") or orig_title_obj.get("title")

    # Zaokrąglamy jak wyświetla Filmweb. Bez głosów zwraca rate=0 - to brak oceny, nie zero.
    rate = (rating_json or {}).get("rate")
    count = (rating_json or {}).get("count")
    has_votes = isinstance(rate, (int, float)) and rate and count
    rating = round(rate, 1) if has_votes else None
    rating_count = count if has_votes else None

    return {
        "id": movie_id,
        "title": film_title,
        "year": data.get("year"),
        "duration": data.get("duration"),
        "directors": directors,
        "release_date": _extract_filmweb_pl_date(dates_json),
        "rating": rating,
        "rating_count": rating_count,
        "description": _fw_description(description_json, data),
        "cast": _fw_cast(data),
        "genre": _fw_genre(data),
        "poster": _fw_poster_url(info_json),
    }

async def search_movie_details(title: str, year: Optional[int] = None, session: Optional[aiohttp.ClientSession] = None):
    """Funkcja główna: pobiera szczegóły filmu na podstawie tytułu i opcjonalnie roku."""
    if session is None:
        async with aiohttp.ClientSession() as new_session:
            movie_id = await get_filmweb_movie_id(title, year, new_session)
            if movie_id:
                return await get_filmweb_movie_details(movie_id, new_session)
            return None
    else:
        movie_id = await get_filmweb_movie_id(title, year, session)
        if movie_id:
            return await get_filmweb_movie_details(movie_id, session)
        return None
import asyncio
import aiohttp
import urllib.parse
from typing import Optional

from utils import parse_release_date

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

async def get_filmweb_movie_id(title: str, year: Optional[int], session: aiohttp.ClientSession):
    # Kodowanie tytułu do formatu URL (zamiana spacji na %20 itp.)
    query = urllib.parse.quote(title)
    url = f"https://www.filmweb.pl/api/v1/search?query={query}"

    data = await _fetch_json(session, url)
    if data is None:
        print(f"Błąd/brak odpowiedzi z API Filmwebu dla zapytania: '{title}'")
        return None

    search_hits = data.get("searchHits", [])

    # Filtrujemy tylko wyniki, które są filmami
    film_hits = [hit for hit in search_hits if hit.get("type") == "film"]

    if not film_hits:
        print(f"Nie znaleziono żadnych filmów dla zapytania: '{title}'")
        return None

    if year:
        for hit in film_hits:
            hit_year = hit.get("year")
            if hit_year and str(hit_year) == str(year):
                film_id = hit.get("id")
                film_title = hit.get("matchedTitle")
                print(f"Znaleziono dokładne dopasowanie: '{film_title}' ({hit_year}) z ID: {film_id}")
                return film_id
        print(f"Nie znaleziono filmu '{title}' z roku {year}. Próba dopasowania pierwszego wyniku...")

    # Zwracamy ID pierwszego znalezionego filmu (wartość zapasowa / brak roku)
    first_film_id = film_hits[0].get("id")
    first_film_title = film_hits[0].get("matchedTitle")

    print(f"Znaleziono film: '{first_film_title}' z ID: {first_film_id}")
    return first_film_id

async def get_filmweb_movie_details(movie_id: int, session: aiohttp.ClientSession):
    """Pobiera szczegółowe informacje o filmie na podstawie jego ID."""
    url = f"https://www.filmweb.pl/api/v1/film/{movie_id}/preview"
    dates_url = f"https://www.filmweb.pl/api/v1/film/{movie_id}/dates"

    # Równolegle: podstawowe dane (preview) i daty premier (dates), każde z ponowieniami
    data, dates_json = await asyncio.gather(
        _fetch_json(session, url),
        _fetch_json(session, dates_url)
    )

    if data is None:
        print(f"Błąd/brak odpowiedzi z Filmwebu dla szczegółów filmu (ID: {movie_id})")
        return None

    # Reżyserzy to lista obiektów, więc wyciągamy z nich imiona
    directors_list = data.get("directors", [])
    directors = ", ".join([d.get("name") for d in directors_list if d.get("name")])

    # Wyciąganie tytułu - fallback na 'originalTitle', jeśli 'title' nie istnieje lub jest null
    title_obj = data.get("title") or {}
    orig_title_obj = data.get("originalTitle") or {}
    film_title = title_obj.get("title") or orig_title_obj.get("title")

    return {
        "title": film_title,
        "year": data.get("year"),
        "duration": data.get("duration"),
        "directors": directors,
        "release_date": _extract_filmweb_pl_date(dates_json)
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
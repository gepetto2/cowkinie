import logging
import os
import asyncio
import aiohttp
from dotenv import load_dotenv
from typing import Optional

logger = logging.getLogger(__name__)

load_dotenv()

OMDB_API_KEY = os.environ.get("OMDB_API_KEY")
_BASE_URL = "https://www.omdbapi.com/"


def _to_float(value):
    """'8.0' -> 8.0; 'N/A'/puste -> None."""
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _to_int(value):
    """'741,000' -> 741000; 'N/A'/puste -> None."""
    if not value or value == "N/A":
        return None
    try:
        return int(str(value).replace(",", "").strip())
    except ValueError:
        return None


def _rt_percent(ratings: list):
    """Wynik Rotten Tomatoes ('83%') z listy Ratings -> 83 (int)."""
    for r in ratings or []:
        if r.get("Source") == "Rotten Tomatoes":
            return _to_int((r.get("Value") or "").rstrip("%"))
    return None


async def get_omdb_ratings(imdb_id: str, session: aiohttp.ClientSession, retries: int = 2):
    """Pobiera oceny z OMDb po imdb_id (jednoznaczne, bez zgadywania po tytule).
    Zwraca {rating_imdb, rating_count_imdb, rating_rt, rating_metacritic} lub None."""
    if not OMDB_API_KEY:
        logger.warning("Brak OMDB_API_KEY w zmiennych środowiskowych.")
        return None
    if not imdb_id:
        return None

    params = {"i": imdb_id, "apikey": OMDB_API_KEY}
    for attempt in range(retries + 1):
        try:
            async with session.get(_BASE_URL, params=params, timeout=aiohttp.ClientTimeout(total=10)) as resp:
                if resp.status == 200:
                    data = await resp.json()
                    if data.get("Response") != "True":
                        logger.debug(f"OMDb bez wyniku dla {imdb_id}: {data.get('Error')}")
                        return None
                    return {
                        "rating_imdb": _to_float(data.get("imdbRating")),
                        "rating_count_imdb": _to_int(data.get("imdbVotes")),
                        "rating_rt": _rt_percent(data.get("Ratings")),
                        "rating_metacritic": _to_int(data.get("Metascore")),
                        # Do weryfikacji trafienia w movies-debug (porównanie tytułu/roku/czasu)
                        "title_omdb": data.get("Title") or None,
                        "release_year_omdb": _to_int((data.get("Year") or "")[:4]),
                        "length_omdb": _to_int((data.get("Runtime") or "").replace(" min", "")),
                    }
                if resp.status in (429, 500, 502, 503, 504) and attempt < retries:
                    await asyncio.sleep(0.5 * (attempt + 1))
                    continue
                return None
        except (aiohttp.ClientError, asyncio.TimeoutError):
            if attempt < retries:
                await asyncio.sleep(0.5 * (attempt + 1))
                continue
            logger.warning(f"Błąd/timeout OMDb dla {imdb_id}")
            return None
    return None

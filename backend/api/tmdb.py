import logging
import os
import asyncio
import aiohttp
from dotenv import load_dotenv
from typing import Optional

from utils import parse_release_date


logger = logging.getLogger(__name__)

load_dotenv()

TMDB_API_KEY = os.environ.get("TMDB_API_KEY")

async def _fetch_json(session, url, params, retries: int = 2):
    """GET JSON z timeoutem i ponowieniami. Zwraca None po wyczerpaniu prób.
    Ponawiamy przy błędach sieci/timeout oraz przy 429/5xx (chwilowe), nie przy 4xx (trwałe)."""
    for attempt in range(retries + 1):
        try:
            async with session.get(url, params=params, timeout=aiohttp.ClientTimeout(total=15)) as resp:
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

def _extract_pl_release_date(tmdb_movie):
    """Polska data premiery kinowej z /release_dates. Preferencja typu: 3 (Theatrical) > 2 > 1 (Premiere)."""
    results = (tmdb_movie.get("release_dates") or {}).get("results", [])
    pl = next((r for r in results if r.get("iso_3166_1") == "PL"), None)
    if not pl:
        return None
    dates = pl.get("release_dates", [])
    for wanted_type in (3, 2, 1):
        for d in dates:
            if d.get("type") == wanted_type and d.get("release_date"):
                return parse_release_date(d["release_date"])
    # Fallback: pierwsza dostępna data dla PL
    for d in dates:
        if d.get("release_date"):
            return parse_release_date(d["release_date"])
    return None

async def get_tmdb_movie_details(title: str, year: Optional[int] = None, director: Optional[str] = None, original_title: Optional[str] = None, session: Optional[aiohttp.ClientSession] = None):
    """
    Wyszukuje film w bazie TMDB na podstawie tytułu i (opcjonalnie) roku premiery,
    a następnie zwraca jego szczegóły.
    Zwraca słownik z danymi lub None, jeśli filmu nie znaleziono.
    """
    if not TMDB_API_KEY:
        logger.warning("Brak TMDB_API_KEY w zmiennych środowiskowych.")
        return None

    # Używamy przekazanej sesji lub tworzymy własną
    if session is None:
        async with aiohttp.ClientSession() as new_session:
            return await _fetch_and_extract(new_session, title, year, director, original_title)
    else:
        return await _fetch_and_extract(session, title, year, director, original_title)

async def _fetch_and_extract(session: aiohttp.ClientSession, title: str, year: Optional[int], director: Optional[str], original_title: Optional[str] = None):
    search_url = "https://api.themoviedb.org/3/search/movie"
    
    lower_title = title.lower()
    lower_original_title = original_title.lower() if original_title else None
            
    base_params = {
        "api_key": TMDB_API_KEY,
        "language": "pl-PL"
    }

    async def fetch_credits(movie_id: int):
        """Same credits (obsada/ekipa) - lekkie, do sprawdzania reżysera."""
        return await _fetch_json(session, f"https://api.themoviedb.org/3/movie/{movie_id}/credits",
                                 {"api_key": TMDB_API_KEY, "language": "en-US"})

    async def get_movie_details(movie_id: int):
        details_url = f"https://api.themoviedb.org/3/movie/{movie_id}"
        details_params = {"api_key": TMDB_API_KEY, "language": "pl-PL"}

        release_dates_url = f"https://api.themoviedb.org/3/movie/{movie_id}/release_dates"
        release_dates_params = {"api_key": TMDB_API_KEY}

        movie_data, credits_data, release_dates_data = await asyncio.gather(
            _fetch_json(session, details_url, details_params),
            fetch_credits(movie_id),
            _fetch_json(session, release_dates_url, release_dates_params)
        )

        if movie_data:
            movie_data["credits"] = credits_data or {}
            movie_data["release_dates"] = release_dates_data or {}
            return movie_data
        return None

    def extract_directors(tmdb_movie):
        dirs = []
        if tmdb_movie and "credits" in tmdb_movie and "crew" in tmdb_movie["credits"]:
            for crew_member in tmdb_movie["credits"]["crew"]:
                if crew_member.get("job") == "Director":
                    dirs.append(crew_member.get("name"))
        return dirs

    async def check_director_in_results(results_list):
        if not director:
            return None
        director_lower = director.lower()
        for candidate in results_list[:20]:
            # Do sprawdzenia reżysera wystarczą same credits (1 zapytanie zamiast 3).
            credits_data = await fetch_credits(candidate["id"])
            dirs = extract_directors({"credits": credits_data or {}})
            if any(d.lower() in director_lower or director_lower in d.lower() for d in dirs):
                logger.debug(f"[TMDB] Dopasowano film po reżyserze: {', '.join(dirs)}")
                # Pełne dane (details + release_dates) dociągamy dopiero dla trafionego filmu.
                full = await get_movie_details(candidate["id"])
                if full:
                    return _format_tmdb_response(full, extract_directors(full))
        return None

    async def perform_search(query: str, search_year: Optional[int] = None):
        p = base_params.copy()
        p["query"] = query
        if search_year:
            p["year"] = str(search_year)
        json_data = await _fetch_json(session, search_url, p)
        results = (json_data or {}).get("results", [])
        if results:
            year_str = f" (rok: {search_year})" if search_year else " (bez roku)"
            logger.debug(f"[TMDB] Znaleziono wyniki dla zapytania: '{query}'{year_str}")
        return results

    search_strategies = [
        {"query": title, "year": year},
    ]
    if original_title and original_title.strip() and original_title != title:
        search_strategies.append({"query": original_title, "year": year})
        
    if year is not None:
        search_strategies.append({"query": title, "year": None})
        
        if original_title and original_title.strip() and original_title != title:
            search_strategies.append({"query": original_title, "year": None})
        
    all_results = []
    
    for strategy in search_strategies:
        results = await perform_search(strategy["query"], strategy["year"])
        if results:
            all_results.extend(results)
            if director:
                match = await check_director_in_results(results)
                if match:
                    return match

    if not all_results:
        return None

    # Usuwamy duplikaty, zachowując kolejność
    unique_results = []
    seen_ids = set()
    for res in all_results:
        if res["id"] not in seen_ids:
            unique_results.append(res)
            seen_ids.add(res["id"])

    best_match = None
    for result in unique_results:
        res_title = result.get("title", "").lower()
        res_orig = result.get("original_title", "").lower()
        if res_title == lower_title or res_orig == lower_title or (lower_original_title and (res_title == lower_original_title or res_orig == lower_original_title)):
            best_match = result
            break
            
    if not best_match:
        best_match = unique_results[0]
        
    tmdb_movie = await get_movie_details(best_match["id"])
    if not tmdb_movie:
        return None
        
    dirs = extract_directors(tmdb_movie)
    return _format_tmdb_response(tmdb_movie, dirs)

def _format_tmdb_response(tmdb_movie, dirs):
    release_date = tmdb_movie.get("release_date", "")
    release_year = int(release_date[:4]) if release_date else None
    director_str = ", ".join(dirs) if dirs else None
    
    runtime = tmdb_movie.get("runtime")
    return {
        "tmdb_id": tmdb_movie.get("id"),
        "title": tmdb_movie.get("title"),
        "original_title": tmdb_movie.get("original_title"),
        "release_year": release_year,
        "release_date": release_date if release_date else None,
        "release_date_pl": _extract_pl_release_date(tmdb_movie),
        "length": runtime if runtime and runtime > 0 else None,
        "director": director_str,
        "poster_path": tmdb_movie.get("poster_path"),
        "overview": tmdb_movie.get("overview")
    }

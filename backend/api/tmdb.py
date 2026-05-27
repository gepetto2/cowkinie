import os
import asyncio
import aiohttp
from dotenv import load_dotenv
from typing import Optional

load_dotenv()

TMDB_API_KEY = os.environ.get("TMDB_API_KEY")

async def get_tmdb_movie_details(title: str, year: Optional[int] = None, director: Optional[str] = None, original_title: Optional[str] = None, session: Optional[aiohttp.ClientSession] = None):
    """
    Wyszukuje film w bazie TMDB na podstawie tytułu i (opcjonalnie) roku premiery,
    a następnie zwraca jego szczegóły.
    Zwraca słownik z danymi lub None, jeśli filmu nie znaleziono.
    """
    if not TMDB_API_KEY:
        print("Brak TMDB_API_KEY w zmiennych środowiskowych.")
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

    async def get_movie_details(movie_id: int):
        details_url = f"https://api.themoviedb.org/3/movie/{movie_id}"
        details_params = {"api_key": TMDB_API_KEY, "language": "pl-PL"}
        
        credits_url = f"https://api.themoviedb.org/3/movie/{movie_id}/credits"
        credits_params = {"api_key": TMDB_API_KEY, "language": "en-US"}

        async def fetch(url, params):
            async with session.get(url, params=params) as resp:
                if resp.status == 200:
                    return await resp.json()
                return None

        movie_data, credits_data = await asyncio.gather(
            fetch(details_url, details_params),
            fetch(credits_url, credits_params)
        )

        if movie_data:
            movie_data["credits"] = credits_data or {}
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
            tmdb_movie = await get_movie_details(candidate["id"])
            if not tmdb_movie:
                continue
            dirs = extract_directors(tmdb_movie)
            if any(d.lower() in director_lower or director_lower in d.lower() for d in dirs):
                print(f"  [TMDB] Dopasowano film po reżyserze: {', '.join(dirs)}")
                return _format_tmdb_response(tmdb_movie, dirs)
        return None

    async def perform_search(query: str, search_year: Optional[int] = None):
        p = base_params.copy()
        p["query"] = query
        if search_year:
            p["year"] = str(search_year)
        async with session.get(search_url, params=p) as response:
            if response.status == 200:
                json_data = await response.json()
                results = json_data.get("results", [])
                if results:
                    year_str = f" (rok: {search_year})" if search_year else " (bez roku)"
                    print(f"  [TMDB] Znaleziono wyniki dla zapytania: '{query}'{year_str}")
                return results
            return []

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
        "length": runtime if runtime and runtime > 0 else None,
        "director": director_str,
        "poster_path": tmdb_movie.get("poster_path"),
        "overview": tmdb_movie.get("overview")
    }

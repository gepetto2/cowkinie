import os
import asyncio
import aiohttp
from dotenv import load_dotenv
from typing import Optional

load_dotenv()

TMDB_API_KEY = os.environ.get("TMDB_API_KEY")

async def get_tmdb_movie_details(title: str, year: Optional[int] = None, director: Optional[str] = None, session: Optional[aiohttp.ClientSession] = None):
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
            return await _fetch_and_extract(new_session, title, year, director)
    else:
        return await _fetch_and_extract(session, title, year, director)

async def _fetch_and_extract(session: aiohttp.ClientSession, title: str, year: Optional[int], director: Optional[str]):
    search_url = "https://api.themoviedb.org/3/search/movie"
    
    lower_title = title.lower()
            
    params = {
        "api_key": TMDB_API_KEY,
        "query": title,
        "language": "pl-PL"
    }

    async def get_movie_details(movie_id: int):
        details_url = f"https://api.themoviedb.org/3/movie/{movie_id}"
        details_params = {
            "api_key": TMDB_API_KEY,
            "language": "pl-PL",
            "append_to_response": "credits"
        }
        async with session.get(details_url, params=details_params) as resp:
            if resp.status == 200:
                return await resp.json()
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
        for candidate in results_list[:5]:
            tmdb_movie = await get_movie_details(candidate["id"])
            if not tmdb_movie:
                continue
            dirs = extract_directors(tmdb_movie)
            if any(d.lower() in director_lower or director_lower in d.lower() for d in dirs):
                print(f"  [TMDB] Dopasowano film po reżyserze: {', '.join(dirs)}")
                return _format_tmdb_response(tmdb_movie, dirs)
        return None

    # KROK 1: Wyszukiwanie z rokiem (używając parametru 'year' zamiast 'primary_release_year')
    results_with_year = []
    if year:
        params_year = params.copy()
        params_year["year"] = str(year)
        async with session.get(search_url, params=params_year) as response:
            if response.status == 200:
                json_data = await response.json()
                results_with_year = json_data.get("results", [])
                if results_with_year:
                    print(f"  [TMDB] Znaleziono wyniki dla zapytania: '{title}' ({year})")

    # KROK 2: Sprawdzenie reżysera w wynikach z rokiem
    match = None
    if results_with_year and director:
        match = await check_director_in_results(results_with_year)

    # KROK 3: Jeśli nie ma dopasowania, szukamy bez roku
    results_without_year = []
    if not match:
        async with session.get(search_url, params=params) as response:
            if response.status == 200:
                json_data = await response.json()
                results_without_year = json_data.get("results", [])
                if results_without_year:
                    print(f"  [TMDB] Znaleziono wyniki dla zapytania: '{title}' (bez roku)")
        
        if results_without_year and director:
            match = await check_director_in_results(results_without_year)

    if match:
        return match

    # KROK 4: Fallback (zapasowe dopasowanie)
    final_results = results_with_year if results_with_year else results_without_year
    if not final_results:
        return None

    best_match = None
    for result in final_results:
        res_title = result.get("title", "").lower()
        res_orig = result.get("original_title", "").lower()
        if res_title == lower_title or res_orig == lower_title:
            best_match = result
            break
            
    if not best_match:
        best_match = final_results[0]
        
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
        "release_year": release_year,
        "length": runtime if runtime and runtime > 0 else None,
        "director": director_str,
        "poster_path": tmdb_movie.get("poster_path"),
        "overview": tmdb_movie.get("overview")
    }

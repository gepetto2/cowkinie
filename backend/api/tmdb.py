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
        # `videos` doczepiamy do istniejącego zapytania - zero dodatkowych żądań. `include_video_language`
        # jest konieczne: samo language=pl-PL zawęża wideo do polskich i dla większości filmów daje zero.
        details_params = {
            "api_key": TMDB_API_KEY,
            "language": "pl-PL",
            "append_to_response": "videos",
            "include_video_language": "pl,en",
        }

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
        matched = []
        for candidate in results_list[:20]:
            # Do sprawdzenia reżysera wystarczą same credits (1 zapytanie zamiast 3).
            credits_data = await fetch_credits(candidate["id"])
            dirs = extract_directors({"credits": credits_data or {}})
            if any(d.lower() in director_lower or director_lower in d.lower() for d in dirs):
                matched.append(candidate)
        if not matched:
            return None
        # Wśród filmów tego samego reżysera bierzemy NAJPOPULARNIEJSZY (vote_count), a nie pierwszy z listy.
        # Odsiewa to dodatki/krótkie metraże twórcy, które TMDB czasem stawia wyżej niż właściwy film
        # (np. 'WALL·E's Treasures & Trinkets' [5 głosów] zamiast filmu WALL·E [20 tys. głosów]).
        best = max(matched, key=lambda c: c.get("vote_count") or 0)
        logger.debug(f"[TMDB] Dopasowano po reżyserze (najwięcej głosów): {best.get('title')} (id {best.get('id')})")
        # Pełne dane (details + release_dates) dociągamy dopiero dla trafionego filmu.
        full = await get_movie_details(best["id"])
        if full:
            return _format_tmdb_response(full, extract_directors(full))
        return None

    async def directed_films(person_id: int):
        """Filmy wyreżyserowane przez daną osobę, z tytułami PO POLSKU I PO ANGIELSKU.

        Pobieramy filmografię w obu językach, bo tytuł od kina bywa raz polski ('Amelia'), a raz
        angielski ('Breathless' przy filmie, który TMDB prowadzi jako 'Do utraty tchu' /
        'À bout de souffle'). Scalamy je po id filmu w jeden zestaw tytułów do porównania.
        """
        pl_data, en_data = await asyncio.gather(
            _fetch_json(session, f"https://api.themoviedb.org/3/person/{person_id}/movie_credits",
                        {"api_key": TMDB_API_KEY, "language": "pl-PL"}),
            _fetch_json(session, f"https://api.themoviedb.org/3/person/{person_id}/movie_credits",
                        {"api_key": TMDB_API_KEY, "language": "en-US"}),
        )
        films = {}
        for data in (pl_data, en_data):
            for c in (data or {}).get("crew", []):
                if c.get("job") != "Director":
                    continue
                entry = films.setdefault(c["id"], {"id": c["id"], "titles": set(), "film": c})
                for key in ("title", "original_title"):
                    if c.get(key):
                        entry["titles"].add(c[key].strip().lower())
        return list(films.values())

    async def match_by_director_filmography():
        """Ostatnia deska ratunku: szukamy filmu w FILMOGRAFII reżysera, a nie po tytule.

        Po co: `search/movie` dopasowuje tytuł oryginalny i `alternative_titles`, ale NIE `translations`,
        więc film o polskim tytule innym niż oryginalny bywa nieosiągalny przez wyszukiwarkę - mimo że
        TMDB ten polski tytuł zna. Sprawdzone: Amélie ma w TMDB (id 194) tłumaczenie PL dokładnie
        'Amelia' i 12,5 tys. głosów, a mimo to NIE MA jej wśród 20 wyników zapytania 'Amelia' -
        wygrywał tam biograficzny 'Amelia' o Amelii Earhart (263 głosy). Tak samo 'Flow' (oryginał
        'Straume'). W takim układzie dopasowanie po reżyserze wyżej nie ma czego potwierdzić, bo
        właściwego filmu w ogóle nie ma na liście.
        `person/{id}/movie_credits` zwraca natomiast tytuły w żądanym języku, więc tam film znajdujemy.

        Wywoływane TYLKO gdy zwykłe wyszukiwanie nie potwierdziło reżysera - to dwa dodatkowe zapytania
        na ścieżce awaryjnej, nie w każdym przebiegu.
        """
        # Przy duetach ('Bartosz Szpak, Helena Ganjalyan') szukamy po pierwszym nazwisku - wyszukiwarka
        # osób nie zna takich par, a do odnalezienia wspólnego filmu wystarczy jedno z nazwisk.
        name = director.split(",")[0].strip()
        if not name:
            return None
        people = await _fetch_json(session, "https://api.themoviedb.org/3/search/person",
                                   {"api_key": TMDB_API_KEY, "query": name})
        results_people = (people or {}).get("results", [])[:2]  # imiennicy zdarzają się rzadko
        if not results_people:
            return None

        candidates = []
        for person in results_people:
            candidates.extend(await directed_films(person["id"]))
        if not candidates:
            return None

        wanted = {t for t in (lower_title, lower_original_title) if t}
        by_title = [c for c in candidates if c["titles"] & wanted]
        # Rok bierzemy pod uwagę dopiero, gdy tytuł niczego nie rozstrzygnął (np. angielski tytuł
        # od kina przy filmie prowadzonym w TMDB pod tytułem francuskim i polskim).
        matched = by_title or ([c for c in candidates
                                if year and (c["film"].get("release_date") or "")[:4] == str(year)]
                               if year else [])
        if not matched:
            return None

        best = max(matched, key=lambda c: c["film"].get("vote_count") or 0)
        full = await get_movie_details(best["id"])
        if not full:
            return None
        logger.info(
            f"[TMDB] '{title}': wyszukiwarka nie znalazła filmu tego reżysera - dopasowano przez "
            f"filmografię {name}: '{full.get('title')}' (id {full.get('id')}, "
            f"{(full.get('release_date') or '')[:4]}, {full.get('vote_count')} głosów)."
        )
        return _format_tmdb_response(full, extract_directors(full))

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

    # Doszliśmy tutaj, więc ŻADEN wynik wyszukiwania nie potwierdził reżysera podanego przez kino.
    # Zanim spadniemy do wyboru "najpopularniejszego dokładnego trafienia" (który przy tytułach-
    # bliźniakach potrafi wskazać zupełnie inny film), próbujemy przejść od strony reżysera.
    if director:
        match = await match_by_director_filmography()
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

    # Spośród DOKŁADNYCH trafień tytułu bierzemy ten z największą liczbą głosów, a nie pierwszy
    # z listy. Kolejność TMDB bywa myląca: dla "Oldboy" stawia na czele remake z 2013 (2 tys. głosów)
    # przed oryginałem z 2003 (10 tys. głosów), przez co film dostawał reżysera i tmdb_id nie tego
    # tytułu, co opis z Filmwebu. Ta sama zasada obowiązuje już przy dopasowaniu po reżyserze wyżej.
    #
    # Ryzyko pomyłki w drugą stronę (nowy film o tytule starego klasyka) jest ograniczone: filmy
    # z sieciówek mają rok z API kina, więc `perform_search` zawęża wyniki do właściwego rocznika,
    # a bez roku szukamy głównie repertuaru kin studyjnych, czyli klasyków i wznowień.
    exact = [
        r for r in unique_results
        if (r.get("title", "").lower() in (lower_title, lower_original_title)
            or r.get("original_title", "").lower() in (lower_title, lower_original_title))
    ]
    if exact:
        best_match = max(exact, key=lambda c: c.get("vote_count") or 0)
        if best_match is not exact[0]:
            logger.debug(
                f"[TMDB] '{title}': wybrano '{best_match.get('title')}' "
                f"({(best_match.get('release_date') or '')[:4]}, {best_match.get('vote_count')} głosów) "
                f"zamiast pierwszego '{exact[0].get('title')}' ({(exact[0].get('release_date') or '')[:4]})"
            )
    else:
        best_match = unique_results[0]
        
    tmdb_movie = await get_movie_details(best_match["id"])
    if not tmdb_movie:
        return None
        
    dirs = extract_directors(tmdb_movie)
    return _format_tmdb_response(tmdb_movie, dirs)

async def get_tmdb_ratings_by_id(tmdb_id: int, session: aiohttp.ClientSession):
    """Same oceny z TMDB dla ZNANEGO id - bez wyszukiwania po tytule.

    Odświeżanie musi iść po id, a nie przez `get_tmdb_movie_details`: powtórne wyszukiwanie po tytule
    mogłoby dopasować film do INNEJ pozycji (np. remake'u albo tytułu-bliźniaka) i po cichu podmienić
    dane już poprawnie dopasowanego rekordu. Przy okazji to jedno zapytanie zamiast dwóch.

    Zwraca {"rating_tmdb": float|None, "rating_count_tmdb": int|None} albo None, gdy nie udało się pobrać.
    """
    data = await _fetch_json(session, f"https://api.themoviedb.org/3/movie/{tmdb_id}",
                             {"api_key": TMDB_API_KEY, "language": "pl-PL"})
    if not data:
        return None
    vote_avg = data.get("vote_average")
    vote_count = data.get("vote_count") or 0
    # Bez głosów TMDB zwraca 0 - traktujemy jako brak oceny (spójnie z _format_tmdb_response).
    rating = round(vote_avg, 1) if isinstance(vote_avg, (int, float)) and vote_avg and vote_count > 0 else None
    return {"rating_tmdb": rating, "rating_count_tmdb": vote_count if rating is not None else None}


def _extract_trailer(tmdb_movie):
    """ID zwiastuna z YouTube albo None. TMDB zwraca po kilkadziesiąt wideo na film (klipy, materiały
    zza kulis, wywiady), więc bierzemy tylko zwiastuny i preferujemy: polski > oficjalny > Trailer."""
    videos = ((tmdb_movie or {}).get("videos") or {}).get("results") or []
    cand = [v for v in videos if v.get("site") == "YouTube" and v.get("type") in ("Trailer", "Teaser")]
    if not cand:
        return None
    cand.sort(key=lambda v: (v.get("iso_639_1") != "pl", not v.get("official"), v.get("type") != "Trailer"))
    return cand[0].get("key") or None


def _extract_cast(tmdb_movie, limit=8):
    """Główna obsada z TMDB credits, uporządkowana wg 'order' (billing), złączona przecinkiem.
    Nazwiska aktorów są niezależne od języka (credits pobieramy w en-US)."""
    cast = ((tmdb_movie or {}).get("credits") or {}).get("cast") or []
    cast = sorted(cast, key=lambda c: c.get("order") if c.get("order") is not None else 999)
    actor_names = [c.get("name") for c in cast[:limit] if c.get("name")]
    return ", ".join(actor_names) or None

def _format_tmdb_response(tmdb_movie, dirs):
    release_date = tmdb_movie.get("release_date", "")
    release_year = int(release_date[:4]) if release_date else None
    director_str = ", ".join(dirs) if dirs else None
    
    runtime = tmdb_movie.get("runtime")

    # Ocena TMDB (0-10). Bez głosów TMDB zwraca 0 - traktujemy jako brak oceny.
    vote_avg = tmdb_movie.get("vote_average")
    vote_count = tmdb_movie.get("vote_count") or 0
    tmdb_rating = round(vote_avg, 1) if isinstance(vote_avg, (int, float)) and vote_avg and vote_count > 0 else None

    return {
        "tmdb_id": tmdb_movie.get("id"),
        "imdb_id": tmdb_movie.get("imdb_id"),
        "title": tmdb_movie.get("title"),
        "original_title": tmdb_movie.get("original_title"),
        "release_year": release_year,
        "release_date": release_date if release_date else None,
        "release_date_pl": _extract_pl_release_date(tmdb_movie),
        "length": runtime if runtime and runtime > 0 else None,
        "director": director_str,
        "cast": _extract_cast(tmdb_movie),
        "trailer": _extract_trailer(tmdb_movie),
        "poster_path": tmdb_movie.get("poster_path"),
        "overview": tmdb_movie.get("overview"),
        "rating": tmdb_rating,
        "rating_count": vote_count if tmdb_rating is not None else None
    }

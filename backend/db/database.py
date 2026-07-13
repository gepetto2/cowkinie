import re
import unicodedata

def upsert_cinema(supabase, name: str, city: str, franchise: str) -> str:
    """Dodaje lub aktualizuje kino w bazie danych i zwraca jego ID."""
    cinema_res = supabase.table("cinemas").upsert(
        {"name": name, "city": city, "franchise": franchise},
        on_conflict="name,franchise"
    ).execute()
    return cinema_res.data[0]["id"]

def upsert_movies_batch(supabase, movies_to_upsert: dict) -> dict:
    """
    Upsertuje słownik z filmami i aktualizuje cache filmów o nowe ID z bazy.
    Zwraca zaktualizowany cache: {title: movie_id}
    """
    if not movies_to_upsert:
        return {}
        
    movie_res = supabase.table("movies").upsert(
        list(movies_to_upsert.values()),
        on_conflict="title"
    ).execute()
    
    return {m["title"]: m["id"] for m in movie_res.data}

def upsert_screenings_chunked(supabase, screenings_dict: dict, cinema_name: str, chunk_size: int = 1000):
    """Zapisuje seanse do bazy danych z uwzględnieniem paginacji."""
    if not screenings_dict:
        return
        
    screenings_list = list(screenings_dict.values())
    for i in range(0, len(screenings_list), chunk_size):
        supabase.table("screenings").upsert(
            screenings_list[i:i+chunk_size],
            on_conflict="movie_id,cinema_id,start_time,room_name",
            ignore_duplicates=True
        ).execute()
    print(f"Zapisano {len(screenings_list)} seansów do bazy dla kina {cinema_name}.")

def consolidate_movie_data(supabase):
    """Wypełnia główne kolumny release_year, movie_type, director, original_title i poster na podstawie danych z poszczególnych źródeł."""
    print("\nKonsolidacja danych o filmach (release_year, movie_type, director, original_title, poster)...")
    
    # Pobieramy filmy, które nie mają jeszcze głównego release_year, movie_type, director, original_title lub poster
    response = supabase.table("movies").select(
        "id, title, release_year, movie_type, director, original_title, poster, "
        "release_year_cc, release_year_multikino, release_year_helios, "
        "movie_type_cc, movie_type_multikino, movie_type_helios, "
        "director_multikino, director_helios, director_cc, "
        "original_title_cc, original_title_helios, "
        "poster_cc, poster_multikino, poster_helios"
    ).or_("release_year.is.null,movie_type.is.null,director.is.null,original_title.is.null,poster.is.null").execute()
    movies = response.data
    
    if not movies:
        print("Wszystkie filmy mają już określony release_year, movie_type, director, original_title oraz poster.")
        return
        
    updated_count = 0
    for movie in movies:
        update_data = {}
        
        if movie.get("release_year") is None:
            years = [movie.get("release_year_multikino"), movie.get("release_year_cc"), movie.get("release_year_helios")]
            valid_years = [y for y in years if y is not None]

            if valid_years:
                # Wybieramy najstarszy zeskrapowany rok
                update_data["release_year"] = min(valid_years)

        if movie.get("movie_type") is None:
            types = [movie.get("movie_type_multikino"), movie.get("movie_type_cc"), movie.get("movie_type_helios")]
            valid_types = [t for t in types if t] # Pobieramy tylko niepuste stringi
            
            if valid_types:
                unique_types = list(set(valid_types))
                if len(unique_types) > 1:
                    print(f"  Uwaga: Niezgodność typów dla filmu '{movie.get('title')}': {unique_types}")
                
                # Wybieramy pierwszą z brzegu niepustą wartość
                update_data["movie_type"] = valid_types[0]
                
        if movie.get("director") is None:
            directors = [
                movie.get("director_multikino"),
                movie.get("director_helios"),
                movie.get("director_cc")
            ]
            valid_directors = [d for d in directors if d]
            
            if valid_directors:
                unique_directors = list({d.lower(): d for d in valid_directors}.values())
                if len(unique_directors) > 1:
                    longest_director_lower = max(unique_directors, key=len).lower()
                    if not all(d.lower() in longest_director_lower for d in unique_directors):
                        print(f"  Uwaga: Niezgodność reżyserów dla filmu '{movie.get('title')}': {unique_directors}")
                
                # Wybieramy najdłuższą z dostępnych wartości
                update_data["director"] = max(valid_directors, key=len)
                
        if movie.get("original_title") is None:
            original_titles = [
                movie.get("original_title_helios"),
                movie.get("original_title_cc")
            ]
            valid_titles = [t for t in original_titles if t]
            
            if valid_titles:
                unique_titles = list(set(valid_titles))
                if len(unique_titles) > 1:
                    print(f"  Uwaga: Niezgodność oryginalnych tytułów dla filmu '{movie.get('title')}': {unique_titles}")
                
                # Preferujemy tytuł z Heliosa, w drugiej kolejności z Cinema City
                update_data["original_title"] = movie.get("original_title_helios") or movie.get("original_title_cc")
                
        if movie.get("poster") is None:
            posters = [
                movie.get("poster_cc"),
                movie.get("poster_helios"),
                movie.get("poster_multikino")
            ]
            valid_posters = [p for p in posters if p]
            
            if valid_posters:
                update_data["poster"] = valid_posters[0]

        if update_data:
            supabase.table("movies").update(update_data).eq("id", movie["id"]).execute()
            updated_count += 1

    print(f"Zaktualizowano dane dla {updated_count} filmów.")

def consolidate_release_dates(supabase):
    """Ustala główną release_date jako najwcześniejszą (min) datę ze WSZYSTKICH źródeł, łącznie z TMDB/Filmweb.
    Uruchamiane PO wzbogaceniu (enrich), gdy release_date_tmdb/release_date_filmweb są już pobrane -
    dzięki temu daty z baz zewnętrznych realnie wpływają na wynik (a nie tylko daty kinowe)."""
    print("\nKonsolidacja dat premiery (min ze wszystkich źródeł, łącznie z TMDB/Filmweb)...")

    response = supabase.table("movies").select(
        "id, title, release_date_cc, release_date_multikino, release_date_helios, "
        "release_date_tmdb, release_date_filmweb"
    ).is_("release_date", "null").execute()
    movies = response.data

    if not movies:
        print("Wszystkie filmy mają już ustaloną datę premiery.")
        return

    updated_count = 0
    for movie in movies:
        # Stringi ISO 'YYYY-MM-DD' porównują się chronologicznie leksykograficznie
        dates = [
            movie.get("release_date_multikino"),
            movie.get("release_date_cc"),
            movie.get("release_date_helios"),
            movie.get("release_date_tmdb"),
            movie.get("release_date_filmweb"),
        ]
        valid_dates = [d for d in dates if d]
        if valid_dates:
            supabase.table("movies").update({"release_date": min(valid_dates)}).eq("id", movie["id"]).execute()
            updated_count += 1

    print(f"Ustalono datę premiery dla {updated_count} filmów.")

def _normalize_title_key(title: str) -> str:
    """Klucz porównawczy tytułu: bez diakrytyków, bez wielkości liter, ze zbitymi spacjami.
    'André Rieu' i 'Andre Rieu' dają ten sam klucz. 'ł' nie ma dekompozycji NFKD - mapujemy ręcznie."""
    if not title:
        return ""
    s = unicodedata.normalize("NFKD", title)
    s = "".join(c for c in s if not unicodedata.combining(c))
    s = s.replace("ł", "l").replace("Ł", "L")
    return re.sub(r"\s+", " ", s).strip().lower()

def _accent_score(title: str) -> int:
    """Miara 'bogactwa' pisowni - liczba znaków spoza ASCII (im więcej diakrytyków, tym lepszy tytuł)."""
    return sum(1 for c in (title or "") if ord(c) > 127)

def dedupe_by_normalized_title(supabase):
    """Łączy filmy różniące się tylko diakrytykami/wielkością liter/spacjami w tytule
    (np. 'Andre Rieu' vs 'André Rieu'). Zostawia rekord z najbogatszą pisownią, przepina do niego
    seanse, przenosi brakujące dane, resztę kasuje. Uruchamiane po scrapie, przed konsolidacją."""
    print("\nDeduplikacja filmów po znormalizowanym tytule (diakrytyki/wielkość liter)...")

    movies = supabase.table("movies").select("*").execute().data or []

    groups = {}
    for m in movies:
        key = _normalize_title_key(m.get("title"))
        if key:
            groups.setdefault(key, []).append(m)

    merged_count = 0
    for group in groups.values():
        if len(group) < 2:
            continue

        # Ocalały: najwięcej diakrytyków, potem najdłuższy, potem stabilnie po id
        survivor = max(group, key=lambda m: (_accent_score(m.get("title")), len(m.get("title") or ""), str(m.get("id"))))
        dups = [m for m in group if m["id"] != survivor["id"]]

        print(f"  Scalanie {len(group)} wariantów -> '{survivor.get('title')}': {[m.get('title') for m in group]}")

        update_payload = {}
        for dup in dups:
            try:
                # Niepuste wartości z duplikatu w puste miejsca ocalałego (tytułu nie ruszamy)
                for k, v in dup.items():
                    if k in ("id", "created_at", "title"):
                        continue
                    if survivor.get(k) is None and update_payload.get(k) is None and v is not None:
                        update_payload[k] = v
                # Przepięcie seansów, potem usunięcie duplikatu
                supabase.table("screenings").update({"movie_id": survivor["id"]}).eq("movie_id", dup["id"]).execute()
                supabase.table("movies").delete().eq("id", dup["id"]).execute()
                merged_count += 1
            except Exception as e:
                print(f"    Błąd przy scalaniu '{dup.get('title')}' -> '{survivor.get('title')}': {e}")

        if update_payload:
            supabase.table("movies").update(update_payload).eq("id", survivor["id"]).execute()

    print(f"Zdeduplikowano {merged_count} rekordów.")

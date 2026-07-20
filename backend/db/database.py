import logging
import re
import unicodedata
from datetime import datetime, time
from zoneinfo import ZoneInfo


logger = logging.getLogger(__name__)

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

def load_existing_movies(supabase, columns: list) -> dict:
    """Zwraca {title: wiersz} dla filmów już w bazie - pozwala pominąć kosztowne sub-fetche
    (plakaty/szczegóły) przy scrapie bez czyszczenia. `columns` to dodatkowe kolumny (title dołączany zawsze).
    Uwaga: przy >1000 filmach trzeba by paginować (obecnie ~130, mieści się w limicie)."""
    select = "title," + ",".join(columns)
    rows = supabase.table("movies").select(select).execute().data or []
    return {r["title"]: r for r in rows}

def upsert_screenings_chunked(supabase, screenings_dict: dict, cinema_name: str, chunk_size: int = 1000):
    """ZASTĘPUJE komplet seansów danego kina świeżym zestawem (usuwa stare, wstawia nowe).
    Dzięki temu scrapowanie działa poprawnie BEZ czyszczenia bazy: znikają seanse odwołane/przeszłe,
    a availability_ratio/format istniejących seansów się odświeżają. Scraper podaje pełny bieżący repertuar kina."""
    if not screenings_dict:
        return

    screenings_list = list(screenings_dict.values())
    cinema_id = screenings_list[0]["cinema_id"]

    # Usuwamy dotychczasowe seanse tego kina, potem wstawiamy świeży komplet (brak konfliktów -> zwykły insert).
    supabase.table("screenings").delete().eq("cinema_id", cinema_id).execute()
    for i in range(0, len(screenings_list), chunk_size):
        supabase.table("screenings").insert(screenings_list[i:i+chunk_size]).execute()
    logger.info(f"Zastąpiono {len(screenings_list)} seansów w bazie dla kina {cinema_name}.")

def consolidate_movie_data(supabase):
    """Przed enrich: wypełnia TYLKO pola używane jako wejście do wyszukiwania w TMDB/Filmweb
    (release_year, movie_type, director, original_title). Reszta (poster, genre, release_date, length)
    konsolidowana jest po enrich w consolidate_post_enrich - dzięki temu może korzystać z danych z API."""
    logger.info("Konsolidacja danych do wyszukiwania (release_year, movie_type, director, original_title)...")

    # Źródła per pole (kolejność = priorytet tam, gdzie bierzemy pierwszą niepustą wartość).
    cinemas = ("multikino", "cc", "helios", "muza")
    ot_sources = ("helios", "muza")  # original_title: bez Multikina, priorytet Helios -> CC -> Muza

    # Pobieramy filmy, które nie mają jeszcze głównego release_year, movie_type, director lub original_title
    select_cols = ["id", "title", "release_year", "movie_type", "director", "original_title"]
    select_cols += [f"release_year_{s}" for s in cinemas]
    select_cols += [f"movie_type_{s}" for s in cinemas]
    select_cols += [f"director_{s}" for s in cinemas]
    select_cols += [f"original_title_{s}" for s in ot_sources]
    response = supabase.table("movies").select(", ".join(select_cols)).or_(
        "release_year.is.null,movie_type.is.null,director.is.null,original_title.is.null"
    ).execute()
    movies = response.data

    if not movies:
        logger.info("Wszystkie filmy mają już określony release_year, movie_type, director oraz original_title.")
        return

    updated_count = 0
    for movie in movies:
        update_data = {}

        if movie.get("release_year") is None:
            valid_years = [y for y in (movie.get(f"release_year_{s}") for s in cinemas) if y is not None]
            if valid_years:
                # Wybieramy najstarszy zeskrapowany rok
                update_data["release_year"] = min(valid_years)

        if movie.get("movie_type") is None:
            valid_types = [t for t in (movie.get(f"movie_type_{s}") for s in cinemas) if t]
            if valid_types:
                unique_types = list(set(valid_types))
                if len(unique_types) > 1:
                    logger.warning(f"Niezgodność typów dla filmu '{movie.get('title')}': {unique_types}")
                # Wybieramy pierwszą z brzegu niepustą wartość
                update_data["movie_type"] = valid_types[0]

        if movie.get("director") is None:
            valid_directors = [d for d in (movie.get(f"director_{s}") for s in cinemas) if d]
            if valid_directors:
                unique_directors = list({d.lower(): d for d in valid_directors}.values())
                if len(unique_directors) > 1:
                    longest_director_lower = max(unique_directors, key=len).lower()
                    if not all(d.lower() in longest_director_lower for d in unique_directors):
                        logger.warning(f"Niezgodność reżyserów dla filmu '{movie.get('title')}': {unique_directors}")
                # Wybieramy najdłuższą z dostępnych wartości
                update_data["director"] = max(valid_directors, key=len)

        if movie.get("original_title") is None:
            valid_titles = [t for t in (movie.get(f"original_title_{s}") for s in ot_sources) if t]
            if valid_titles:
                if len(set(valid_titles)) > 1:
                    logger.warning(f"Niezgodność oryginalnych tytułów dla filmu '{movie.get('title')}': {list(set(valid_titles))}")
                # ot_sources jest już w kolejności priorytetu (Helios -> CC -> Muza)
                update_data["original_title"] = valid_titles[0]

        if update_data:
            supabase.table("movies").update(update_data).eq("id", movie["id"]).execute()
            updated_count += 1

    logger.info(f"Zaktualizowano dane dla {updated_count} filmów.")

def consolidate_post_enrich(supabase):
    """Po enrich: konsoliduje pola, które NIE są potrzebne do wyszukiwania w API, więc korzystają
    już z danych TMDB/Filmweb - release_date, release_year (finalny), length, poster, genre.
    Korekta roku jest kluczowa dla wznowień: kina podają rok WZNOWIENIA, a TMDB/Filmweb rok produkcji.
    Czas trwania bierzemy w priorytecie TMDB -> Filmweb -> kina (kanoniczny czas filmu; kina bywają z reklamami).
    Plakat preferuje lokalne (PL) plakaty z kin, a TMDB jest ostatecznym fallbackiem."""
    logger.info("Konsolidacja po enrich (release_date, release_year, length, poster, genre)...")

    # Źródła per pole. Kolejność = priorytet dla length i poster (pierwsza niepusta wygrywa).
    # Datę/rok premiery bierzemy z kin + TMDB/Filmweb (bez Lumiere - jego premiera bywa datą wznowienia).
    date_sources = ("multikino", "cc", "helios", "tmdb", "filmweb", "muza")
    length_sources = ("tmdb", "filmweb", "helios", "cc", "multikino", "muza", "lumiere")
    poster_sources = ("cc", "helios", "multikino", "muza", "tmdb")  # lokalne (PL) plakaty z kin, TMDB jako fallback

    select_cols = ["id", "title", "release_year", "length", "poster", "genre", "genre_lumiere"]
    select_cols += [f"release_date_{s}" for s in date_sources]
    select_cols += [f"release_year_{s}" for s in date_sources]
    select_cols += [f"length_{s}" for s in length_sources]
    select_cols += [f"poster_{s}" for s in poster_sources]
    response = supabase.table("movies").select(", ".join(select_cols)).execute()
    movies = response.data

    if not movies:
        logger.info("Brak filmów do konsolidacji.")
        return

    updated_count = 0
    for movie in movies:
        update_data = {}

        # Data premiery: najwcześniejsza z dostępnych (stringi ISO 'YYYY-MM-DD' porównują się chronologicznie)
        valid_dates = [d for d in (movie.get(f"release_date_{s}") for s in date_sources) if d]
        if valid_dates:
            update_data["release_date"] = min(valid_dates)

        # Rok produkcji: najwcześniejszy ze WSZYSTKICH źródeł. Nadpisuje ewentualny rok wznowienia
        # ustawiony w konsolidacji przed-enrich (która nie zna jeszcze lat z TMDB/Filmweb).
        valid_years = [int(y) for y in (movie.get(f"release_year_{s}") for s in date_sources) if y is not None]
        if valid_years:
            new_year = min(valid_years)
            if new_year != movie.get("release_year"):
                update_data["release_year"] = new_year

        # Czas trwania: pierwszy sensowny wg priorytetu źródeł (TMDB/Filmweb kanoniczne, potem kina)
        length = next((movie.get(f"length_{s}") for s in length_sources if movie.get(f"length_{s}")), None)
        if length and length != movie.get("length"):
            update_data["length"] = length

        # Plakat: preferujemy lokalne plakaty z kin, TMDB jako ostateczny fallback (dla filmów bez plakatu z kina)
        if movie.get("poster") is None:
            poster = next((movie.get(f"poster_{s}") for s in poster_sources if movie.get(f"poster_{s}")), None)
            if poster:
                update_data["poster"] = poster

        # Gatunek: na razie dostarcza go tylko Cinema Lumiere; docelowo dojdą TMDB/CC/Helios
        if movie.get("genre") is None:
            genre = movie.get("genre_lumiere")
            if genre:
                update_data["genre"] = genre

        if update_data:
            supabase.table("movies").update(update_data).eq("id", movie["id"]).execute()
            updated_count += 1

    logger.info(f"Zaktualizowano dane po enrich dla {updated_count} filmów.")

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
    logger.info("Deduplikacja filmów po znormalizowanym tytule (diakrytyki/wielkość liter)...")

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

        logger.info(f"Scalanie {len(group)} wariantów -> '{survivor.get('title')}': {[m.get('title') for m in group]}")

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
                logger.error(f"Błąd przy scalaniu '{dup.get('title')}' -> '{survivor.get('title')}': {e}")

        if update_payload:
            supabase.table("movies").update(update_payload).eq("id", survivor["id"]).execute()

    logger.info(f"Zdeduplikowano {merged_count} rekordów.")

def dedupe_ukrainian_by_tmdb(supabase):
    """Scala rekordy ukraińskiego dubbingu tego samego filmu z różnych sieci kin. Mają wspólne tmdb_id,
    ale różne tytuły ('ВАЯНА' / 'Vajana - UA' / 'Vaiana ukraiński dubbing'), więc upsert ich nie łączy,
    a scalanie po tmdb_id jest dla tego typu wyłączone (żeby nie zlać z polskim oryginałem).
    Tu łączymy ukraiński-z-ukraińskim: zostaje jeden rekord z kanonicznym tytułem '{tytuł_tmdb} (ukraiński dubbing)',
    seanse ze wszystkich sieci są przepięte, a niepuste pola przeniesione. Uruchamiane PO enrich (potrzebne tmdb_id)."""
    logger.info("Scalanie rekordów ukraińskiego dubbingu po tmdb_id...")

    movies = supabase.table("movies").select("*").eq("movie_type", "UKRAIŃSKI DUBBING").execute().data or []

    groups = {}
    for m in movies:
        if m.get("tmdb_id"):
            groups.setdefault(m["tmdb_id"], []).append(m)

    merged_count = 0
    renamed_count = 0
    for tmdb_id, group in groups.items():
        # Kanoniczny tytuł z dowolnego dostępnego title_tmdb w grupie
        title_tmdb = next((m.get("title_tmdb") for m in group if m.get("title_tmdb")), None)

        # Pojedynczy rekord (film tylko w jednym kinie): nie ma czego scalać, ale ujednolicamy
        # tytuł do tego samego formatu co rekordy scalone.
        if len(group) < 2:
            movie = group[0]
            single_title = f"{title_tmdb} (ukraiński dubbing)" if title_tmdb else None
            if single_title and single_title != movie.get("title"):
                try:
                    supabase.table("movies").update({"title": single_title}).eq("id", movie["id"]).execute()
                    logger.info(f"Ujednolicono tytuł: '{movie.get('title')}' -> '{single_title}'")
                    renamed_count += 1
                except Exception as e:
                    logger.error(f"Błąd przy zmianie tytułu '{movie.get('title')}' -> '{single_title}': {e}")
            continue

        # Ocalały: najbardziej kompletny rekord (najwięcej niepustych pól), stabilnie po id
        survivor = max(group, key=lambda m: (sum(1 for v in m.values() if v is not None), str(m.get("id"))))
        dups = [m for m in group if m["id"] != survivor["id"]]

        new_title = f"{title_tmdb} (ukraiński dubbing)" if title_tmdb else survivor.get("title")

        logger.info(f"Scalanie {len(group)} wariantów (tmdb {tmdb_id}) -> '{new_title}': {[m.get('title') for m in group]}")

        update_payload = {}
        for dup in dups:
            try:
                # Niepuste wartości z duplikatu w puste miejsca ocalałego (tytuł ustawiamy osobno)
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
                logger.error(f"Błąd przy scalaniu '{dup.get('title')}' -> '{new_title}': {e}")

        # Tytuł ustawiamy PO usunięciu duplikatów, by uniknąć kolizji unique (jeden z dupów mógł mieć ten tytuł)
        if new_title and new_title != survivor.get("title"):
            update_payload["title"] = new_title

        if update_payload:
            supabase.table("movies").update(update_payload).eq("id", survivor["id"]).execute()

    logger.info(f"Ukraiński dubbing: scalono {merged_count} rekordów, ujednolicono {renamed_count} tytułów.")

def delete_past_screenings(supabase):
    """Usuwa seanse z przeszłości (start_time przed dzisiejszą północą w strefie Europe/Warsaw).
    Bezpieczne w każdym przebiegu - przeszłe seanse są zawsze nieaktualne."""
    warsaw_midnight = datetime.combine(
        datetime.now(ZoneInfo("Europe/Warsaw")).date(), time.min, tzinfo=ZoneInfo("Europe/Warsaw")
    )
    cutoff = warsaw_midnight.isoformat()
    res = supabase.table("screenings").delete().lt("start_time", cutoff).execute()
    count = len(res.data or [])
    logger.info(f"Usunięto przeszłe seanse (start_time < {cutoff}): {count}.")
    return count

def delete_orphan_movies(supabase):
    """Usuwa filmy bez żadnego seansu (wypadły z repertuaru). Uruchamiać TYLKO gdy wszystkie źródła
    zescrapowały się poprawnie - inaczej skasowalibyśmy filmy chwilowo nieudanego źródła."""
    all_ids = {m["id"] for m in supabase.table("movies").select("id").execute().data}
    # movie_screening_counts to widok z jednym wierszem na film mający seanse (agregacja) - mieści się w limicie
    used_ids = {r["movie_id"] for r in supabase.table("movie_screening_counts").select("movie_id").execute().data}
    orphans = [i for i in all_ids if i not in used_ids]

    if not orphans:
        logger.info("Brak osieroconych filmów do usunięcia.")
        return 0

    for i in range(0, len(orphans), 100):
        supabase.table("movies").delete().in_("id", orphans[i:i+100]).execute()
    logger.info(f"Usunięto {len(orphans)} osieroconych filmów (bez seansów).")
    return len(orphans)

def log_run_summary(supabase, enriched_count=0, past_deleted=0, orphans_deleted=0):
    """Wypisuje na końcu logu zwięzłe podsumowanie przebiegu (stan bazy + statystyki sprzątania)."""
    total_movies = supabase.table("movies").select("id", count="exact").limit(1).execute().count
    total_scr = supabase.table("screenings").select("id", count="exact").limit(1).execute().count

    # Seanse w rozbiciu na sieci (po kilka zapytań count - pozwala wychwycić źródło, które nic nie zwróciło)
    cinemas = supabase.table("cinemas").select("id, franchise").execute().data
    by_franchise = {}
    for c in cinemas:
        by_franchise.setdefault(c.get("franchise") or "?", []).append(c["id"])
    parts = []
    for fr, ids in sorted(by_franchise.items()):
        cnt = supabase.table("screenings").select("id", count="exact").in_("cinema_id", ids).limit(1).execute().count
        parts.append(f"{fr}: {cnt}")

    logger.info("=== PODSUMOWANIE ===")
    logger.info("Filmy w bazie: %s (nowo wzbogaconych w tym przebiegu: %s)", total_movies, enriched_count)
    logger.info("Seanse w bazie: %s  [%s]", total_scr, ", ".join(parts))
    logger.info("Sprzątanie: przeszłych seansów usunięto %s, osieroconych filmów %s", past_deleted, orphans_deleted)

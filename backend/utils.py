import logging
import re
from datetime import datetime
from zoneinfo import ZoneInfo


logger = logging.getLogger(__name__)

def parse_start_time(start_time_raw: str) -> str:
    """Parsuje ciąg daty i w razie braku strefy czasowej dodaje Europe/Warsaw."""
    if not start_time_raw:
        return ""
    try:
        dt_obj = datetime.fromisoformat(start_time_raw)
        if dt_obj.tzinfo is None:
            dt_obj = dt_obj.replace(tzinfo=ZoneInfo("Europe/Warsaw"))
        return dt_obj.isoformat()
    except ValueError:
        return start_time_raw

def parse_release_date(raw) -> str:
    """Sprowadza datę premiery z różnych formatów źródeł do 'YYYY-MM-DD' (lub None).
    Obsługuje: dateInt Filmwebu (int/str '20211022'), naiwny ISO ('2026-07-10T00:00:00'),
    ISO ze strefą ('2026-07-17T00:00:00+02:00') oraz z 'Z'/ułamkami ('2021-10-01T00:00:00.000Z')."""
    if not raw:
        return None

    s = str(raw).strip()

    # Filmweb: dateInt w formacie YYYYMMDD. Bywa niepełny (np. 19970000 = sam rok) -
    # wtedy nie da się zbudować prawidłowej daty, więc zwracamy None (rok jest w release_year).
    if s.isdigit() and len(s) == 8:
        month, day = s[4:6], s[6:8]
        if month == "00" or day == "00":
            return None
        return f"{s[:4]}-{month}-{day}"

    try:
        dt_obj = datetime.fromisoformat(s.replace("Z", "+00:00"))
        return dt_obj.date().isoformat()
    except ValueError:
        # Ostatnia deska ratunku: początek stringa wygląda jak data ISO
        if len(s) >= 10 and s[4] == "-" and s[7] == "-":
            return s[:10]
        return None

def clean_title(title: str) -> str:
    if not title:
        return ""
    
    original_title = title

    # Ujednolicenie myślników (półpauza i pauza na zwykły dywiz)
    title = title.replace("–", "-").replace("—", "-")
    # Usuwa przedrostki kinowe
    title = re.sub(r'^(?:NMF|NT Live)[:\s\-]+', '', title, flags=re.IGNORECASE)
    # Usuwa przedrostek Royal Ballet and Opera (sezon generalizowany, np. 2026-27, 2027-28...)
    title = re.sub(r'^Royal Ballet (?:and|&) Opera Sezon Kinowy \d{4}-\d{2}:\s*', '', title, flags=re.IGNORECASE)
    # Usuwa rocznice np. " 40. Rocznica", " 40th Anniversary", " - 40. rocznica"
    title = re.sub(r'\s*-?\s*(?:\.\s*)?\s*\d+(?:\.|st|nd|rd|th)?\s*(?:rocznica|Anniversary)\b.*$', '', title, flags=re.IGNORECASE)
    # Usuwa dopiski typu "25-lecie", "100-lecie"
    title = re.sub(r'\s*-?\s*\d+-lecie\b.*$', '', title, flags=re.IGNORECASE)
    # Usuwa typowy dopisek CC (rok generalizowany, np. 2026, 2027...)
    title = re.sub(r"\s*-\s*National Theatre Live \d{4}", "", title)
    title = title.removesuffix(" - wersja oryginalna")
    title = title.removesuffix(". Wersja zremasterowana")
    title = title.removesuffix("- powrót do kin")
    title = title.removesuffix(" | NAJLEPSZE Z NAJGORSZYCH")
    # Usuwa parentetyczny "(lektor)". Uwaga: dopiski o wersji reżyserskiej/rozszerzonej celowo
    # ZOSTAJĄ w tytule (to inna wersja filmu) - zdejmuje je dopiero search_title na potrzeby wyszukiwania.
    title = re.sub(r"\s*\(lektor\)\s*$", "", title, flags=re.IGNORECASE)
    # Zamiana skrótu na pełne słowo (np. "Diuna: cz. 2" -> "Diuna: część 2")
    title = title.replace("cz.", "część").replace("Cz.", "Część")
    
    cleaned_title = title.strip()
    if original_title != cleaned_title:
        logger.debug(f"Zmieniono tytuł: '{original_title}' -> '{cleaned_title}'")
        
    return cleaned_title

# Ujednolicony słownik wersji językowej seansu (kolumna `lang`).
# Kanon: NAPISY, DUBBING, PL, ORYGINALNY, LEKTOR.
# Klucze są w UPPERCASE - porównanie po .strip().upper() surowej wartości ze źródła.
_LANG_MAP = {
    "NAPISY": "NAPISY",
    "NAP": "NAPISY",
    "SUBBED": "NAPISY",
    "DUBBING": "DUBBING",
    "DUB": "DUBBING",
    "DUBBED": "DUBBING",
    "UA": "DUBBING",            # ukraiński dubbing; sama "ukraińskość" jest w movie_type
    "PL": "PL",
    "POLSKI": "PL",
    "JĘZYK ORYGINALNY": "ORYGINALNY",
    "ORYGINALNY": "ORYGINALNY",
    "ANGIELSKIE": "ORYGINALNY",
    "ORIGINAL": "ORYGINALNY",
    "LEKTOR": "LEKTOR",
}

def normalize_lang(raw: str):
    """Sprowadza surową wartość języka z dowolnego kina do wspólnego słownika.
    Nieznane wartości przepuszcza w UPPERCASE (nie gubi danych, ułatwia późniejsze zmapowanie)."""
    if not raw:
        return None
    key = raw.strip().upper()
    return _LANG_MAP.get(key, key) or None

def search_title(title: str) -> str:
    """Dodatkowo oczyszczony tytuł WYŁĄCZNIE do wyszukiwania w TMDB/Filmweb.
    Zdejmuje ozdobniki, które w bazie zostawiamy dla odrębności/informacji o rekordzie
    (Ladies Night, Unlimited Show, Kino na obcasach, ' ukraiński dubbing', wersja reżyserska/rozszerzona).
    Dzięki temu np. 'Vaiana ukraiński dubbing' czy 'Diuna (wersja rozszerzona)' znajdą film bazowy."""
    if not title:
        return title
    t = re.sub(r"^(?:Ladies\s*Night|Unlimited\s*Show)\s*-\s*", "", title, flags=re.IGNORECASE)
    t = re.sub(r"^Kino na obcasach:\s*", "", t, flags=re.IGNORECASE)
    # Sufiks ukraińskiego dubbingu w różnych formach (PL/EN, z nawiasem, po ". "/" - "/spacji)
    t = re.sub(r"\s*[.\-]?\s*\(?(?:ukrai[nń]ski dubbing|ukrainian dubbing)\)?\s*$", "", t, flags=re.IGNORECASE)
    t = re.sub(r"\s*[:.\-]\s*wersja reżyserska\s*$", "", t, flags=re.IGNORECASE)
    t = re.sub(r"\s*\(wersja rozszerzona\)\s*$", "", t, flags=re.IGNORECASE)
    return t.strip() or title

def get_valid_poster(poster_data):
    """
    Wyciąga i weryfikuje poprawność linku do plakatu. 
    Obsługuje zarówno listy (Helios) jak i pojedyncze stringi (Cinema City / Multikino).
    """
    if not poster_data:
        return None
        
    poster = poster_data[0] if isinstance(poster_data, list) else poster_data
    
    if isinstance(poster, str) and poster.startswith("http"):
        return poster
    return None

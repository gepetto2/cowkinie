"""Aktualizuje DANE O KINACH: adres, współrzędne, link do strony.

Osobno od `run_scrapers.py`, bo to informacje, które zmieniają się raz na lata - kino nie przenosi
się co noc, a codzienne ich odświeżanie nic nie wnosi.

Repertuar i tak zakłada kina przez `upsert_cinema`, więc nowe kino pojawi się w bazie samo -
tylko bez adresu, dopóki nie uruchomisz tego skryptu.

UWAGA: strony kin Multikina pobiera teraz także `run_scrapers.py` (miasta nie ma w ich API,
patrz multikino._city_from_page), więc te 38 żądań lecą w obu skryptach. Da się to scalić -
`get_target_cinemas` mogłoby zwracać od razu adres i współrzędne - ale wtedy dane opisowe
wracają do scrapera repertuaru.

Użycie:
    python update_cinemas.py
"""
import asyncio
import json
import logging
import re
import sys
import unicodedata

from logging_config import setup_logging
setup_logging()

from curl_cffi import requests

from config import supabase
from db.database import upsert_cinema
from scrapers import cinema_city, helios, multikino

logger = logging.getLogger(__name__)


def _address(street: str, city: str):
    """'ul. Focha 48' + 'Bydgoszcz' -> 'ul. Focha 48, Bydgoszcz'.

    Świadomie BEZ kodu pocztowego: Helios go nie podaje, więc gdyby zostawić go u pozostałych,
    lista kin czytałaby się niespójnie. Do nawigacji i tak służą współrzędne.
    """
    street = (street or "").strip()
    return f"{street}, {city}" if street and city else (street or None)


def _strip_postal_code(text: str):
    """Zdejmuje polski kod pocztowy ('00-120 Warszawa' -> 'Warszawa')."""
    return re.sub(r"\b\d{2}-\d{3}\b\s*", "", text or "").strip()


def _city_slug(city: str) -> str:
    """'Gdańsk' -> 'gdansk'. Adres strony kina Heliosa to helios.pl/{miasto}/{slug}; API podaje sam
    slug ("kino-helios"), więc bez miasta link prowadzi do kina w zupełnie innym mieście."""
    s = (city or "").lower().replace("ł", "l")
    s = unicodedata.normalize("NFD", s).encode("ascii", "ignore").decode()
    return re.sub(r"[^a-z0-9]+", "-", s).strip("-")


async def _from_cinema_city(client) -> list:
    """[(nazwa, miasto, pola)] dla Cinema City - wszystko jest w liście kin, bez dodatkowych żądań."""
    out = []
    for c in await cinema_city.get_target_cinemas(client):
        info = c.get("addressInfo") or {}
        city = info.get("city")
        name = c.get("displayName")
        if not name or not city:
            continue
        out.append((name, city, {
            "address": _address(info.get("address1"), city),
            "latitude": c.get("latitude"),
            "longitude": c.get("longitude"),
            "url": c.get("link"),
        }))
    return out


async def _from_helios(client) -> list:
    out = []
    for c in await helios.get_target_cinemas(client):
        loc = c.get("location") or {}
        city, slug = loc.get("city"), c.get("slug")
        # Marka musi lecieć z nazwy tak samo jak w scraperze repertuaru, inaczej upsert po
        # (name, franchise) założy drugie kino zamiast uzupełnić istniejące.
        name = (c.get("name") or "").replace("Helios", "").strip()
        if not name or not city:
            continue
        out.append((name, city, {
            "address": _address(loc.get("street"), city),
            "latitude": loc.get("latitude"),
            "longitude": loc.get("longitude"),
            "url": f"https://helios.pl/{_city_slug(city)}/{slug}" if slug else None,
        }))
    return out


# Multikino nie ma API z danymi kina - endpointy /cinemas/{id} zwracają 401. Adres i współrzędne
# są za to w `__NEXT_DATA__` strony repertuaru (serwis stoi na Next.js).
_NEXT_DATA = re.compile(r'<script id="__NEXT_DATA__"[^>]*>(.*?)</script>', re.S)


async def _multikino_details(client, page_url: str, cinema_id: str):
    """(adres, szerokość, długość) ze strony repertuaru kina Multikina. Braki jako None.

    `cinemaId` ze strony porównujemy z tym z listy kin - gdyby Multikino przekierowało na inne
    kino, wolimy nie zapisać nic niż przypisać cudzy adres.
    """
    if not page_url:
        return None, None, None
    try:
        resp = await client.get(page_url, timeout=40.0)
        if resp.status_code != 200:
            return None, None, None
        m = _NEXT_DATA.search(resp.text)
        if not m:
            return None, None, None
        node = json.loads(m.group(1))["props"]["pageProps"]["layoutData"]["sitecore"]["context"]["cinema"]
    except Exception as e:
        logger.debug("Nie pobrano danych kina %s: %s", page_url, e)
        return None, None, None

    def val(key):
        return ((node.get(key) or {}).get("value") or "").strip() or None

    if val("cinemaId") not in (None, cinema_id):
        logger.warning("Strona %s dotyczy kina %s, nie %s - pomijam dane opisowe.",
                       page_url, val("cinemaId"), cinema_id)
        return None, None, None

    # Adres przychodzi w dwóch liniach (ulica, potem kod z miastem) - scalamy przecinkiem.
    address = val("cinemaAddress")
    if address:
        address = ", ".join(x.strip() for x in address.splitlines() if x.strip())

    lat = lng = None
    coords = val("cinemaLocationCoordinates")
    if coords and "," in coords:
        try:
            lat, lng = (float(x) for x in coords.split(",", 1))
        except ValueError:
            lat = lng = None
    return address, lat, lng


async def _from_multikino(client) -> list:
    """Multikino nie ma API z danymi kina (endpointy /cinemas/{id} zwracają 401) - adres
    i współrzędne są w `__NEXT_DATA__` strony repertuaru. Jedno żądanie na kino."""
    out = []
    for c in await multikino.get_target_cinemas(client):
        address, lat, lng = await _multikino_details(client, c.get("page"), c["id"])
        out.append((c["name"], c["city"], {
            "address": _strip_postal_code(address) if address else None,
            "latitude": lat,
            "longitude": lng,
            "url": c.get("page"),
        }))
    return out


# Kina jednooddziałowe. Adres i strona nie zmieniają się latami, a każde z nich stoi na innym
# silniku - pisanie siedmiu integracji po dane stałe kosztowałoby więcej niż wpisanie ich tutaj.
# Wartości spisane ze stron samych kin (sierpień 2026). Kategorię podajemy jawnie, bo upsert
# nadpisuje ją razem z resztą, a scrapery repertuaru ustawiają ją tak samo.
#
# Brakujące adresy zostawiamy jako None - podstrona /kina pokazuje wtedy samą nazwę:
#  - Kino Pałacowe: strona CK Zamku renderuje kontakt JS-em, adresu nie ma w HTML,
#  - Cinema Lumiere: strona kina to dziś pusta skorupa, jedyny adres w stopce to siedziba
#    spółki w Białymstoku, a nie kino w Suwałkach.
STATIC_CINEMAS = [
    # (nazwa, miasto, kategoria, adres, strona)
    ("Kino Muza", "Poznań", "studyjne", "ul. Św. Marcin 30, Poznań", "https://www.kinomuza.pl/"),
    ("Kino Apollo", "Poznań", "studyjne", "ul. Ratajczaka 18, Poznań", "https://kinoapollo.pl/"),
    ("Kino Rialto", "Poznań", "studyjne", "ul. Dąbrowskiego 38, Poznań", "https://www.kinorialto.poznan.pl/"),
    ("Kino Bułgarska 19", "Poznań", "studyjne", "ul. Bułgarska 19, Poznań", "http://kinobulgarska19.pl/"),
    ("Kino Malta", "Poznań", "studyjne", "ul. Rybaki 6a, Poznań", "https://www.kinomalta.pl/"),
    ("Kino Pałacowe", "Poznań", "studyjne", "ul. Św. Marcin 80/82, Poznań", "https://kinopalacowe.pl/"),
    ("Cinema Lumiere", "Suwałki", "niezależne", "Dwernickiego 15, Suwałki", "https://suwalki.cinema-lumiere.pl/"),
    ("Kino Orzeł", "Bydgoszcz", "studyjne", "ul. Marcinkowskiego 12, Bydgoszcz", "https://www.kino-orzel.pl/"),
]


SOURCES = [
    ("Cinema City", _from_cinema_city, "sieć"),
    ("Helios", _from_helios, "sieć"),
    ("Multikino", _from_multikino, "sieć"),
]


async def update_all() -> bool:
    logger.info("=== START: aktualizacja danych o kinach (cała Polska) ===")
    total, with_address, failed = 0, 0, []

    async with requests.AsyncSession(impersonate="chrome") as client:
        # Multikino stoi za Cloudflare - bez wizyty na stronie głównej nie dostaniemy ciasteczek.
        await client.get("https://www.multikino.pl/", timeout=60.0)

        for franchise, fetch, category in SOURCES:
            try:
                rows = await fetch(client)
            except Exception as e:
                logger.error("%s: nie udało się pobrać danych o kinach: %s", franchise, e)
                failed.append(franchise)
                continue

            for name, city, fields in rows:
                upsert_cinema(supabase, name, city, franchise, category, **fields)
                total += 1
                with_address += bool(fields.get("address"))
            logger.info("%s: zaktualizowano %s kin (z adresem: %s).", franchise, len(rows),
                        sum(1 for _, _, f in rows if f.get("address")))

    for name, city, category, address, url in STATIC_CINEMAS:
        upsert_cinema(supabase, name, city, name, category, address=address, url=url)
        total += 1
        with_address += bool(address)
    logger.info("Kina jednooddziałowe: zapisano %s (z adresem: %s).", len(STATIC_CINEMAS),
                sum(1 for c in STATIC_CINEMAS if c[3]))

    logger.info("=== KONIEC: %s kin, z adresem %s. Nieudane źródła: %s ===",
                total, with_address, ", ".join(failed) or "brak")
    return not failed


if __name__ == "__main__":
    sys.exit(0 if asyncio.run(update_all()) else 1)

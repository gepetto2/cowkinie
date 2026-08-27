# Co w kinie

Cinema listings for Polish cities in one place. Live at **[cowkinie.pl](https://cowkinie.pl)**.

National chains alongside single-screen art-house venues. Each runs its own
site, its own layout, and its own spelling of the same film title. This project
scrapes all of them, works out which listings refer to the same film, enriches
the result from TMDB, Filmweb and OMDb, and serves one filterable schedule.

<img src="docs/listing.webp" width="900"
     alt="Poznań listing with date, city, format and genre filters, showing carousels of the most popular and highest rated films; each poster carries badges for the cinemas screening it and ratings from Filmweb and IMDb.">

## What it does

* Filtering by city, date range, format (2D/3D/IMAX/4DX), language version and genre
* Ratings combined from Filmweb, IMDb and TMDB using a Bayesian average
* Special screenings (opera, ballet, marathons, ladies' nights, Ukrainian dubbing) kept in their own section rather than mixed into the schedule
* Booking links straight to the cinema's checkout
* Per-city URLs (`/poznan`, `/gdansk`) with their own metadata and sitemap entries

## The pipeline

[`backend/run_scrapers.py`](backend/run_scrapers.py) orchestrates a run:

1. **Scrape** every source concurrently, with
   `asyncio.gather(..., return_exceptions=True)`. A source that fails, gets
   blocked or comes back empty does not abort the run. Consolidation carries on
   with partial data and each failure is reported by name.
2. **Merge the small-cinema fields** by explicit priority, once every scraper has
   finished. Doing this inside the scrapers would hand the decision to whichever
   coroutine happened to end last.
3. **Dedupe by normalised title**, folding diacritics so that `Andre` and
   `André Rieu` collapse into one record before the expensive steps run.
4. **Consolidate** the scraped fields into the canonical columns.
5. **Enrich** from TMDB, Filmweb and OMDb, then refresh the ratings of films
   matched during earlier runs. Without that second step, scores would stay
   frozen at the value they held on the day of first match, which is exactly
   when a film has the fewest votes and the least stable average.
6. **Dedupe Ukrainian dubbing** by the TMDB id that enrichment has just assigned.
7. **Consolidate again**, now that the external metadata exists.
8. **Clean up.** Past screenings always go. Orphaned films go only when every
   source succeeded, for reasons covered further down.

Runs are idempotent, so the pipeline can be pointed at a populated database
without duplicating anything, and a non-zero exit code marks a failed source for
whatever is scheduling it.

The backend writes using a secret Supabase key. The frontend only ever reads,
with a publishable one.

## Every source, a different integration

There is no shared standard between cinema sites, so each one needed its own
approach:

| Source | Integration |
|---|---|
| Multikino, Cinema City | Undocumented internal REST APIs |
| Helios | Two separate APIs, a v1 JSON one and a SOAP-backed REST layer |
| Kino Muza | JSON per day, offset-addressed (`/repertoire/day/{n}.json`) |
| Kino Pałacowe | Django REST, but only with `Accept: application/json`; otherwise it serves its browsable HTML page |
| Kino Malta | JSON-LD `ScreeningEvent` blocks, cross-checked against the rendered cards |
| Kino Rialto | WordPress with a Bilety24 plugin, parameterised so the next cinema on the same engine is a one-line addition |
| Kino Apollo | WordPress JetEngine listing, whose REST API omits about a third of the screenings |
| Cinema Lumiere | One ASP.NET endpoint returning the whole schedule, but only when asked with `X-Requested-With: XMLHttpRequest` |
| Kino Bułgarska 19 | Server-rendered HTML, no API at all |

Source list as of August 2026. Cinemas are still being added, so the table
lags the code; `backend/scrapers/` is the authoritative list.

## Getting the same film to line up

### Matching against TMDB

Small cinemas screen re-releases, and re-releases share titles with remakes.
Matching on title alone put the 2013 *Oldboy* remake's id onto the 2003
original's record.

A quieter failure took longer to find. TMDB's search endpoint does not index
localized titles. *Amélie* sits in the database under the Polish title `Amelia`
with roughly 12,500 votes, but searching `Amelia` never returns it, because
search covers original and alternative titles only. The match went instead to an
unrelated 2009 biopic with 263 votes.

The fix comes at the problem backwards. When no search result can be confirmed
against the director the cinema supplied, the film is looked up inside that
director's filmography, where `person/{id}/movie_credits` does return localized
titles. It runs on the failure path only, costing two extra requests when the
normal path has already given up.

### When merging is the mistake

Duplicates are merged by title similarity once a TMDB id is known. The
interesting cases are the ones where two listings share an id and still must
stay apart, each of which came from a real bug:

| Case | Why it must not merge |
|---|---|
| `Vaiana, karaoke version` | Same TMDB id as the ordinary screening. Merged, the karaoke showings vanished from the schedule, their screenings absorbed into the regular ones and no longer distinguishable. |
| Audio-described and signed screenings | Same film, but somebody who needs those facilities cannot simply attend the regular showing. Merging removes the only record that an accessible screening exists. |
| Director's, extended and remastered cuts | Share an id with the theatrical version, yet are a different film to whoever is buying the ticket. |
| Ukrainian-dubbed showings | The inverse case. These *do* need merging with each other across chains, but only after enrichment has given them an id. |

So the merge key is `(tmdb_id, set_of_version_markers)` rather than `tmdb_id`,
and a short list of screening types is excluded from id-based merging outright.
See [`backend/core/merge_movies.py`](backend/core/merge_movies.py).

## Keeping every source's answer

The `movies` table holds one column per source per field (`poster_helios`,
`release_year_cc`, `director_muza` and so on) alongside the consolidated column
that the site renders. Consolidation is a separate pass with an explicit
priority order, so one cinema can supply the runtime while another supplies the
poster.

It runs twice. The first pass fills the fields used as *search input* for
enrichment: year, director, original title. The second runs afterwards, once
TMDB and Filmweb have answered for everything else.

<img src="docs/film-details.webp" width="900"
     alt="Film detail view combining ratings from Filmweb, IMDb and TMDB with a director, cast, synopsis and genres, above a per-day list of screening counts and the cinemas showing the film.">

Everything in that panel arrives from a different place. The three ratings come
from three APIs, the synopsis and cast from whichever source ranked highest for
those fields, and the format and language chips from the cinemas themselves.

The width buys three things. Re-consolidating never requires a re-scrape, so
changing which source wins is a query rather than a ninety-minute crawl.
Disagreements between sources become visible instead of being silently resolved.
And a source that turns out to be unreliable can be demoted by reordering
priority, without touching any scraper.

Smaller cinemas share one set of `*_small` columns rather than each getting
their own, merged by priority after every scraper has finished. Doing that
inside the scrapers would hand the decision to whichever coroutine happened to
finish last.

## Not trusting what comes back

A scraper that returns nothing looks identical to a cinema with an empty
schedule. Several kinds of quiet corruption had to be made loud.

**Failures that looked like successes.** A blocked or broken source returned
zero rows and the run reported success, leaving yesterday's data in place as
though it were fresh. Scrapers now raise `ScraperError` on failure. That was not
quite enough: Helios's SOAP backend once returned HTTP 500 for all five of its
cinemas while the run still exited 0, so a source that returns a cinema list but
no screenings from any of them now counts as a failure too. When any source
fails, orphan-film deletion is skipped, otherwise one blocked site would delete
its own catalogue.

**HTTP 200 is not a health check.** Cloudflare's challenge pages arrive with a
success status. Anything deciding whether a fetch worked has to look at the
body.

**TLS fingerprints and IP reputation are separate problems.** Requests go out
through `curl_cffi` with `impersonate="chrome"`, which matches Chrome's TLS
fingerprint and clears that check. It does nothing about the other one:
datacenter IP ranges get refused wholesale, however convincing the handshake is.
Multikino turned out to block them, which first showed up when a cloud-hosted
run failed while identical code worked from a Polish connection. The same thing
resurfaced much later from an unexpected direction: enabling image optimization
broke exactly those posters, because Vercel's optimizer fetches server-side from
Frankfurt. Those posters now go to the browser unoptimized.

**Posters that are not posters.** Multikino serves placeholders for films
without artwork, and some Cinema City posters carry the chain's orange brand
frame. The frame is detected by measuring how much of the image border sits near
`#f5821f`; above half, a cleaner source is used instead.

**Genres arrive however each site felt like writing them.** Inconsistent casing,
occasionally run together without separators, and different between sites for
the same film. They are canonicalised against a vocabulary before storage.

## Ratings that do not mislead

A raw average is meaningless at low vote counts, since one 10/10 vote does not
make a masterpiece. Scores use a Bayesian average, `(v*R + m*C) / (v + m)`,
pulling small samples toward the overall mean.

Display and ranking use different vote thresholds, because they tolerate
different amounts of uncertainty. A rating printed on a card is the raw value,
so a few hundred votes is plenty to be worth showing. The same rating entering
the ranking gets shrunk almost to the mean, so it needs a larger sample before
it says anything. Using one threshold for both hid legitimate ratings for Polish
classics, which carry thousands of votes on Filmweb but only hundreds on IMDb.

## Serving the data

PostgreSQL on Supabase: `movies`, `screenings`, `cinemas`, plus views for filter
options and screening counts.

Filtering by date, city, format and language runs as a Postgres function called
over RPC. Aggregating inside the database returns one row per film instead of
thousands of screening rows, which keeps the payload small and stays clear of
PostgREST's 1000-row response cap. Adding a filter means one more parameter and
one more `WHERE` clause rather than a new query path in the client.

The frontend is Next.js on the App Router. Reads are cached for 120 seconds with
tag invalidation, since the data only moves when the scraper runs. Card queries
name their columns instead of using `select('*')`, because a film row carries
descriptions and per-source fields that a poster tile has no use for.

## Stack

**Backend** Python 3.13, `asyncio`, `curl_cffi`, `aiohttp`, Pillow

**Frontend** Next.js 16 (App Router, server components), React 19, TypeScript, Tailwind v4, Radix UI

**Data** Supabase (PostgreSQL); TMDB, Filmweb and OMDb for enrichment

**Infrastructure** Vercel

## Project structure

```
backend/
  scrapers/        one module per cinema source
  api/             TMDB, Filmweb, OMDb clients
  core/            enrichment, merging, shared small-cinema columns
  db/              persistence, consolidation, cleanup
  run_scrapers.py  orchestrates the run

frontend/
  app/             routes, metadata, sitemap, robots, OG image
  components/      movie cards, filters, city picker, carousels
  lib/             queries, ratings, city slugs and declension
```

## Status

Live. The scrape runs nightly, scheduled from a local machine rather than from
CI, plus ad-hoc runs whenever something is being tested.

That placement is deliberate rather than convenient. Multikino refuses
datacenter IP ranges, and every hosted option lands in one: GitHub Actions
runners, a VPS and edge platforms alike. Residential proxies would fix it for a
per-gigabyte fee this project cannot justify, and moving the scrapers to Workers
or Edge Functions would mean dropping `curl_cffi`, which is the piece that gets
past the fingerprint check in the first place. A residential connection is the
one asset that makes the full scrape work, so the scheduler sits next to it.

The cost is real and worth stating: nothing runs while that machine is off, and
nothing alerts when it is. The GitHub Actions workflow is committed and works on
manual trigger with its daily schedule commented out, so moving the job into CI
is a one-line change on the day the IP question is settled. It uploads its debug
log as an artifact on every run, including failed ones, which is how that answer
will arrive.

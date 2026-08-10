import type { MetadataRoute } from "next";

import { citySlug } from "@/lib/cities";
import { SITE_URL } from "@/lib/site";
import { getCities } from "@/lib/supabase/queries";

/**
 * Mapa strony: adres główny, ekran wyboru miasta i po jednym wpisie na miasto.
 *
 * Miasta bierzemy z bazy, więc kolejne kino w nowym mieście trafia do sitemapy samo - bez tego
 * trzeba by pamiętać o ręcznej aktualizacji przy każdym rozszerzeniu zasięgu.
 *
 * Adresy z parametrami (?miasta=, ?q=, filtry) świadomie POMIJAMY: to warianty tej samej treści,
 * a nie osobne strony - w sitemapie rozmywałyby tylko sygnał dla wyszukiwarki.
 */
export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const cities = await getCities();
  const lastModified = new Date();

  return [
    {
      url: SITE_URL,
      lastModified,
      changeFrequency: "daily",
      priority: 1,
    },
    {
      url: `${SITE_URL}/wybierz-miasto`,
      lastModified,
      changeFrequency: "monthly",
      priority: 0.5,
    },
    {
      url: `${SITE_URL}/kina`,
      lastModified,
      changeFrequency: "monthly",
      priority: 0.5,
    },
    ...cities.map((city) => ({
      url: `${SITE_URL}/${citySlug(city)}`,
      lastModified,
      // Repertuar zmienia się co dobę - to najczęściej aktualizowana treść w serwisie.
      changeFrequency: "daily" as const,
      priority: 0.8,
    })),
  ];
}

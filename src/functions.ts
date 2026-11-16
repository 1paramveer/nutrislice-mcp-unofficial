import { env } from "cloudflare:workers";
import type {
    RawDiningLocation,
    DiningLocation,
    RawWeeklyMenu,
    WeeklyMenu,
    MenuSummary,
    FoodInfo,
    CacheEntry,
} from "./types.ts";

// Cache entries are fresh for 7 days and retained for 14 days.
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const KV_RETENTION_SECONDS = 14 * 24 * 60 * 60;
const UPSTREAM_TIMEOUT_MS = 20_000;

const days = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;

/**
 * Fetches JSON from Nutrislice with a timeout.
 * Verifies the destination before allowing the outgoing request.
 *
 * @param url Nutrislice API URL.
 * @returns Parsed JSON response.
 * @throws If the URL is invalid or the request fails.
 */
async function fetchNutrisliceJson(url: string): Promise<unknown> {
    const target = new URL(url);

    // Prevent requests to destinations outside Nutrislice.
    if (
        target.protocol !== "https:" ||
        !target.hostname.endsWith(".api.nutrislice.com") ||
        target.username ||
        target.password ||
        target.port
    ) {
        throw new Error("Invalid Nutrislice API destination");
    }

    const response = await fetch(target, {
        signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
        redirect: "manual",
    });

    if (!response.ok) {
        throw new Error(`Nutrislice HTTP ${response.status}`);
    }

    return response.json();
}

/**
 * Fetches and normalizes dining locations for a district.
 *
 * @param district_name Nutrislice district slug.
 * @returns Dining locations, or null on failure.
 */
export async function getDiningLocations(
    district_name: string,
): Promise<DiningLocation[] | null> {
    try {
        const raw = await fetchNutrisliceJson(
            `https://${district_name}.api.nutrislice.com/menu/api/schools`,
        );

        // Check the basic response structure before processing it.
        if (
            !Array.isArray(raw) ||
            raw.some(
                (location) =>
                    !location ||
                    typeof location.id !== "number" ||
                    !Array.isArray(location.active_menu_types),
            )
        ) {
            throw new Error("Unexpected dining locations response");
        }

        const data = raw as RawDiningLocation[];
        const locations: DiningLocation[] = [];

        for (const location of data) {
            locations.push({
                id: location.id,
                name: location.name,
                slug: location.slug,
                address: location.address,
                wayfindingNote: location.wayfinding_note || null,
                operatingStatus: location.operating_status,
                hours: Object.fromEntries(
                    days.map((day) => [
                        day,
                        {
                            enabled: location[`${day}_enabled`],
                            start: location[`${day}_start`],
                            end: location[`${day}_end`],
                            is24Hours: location[`${day}_is_24_hours`],
                        },
                    ]),
                ) as DiningLocation["hours"],
                availableMeals: location.active_menu_types.map((menu) => ({
                    id: menu.id,
                    name: menu.name,
                    slug: menu.slug,
                })),
            });
        }

        return locations;
    } catch (error) {
        console.error(
            `Error fetching or parsing dining locations for "${district_name}":`,
            error,
        );
        return null;
    }
}

/**
 * Converts a Nutrislice weekly response into days and dining stations.
 * Complete food records are preserved without duplicating their fields.
 *
 * @param raw Weekly Nutrislice API response.
 * @returns Normalized weekly menu.
 * @throws If the expected menu structure is missing.
 */
function parseWeeklyMenu(raw: unknown): WeeklyMenu {
    const data = raw as RawWeeklyMenu;

    if (
        !data ||
        !Array.isArray(data.days) ||
        typeof data.menu_type_id === "undefined" ||
        data.days.some((day) => !Array.isArray(day.menu_items) || !day.date)
    ) {
        throw new Error("Unexpected weekly menu response");
    }

    return {
        startDate: data.days[0]?.date ?? data.start_date,
        menuTypeId: Number(data.menu_type_id),
        sourceUpdatedAt: data.last_updated ?? null,
        days: data.days.map((day) => {
            const stations = new Map<
                number,
                WeeklyMenu["days"][number]["stations"][number]
            >();

            // Station headers and foods share the same API array.
            for (const item of day.menu_items) {
                if (item.is_station_header && item.station_id !== null) {
                    stations.set(item.station_id, {
                        name: item.text,
                        items: [],
                    });
                }
            }

            for (const item of day.menu_items) {
                if (!item.food) continue;

                const stationId = item.station_id ?? -1;

                if (!stations.has(stationId)) {
                    stations.set(stationId, {
                        name: "Other",
                        items: [],
                    });
                }

                // Keep all food details, preferring the menu item's price.
                stations.get(stationId)!.items.push({
                    ...item.food,
                    price: item.price ?? item.food.price ?? null,
                });
            }

            return {
                date: day.date,
                unpublished: day.has_unpublished_menus,
                stations: [...stations.values()].filter(
                    (station) => station.items.length > 0,
                ),
            };
        }),
    };
}

/**
 * Identifies the Sunday-start week used by the menu cache.
 *
 * @param district Nutrislice district.
 * @param locationId Dining location ID.
 * @param mealTypeId Meal type ID.
 * @param date Requested date.
 * @returns Weekly cache key.
 */
export function getMenuCacheKey(
    district: string,
    locationId: number,
    mealTypeId: number,
    date: string,
): string {
    const week = new Date(`${date}T00:00:00Z`);
    week.setUTCDate(week.getUTCDate() - week.getUTCDay());

    return `${district}:${locationId}:${mealTypeId}:${week.toISOString().slice(0, 10)}`;
}

/**
 * Fetches and parses a full week of dining data.
 *
 * @param district Nutrislice district.
 * @param locationId Dining location ID.
 * @param mealTypeId Meal type ID.
 * @param date Requested date.
 * @returns Weekly menu or null on failure.
 */
export async function getWeeklyMenu(
    district: string,
    locationId: number,
    mealTypeId: number,
    date: string,
): Promise<WeeklyMenu | null> {
    try {
        // Nutrislice returns a Sunday–Saturday week for the requested Monday.
        const requestDate = new Date(`${date}T00:00:00Z`);

        requestDate.setUTCDate(
            requestDate.getUTCDate() - requestDate.getUTCDay() + 1,
        );

        const [year, month, day] = requestDate
            .toISOString()
            .slice(0, 10)
            .split("-");

        const raw = await fetchNutrisliceJson(
            `https://${district}.api.nutrislice.com/menu/api/weeks/school/${locationId}/menu-type/${mealTypeId}/${year}/${month}/${day}/?format=json`,
        );

        return parseWeeklyMenu(raw);
    } catch (error) {
        console.error(
            `Error fetching weekly menu for district "${district}", location ${locationId}, meal ${mealTypeId}, date ${date}:`,
            error,
        );
        return null;
    }
}

/**
 * Reads saved data from Cloudflare KV without contacting Nutrislice.
 *
 * @param key Unique cache key.
 * @returns Cached data, or null if missing or expired.
 */
export async function readCache<T>(key: string): Promise<CacheEntry<T> | null> {
    return env.MENU_CACHE.get<CacheEntry<T>>(key, "json");
}

/**
 * Stores a response in Cloudflare KV for up to 14 days.
 * Data is considered stale after seven days, not immediately deleted.
 *
 * @param key Unique cache key.
 * @param data Data to store.
 * @returns Time at which the data was fetched.
 */
export async function writeCache<T>(key: string, data: T): Promise<number> {
    const lastUpdatedAt = Date.now();

    try {
        await env.MENU_CACHE.put(key, JSON.stringify({ data, lastUpdatedAt }), {
            expirationTtl: KV_RETENTION_SECONDS,
        });
    } catch (error) {
        // A cache failure must not hide successfully fetched menu data.
        console.error("KV cache write failed:", error);
    }

    return lastUpdatedAt;
}

/**
 * Checks freshness without fetching new Nutrislice data.
 *
 * @param cached Cache entry, if one exists.
 * @returns Freshness status.
 */
export function getCacheStatus(
    cached: CacheEntry<unknown> | null,
): "miss" | "fresh" | "stale" {
    if (!cached) return "miss";

    return Date.now() - cached.lastUpdatedAt >= CACHE_TTL_MS
        ? "stale"
        : "fresh";
}

/**
 * Returns a compact menu listing. Full food records remain in KV.
 *
 * @param menu Full weekly menu.
 * @param date Requested date.
 * @param fullWeek Whether all seven days are requested.
 * @returns Menu with short item summaries.
 */
export function selectMenuDays(
    menu: WeeklyMenu,
    date: string,
    fullWeek?: boolean,
): MenuSummary {
    const selectedDays = fullWeek
        ? menu.days
        : menu.days.filter((day) => day.date === date);

    return {
        startDate: menu.startDate,
        menuTypeId: menu.menuTypeId,
        sourceUpdatedAt: menu.sourceUpdatedAt,
        days: selectedDays.map((day) => ({
            date: day.date,
            unpublished: day.unpublished,
            stations: day.stations.map((station) => ({
                name: station.name,
                items: station.items.map((food) => ({
                    id: food.id,
                    name: food.name,
                    price: food.price,
                    calories: food.rounded_nutrition_info?.calories ?? null,
                    protein: food.rounded_nutrition_info?.g_protein ?? null,
                    foodIcons:
                        food.icons?.food_icons?.map((icon) => icon.name) ?? [],
                })),
            })),
        })),
    };
}

/**
 * Finds one food in an already cached full menu. Never calls Nutrislice.
 *
 * @returns Food and cache timestamp, or null if unavailable.
 */
export async function getCachedFood(
    district: string,
    locationId: number,
    mealTypeId: number,
    date: string,
    foodId: number,
): Promise<{ food: FoodInfo; lastUpdatedAt: number } | null> {
    const key = getMenuCacheKey(district, locationId, mealTypeId, date);
    const cached = await readCache<WeeklyMenu>(`menu:${key}`);

    if (!cached) return null;

    const day = cached.data.days.find((day) => day.date === date);
    if (!day) return null;

    for (const station of day.stations) {
        const food = station.items.find((item) => item.id === foodId);

        if (food) {
            return {
                food,
                lastUpdatedAt: cached.lastUpdatedAt,
            };
        }
    }

    return null;
}

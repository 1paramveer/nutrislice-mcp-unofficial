import { createServer as createHttpServer } from "node:http";
import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import {
    hostHeaderValidation,
    originValidation,
    toNodeHandler,
} from "@modelcontextprotocol/node";
import { z } from "zod";

// Keep a seven-day cache and basic limits on HTTP input and upstream waits.
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const UPSTREAM_TIMEOUT_MS = 20_000;
const MAX_MCP_REQUEST_BYTES = 256 * 1024;

// Accept the district slug as supplied; the destination is checked before fetching.
const districtNameSchema = z.string().min(1);

const days = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;

type RawDiningLocation = {
    id: number;
    name: string;
    slug: string;
    address: string;
    wayfinding_note?: string | null;
    operating_status: string;
    active_menu_types: { id: number; name: string; slug: string }[];
    mon_enabled: boolean;
    mon_start: string | null;
    mon_end: string | null;
    mon_is_24_hours: boolean;
    tue_enabled: boolean;
    tue_start: string | null;
    tue_end: string | null;
    tue_is_24_hours: boolean;
    wed_enabled: boolean;
    wed_start: string | null;
    wed_end: string | null;
    wed_is_24_hours: boolean;
    thu_enabled: boolean;
    thu_start: string | null;
    thu_end: string | null;
    thu_is_24_hours: boolean;
    fri_enabled: boolean;
    fri_start: string | null;
    fri_end: string | null;
    fri_is_24_hours: boolean;
    sat_enabled: boolean;
    sat_start: string | null;
    sat_end: string | null;
    sat_is_24_hours: boolean;
    sun_enabled: boolean;
    sun_start: string | null;
    sun_end: string | null;
    sun_is_24_hours: boolean;
};

type DiningLocation = {
    id: number;
    name: string;
    slug: string;
    address: string;
    wayfindingNote: string | null;
    operatingStatus: string;
    hours: Record<
        "mon" | "tue" | "wed" | "thu" | "fri" | "sat" | "sun",
        {
            enabled: boolean;
            start: string | null;
            end: string | null;
            is24Hours: boolean;
        }
    >;
    availableMeals: { id: number; name: string; slug: string }[];
};

// Keep the complete food information provided by Nutrislice.
type FoodInfo = {
    id: number;
    name: string;
    description: string;
    subtext: string;
    image_url: string | null;
    image_alt_text: string | null;
    hoverpic_url: string | null;
    price: number | null;
    ingredients: string | null;
    food_category: string;
    food_highlight_message: string | null;
    file_url: string;
    download_label: string;
    rounded_nutrition_info: {
        calories: number | null;
        g_fat: number | null;
        g_saturated_fat: number | null;
        g_trans_fat: number | null;
        mg_cholesterol: number | null;
        g_carbs: number | null;
        g_added_sugar: number | null;
        g_sugar: number | null;
        mg_potassium: number | null;
        mg_sodium: number | null;
        g_fiber: number | null;
        g_protein: number | null;
        mg_iron: number | null;
        mg_calcium: number | null;
        mg_vitamin_c: number | null;
        iu_vitamin_a: number | null;
        re_vitamin_a: number | null;
        mcg_vitamin_a: number | null;
        mg_vitamin_d: number | null;
        mcg_vitamin_d: number | null;
    } | null;
    serving_size_info: {
        serving_size_amount: string;
        serving_size_unit: string;
    } | null;
    has_nutrition_info: boolean;
    icons: {
        food_icons: {
            id: number;
            synced_name: string;
            enabled: boolean;
            spotlight_enabled: boolean;
            sprite: {
                slug: string;
                name: string;
                help_text: string;
                class_name: string;
            } | null;
            custom_icon_url: string | null;
            custom_icon: number | null;
            custom_spotlight_icon_url: string | null;
            custom_spotlight_icon: number | null;
            type: number;
            behavior: number;
            is_filter: boolean;
            is_highlight: boolean;
            is_digital_signage_only: boolean;
            slug: string;
            icon_slug: string | null;
            spotlight_icon_slug: string | null;
            name: string;
            _synced_name: string;
            help_text: string;
            sort_order: number;
            _enabled: boolean;
            food_icon_group: number;
        }[];
        myplate_icons: unknown[];
    };
    icons_approved: boolean;
    nested_foods: unknown[];
    aggregated_data: {
        price_adjustment: number;
        icons_approved: boolean;
        food_icons: unknown[];
        calories: number;
    };
    food_sizes: unknown[];
    ds_calories_override: string;
    synced_id: string | null;
    sync_placeholder: unknown;
    has_options_or_sides: boolean;
    digest: string;
    pos_item_id: string;
    smart_recipe_id: number | null;
    has_subfoods: boolean;
    meal_plan_price: number | null;
    use_custom_sizes: boolean;
    tags: number[];
    synced_ordering_enabled: boolean;
    ordering_enabled: boolean;
    ordering_enabled_unlocked: boolean;
};

type WeeklyMenu = {
    startDate: string;
    menuTypeId: number;
    sourceUpdatedAt: string | null;
    days: {
        date: string;
        unpublished: boolean;
        stations: {
            name: string;
            items: FoodInfo[];
        }[];
    }[];
};

type RawWeeklyMenu = {
    start_date: string;
    menu_type_id: string | number;
    last_updated?: string | null;
    days: {
        date: string;
        has_unpublished_menus: boolean;
        menu_items: {
            station_id: number | null;
            is_station_header: boolean;
            text: string;
            price: number | null;
            food: FoodInfo | null;
        }[];
    }[];
};

/**
 * Fetches Nutrislice JSON with a timeout and a fixed API destination.
 * This prevents malformed district names from sending requests elsewhere.
 *
 * @param url Nutrislice API URL.
 * @returns Parsed API response.
 * @throws If the destination is invalid or the request fails.
 */
async function fetchNutrisliceJson(url: string): Promise<unknown> {
    const target = new URL(url);

    // Allow Nutrislice HTTPS API hosts only; do not follow redirects.
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
        redirect: "error",
    });

    if (!response.ok) {
        throw new Error(`Nutrislice HTTP ${response.status}`);
    }

    return response.json();
}

/**
 * Fetches and normalizes dining locations for a district.
 * @param district_name Nutrislice district slug.
 * @returns Dining locations, or null if fetching or validation fails.
 */
async function getDiningLocations(
    district_name: string,
): Promise<DiningLocation[] | null> {
    try {
        const raw = await fetchNutrisliceJson(
            `https://${district_name}.api.nutrislice.com/menu/api/schools`,
        );

        // Check the API response shape before converting it into dining locations.
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
 * Extracts the menu fields used by the MCP tools from a weekly API response.
 * @param raw Weekly Nutrislice API response.
 * @returns A normalized weekly menu.
 * @throws If the response is missing required menu structure.
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

            // Station headers and foods share one API array.
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
                    stations.set(stationId, { name: "Other", items: [] });
                }

                // Preserve the food record, preferring the menu item's price.
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
 * Builds a Sunday-start cache key for a district, location, meal, and week.
 * @param district Nutrislice district slug.
 * @param locationId Dining location ID.
 * @param mealTypeId Meal type ID.
 * @param date Requested date in YYYY-MM-DD format.
 * @returns A unique weekly menu cache key.
 */
function getMenuCacheKey(
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
 * Fetches and parses one meal type's full week without updating the cache.
 * @param district Nutrislice district slug.
 * @param locationId Dining location ID.
 * @param mealTypeId Meal type ID.
 * @param date Requested date in YYYY-MM-DD format.
 * @returns Weekly menu, or null if the request or parsing fails.
 */
async function getWeeklyMenu(
    district: string,
    locationId: number,
    mealTypeId: number,
    date: string,
): Promise<WeeklyMenu | null> {
    try {
        // The Nutrislice response spans Sunday through Saturday.
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

type CacheEntry<T> = {
    data: T;
    lastUpdatedAt: number;
};

/** Returns whether a cache entry is missing, fresh, or stale. */
function getCacheStatus(cached?: {
    lastUpdatedAt: number;
}): "miss" | "fresh" | "stale" {
    if (!cached) return "miss";

    return Date.now() - cached.lastUpdatedAt >= CACHE_TTL_MS
        ? "stale"
        : "fresh";
}

/** Returns the requested day or the entire cached week. */
function selectMenuDays(
    menu: WeeklyMenu,
    date: string,
    fullWeek?: boolean,
): WeeklyMenu {
    return {
        ...menu,
        days: fullWeek
            ? menu.days
            : menu.days.filter((day) => day.date === date),
    };
}

// Caches and ongoing fetches are shared by requests in the same process.
const locationCache = new Map<number, DiningLocation>();
const districtCache = new Map<string, CacheEntry<DiningLocation[]>>();
const inFlight = new Map<string, Promise<DiningLocation[] | null>>();
const weeklyMenuCache = new Map<string, CacheEntry<WeeklyMenu>>();
const inFlightMenus = new Map<string, Promise<WeeklyMenu | null>>();

/**
 * Creates a fresh MCP tool registry for each stateless HTTP request.
 * The data caches remain shared outside this function.
 */
function createServer(): McpServer {
    const server = new McpServer(
        {
            name: "nutrislice-mcp-unofficial",
            version: "1.0.0",
        },
        {
            capabilities: { tools: {} },
        },
    );

    // MCP clients discover and invoke the four tools registered below.
    server.registerTool(
        "check-location-cache",
        {
            title: "Check Dining Locations Cache",
            description:
                "Always check this cache before fetching dining locations. " +
                "Returns cached locations, freshness status, and last update time. " +
                "If missing or stale (7+ days), call get-locations to fetch fresh data. " +
                "If fresh, use cached data, tell the user when it was last updated, " +
                "mention that schedules may change, and offer an optional refresh. " +
                "Never fetch data through this tool.",
            inputSchema: z.object({
                district_name: districtNameSchema.describe(
                    "Nutrislice district slug (e.g., 'wsu' from wsu.nutrislice.edu)",
                ),
            }),
            annotations: {
                readOnlyHint: true,
                destructiveHint: false,
                idempotentHint: true,
                openWorldHint: false,
            },
        },
        async ({ district_name }) => {
            const cached = districtCache.get(district_name);

            // Check freshness without contacting Nutrislice.
            const status = getCacheStatus(cached);

            return {
                content: [
                    {
                        type: "text" as const,
                        text: JSON.stringify({
                            status,
                            lastUpdatedAt: cached
                                ? new Date(cached.lastUpdatedAt).toISOString()
                                : null,
                            locations: cached?.data ?? null,
                        }),
                    },
                ],
            };
        },
    );

    server.registerTool(
        "get-locations",
        {
            title: "Get Dining Locations",
            description:
                "Fetch fresh dining locations from Nutrislice and update the cache. " +
                "Call after check-location-cache returns miss or stale (7+ days), " +
                "or when the user explicitly requests updated data. " +
                "Avoid unnecessary API requests. Report the last update time " +
                "and tell the user when fresh data was retrieved.",
            inputSchema: z.object({
                district_name: districtNameSchema.describe(
                    "Enter your District name (e.g., 'wsu' from wsu.nutrislice.edu)",
                ),
            }),
            annotations: {
                readOnlyHint: true,
                destructiveHint: false,
                idempotentHint: true,
                openWorldHint: true,
            },
        },
        async ({ district_name }) => {
            // Share an ongoing fetch when multiple users request one district.
            let request = inFlight.get(district_name);

            if (!request) {
                request = getDiningLocations(district_name).finally(() =>
                    inFlight.delete(district_name),
                );
                inFlight.set(district_name, request);
            }

            const locations = await request;

            if (locations === null) {
                return {
                    content: [
                        {
                            type: "text" as const,
                            text: `Unable to fetch dining locations for district "${district_name}". Check the district name, network connection, and server error logs.`,
                        },
                    ],
                    isError: true,
                };
            }

            // Update the cache only after a successful fetch.
            const lastUpdatedAt = Date.now();

            districtCache.set(district_name, {
                data: locations,
                lastUpdatedAt,
            });

            for (const location of locations) {
                locationCache.set(location.id, location);
            }

            return {
                content: [
                    {
                        type: "text" as const,
                        text: JSON.stringify({
                            source: "api",
                            lastUpdatedAt: new Date(
                                lastUpdatedAt,
                            ).toISOString(),
                            locations,
                        }),
                    },
                ],
            };
        },
    );

    const menuInputSchema = z.object({
        district_name: districtNameSchema.describe(
            "Nutrislice district slug (e.g., 'wsu')",
        ),
        location_id: z
            .number()
            .int()
            .positive()
            .describe(
                "Dining location ID from get-locations (e.g., 61250 for Northside Café)",
            ),
        meal_type_id: z
            .number()
            .int()
            .positive()
            .describe("Meal ID from availableMeals (e.g., 28915 for lunch)"),
        date: z.iso
            .date()
            .describe("Menu date in YYYY-MM-DD format (e.g., 2026-11-16)"),
        full_week: z
            .boolean()
            .optional()
            .describe(
                "Return all seven days instead of only the requested date",
            ),
    });

    server.registerTool(
        "check-weekly-menu-cache",
        {
            title: "Check Weekly Menu Cache",
            description:
                "Check this cache before requesting a meal menu. " +
                "Use location and meal IDs from get-locations. " +
                "On a miss or a stale entry (7+ days), call get-weekly-menu. " +
                "On a fresh entry, use cached data and offer an optional refresh. " +
                "No network request is made by this tool.",
            inputSchema: menuInputSchema,
            annotations: {
                readOnlyHint: true,
                destructiveHint: false,
                idempotentHint: true,
                openWorldHint: false,
            },
        },
        async ({
            district_name,
            location_id,
            meal_type_id,
            date,
            full_week,
        }) => {
            const key = getMenuCacheKey(
                district_name,
                location_id,
                meal_type_id,
                date,
            );

            const cached = weeklyMenuCache.get(key);

            // One cache entry covers a full Sunday–Saturday menu week.
            const status = getCacheStatus(cached);

            return {
                content: [
                    {
                        type: "text" as const,
                        text: JSON.stringify({
                            status,
                            lastUpdatedAt: cached
                                ? new Date(cached.lastUpdatedAt).toISOString()
                                : null,
                            menu: cached
                                ? selectMenuDays(cached.data, date, full_week)
                                : null,
                        }),
                    },
                ],
            };
        },
    );

    server.registerTool(
        "get-weekly-menu",
        {
            title: "Get Weekly Dining Menu",
            description:
                "Fetch and cache one full Nutrislice week for one meal type. " +
                "Call after check-weekly-menu-cache reports miss or stale, or when the user " +
                "explicitly requests fresh data. Select meal_type_id from availableMeals " +
                "returned by get-locations (breakfast, lunch, dinner, brunch, other, etc.). " +
                "By default returns only the requested day; set full_week for seven days.",
            inputSchema: menuInputSchema,
            annotations: {
                readOnlyHint: true,
                destructiveHint: false,
                idempotentHint: true,
                openWorldHint: true,
            },
        },
        async ({
            district_name,
            location_id,
            meal_type_id,
            date,
            full_week,
        }) => {
            const key = getMenuCacheKey(
                district_name,
                location_id,
                meal_type_id,
                date,
            );

            // Concurrent requests for the same week share one API fetch.
            let request = inFlightMenus.get(key);

            if (!request) {
                request = getWeeklyMenu(
                    district_name,
                    location_id,
                    meal_type_id,
                    date,
                ).finally(() => inFlightMenus.delete(key));

                inFlightMenus.set(key, request);
            }

            const menu = await request;

            // A shared response must include each caller's requested date.
            if (menu === null || !menu.days.some((day) => day.date === date)) {
                return {
                    content: [
                        {
                            type: "text" as const,
                            text: `Unable to fetch the weekly menu for district "${district_name}", location ${location_id}, meal ${meal_type_id}, date ${date}. Verify the IDs and check the server error logs.`,
                        },
                    ],
                    isError: true,
                };
            }

            // Store the full week; filter only the response sent to the caller.
            const lastUpdatedAt = Date.now();

            weeklyMenuCache.set(key, {
                data: menu,
                lastUpdatedAt,
            });

            return {
                content: [
                    {
                        type: "text" as const,
                        text: JSON.stringify({
                            source: "api",
                            lastUpdatedAt: new Date(
                                lastUpdatedAt,
                            ).toISOString(),
                            menu: selectMenuDays(menu, date, full_week),
                        }),
                    },
                ],
            };
        },
    );

    return server;
}

/**
 * Starts the HTTP endpoint for MCP clients.
 * The hosting platform should provide HTTPS when deployed publicly.
 */
async function main(): Promise<void> {
    const host = process.env.HOST ?? "127.0.0.1";
    const port = Number(process.env.PORT ?? 3000);
    const configuredHosts = process.env.ALLOWED_HOSTS;

    // Public binding requires an explicit list of accepted hostnames.
    if (
        host !== "127.0.0.1" &&
        host !== "localhost" &&
        host !== "::1" &&
        !configuredHosts
    ) {
        throw new Error(
            "Set ALLOWED_HOSTS before binding to a public interface",
        );
    }

    const allowedHosts = configuredHosts
        ? configuredHosts
              .split(",")
              .map((value) => value.trim())
              .filter(Boolean)
        : ["localhost", "127.0.0.1", "[::1]"];

    if (allowedHosts.length === 0) {
        throw new Error("ALLOWED_HOSTS must not be empty");
    }

    const validateHost = hostHeaderValidation(allowedHosts);
    const validateOrigin = originValidation(allowedHosts);

    // The MCP SDK processes protocol requests and limits incoming body size.
    const handleMcp = toNodeHandler(
        createMcpHandler(createServer, {
            maxRequestBodySize: MAX_MCP_REQUEST_BYTES,
        }),
        {
            maxRequestBodySize: MAX_MCP_REQUEST_BYTES,
        },
    );

    const httpServer = createHttpServer((req, res) => {
        // Health checks don't invoke MCP tools or Nutrislice.
        if (req.url === "/healthz" && req.method === "GET") {
            res.writeHead(200).end("ok");
            return;
        }

        if (req.url?.split("?")[0] !== "/mcp") {
            res.writeHead(404).end("Not Found");
            return;
        }

        // Validate hosts and browser origins before processing MCP messages.
        if (!validateHost(req, res) || !validateOrigin(req, res)) {
            return;
        }

        // No global rate counter or concurrency cap blocks other users.
        void handleMcp(req, res).catch((error: unknown) => {
            console.error("MCP request failed:", error);

            if (!res.headersSent) {
                res.writeHead(500).end("Internal Server Error");
            } else {
                res.destroy();
            }
        });
    });

    await new Promise<void>((resolve, reject) => {
        httpServer.once("error", reject);
        httpServer.listen(port, host, resolve);
    });

    console.error(`Nutrislice MCP listening at http://${host}:${port}/mcp`);
}

main().catch((error: unknown) => {
    console.error("Failed to start Nutrislice MCP server:", error);
    process.exitCode = 1;
});

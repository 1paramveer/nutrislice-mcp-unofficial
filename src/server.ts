import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";
import { z } from "zod";
import type { DiningLocation, WeeklyMenu, CacheEntry } from "./types.ts";
import {
    getDiningLocations,
    getMenuCacheKey,
    getWeeklyMenu,
    readCache,
    writeCache,
    getCacheStatus,
    selectMenuDays,
    getCachedFood,
} from "./functions.ts";

const MAX_MCP_REQUEST_BYTES = 256 * 1024;

// Accept institution slugs as provided; validate the URL destination before fetching.
const districtNameSchema = z.string().min(1);

// Within one Worker instance, simultaneous requests share a fetch.
// KV stores the completed response for other instances and future requests.
const inFlight = new Map<
    string,
    Promise<CacheEntry<DiningLocation[]> | null>
>();

const inFlightMenus = new Map<string, Promise<CacheEntry<WeeklyMenu> | null>>();

/**
 * Creates an MCP server and registers its seven tools.
 * Each HTTP request receives a new MCP server, while KV stores shared data.
 *
 * @returns Configured MCP server.
 */
function createServer(): McpServer {
    const server = new McpServer(
        {
            name: "nutrislice-mcp-unofficial",
            version: "1.1.0-rc.1",
        },
        {
            capabilities: { tools: {} },
        },
    );

    server.registerTool(
        "check-location-cache",
        {
            title: "Check Dining Locations Cache",
            description:
                "FIRST STEP for any dining-location request. Always check this cache " +
                "before calling get-locations. This tool never contacts Nutrislice. " +
                "Returns status (miss, fresh, or stale), lastUpdatedAt, and locations. " +
                "Each location includes id, name, slug, address, wayfindingNote, " +
                "operatingStatus, hours for each weekday, and availableMeals " +
                "(meal type id, name, and slug). " +
                "If fresh, use the cached locations without calling get-locations. " +
                "If missing or stale (7+ days), call get-locations. " +
                "Only refresh fresh data if the user explicitly requests a refresh. " +
                "When reporting cached information, mention when it was last updated " +
                "and that published operating hours may change.",
            inputSchema: z.object({
                district_name: districtNameSchema.describe(
                    "Nutrislice district slug, such as 'wsu' from wsu.nutrislice.edu.",
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
            // The cache-check tool only reads KV.
            const cached = await readCache<DiningLocation[]>(
                `district:${district_name}`,
            );

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
                "Fetch fresh dining locations from the Nutrislice API and update KV. " +
                "IMPORTANT: Call check-location-cache first. Use this tool only if " +
                "the cache is missing or stale (7+ days), or if the user explicitly " +
                "requests fresh information. Do not fetch again when cached data is fresh. " +
                "Returns source='api', lastUpdatedAt, and locations. " +
                "Each location contains id, name, slug, address, wayfindingNote, " +
                "operatingStatus, daily operating hours, and availableMeals. " +
                "Use the returned location id and availableMeals ids for menu requests. " +
                "Do not guess location IDs or meal type IDs. " +
                "Do not automatically fetch menus for every returned location. " +
                "Let the user's question determine which locations and meals are needed.",
            inputSchema: z.object({
                district_name: districtNameSchema.describe(
                    "Nutrislice district slug, such as 'wsu'.",
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
            // Concurrent callers share both the API fetch and KV write.
            let request = inFlight.get(district_name);

            if (!request) {
                request = getDiningLocations(district_name)
                    .then(async (data) =>
                        data === null
                            ? null
                            : {
                                  data,
                                  lastUpdatedAt: await writeCache(
                                      `district:${district_name}`,
                                      data,
                                  ),
                              },
                    )
                    .finally(() => inFlight.delete(district_name));

                inFlight.set(district_name, request);
            }

            const cached = await request;

            if (cached === null) {
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

            return {
                content: [
                    {
                        type: "text" as const,
                        text: JSON.stringify({
                            source: "api",
                            lastUpdatedAt: new Date(
                                cached.lastUpdatedAt,
                            ).toISOString(),
                            locations: cached.data,
                        }),
                    },
                ],
            };
        },
    );

    const menuInputSchema = z.object({
        district_name: districtNameSchema.describe(
            "Nutrislice district slug, such as 'wsu'.",
        ),
        location_id: z
            .number()
            .int()
            .positive()
            .describe(
                "Dining location ID obtained from cached or fetched locations.",
            ),
        meal_type_id: z
            .number()
            .int()
            .positive()
            .describe(
                "Meal type ID from the selected location's availableMeals.",
            ),
        date: z.iso
            .date()
            .describe("Requested menu date in YYYY-MM-DD format."),
        full_week: z
            .boolean()
            .optional()
            .describe(
                "Omit or set false for one day. Set true only when the user requests a weekly menu or the full week is needed.",
            ),
    });

    const foodInputSchema = menuInputSchema
        .omit({
            full_week: true,
        })
        .extend({
            food_id: z
                .number()
                .int()
                .positive()
                .describe(
                    "Exact food ID from a compact menu listing. Use the same district, location, meal type, and date as that listing.",
                ),
        });

    server.registerTool(
        "check-weekly-menu-cache",
        {
            title: "Check Weekly Menu Cache",
            description:
                "FIRST STEP for any menu request. Always check this tool before " +
                "calling get-weekly-menu. It reads KV and never contacts Nutrislice. " +
                "Returns status (miss, fresh, or stale), lastUpdatedAt, and a COMPACT menu. " +
                "The compact menu includes startDate, menuTypeId, sourceUpdatedAt, " +
                "and days containing date, unpublished, and stations. " +
                "Each station has a name and food items. Each food item contains ONLY " +
                "id, name, price, calories, protein, and foodIcons. " +
                "Calories and protein are from Nutrislice's published nutrition data. " +
                "Use foodIcons as published labels, not as proof of allergen safety. " +
                "The complete food records remain stored separately inside the cached menu. " +
                "If the cache is fresh, answer using this compact response. " +
                "Do not call get-weekly-menu again unless the user asks for fresh data. " +
                "If missing or stale (7+ days), call get-weekly-menu. " +
                "COMPACT-FIRST RULE: For ordinary menu questions, comparisons, " +
                "prices, calories, protein, or visible food labels, use the compact " +
                "listing without requesting detailed food records. " +
                "Do not call individual food-detail tools merely because they exist. " +
                "If the user wants additional information but has not specified which " +
                "food or which type of detail, ask them to choose first. " +
                "Only request one day's menu by default. Use full_week=true " +
                "when the user requests a weekly menu or the full week is necessary.",
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

            // The stored entry contains the complete weekly menu.
            const cached = await readCache<WeeklyMenu>(`menu:${key}`);
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
                "Fetch a complete weekly menu from Nutrislice and store the FULL " +
                "food records in Cloudflare KV, but return ONLY a COMPACT menu to the AI. " +
                "IMPORTANT: Call check-weekly-menu-cache first. " +
                "Use this tool only when the cache is missing, stale (7+ days), " +
                "or when the user explicitly requests fresh information. " +
                "Do not repeatedly fetch a fresh cached menu. " +
                "Returns source='api', lastUpdatedAt, and menu. " +
                "The compact menu contains startDate, menuTypeId, sourceUpdatedAt, " +
                "and days with date, unpublished, and stations. " +
                "Each station contains a name and items with id, name, price, " +
                "calories, protein, and foodIcons. " +
                "The returned food ID identifies an item for later detailed lookups. " +
                "The full records are retained in KV, including ingredients, " +
                "complete nutrition, serving size, dietary labels, and other metadata. " +
                "COMPACT-FIRST RULE: Always answer from the compact menu when it " +
                "contains enough information. Do not fetch detailed records for every item. " +
                "For questions about additional nutrients, use get-food-nutrition " +
                "only for the relevant food. For ingredients, use get-food-ingredients. " +
                "Use get-food-details only as a last resort. " +
                "If the user wants more detail but has not selected an item, " +
                "present the relevant menu choices and ask which item they want. " +
                "If they have not specified the desired detail, ask whether they " +
                "want nutrition, ingredients, or the complete record. " +
                "Do not ask again if the user's original question already identifies " +
                "the food and required information. " +
                "By default return only the requested date. Use full_week=true " +
                "for an explicitly requested full week.",
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

            // Share the fetch and KV write within the same Worker instance.
            let request = inFlightMenus.get(key);

            if (!request) {
                request = getWeeklyMenu(
                    district_name,
                    location_id,
                    meal_type_id,
                    date,
                )
                    .then(async (data) =>
                        data === null
                            ? null
                            : {
                                  data,
                                  lastUpdatedAt: await writeCache(
                                      `menu:${key}`,
                                      data,
                                  ),
                              },
                    )
                    .finally(() => inFlightMenus.delete(key));

                inFlightMenus.set(key, request);
            }

            const cached = await request;

            // Even when sharing a fetch, each caller needs its requested date.
            if (
                cached === null ||
                !cached.data.days.some((day) => day.date === date)
            ) {
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

            // KV stores all seven days; filter only what we return to the client.
            return {
                content: [
                    {
                        type: "text" as const,
                        text: JSON.stringify({
                            source: "api",
                            lastUpdatedAt: new Date(
                                cached.lastUpdatedAt,
                            ).toISOString(),
                            menu: selectMenuDays(cached.data, date, full_week),
                        }),
                    },
                ],
            };
        },
    );

    server.registerTool(
        "get-food-nutrition",
        {
            title: "Get Food Nutrition",
            description:
                "TARGETED DETAIL TOOL. Read nutrition information for exactly " +
                "one food from an already cached weekly menu. Never contacts Nutrislice. " +
                "Use this tool ONLY when the user requests nutrition information " +
                "not included in the compact menu, or when that information is " +
                "necessary to answer their specific question. " +
                "The compact menu ALREADY includes calories and protein. " +
                "Do not use this tool just to retrieve those two values again. " +
                "Returns lastUpdatedAt, id, name, servingSize, nutrition, " +
                "and hasNutritionInfo. " +
                "The nutrition object includes calories, total fat, saturated fat, " +
                "trans fat, cholesterol, carbohydrates, added sugar, total sugar, " +
                "potassium, sodium, fiber, protein, iron, calcium, vitamin C, " +
                "vitamin A in multiple units, and vitamin D in multiple units. " +
                "Actual response fields use Nutrislice's nutrient names: " +
                "calories, g_fat, g_saturated_fat, g_trans_fat, mg_cholesterol, " +
                "g_carbs, g_added_sugar, g_sugar, mg_potassium, mg_sodium, " +
                "g_fiber, g_protein, mg_iron, mg_calcium, mg_vitamin_c, " +
                "iu_vitamin_a, re_vitamin_a, mcg_vitamin_a, mg_vitamin_d, " +
                "and mcg_vitamin_d. " +
                "Values may be null if the institution has not published them. " +
                "COMPACT-FIRST RULE: Never retrieve nutrition for every food " +
                "speculatively. If the user requests nutritional details without " +
                "identifying a food, ask which item they want. " +
                "If the user explicitly asks for a particular nutrient of a " +
                "particular food, retrieve it without an unnecessary confirmation. " +
                "If the requested food is missing from KV, use get-weekly-menu " +
                "to populate the cache before retrying.",
            inputSchema: foodInputSchema,
            annotations: {
                readOnlyHint: true,
                destructiveHint: false,
                idempotentHint: true,
                openWorldHint: false,
            },
        },
        async ({ district_name, location_id, meal_type_id, date, food_id }) => {
            const result = await getCachedFood(
                district_name,
                location_id,
                meal_type_id,
                date,
                food_id,
            );

            if (!result) {
                return {
                    content: [
                        {
                            type: "text" as const,
                            text: "Food not found in the cached menu. Call get-weekly-menu for this date first.",
                        },
                    ],
                    isError: true,
                };
            }

            const { food, lastUpdatedAt } = result;

            return {
                content: [
                    {
                        type: "text" as const,
                        text: JSON.stringify({
                            lastUpdatedAt: new Date(
                                lastUpdatedAt,
                            ).toISOString(),
                            id: food.id,
                            name: food.name,
                            servingSize: food.serving_size_info,
                            nutrition: food.rounded_nutrition_info,
                            hasNutritionInfo: food.has_nutrition_info,
                        }),
                    },
                ],
            };
        },
    );

    server.registerTool(
        "get-food-ingredients",
        {
            title: "Get Food Ingredients and Labels",
            description:
                "TARGETED DETAIL TOOL. Retrieve ingredients and published food " +
                "labels for exactly one item from an already cached weekly menu. " +
                "Never contacts Nutrislice. " +
                "Use when the user specifically requests ingredients, descriptions, " +
                "or more information about a food's composition or dietary labels. " +
                "Returns lastUpdatedAt, id, name, description, subtext, ingredients, " +
                "and foodIcons. " +
                "The ingredients field contains the published ingredient text, " +
                "which may be long or unavailable. " +
                "foodIcons contains the institution's published dietary or food labels. " +
                "These labels do not guarantee that a food is safe for someone " +
                "with an allergy. Never infer allergen absence from missing labels. " +
                "COMPACT-FIRST RULE: Check the compact menu's foodIcons first. " +
                "Do not call this tool when the compact labels already answer " +
                "the user's question. Do not retrieve ingredient lists for " +
                "every menu item without a clear user request. " +
                "If the user wants ingredient details but has not named a food, " +
                "ask which item they want. " +
                "If the user identifies a specific food and asks about ingredients, " +
                "retrieve them without an unnecessary confirmation. " +
                "If the food is not cached, call get-weekly-menu first.",
            inputSchema: foodInputSchema,
            annotations: {
                readOnlyHint: true,
                destructiveHint: false,
                idempotentHint: true,
                openWorldHint: false,
            },
        },
        async ({ district_name, location_id, meal_type_id, date, food_id }) => {
            const result = await getCachedFood(
                district_name,
                location_id,
                meal_type_id,
                date,
                food_id,
            );

            if (!result) {
                return {
                    content: [
                        {
                            type: "text" as const,
                            text: "Food not found in the cached menu. Call get-weekly-menu for this date first.",
                        },
                    ],
                    isError: true,
                };
            }

            const { food, lastUpdatedAt } = result;

            return {
                content: [
                    {
                        type: "text" as const,
                        text: JSON.stringify({
                            lastUpdatedAt: new Date(
                                lastUpdatedAt,
                            ).toISOString(),
                            id: food.id,
                            name: food.name,
                            description: food.description,
                            subtext: food.subtext,
                            ingredients: food.ingredients,
                            foodIcons:
                                food.icons?.food_icons?.map(
                                    (icon) => icon.name,
                                ) ?? [],
                        }),
                    },
                ],
            };
        },
    );

    server.registerTool(
        "get-food-details",
        {
            title: "Get Complete Food Details",
            description:
                "LAST-RESORT DETAIL TOOL. Returns the COMPLETE original Nutrislice " +
                "food record for exactly one item from Cloudflare KV. " +
                "This is the most detailed response and may contain substantially " +
                "more information than the other tools. Never contacts Nutrislice. " +
                "The result contains lastUpdatedAt and the full food object. " +
                "The food object includes id, name, description, subtext, " +
                "image URLs, price, ingredients, food_category, " +
                "food_highlight_message, file_url, download_label, " +
                "all rounded_nutrition_info fields, serving_size_info, " +
                "has_nutrition_info, detailed icons and their metadata, " +
                "icons_approved, nested_foods, aggregated_data, food_sizes, " +
                "sync identifiers, ordering fields, tags, and other source metadata. " +
                "STRICT TOOL PRIORITY: First use the compact menu from " +
                "check-weekly-menu-cache or get-weekly-menu. " +
                "If additional nutrition is needed, prefer get-food-nutrition. " +
                "If ingredients or dietary labels are needed, prefer " +
                "get-food-ingredients. Only consider this tool if those " +
                "smaller responses cannot answer the user's actual request. " +
                "USER CHOICE REQUIRED: If the user has not explicitly requested " +
                "the complete original record, explain that a detailed record " +
                "is available and ask whether they want it before calling this tool. " +
                "If the user explicitly requests the complete record, " +
                "that request already establishes their choice. " +
                "Never automatically load full records for all foods, " +
                "all stations, or an entire menu. " +
                "If the food is missing from KV, call get-weekly-menu first.",
            inputSchema: foodInputSchema,
            annotations: {
                readOnlyHint: true,
                destructiveHint: false,
                idempotentHint: true,
                openWorldHint: false,
            },
        },
        async ({ district_name, location_id, meal_type_id, date, food_id }) => {
            const result = await getCachedFood(
                district_name,
                location_id,
                meal_type_id,
                date,
                food_id,
            );

            if (!result) {
                return {
                    content: [
                        {
                            type: "text" as const,
                            text: "Food not found in the cached menu. Call get-weekly-menu for this date first.",
                        },
                    ],
                    isError: true,
                };
            }

            return {
                content: [
                    {
                        type: "text" as const,
                        text: JSON.stringify({
                            lastUpdatedAt: new Date(
                                result.lastUpdatedAt,
                            ).toISOString(),
                            food: result.food,
                        }),
                    },
                ],
            };
        },
    );

    return server;
}

// Cloudflare provides HTTPS and passes requests directly to the MCP handler.
const handleMcp = createMcpHandler(createServer, {
    maxRequestBodySize: MAX_MCP_REQUEST_BYTES,
});

export default {
    fetch(
        request: Request,
        workerEnv: Env,
        ctx: ExecutionContext,
    ): Promise<Response> {
        const path = new URL(request.url).pathname;

        // Health checks don't invoke MCP tools or Nutrislice.
        if (path === "/healthz" && request.method === "GET") {
            return Promise.resolve(new Response("ok"));
        }

        if (path !== "/mcp") {
            return Promise.resolve(new Response("Not Found", { status: 404 }));
        }

        // Handle stateless Streamable HTTP; no Node HTTP server is needed.
        return handleMcp(request, workerEnv, ctx);
    },
};

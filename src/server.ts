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
 * Creates an MCP server and registers its four tools.
 * Each HTTP request receives a new MCP server, while KV stores shared data.
 *
 * @returns Configured MCP server.
 */
function createServer(): McpServer {
    const server = new McpServer(
        {
            name: "nutrislice-mcp-unofficial",
            version: "1.0.1",
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
                "Never fetches Nutrislice data.",
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
